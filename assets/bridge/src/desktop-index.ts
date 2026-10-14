import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadConfig } from "./config.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";

type DesktopGlobalState = Record<string, unknown>;

export type DesktopIndexStatus = {
  threadId: string | null;
  indexed: boolean;
  jsonIndexed: boolean;
  appStateIndexed: boolean;
  pinned: boolean;
  appServerTitleRefreshed?: boolean;
  appStateTouched?: boolean;
  globalStatePath: string;
  appStatePath: string;
  sessionPath: string | null;
  cwd: string | null;
  title: string | null;
  outputDir: string | null;
  backupPath?: string;
};

export type DesktopIndexArgs = {
  threadId?: string;
  peerId?: string;
  title?: string;
  skipAppServerRefresh?: boolean;
};

type SessionMeta = {
  id?: string;
  cwd?: string;
  title?: string;
  instructions?: string;
};

const PROJECTLESS_THREAD_IDS = "projectless-thread-ids";
const PINNED_THREAD_IDS = "pinned-thread-ids";
const THREAD_WORKSPACE_ROOT_HINTS = "thread-workspace-root-hints";
const THREAD_PROJECTLESS_OUTPUT_DIRECTORIES = "thread-projectless-output-directories";
const ELECTRON_PERSISTED_ATOM_STATE = "electron-persisted-atom-state";

export async function desktopIndexStatus(args: DesktopIndexArgs = {}): Promise<DesktopIndexStatus> {
  const threadId = resolveThreadId(args);
  const paths = codexPaths();
  const state = readGlobalState(paths.globalStatePath);
  const session = threadId ? await findSession(threadId, paths.sessionsDir) : null;
  return buildStatus(threadId, state, paths.globalStatePath, paths.appStatePath, session);
}

export async function addDesktopIndex(args: DesktopIndexArgs = {}): Promise<DesktopIndexStatus> {
  const threadId = resolveThreadId(args);
  if (!threadId) throw new Error("Usage: codex-weixin desktop-index add [thread-id] [--peer <weixin-user-id>]");

  const paths = codexPaths();
  const state = readGlobalState(paths.globalStatePath);
  const session = await findSession(threadId, paths.sessionsDir);
  const cwd = session?.meta.cwd || session?.cwd || process.cwd();
  const outputDir = path.join(cwd, "outputs");

  const projectless = ensureStringArray(state, PROJECTLESS_THREAD_IDS);
  moveToFront(projectless, threadId);
  const pinned = ensureStringArray(state, PINNED_THREAD_IDS);
  moveToFront(pinned, threadId);

  ensureRecord(state, THREAD_WORKSPACE_ROOT_HINTS)[threadId] = cwd;
  ensureRecord(state, THREAD_PROJECTLESS_OUTPUT_DIRECTORIES)[threadId] = outputDir;

  const atomState = ensureRecord(state, ELECTRON_PERSISTED_ATOM_STATE);
  const promptHistory = ensureRecord(atomState, "prompt-history");
  if (!Array.isArray(promptHistory[threadId])) {
    promptHistory[threadId] = [session?.title || "Weixin Codex session"];
  }

  const title = args.title || session?.title || "Weixin Codex session";
  const preview = args.title || session?.title || title;
  const appServerTitleRefreshed = args.skipAppServerRefresh
    ? false
    : await refreshThreadTitleViaAppServer(threadId, title);
  const latestState = readGlobalState(paths.globalStatePath);
  mergeDesktopState(latestState, state);
  const backupPath = writeGlobalStateWithBackup(paths.globalStatePath, latestState);
  const appStateTouched = touchAppStateThread(paths.appStatePath, {
    threadId,
    title,
    preview,
    cwd
  });
  return {
    ...buildStatus(threadId, latestState, paths.globalStatePath, paths.appStatePath, session),
    appServerTitleRefreshed,
    appStateTouched,
    backupPath
  };
}

