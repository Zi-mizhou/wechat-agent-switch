import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { BridgeConfig, CodexThread, CodexTurnImage, CodexTurnResult, ModelProviderCapabilities } from "./types.js";

type Session = { id?: string; cwd: string; title?: string; updatedAt: number };
export class DeepSeekAdapter {
  private sessions: Record<string, Session> = {};
  private active = new Map<string, ChildProcess>();
  private closeProxy?: () => void;
  constructor(private config: BridgeConfig) {
    const file = this.indexPath();
    if (fs.existsSync(file)) this.sessions = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  private indexPath(): string { return path.join(this.config.stateDir, "deepseek-sessions.json"); }
  private persist(): void {
    fs.mkdirSync(this.config.stateDir, { recursive: true });
    fs.writeFileSync(this.indexPath(), JSON.stringify(this.sessions, null, 2), { mode: 0o600 });
  }
  async initialize(): Promise<void> {
    if (!this.config.dsh || !fs.existsSync(this.config.dsh.executable) || !fs.existsSync(this.config.dsh.entry)) throw new Error("DeepSeek Harness installation is unavailable");
    const proxy = this.config.dsh.workbuddyProxy;
    if (proxy) {
      const module = await import(pathToFileURL(proxy.script).href);
      const started = await module.startProxy({ ...proxy, stateDir: this.config.stateDir });
      this.closeProxy = started.close;
    }
  }
  async readModelProviderCapabilities(): Promise<ModelProviderCapabilities> { return { imageGeneration: false, namespaceTools: false, webSearch: false }; }
  async startThread(cwd = this.config.defaultCwd): Promise<string> {
    const id = `dsh-${randomUUID()}`;
    this.sessions[id] = { cwd, updatedAt: Date.now() };
    this.persist();
    return id;
  }
  async listThreads(limit = 10): Promise<CodexThread[]> {
    return Object.entries(this.sessions).sort((a,b) => b[1].updatedAt - a[1].updatedAt).slice(0,limit).map(([id,s]) => ({id,cwd:s.cwd,title:s.title,updatedAt:s.updatedAt}));
  }
  async sendTurn(threadId: string, text: string, images: CodexTurnImage[] = []): Promise<CodexTurnResult> {
    const session = this.sessions[threadId];
    if (!session) throw new Error("找不到此 DeepSeek 会话，请发送 /new 新建。");
    const settings = this.config.dsh!;
    const args = ["--expose-internals", settings.entry, "--profile", settings.profile];
    if (settings.patch) args.push("--patch",settings.patch);
    args.push("--json");
    if (session.id) args.push("--session-id", session.id);
    args.push("-");
    const child = spawn(settings.executable, args, {cwd:session.cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:"1",...(settings.workbuddyProxy ? { WECHAT_WORKBUDDY_RELAY_KEY: settings.workbuddyProxy.token } : {})},windowsHide:true,stdio:["pipe","pipe","pipe"]});
    this.active.set(threadId, child);
    let buffer = "", answer: string | undefined, runFailed = false;
    const consume = (line: string) => {
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "session" && typeof event.sessionId === "string") { session.id = event.sessionId; this.persist(); }
      if (event.type === "final" && typeof event.text === "string") answer = event.text;
      if (event.type === "error" || (event.type === "status" && event.phase === "turn_end" && event.reason?.kind !== "completed")) runFailed = true;
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) { runFailed = true; child.kill(); return; }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0,index)); buffer = buffer.slice(index+1); }
    });
    child.stderr!.resume();
    child.stdin!.on("error", () => undefined);
    const task = images.length ? `${text}\n\n用户上传的图片保存在以下本地路径，可用可用的图片工具读取：\n${images.map(i=>i.path).join("\n")}` : text;
    child.stdin!.end(task);
    const timer = setTimeout(() => { runFailed = true; void this.interrupt(threadId); },20*60_000);
    try {
      const code = await new Promise<number | null>((resolve,reject) => { child.on("error",reject); child.on("close",resolve); });
      if (buffer.trim()) consume(buffer);
      if (code !== 0 || runFailed || !answer?.trim()) throw new Error("DeepSeek 任务失败或已中止。若操作需要交互审批，请在桌面 Harness 中处理；可发 /new 重试新会话。");
      session.title ||= text.slice(0,60);
      session.updatedAt = Date.now(); this.persist();
      return { threadId, text: answer };
    } finally { clearTimeout(timer); this.active.delete(threadId); }
  }
  async interrupt(threadId: string): Promise<void> {
    const child = this.active.get(threadId);
    if (!child?.pid) return;
    if (process.platform === "win32") spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
    else child.kill("SIGTERM");
  }
  stop(): void { for (const id of this.active.keys()) void this.interrupt(id); this.closeProxy?.(); }
  listPendingApprovals(): [] { return []; }
  async resolveApproval(_id: string, _decision: string): Promise<boolean> { return false; }
}
