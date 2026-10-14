#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig, saveConfig, updateConfig } from "./config.js";
import { BridgeDaemon } from "./daemon.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { addDesktopIndex, desktopIndexStatus, removeDesktopIndex, type DesktopIndexArgs } from "./desktop-index.js";
import { downloadImagesFromMessage, sendImages, startLogin, waitForLogin } from "./weixin.js";
import type { BridgeConfig, ModelProviderCapabilities, WeixinMessage } from "./types.js";

type Command = {
  name: string;
  args: string[];
};

async function main(): Promise<void> {
  const { name, args } = parseArgs(process.argv.slice(2));
  switch (name) {
    case "init":
      await cmdInit(args);
      break;
    case "login-weixin":
      await cmdLoginWeixin();
      break;
    case "allow":
      await cmdAllow(args[0]);
      break;
    case "disallow":
      await cmdDisallow(args[0]);
      break;
    case "admin":
      await cmdAdmin(args[0], true);
      break;
    case "unadmin":
      await cmdAdmin(args[0], false);
      break;
    case "allow-cwd":
      await cmdAllowCwd(args[0], true);
      break;
    case "disallow-cwd":
      await cmdAllowCwd(args[0], false);
      break;
    case "start":
      await cmdStart(args);
      break;
    case "run-daemon":
      await cmdRunDaemon();
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdStop().catch(() => undefined);
      await cmdStart(args);
      break;
    case "status":
      await cmdStatus();
      break;
    case "mirror-status":
      await cmdMirrorStatus();
      break;
    case "logs":
      await cmdLogs();
      break;
    case "raw-messages":
      await cmdRawMessages();
      break;
    case "download-raw-media":
      await cmdDownloadRawMedia(args[0]);
      break;
    case "send-image":
      await cmdSendImage(args);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "capabilities":
      await cmdCapabilities();
      break;
    case "desktop-index":
      await cmdDesktopIndex(args);
      break;
    case "bind-thread":
      await cmdBindThread(args);
      break;
    case "inject":
      await cmdInject(args);
      break;
    case "help":
    case "":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${name}. Try codex-weixin help.`);
  }
}

function parseArgs(argv: string[]): Command {
  const args = [...argv];
  const instanceIndex = args.indexOf("--instance");
  if (instanceIndex >= 0 && args[instanceIndex + 1]) {
    process.env.CODEX_WEIXIN_INSTANCE = args[instanceIndex + 1];
    args.splice(instanceIndex, 2);
  }
  const [name = "help", ...rest] = args;
  return { name, args: rest };
}

async function cmdInit(args: string[]): Promise<void> {
  const config = loadConfig();
  const cwdIndex = args.indexOf("--cwd");
  const adapterIndex = args.indexOf("--adapter");
  const desktopIndexIndex = args.indexOf("--desktop-index");
  if (cwdIndex >= 0 && args[cwdIndex + 1]) config.defaultCwd = path.resolve(args[cwdIndex + 1]);
  if (adapterIndex >= 0 && args[adapterIndex + 1]) {
    const adapter = args[adapterIndex + 1];
    if (adapter !== "app-server" && adapter !== "cli") throw new Error("--adapter must be app-server or cli");
    config.adapter = adapter;
  }
  if (desktopIndexIndex >= 0 && args[desktopIndexIndex + 1]) {
    const mode = args[desktopIndexIndex + 1];
    if (mode !== "auto" && mode !== "manual" && mode !== "off") {
      throw new Error("--desktop-index must be auto, manual, or off");
    }
    config.desktopIndex.autoRegister = mode === "auto";
  }
  if (!config.security.allowedCwds.includes(config.defaultCwd)) {
    config.security.allowedCwds.unshift(config.defaultCwd);
  }
  saveConfig(config);
  console.log(`Initialized ${config.stateDir}`);
}

async function cmdLoginWeixin(): Promise<void> {
  const config = loadConfig();
  const qr = await startLogin(config);
  const qrterm = await import("qrcode-terminal");
  qrterm.default.generate(qr.qrcodeUrl, { small: true });
  console.log("Scan this QR code with Weixin. Fallback URL:");
  console.log(qr.qrcodeUrl);
  const result = await waitForLogin(config, qr.qrcode);
  updateConfig((next) => {
    next.weixin.token = result.token;
    next.weixin.accountId = result.accountId;
    next.weixin.userId = result.userId;
    next.weixin.baseUrl = result.baseUrl;
    if (result.userId && !next.security.allowFrom.includes(result.userId)) {
      next.security.allowFrom.push(result.userId);
    }
  });
  console.log("Weixin login complete.");
  if (result.userId) console.log(`Allowed user: ${result.userId}`);
}

async function cmdAllow(peerId?: string): Promise<void> {
  if (!peerId) throw new Error("Usage: codex-weixin allow <weixin-user-id>");
  updateConfig((config) => {
    if (!config.security.allowFrom.includes(peerId)) config.security.allowFrom.push(peerId);
  });
  console.log(`Allowed ${peerId}`);
}

async function cmdDisallow(peerId?: string): Promise<void> {
  if (!peerId) throw new Error("Usage: codex-weixin disallow <weixin-user-id>");
  updateConfig((config) => {
    config.security.allowFrom = config.security.allowFrom.filter((id) => id !== peerId);
    config.security.adminPeers = config.security.adminPeers.filter((id) => id !== peerId);
  });
  console.log(`Disallowed ${peerId}`);
}

async function cmdAdmin(peerId: string | undefined, enabled: boolean): Promise<void> {
  if (!peerId) throw new Error(`Usage: codex-weixin ${enabled ? "admin" : "unadmin"} <weixin-user-id>`);
  updateConfig((config) => {
    if (enabled) {
      if (!config.security.allowFrom.includes(peerId)) config.security.allowFrom.push(peerId);
      if (!config.security.adminPeers.includes(peerId)) config.security.adminPeers.push(peerId);
    } else {
      config.security.adminPeers = config.security.adminPeers.filter((id) => id !== peerId);
    }
  });
  console.log(`${enabled ? "Admin enabled for" : "Admin disabled for"} ${peerId}`);
}

async function cmdAllowCwd(cwd: string | undefined, enabled: boolean): Promise<void> {
  if (!cwd) throw new Error(`Usage: codex-weixin ${enabled ? "allow-cwd" : "disallow-cwd"} <dir>`);
  const resolved = path.resolve(cwd);
  updateConfig((config) => {
    if (enabled) {
      if (!config.security.allowedCwds.includes(resolved)) config.security.allowedCwds.push(resolved);
    } else {
      config.security.allowedCwds = config.security.allowedCwds.filter((item) => path.resolve(item) !== resolved);
      if (config.security.allowedCwds.length === 0) config.security.allowedCwds.push(config.defaultCwd);
    }
  });
  console.log(`${enabled ? "Allowed cwd root" : "Removed cwd root"} ${resolved}`);
}

async function cmdStart(args: string[]): Promise<void> {
  const config = loadConfig();
  if (isRunning(config.pidFile)) {
    console.log(`Already running pid=${fs.readFileSync(config.pidFile, "utf8").trim()}`);
    return;
  }
  const foreground = args.includes("--foreground");
  if (foreground) {
    process.env.CODEX_WEIXIN_FOREGROUND = "1";
    await cmdRunDaemon();
    return;
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run-daemon"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env }
  });
  child.unref();
  fs.writeFileSync(config.pidFile, String(child.pid), "utf8");
  console.log(`Started weixin-codex bridge pid=${child.pid}`);
}

async function cmdRunDaemon(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(config.pidFile, String(process.pid), "utf8");
  try {
    await new BridgeDaemon().run();
  } finally {
    if (fs.existsSync(config.pidFile) && fs.readFileSync(config.pidFile, "utf8").trim() === String(process.pid)) {
      fs.rmSync(config.pidFile);
    }
  }
}

async function cmdStop(): Promise<void> {
  const config = loadConfig();
  if (!fs.existsSync(config.pidFile)) {
    console.log("Bridge is not running.");
    return;
  }
  const pid = Number(fs.readFileSync(config.pidFile, "utf8").trim());
  if (!pid || !isRunningPid(pid)) {
    fs.rmSync(config.pidFile, { force: true });
    console.log("Removed stale pid file.");
    return;
  }
  process.kill(pid, "SIGTERM");
  fs.rmSync(config.pidFile, { force: true });
  console.log(`Stopped weixin-codex bridge pid=${pid}`);
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const pid = fs.existsSync(config.pidFile) ? fs.readFileSync(config.pidFile, "utf8").trim() : "";
  console.log(JSON.stringify({
    running: Boolean(pid && isRunningPid(Number(pid))),
    pid: pid || null,
    adapter: config.adapter,
    stateDir: config.stateDir,
    logFile: config.logFile,
    defaultCwd: config.defaultCwd,
    desktopIndexAutoRegister: config.desktopIndex.autoRegister,
    desktopMirrorEnabled: config.desktopMirror.enabled,
    desktopMirrorBindings: Object.keys(config.threadBindings).length,
    weixinLoggedIn: Boolean(config.weixin.token),
    allowFrom: config.security.allowFrom,
    adminPeers: config.security.adminPeers,
    allowedCwds: config.security.allowedCwds
  }, null, 2));
}

async function cmdMirrorStatus(): Promise<void> {
  const config = loadConfig();
  const stateFile = path.join(config.stateDir, "desktop-mirror-state.json");
  const mirrorState = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, "utf8")) as { threads?: Record<string, { path?: string; offset?: number }> }
    : { threads: {} };
  const sessionsDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const bindings = new Map<string, string>();
  for (const [threadId, binding] of Object.entries(config.threadBindings)) {
    bindings.set(threadId, binding.peerId);
  }
  for (const session of Object.values(config.sessions)) {
    if (session.threadId) bindings.set(session.threadId, session.peerId);
  }
  console.log(JSON.stringify({
    enabled: config.desktopMirror.enabled,
    pollIntervalMs: config.desktopMirror.pollIntervalMs,
    stateFile,
    bindings: [...bindings.entries()].map(([threadId, peerId]) => {
      const session = config.sessions[peerId];
      const saved = mirrorState.threads?.[threadId];
      const file = saved?.path && fs.existsSync(saved.path)
        ? saved.path
        : fs.existsSync(sessionsDir)
          ? findSessionFile(sessionsDir, threadId)
          : null;
      const size = file && fs.existsSync(file) ? fs.statSync(file).size : null;
      const offset = saved?.offset ?? null;
      return {
        peerId,
        threadId,
        activeForPeer: session?.threadId === threadId,
        file,
        fileSize: size,
        offset,
        pendingBytes: typeof size === "number" && typeof offset === "number" ? Math.max(0, size - offset) : null,
        hasLastContextToken: Boolean(session?.lastContextToken)
      };
    })
  }, null, 2));
}

async function cmdLogs(): Promise<void> {
  const config = loadConfig();
  if (!fs.existsSync(config.logFile)) {
    console.log(`No log file yet: ${config.logFile}`);
    return;
  }
  const lines = fs.readFileSync(config.logFile, "utf8").trim().split("\n").slice(-80);
  console.log(lines.join("\n"));
}

async function cmdRawMessages(): Promise<void> {
  const config = loadConfig();
  const dir = path.join(config.stateDir, "inbound-raw");
  if (!fs.existsSync(dir)) {
    console.log(`No raw messages yet: ${dir}`);
    return;
  }
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, 20);
  console.log(JSON.stringify(files.map((file) => {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { from_user_id?: string; item_list?: Array<{ type?: number; [key: string]: unknown }> };
    return {
      file,
      from: raw.from_user_id,
      itemTypes: (raw.item_list || []).map((item) => item.type ?? null),
      itemKeys: (raw.item_list || []).map((item) => Object.keys(item))
    };
  }), null, 2));
}

async function cmdDownloadRawMedia(rawFile?: string): Promise<void> {
  if (!rawFile) throw new Error("Usage: codex-weixin download-raw-media <raw-json-file>");
  const config = loadConfig();
  const raw = JSON.parse(fs.readFileSync(path.resolve(rawFile), "utf8")) as WeixinMessage;
  const result = await downloadImagesFromMessage(config, raw);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSendImage(args: string[]): Promise<void> {
  const config = loadConfig();
  const peerIndex = args.indexOf("--peer");
  const peerId = peerIndex >= 0 ? args[peerIndex + 1] : config.security.allowFrom[0];
  const imagePaths = args.filter((arg, index) => arg !== "--peer" && index !== peerIndex + 1);
  if (!peerId || imagePaths.length === 0) {
    throw new Error("Usage: codex-weixin send-image [--peer <weixin-user-id>] <image-path>...");
  }
  await sendImages(config, peerId, imagePaths.map((imagePath) => path.resolve(imagePath)));
  console.log(JSON.stringify({ sent: imagePaths.length, peerId }, null, 2));
}

async function cmdDoctor(): Promise<void> {
  const config = loadConfig();
  const checks = [
    ["state dir", fs.existsSync(config.stateDir) ? "ok" : "missing"],
    ["weixin token", config.weixin.token ? "ok" : "missing: run codex-weixin login-weixin"],
    ["allowlist", config.security.allowFrom.length > 0 ? "ok" : "empty: run codex-weixin allow <id>"],
    ["allowed cwd roots", config.security.allowedCwds.length > 0 ? config.security.allowedCwds.join(", ") : "empty"],
    ["codex bin", await canRun(config.codexBin, ["--version"])],
    ["adapter", config.adapter],
    ["codex capabilities", await capabilityCheck(config)]
  ];
  for (const [label, value] of checks) console.log(`${label}: ${value}`);
}

async function cmdCapabilities(): Promise<void> {
  const config = loadConfig();
  const capabilities = await readCapabilities(config);
  console.log(JSON.stringify(capabilities, null, 2));
}

async function cmdDesktopIndex(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  const parsed = parseDesktopIndexArgs(rest);
  switch (subcommand) {
    case "status":
      console.log(JSON.stringify(await desktopIndexStatus(parsed), null, 2));
      break;
    case "add":
      {
        const status = await addDesktopIndex(parsed);
        if (parsed.peerId && status.threadId) bindThread(status.threadId, parsed.peerId);
        console.log(JSON.stringify(status, null, 2));
      }
      break;
    case "remove":
      console.log(JSON.stringify(await removeDesktopIndex(parsed), null, 2));
      break;
    case "auto":
      await cmdDesktopIndexAuto(rest);
      break;
    default:
      throw new Error("Usage: codex-weixin desktop-index status|add|remove|auto [thread-id] [--peer <weixin-user-id>]");
  }
}

async function cmdBindThread(args: string[]): Promise<void> {
  const parsed = parseDesktopIndexArgs(args);
  const threadId = parsed.threadId;
  if (!threadId) throw new Error("Usage: codex-weixin bind-thread <thread-id> [--peer <weixin-user-id>] [--title <title>]");
  const config = loadConfig();
  const peerId = parsed.peerId || Object.values(config.sessions).find((session) => session.peerId)?.peerId || config.security.allowFrom[0];
  if (!peerId) throw new Error("No peer selected. Use --peer <weixin-user-id>.");
  bindThread(threadId, peerId);
  const status = await addDesktopIndex({
    threadId,
    title: parsed.title,
    skipAppServerRefresh: parsed.skipAppServerRefresh
  });
  console.log(JSON.stringify({
    threadId,
    peerId,
    desktopIndex: status
  }, null, 2));
}

function bindThread(threadId: string, peerId: string): void {
  updateConfig((config) => {
    config.threadBindings[threadId] = {
      peerId,
      updatedAt: Date.now()
    };
  });
}

async function cmdDesktopIndexAuto(args: string[]): Promise<void> {
  const mode = args[0];
  if (mode !== "on" && mode !== "off") {
    throw new Error("Usage: codex-weixin desktop-index auto on|off");
  }
  const config = updateConfig((next) => {
    next.desktopIndex.autoRegister = mode === "on";
  });
  console.log(JSON.stringify({
    desktopIndexAutoRegister: config.desktopIndex.autoRegister,
    note: config.desktopIndex.autoRegister
      ? "New Weixin-created Codex threads will be registered in Codex Desktop automatically."
      : "New Weixin-created Codex threads will require manual desktop-index add."
  }, null, 2));
}

async function cmdInject(args: string[]): Promise<void> {
  const config = loadConfig();
  const textIndex = args.indexOf("--text");
  const peerIndex = args.indexOf("--peer");
  const text = textIndex >= 0 ? args[textIndex + 1] : args.join(" ").trim();
  const peerId = peerIndex >= 0 ? args[peerIndex + 1] : undefined;
  if (!text) throw new Error("Usage: codex-weixin inject [--peer <weixin-user-id>] --text <text>");
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(config.stateDir, "inject.ndjson"), `${JSON.stringify({ peerId, text, createdAt: Date.now() })}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  console.log("Injected message queued.");
}

function parseDesktopIndexArgs(args: string[]): DesktopIndexArgs {
  const parsed: DesktopIndexArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--peer") {
      parsed.peerId = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--title") {
      parsed.title = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--skip-app-server-refresh") {
      parsed.skipAppServerRefresh = true;
      continue;
    }
    if (!parsed.threadId) parsed.threadId = arg;
  }
  return parsed;
}