export async function removeDesktopIndex(args: DesktopIndexArgs = {}): Promise<DesktopIndexStatus> {
  const threadId = resolveThreadId(args);
  if (!threadId) throw new Error("Usage: codex-weixin desktop-index remove [thread-id] [--peer <weixin-user-id>]");

  const paths = codexPaths();
  const state = readGlobalState(paths.globalStatePath);
  const session = await findSession(threadId, paths.sessionsDir);

  const projectless = ensureStringArray(state, PROJECTLESS_THREAD_IDS);
  state[PROJECTLESS_THREAD_IDS] = projectless.filter((id) => id !== threadId);
  const pinned = ensureStringArray(state, PINNED_THREAD_IDS);
  state[PINNED_THREAD_IDS] = pinned.filter((id) => id !== threadId);
  delete ensureRecord(state, THREAD_WORKSPACE_ROOT_HINTS)[threadId];
  delete ensureRecord(state, THREAD_PROJECTLESS_OUTPUT_DIRECTORIES)[threadId];

  const atomState = ensureRecord(state, ELECTRON_PERSISTED_ATOM_STATE);
  const promptHistory = ensureRecord(atomState, "prompt-history");
  delete promptHistory[threadId];

  const backupPath = writeGlobalStateWithBackup(paths.globalStatePath, state);
  return {
    ...buildStatus(threadId, state, paths.globalStatePath, paths.appStatePath, session),
    backupPath
  };
}

function resolveThreadId(args: DesktopIndexArgs): string | null {
  if (args.threadId) return args.threadId;
  const config = loadConfig();
  if (args.peerId) return config.sessions[args.peerId]?.threadId || null;

  const sessions = Object.values(config.sessions)
    .filter((session) => session.threadId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions[0]?.threadId || null;
}

async function refreshThreadTitleViaAppServer(threadId: string, title: string): Promise<boolean> {
  const config = loadConfig();
  const codex = new CodexAppServerAdapter(config);
  try {
    await codex.initialize();
    await codex.setThreadName(threadId, title);
    return true;
  } catch {
    return false;
  } finally {
    codex.stop();
  }
}

function codexPaths(): { codexHome: string; globalStatePath: string; appStatePath: string; sessionsDir: string } {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    codexHome,
    globalStatePath: path.join(codexHome, ".codex-global-state.json"),
    appStatePath: path.join(codexHome, "state_5.sqlite"),
    sessionsDir: path.join(codexHome, "sessions")
  };
}

function readGlobalState(file: string): DesktopGlobalState {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as DesktopGlobalState;
}

