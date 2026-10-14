import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BridgeConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

function defaultStateDir(): string {
  if (process.env.CODEX_WEIXIN_STATE_DIR) return process.env.CODEX_WEIXIN_STATE_DIR;
  if (process.env.CODEX_WEIXIN_INSTANCE) {
    return path.join(os.homedir(), ".weixin-codex", "instances", safeInstanceName(process.env.CODEX_WEIXIN_INSTANCE));
  }
  return path.join(os.homedir(), ".weixin-codex");
}

function safeInstanceName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "default";
}

export function configPath(stateDir = defaultStateDir()): string {
  return path.join(stateDir, "config.json");
}

export function loadConfig(): BridgeConfig {
  const stateDir = defaultStateDir();
  const file = configPath(stateDir);
  const defaults: BridgeConfig = {
    stateDir,
    logFile: path.join(stateDir, "daemon.log"),
    pidFile: path.join(stateDir, "daemon.pid"),
    adapter: "app-server",
    codexBin: process.env.CODEX_BIN || "codex",
    defaultCwd: process.cwd(),
    approvalPolicy: "on-request",
    weixin: {
      baseUrl: DEFAULT_BASE_URL,
      botType: "3"
    },
    security: {
      allowFrom: [],
      adminPeers: [],
      allowedCwds: [],
      allowStopFromWeixin: false
    },
    desktopIndex: {
      autoRegister: true,
      titlePrefix: "Weixin Codex"
    },
    desktopMirror: {
      enabled: true,
      pollIntervalMs: 3_000
    },
    sessions: {},
    threadBindings: {}
  };

  if (!fs.existsSync(file)) {
    defaults.security.allowedCwds = [defaults.defaultCwd];
    return defaults;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BridgeConfig>;
  const sessions = { ...defaults.sessions, ...parsed.sessions };
  const threadBindings = { ...defaults.threadBindings, ...parsed.threadBindings };
  for (const session of Object.values(sessions)) {
    if (session.threadId && !threadBindings[session.threadId]) {
      threadBindings[session.threadId] = {
        peerId: session.peerId,
        updatedAt: session.updatedAt
      };
    }
  }
  const merged: BridgeConfig = {
    ...defaults,
    ...parsed,
    weixin: { ...defaults.weixin, ...parsed.weixin },
    security: { ...defaults.security, ...parsed.security },
    desktopIndex: { ...defaults.desktopIndex, ...parsed.desktopIndex },
    desktopMirror: { ...defaults.desktopMirror, ...parsed.desktopMirror },
    sessions,
    threadBindings
  };
  if (merged.security.allowedCwds.length === 0) {
    merged.security.allowedCwds = [merged.defaultCwd];
  }
  return merged;
}

export function saveConfig(config: BridgeConfig): void {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const file = configPath(config.stateDir);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temporary, file);
}

export function updateConfig(mutator: (config: BridgeConfig) => void): BridgeConfig {
  const config = loadConfig();
  mutator(config);
  saveConfig(config);
  return config;
}
