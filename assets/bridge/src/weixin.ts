import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { BridgeConfig, InboundImage, InboundTextMessage, WeixinMessage } from "./types.js";

const MESSAGE_ITEM_TEXT = 1;
const MESSAGE_ITEM_IMAGE = 2;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const SEND_CHUNK_SIZE = 3600;
const SEND_RETRIES = 3;
const SEND_SPACING_MS = 180;
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

type QrStartResponse = {
  qrcode: string;
  qrcode_img_content: string;
};

type QrStatusResponse = {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
};

type GetUpdatesResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};

type WeixinApiResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
};

type UploadUrlResponse = WeixinApiResponse & {
  upload_param?: string;
  upload_full_url?: string;
  filekey?: string;
  fileid?: string;
};

const sendQueues = new Map<string, Promise<void>>();

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomUinHeader(): string {
  const value = crypto.randomInt(0, 0xffffffff).toString();
  return Buffer.from(value, "utf8").toString("base64");
}

function buildIlinkHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(buildClientVersion("0.1.0"))
  };
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function generateClientId(): string {
  return `weixin-codex-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertWeixinOk(label: string, rawText: string): void {
  if (!rawText.trim()) return;
  let parsed: WeixinApiResponse;
  try {
    parsed = JSON.parse(rawText) as WeixinApiResponse;
  } catch {
    return;
  }
  const failed = (parsed.ret != null && parsed.ret !== 0) || (parsed.errcode != null && parsed.errcode !== 0);
  if (failed) {
    throw new Error(`${label} failed: ret=${parsed.ret} errcode=${parsed.errcode} errmsg=${parsed.errmsg ?? ""} body=${rawText.slice(0, 500)}`);
  }
}

async function requestText(params: {
  baseUrl: string;
  endpoint: string;
  method: "GET" | "POST";
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-WECHAT-UIN": randomUinHeader(),
      ...buildIlinkHeaders()
    };
    if (params.token) {
      headers.AuthorizationType = "ilink_bot_token";
      headers.Authorization = `Bearer ${params.token}`;
    }

    const res = await fetch(new URL(params.endpoint, ensureTrailingSlash(params.baseUrl)), {
      method: params.method,
      headers,
      body: params.body == null ? undefined : JSON.stringify(params.body),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Weixin API ${params.endpoint} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startLogin(config: BridgeConfig): Promise<{ qrcodeUrl: string; qrcode: string }> {
  const text = await requestText({
    baseUrl: config.weixin.baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(config.weixin.botType)}`,
    method: "POST",
    body: { local_token_list: config.weixin.token ? [config.weixin.token] : [] }
  });
  const parsed = JSON.parse(text) as QrStartResponse;
  if (!parsed.qrcode || !parsed.qrcode_img_content) {
    throw new Error(`Weixin login did not return a QR code: ${text.slice(0, 200)}`);
  }
  return { qrcode: parsed.qrcode, qrcodeUrl: parsed.qrcode_img_content };
}

export async function waitForLogin(config: BridgeConfig, qrcode: string): Promise<{
  token: string;
  accountId: string;
  userId?: string;
  baseUrl: string;
}> {
  let baseUrl = config.weixin.baseUrl;
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const text = await requestText({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      method: "GET",
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS
    });
    const status = JSON.parse(text) as QrStatusResponse;
    if (status.status === "scaned_but_redirect" && status.redirect_host) {
      baseUrl = status.redirect_host;
      continue;
    }
    if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
      return {
        token: status.bot_token,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        baseUrl: status.baseurl || baseUrl
      };
    }
    if (status.status === "expired" || status.status === "verify_code_blocked") {
      throw new Error(`Weixin login failed with status: ${status.status}`);
    }
  }
  throw new Error("Timed out waiting for Weixin QR confirmation");
}