function writeGlobalStateWithBackup(file: string, state: DesktopGlobalState): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const backupPath = `${file}.weixin-codex-${timestamp()}.bak`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backupPath);
  else fs.writeFileSync(backupPath, "{}\n", { encoding: "utf8", mode: 0o600 });
  const tempPath = `${file}.weixin-codex-${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, file);
  return backupPath;
}

function mergeDesktopState(target: DesktopGlobalState, source: DesktopGlobalState): void {
  for (const key of [PROJECTLESS_THREAD_IDS, PINNED_THREAD_IDS]) {
    for (const value of readStringArray(source, key).reverse()) {
      moveToFront(ensureStringArray(target, key), value);
    }
  }
  for (const key of [THREAD_WORKSPACE_ROOT_HINTS, THREAD_PROJECTLESS_OUTPUT_DIRECTORIES]) {
    Object.assign(ensureRecord(target, key), readRecord(source, key));
  }
  const sourceAtom = readRecord(source, ELECTRON_PERSISTED_ATOM_STATE);
  const targetAtom = ensureRecord(target, ELECTRON_PERSISTED_ATOM_STATE);
  const sourcePromptHistory = readRecord(sourceAtom, "prompt-history");
  if (Object.keys(sourcePromptHistory).length > 0) {
    Object.assign(ensureRecord(targetAtom, "prompt-history"), sourcePromptHistory);
  }
}

function buildStatus(
  threadId: string | null,
  state: DesktopGlobalState,
  globalStatePath: string,
  appStatePath: string,
  session: SessionInfo | null
): DesktopIndexStatus {
  const hints = readRecord(state, THREAD_WORKSPACE_ROOT_HINTS);
  const outputDirs = readRecord(state, THREAD_PROJECTLESS_OUTPUT_DIRECTORIES);
  const projectless = readStringArray(state, PROJECTLESS_THREAD_IDS);
  const pinned = readStringArray(state, PINNED_THREAD_IDS);
  const pinnedThread = Boolean(threadId && pinned.includes(threadId));
  const jsonIndexed = Boolean(threadId && (pinnedThread || projectless.includes(threadId) || hints[threadId] || outputDirs[threadId]));
  const appState = threadId ? readAppStateThread(appStatePath, threadId) : null;
  return {
    threadId,
    indexed: jsonIndexed || Boolean(appState),
    jsonIndexed,
    appStateIndexed: Boolean(appState),
    pinned: pinnedThread,
    globalStatePath,
    appStatePath,
    sessionPath: session?.path || null,
    cwd: session?.meta.cwd || session?.cwd || appState?.cwd || (threadId ? stringValue(hints[threadId]) : null),
    title: appState?.title || session?.title || null,
    outputDir: threadId ? stringValue(outputDirs[threadId]) : null
  };
}

function readAppStateThread(appStatePath: string, threadId: string): { title: string | null; cwd: string | null } | null {
  if (!fs.existsSync(appStatePath)) return null;
  const result = spawnSync("sqlite3", [
    "-json",
    appStatePath,
    `select title, cwd from threads where id=${sqlString(threadId)} limit 1;`
  ], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;
    return { title: stringValue(row.title), cwd: stringValue(row.cwd) };
  } catch {
    return null;
  }
}

function touchAppStateThread(appStatePath: string, args: {
  threadId: string;
  title: string;
  preview: string;
  cwd: string;
}): boolean {
  if (!fs.existsSync(appStatePath)) return false;
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const result = spawnSync("sqlite3", [
    appStatePath,
    [
      "update threads set",
      `updated_at=${nowSec},`,
      `updated_at_ms=${nowMs},`,
      `title=${sqlString(args.title)},`,
      `preview=${sqlString(args.preview)},`,
      `cwd=coalesce(nullif(cwd, ''), ${sqlString(args.cwd)})`,
      `where id=${sqlString(args.threadId)};`
    ].join(" ")
  ], { encoding: "utf8" });
  return result.status === 0;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

type SessionInfo = {
  path: string;
  meta: SessionMeta;
  cwd: string | null;
  title: string | null;
};

async function findSession(threadId: string, sessionsDir: string): Promise<SessionInfo | null> {
  if (!fs.existsSync(sessionsDir)) return null;
  const files = await walkFiles(sessionsDir);
  const candidate = files.find((file) => path.basename(file).includes(threadId) && file.endsWith(".jsonl"));
  if (!candidate) return null;
  const lines = fs.readFileSync(candidate, "utf8").split("\n").filter(Boolean);
  const meta = readSessionMeta(lines);
  return {
    path: candidate,
    meta,
    cwd: meta.cwd || readFirstString(lines, ["cwd", "workdir"]),
    title: meta.title || readFirstString(lines, ["title", "summary"])
  };
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(fullPath));
    else if (entry.isFile()) out.push(fullPath);
  }
  return out;
}

function readSessionMeta(lines: string[]): SessionMeta {
  for (const line of lines.slice(0, 20)) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    const record = parsed as Record<string, unknown>;
    const maybeMeta = record.type === "session_meta" ? record : readRecord(record, "session_meta");
    if (Object.keys(maybeMeta).length === 0) continue;
    return {
      id: stringValue(maybeMeta.id) || undefined,
      cwd: stringValue(maybeMeta.cwd) || undefined,
      title: stringValue(maybeMeta.title) || undefined,
      instructions: stringValue(maybeMeta.instructions) || undefined
    };
  }
  return {};
}

function readFirstString(lines: string[], keys: string[]): string | null {
  for (const line of lines.slice(0, 80)) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    const found = findString(parsed, keys, 0);
    if (found) return found;
  }
  return null;
}

function findString(value: unknown, keys: string[], depth: number): string | null {
  if (depth > 4 || !value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = stringValue(record[key]);
    if (direct) return direct;
  }
  for (const child of Object.values(record)) {
    const found = findString(child, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function ensureStringArray(record: DesktopGlobalState, key: string): string[] {
  const existing = record[key];
  const normalized = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : [];
  record[key] = normalized;
  return normalized;
}

function moveToFront(values: string[], value: string): void {
  const existingIndex = values.indexOf(value);
  if (existingIndex >= 0) values.splice(existingIndex, 1);
  values.unshift(value);
}

function readStringArray(record: DesktopGlobalState, key: string): string[] {
  const existing = record[key];
  return Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : [];
}

function ensureRecord(record: DesktopGlobalState, key: string): Record<string, unknown> {
  const existing = record[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  record[key] = created;
  return created;
}

function readRecord(record: DesktopGlobalState, key: string): Record<string, unknown> {
  const existing = record[key];
  return existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