function isRunning(pidFile: string): boolean {
  if (!fs.existsSync(pidFile)) return false;
  return isRunningPid(Number(fs.readFileSync(pidFile, "utf8").trim()));
}

function isRunningPid(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function canRun(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0 ? "ok" : `exit ${code}`));
    child.on("error", (err) => resolve(`error: ${err.message}`));
  });
}

async function capabilityCheck(config: BridgeConfig): Promise<string> {
  try {
    const capabilities = await readCapabilities(config);
    return `imageGeneration=${capabilities.imageGeneration} namespaceTools=${capabilities.namespaceTools} webSearch=${capabilities.webSearch}`;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function readCapabilities(config: BridgeConfig): Promise<ModelProviderCapabilities> {
  if (config.adapter !== "app-server") {
    return {
      imageGeneration: false,
      namespaceTools: false,
      webSearch: false
    };
  }
  const codex = new CodexAppServerAdapter(config);
  try {
    await codex.initialize();
    return await codex.readModelProviderCapabilities();
  } finally {
    codex.stop();
  }
}

function printHelp(): void {
  console.log(`codex-weixin

Usage:
  codex-weixin [--instance <name>] <command>
  codex-weixin init [--cwd <dir>] [--adapter app-server|cli] [--desktop-index auto|manual|off]
  codex-weixin login-weixin
  codex-weixin allow <weixin-user-id>
  codex-weixin disallow <weixin-user-id>
  codex-weixin admin <weixin-user-id>
  codex-weixin unadmin <weixin-user-id>
  codex-weixin allow-cwd <dir>
  codex-weixin disallow-cwd <dir>
  codex-weixin start [--foreground]
  codex-weixin stop
  codex-weixin restart
  codex-weixin status
  codex-weixin mirror-status
  codex-weixin logs
  codex-weixin raw-messages
  codex-weixin download-raw-media <raw-json-file>
  codex-weixin send-image [--peer <weixin-user-id>] <image-path>...
  codex-weixin doctor
  codex-weixin capabilities
  codex-weixin desktop-index status [thread-id] [--peer <weixin-user-id>]
  codex-weixin desktop-index add [thread-id] [--peer <weixin-user-id>] [--title <title>]
  codex-weixin desktop-index remove [thread-id] [--peer <weixin-user-id>]
  codex-weixin desktop-index auto on|off
  codex-weixin bind-thread <thread-id> [--peer <weixin-user-id>] [--title <title>]
  codex-weixin inject [--peer <weixin-user-id>] --text <text>

The bridge never starts automatically unless you install your own service wrapper.
Use 'codex-weixin stop' to close the local daemon.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

function findSessionFile(dir: string, threadId: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSessionFile(fullPath, threadId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
      return fullPath;
    }
  }
  return null;
}