export async function getUpdates(config: BridgeConfig): Promise<{
  messages: InboundTextMessage[];
  rawCaptureFiles: string[];
  getUpdatesBuf?: string;
  nextTimeoutMs?: number;
}> {
  if (!config.weixin.token) throw new Error("Weixin is not logged in. Run codex-weixin login-weixin.");
  const text = await requestText({
    baseUrl: config.weixin.baseUrl,
    endpoint: "ilink/bot/getupdates",
    method: "POST",
    token: config.weixin.token,
    timeoutMs: 45_000,
    body: {
      base_info: { bot_agent: "@zk-experiment/weixin-codex-bridge/0.1.0" },
      get_updates_buf: config.weixin.getUpdatesBuf || ""
    }
  });
  const parsed = JSON.parse(text) as GetUpdatesResponse;
  if ((parsed.ret != null && parsed.ret !== 0) || (parsed.errcode != null && parsed.errcode !== 0)) {
    throw new Error(`getUpdates failed: ret=${parsed.ret} errcode=${parsed.errcode} ${parsed.errmsg ?? ""}`);
  }
  const rawCaptureFiles: string[] = [];
  const messages: InboundTextMessage[] = [];
  for (const msg of parsed.msgs || []) {
    if (hasNonTextItem(msg)) {
      rawCaptureFiles.push(captureInboundRaw(config, msg));
    }
    const textBody = extractText(msg);
    const peerId = msg.from_user_id;
    if (!peerId) continue;
    const { images, errors } = await downloadImagesFromMessage(config, msg);
    const fallbackText = errors.length > 0 ? `图片处理失败：\n${errors.join("\n")}` : "";
    if (!textBody && images.length === 0 && !fallbackText) continue;
    messages.push({
      peerId,
      text: textBody || fallbackText,
      images,
      contextToken: msg.context_token,
      raw: msg
    });
  }
  return {
    messages,
    rawCaptureFiles,
    getUpdatesBuf: parsed.get_updates_buf,
    nextTimeoutMs: parsed.longpolling_timeout_ms
  };
}

export async function sendText(config: BridgeConfig, to: string, text: string, contextToken?: string): Promise<void> {
  const previous = sendQueues.get(to) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => sendTextChunks(config, to, text, contextToken));
  sendQueues.set(to, next);
  try {
    await next;
  } finally {
    if (sendQueues.get(to) === next) sendQueues.delete(to);
  }
}

export async function sendImages(config: BridgeConfig, to: string, imagePaths: string[], contextToken?: string): Promise<void> {
  if (imagePaths.length === 0) return;
  const previous = sendQueues.get(to) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      for (const imagePath of imagePaths) {
        await sendSingleImage(config, to, imagePath, contextToken);
        await sleep(SEND_SPACING_MS);
      }
    });
  sendQueues.set(to, next);
  try {
    await next;
  } finally {
    if (sendQueues.get(to) === next) sendQueues.delete(to);
  }
}

async function sendTextChunks(config: BridgeConfig, to: string, text: string, contextToken?: string): Promise<void> {
  const chunks = splitText(text || "(empty response)", SEND_CHUNK_SIZE);
  for (let index = 0; index < chunks.length; index += 1) {
    const prefix = chunks.length > 1 ? `[${index + 1}/${chunks.length}]\n` : "";
    await sendSingleText(config, to, `${prefix}${chunks[index]}`, contextToken);
    if (index < chunks.length - 1) await sleep(SEND_SPACING_MS);
  }
}

