import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BridgeConfig, CodexThread, CodexTurnImage, CodexTurnResult, ModelProviderCapabilities } from "./types.js";

const execFileAsync = promisify(execFile);

export class CodexCliAdapter {
  constructor(private readonly config: BridgeConfig) {}

  async initialize(): Promise<void> {}

  stop(): void {}

  async listThreads(_limit = 10): Promise<CodexThread[]> {
    return [];
  }

  async readModelProviderCapabilities(): Promise<ModelProviderCapabilities> {
    return {
      imageGeneration: false,
      namespaceTools: false,
      webSearch: false
    };
  }

  async startThread(): Promise<string> {
    return `cli-${Date.now()}`;
  }

  async sendTurn(threadId: string, text: string, images: CodexTurnImage[] = []): Promise<CodexTurnResult> {
    const input = images.length > 0
      ? `${text}\n\nAttached image paths:\n${images.map((image) => image.path).join("\n")}`
      : text;
    const { stdout, stderr } = await execFileAsync(this.config.codexBin, [
      "exec",
      "-C",
      this.config.defaultCwd,
      input
    ], {
      timeout: 20 * 60_000,
      maxBuffer: 1024 * 1024 * 5
    });
    return {
      threadId,
      text: (stdout || stderr || "Codex CLI turn completed.").trim()
    };
  }

  async interrupt(_threadId?: string): Promise<void> {}

  async resolveApproval(_shortId?: string, _decision?: string): Promise<boolean> {
    return false;
  }

  listPendingApprovals(): [] {
    return [];
  }
}