async function sendSingleText(config: BridgeConfig, to: string, text: string, contextToken?: string): Promise<void> {
  if (!config.weixin.token) throw new Error("Weixin is not logged in.");
  let lastError: unknown;
  for (let attempt = 1; attempt <= SEND_RETRIES; attempt += 1) {
    try {
      const rawText = await requestText({
        baseUrl: config.weixin.baseUrl,
        endpoint: "ilink/bot/sendmessage",
        method: "POST",
        token: config.weixin.token,
        body: {
          base_info: { bot_agent: "@zk-experiment/weixin-codex-bridge/0.1.0" },
          msg: {
            from_user_id: "",
            to_user_id: to,
            client_id: generateClientId(),
            message_type: MESSAGE_TYPE_BOT,
            message_state: MESSAGE_STATE_FINISH,
            context_token: contextToken,
            item_list: [{ type: MESSAGE_ITEM_TEXT, text_item: { text } }]
          }
        }
      });
      assertWeixinOk("sendmessage", rawText);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < SEND_RETRIES) await sleep(300 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function sendSingleImage(config: BridgeConfig, to: string, imagePath: string, contextToken?: string): Promise<void> {
  if (!config.weixin.token) throw new Error("Weixin is not logged in.");
  const image = await prepareUploadImage(imagePath);
  const uploaded = await uploadImage(config, to, image);
  const rawText = await requestText({
    baseUrl: config.weixin.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    method: "POST",
    token: config.weixin.token,
    body: {
      base_info: { bot_agent: "@zk-experiment/weixin-codex-bridge/0.1.0" },
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        context_token: contextToken,
        item_list: [{
          type: MESSAGE_ITEM_IMAGE,
          image_item: {
            aeskey: image.aesKeyHex,
            media: {
              encrypt_type: 1,
              encrypt_query_param: uploaded.encryptQueryParam,
              aes_key: Buffer.from(image.aesKeyHex, "utf8").toString("base64")
            },
            mid_size: image.raw.length,
            hd_size: image.raw.length
          }
        }]
      }
    }
  });
  assertWeixinOk("sendmessage image", rawText);
}

async function uploadImage(config: BridgeConfig, to: string, image: PreparedUploadImage): Promise<{ encryptQueryParam: string }> {
  const upload = await getUploadUrl(config, to, image);
  const cdnBaseUrl = config.weixin.cdnBaseUrl || DEFAULT_CDN_BASE_URL;
  const uploadUrl = upload.uploadFullUrl || `${ensureTrailingSlash(cdnBaseUrl)}upload?encrypted_query_param=${encodeURIComponent(upload.uploadParam)}&filekey=${encodeURIComponent(upload.fileKey)}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream"
    },
    body: new Uint8Array(image.encrypted)
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Weixin CDN upload failed: ${res.status} ${text.slice(0, 300)}`);
  const encryptQueryParam = res.headers.get("x-encrypted-param") || res.headers.get("X-Encrypted-Param");
  if (!encryptQueryParam) {
    throw new Error(`Weixin CDN upload did not return x-encrypted-param: ${text.slice(0, 300)}`);
  }
  return { encryptQueryParam };
}

async function getUploadUrl(config: BridgeConfig, to: string, image: PreparedUploadImage): Promise<{ uploadParam: string; uploadFullUrl?: string; fileKey: string }> {
  const attempts = [
    { mediaType: 1, fileSize: image.encrypted.length, noNeedThumb: true },
    { mediaType: 1, fileSize: image.raw.length, noNeedThumb: true },
    { mediaType: 1, fileSize: image.encrypted.length, noNeedThumb: false },
    { mediaType: 2, fileSize: image.encrypted.length, noNeedThumb: true }
  ];
  let lastError = "";
  for (const attempt of attempts) {
    const body = {
        base_info: {
          bot_agent: "@zk-experiment/weixin-codex-bridge/0.1.0",
          channel_version: "1.0.0"
        },
        filekey: image.fileKey,
        media_type: attempt.mediaType,
        to_user_id: to,
        rawsize: image.raw.length,
        rawfilemd5: image.md5,
        filesize: attempt.fileSize,
        no_need_thumb: attempt.noNeedThumb,
        aeskey: image.aesKeyHex
      };
    const rawText = await requestText({
      baseUrl: config.weixin.baseUrl,
      endpoint: "ilink/bot/getuploadurl",
      method: "POST",
      token: config.weixin.token,
      body
    });
    const parsed = JSON.parse(rawText) as UploadUrlResponse;
    const failed = (parsed.ret != null && parsed.ret !== 0) || (parsed.errcode != null && parsed.errcode !== 0);
    if (!failed && (parsed.upload_param || parsed.upload_full_url)) {
      return {
        uploadParam: parsed.upload_param || "",
        uploadFullUrl: parsed.upload_full_url,
        fileKey: parsed.filekey || parsed.fileid || image.fileKey
      };
    }
    lastError = `attempt=${JSON.stringify({ media_type: body.media_type, filesize: body.filesize, no_need_thumb: body.no_need_thumb })} ret=${parsed.ret} errcode=${parsed.errcode} errmsg=${parsed.errmsg ?? ""} body=${rawText.slice(0, 500)}`;
  }
  throw new Error(`getuploadurl failed: ${lastError}`);
}

type PreparedUploadImage = {
  raw: Buffer;
  encrypted: Buffer;
  md5: string;
  aesKeyHex: string;
  fileKey: string;
};

async function prepareUploadImage(imagePath: string): Promise<PreparedUploadImage> {
  const raw = await fs.promises.readFile(imagePath);
  if (!detectImageExtension(raw)) throw new Error(`Unsupported image file: ${imagePath}`);
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  return {
    raw,
    encrypted,
    md5: crypto.createHash("md5").update(raw).digest("hex"),
    aesKeyHex,
    fileKey: crypto.randomBytes(16).toString("hex")
  };
}

function splitText(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkSize) {
    let cut = rest.lastIndexOf("\n", chunkSize);
    if (cut < Math.floor(chunkSize * 0.5)) cut = chunkSize;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(msg: WeixinMessage): string {
  for (const item of msg.item_list || []) {
    if (item.type === MESSAGE_ITEM_TEXT && item.text_item?.text) {
      return item.text_item.text.trim();
    }
  }
  return "";
}

function hasNonTextItem(msg: WeixinMessage): boolean {
  return (msg.item_list || []).some((item) => item.type !== MESSAGE_ITEM_TEXT || !item.text_item);
}

function captureInboundRaw(config: BridgeConfig, msg: WeixinMessage): string {
  const dir = path.join(config.stateDir, "inbound-raw");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const peer = safeFilePart(msg.from_user_id || "unknown");
  const seq = msg.seq ?? msg.message_id ?? crypto.randomBytes(4).toString("hex");
  const file = path.join(dir, `${stamp}-${peer}-${seq}.json`);
  fs.writeFileSync(file, `${JSON.stringify(msg, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._@-]/g, "-").slice(0, 120) || "unknown";
}

export async function downloadImagesFromMessage(config: BridgeConfig, msg: WeixinMessage): Promise<{ images: InboundImage[]; errors: string[] }> {
  const images: InboundImage[] = [];
  const errors: string[] = [];
  for (const item of msg.item_list || []) {
    if (!item.image_item?.media?.full_url || !item.image_item.aeskey) continue;
    try {
      const image = await downloadWeixinImage(config, {
        url: item.image_item.media.full_url,
        aeskey: item.image_item.aeskey,
        peerId: msg.from_user_id || "unknown",
        messageId: String(msg.message_id || msg.seq || item.msg_id || Date.now()),
        width: item.image_item.thumb_width,
        height: item.image_item.thumb_height,
        size: item.image_item.hd_size || item.image_item.mid_size
      });
      images.push(image);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { images, errors };
}

async function downloadWeixinImage(config: BridgeConfig, params: {
  url: string;
  aeskey: string;
  peerId: string;
  messageId: string;
  width?: number;
  height?: number;
  size?: number;
}): Promise<InboundImage> {
  const encrypted = await requestBuffer(params.url, 45_000);
  const decrypted = decryptWeixinImage(encrypted, params.aeskey);
  const ext = detectImageExtension(decrypted);
  if (!ext) {
    throw new Error("downloaded image could not be decrypted into a supported image format");
  }
  const dir = path.join(config.stateDir, "inbound-media");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${Date.now()}-${safeFilePart(params.peerId)}-${safeFilePart(params.messageId)}.${ext}`);
  fs.writeFileSync(file, decrypted, { mode: 0o600 });
  return {
    path: file,
    sourceUrl: params.url,
    width: params.width,
    height: params.height,
    size: params.size
  };
}

async function requestBuffer(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${await res.text().catch(() => "")}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

function decryptWeixinImage(encrypted: Buffer, aeskey: string): Buffer {
  const candidates: Array<{ algorithm: string; key: Buffer }> = [];
  const hexKey = Buffer.from(aeskey, "hex");
  if (hexKey.length === 16) candidates.push({ algorithm: "aes-128-ecb", key: hexKey });
  const utf8Key = Buffer.from(aeskey, "utf8");
  if (utf8Key.length === 32) candidates.push({ algorithm: "aes-256-ecb", key: utf8Key });
  if (utf8Key.length >= 16) candidates.push({ algorithm: "aes-128-ecb", key: utf8Key.subarray(0, 16) });

  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv(candidate.algorithm, candidate.key, null);
      decipher.setAutoPadding(false);
      const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const unpadded = stripPkcs7(out);
      if (detectImageExtension(unpadded)) return unpadded;
      if (detectImageExtension(out)) return out;
    } catch {
      // Try the next commonly observed Weixin CDN key form.
    }
  }
  if (detectImageExtension(encrypted)) return encrypted;
  throw new Error("unable to decrypt Weixin image");
}

function stripPkcs7(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  const pad = buffer[buffer.length - 1];
  if (pad <= 0 || pad > 16 || pad > buffer.length) return buffer;
  for (let index = buffer.length - pad; index < buffer.length; index += 1) {
    if (buffer[index] !== pad) return buffer;
  }
  return buffer.subarray(0, buffer.length - pad);
}

function detectImageExtension(buffer: Buffer): "jpg" | "png" | "gif" | "webp" | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) return "gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}
