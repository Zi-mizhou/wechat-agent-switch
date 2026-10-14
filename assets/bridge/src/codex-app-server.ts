import { EventEmitter } from "node:events";

import { JsonRpcProcess, type JsonRpcMessage } from "./jsonrpc.js";
import type { BridgeConfig, CodexOutputImage, CodexThread, CodexTurnImage, CodexTurnResult, ModelProviderCapabilities, PendingApproval, ModelSelection, ModelOption } from "./types.js";

type ThreadResponse = { thread?: { id?: string }; id?: string };
type ThreadListResponse = { data?: Array<Record<string, unknown>> };
type TurnStartResponse = { turn?: { id?: string }; turnId?: string; id?: string };

export class CodexAppServerAdapter extends EventEmitter {
  private readonly rpc: JsonRpcProcess;
  private pendingApprovals = new Map<string, PendingApproval>();
  private approvalSeq = 1;
  private activeTurnIds = new Map<string, string>();

  constructor(private readonly config: BridgeConfig) {
    super();
    this.rpc = new JsonRpcProcess(config.codexBin, ["app-server", "--stdio"], {
      cwd: config.defaultCwd
    });
    this.rpc.on("notification", (msg) => this.emit("notification", msg));
    this.rpc.on("serverRequest", (msg) => this.handleServerRequest(msg as JsonRpcMessage));
    this.rpc.on("stderr", (chunk) => this.emit("stderr", chunk));
    this.rpc.on("request", (msg) => this.emit("rpcRequest", msg));
    this.rpc.on("response", (msg) => this.emit("rpcResponse", msg));
    this.rpc.on("exit", (info) => this.emit("exit", info));
  }

  async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: { name: "weixin-codex-bridge", version: "0.1.0" },
      protocolVersion: "2"
    }, 30_000);
  }

  stop(): void {
    this.rpc.stop();
  }

  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()];
  }

  async resolveApproval(shortId: string, decision: "accept" | "decline" | "cancel" | "acceptForSession"): Promise<boolean> {
    const item = this.pendingApprovals.get(shortId);
    if (!item) return false;
    this.pendingApprovals.delete(shortId);
    if (item.method === "item/permissions/requestApproval") {
      this.rpc.respond(item.requestId, {
        permissions: decision === "accept" || decision === "acceptForSession"
          ? { fullAccess: {} }
          : { readOnly: {} },
        scope: "turn"
      });
    } else {
      this.rpc.respond(item.requestId, { decision });
    }
    return true;
  }

  async listThreads(limit = 10): Promise<CodexThread[]> {
    const res = await this.rpc.request<ThreadListResponse>("thread/list", {
      limit,
      sortBy: "updatedAt",
      sortDirection: "desc"
    }, 30_000);
    return (res.data || []).map((thread) => ({
      id: String(thread.id || ""),
      title: (thread.title as string | null | undefined) ?? null,
      cwd: (thread.cwd as string | null | undefined) ?? null,
      status: thread.status,
      updatedAt: (thread.updatedAt as number | null | undefined) ?? null
    })).filter((thread) => thread.id);
  }

  async readModelProviderCapabilities(): Promise<ModelProviderCapabilities> {
    return await this.rpc.request<ModelProviderCapabilities>("modelProvider/capabilities/read", {}, 30_000);
  }

  async listModels():Promise<ModelOption[]> {
    const models:ModelOption[]=[];let cursor:string|undefined;
    do{
      const response=await this.rpc.request<{data?:any[];nextCursor?:string}>("model/list",{limit:100,...(cursor?{cursor}:{})},30_000);
      for(const m of response.data||[])if(typeof m.model==='string')models.push({id:m.model,label:m.displayName||m.model,efforts:(m.supportedReasoningEfforts||[]).map((e:any)=>e.reasoningEffort)});
      cursor=response.nextCursor;
    }while(cursor&&models.length<500);
    return models;
  }

  async startThread(cwd?: string, selection:ModelSelection={}): Promise<string> {
    this.emit("debug", `thread/start cwd=${cwd || this.config.defaultCwd}`);
    const res = await this.rpc.request<ThreadResponse>("thread/start", {
      cwd: cwd || this.config.defaultCwd,
      ...((selection.model||this.config.codexModel) ? { model: selection.model||this.config.codexModel } : {}),
      approvalPolicy: this.config.approvalPolicy,
      approvalsReviewer: "user",
      threadSource: "user"
    }, 60_000);
    const threadId = res.thread?.id || res.id;
    if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(res)}`);
    this.emit("debug", `thread/start ok threadId=${threadId}`);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    this.emit("debug", `thread/resume threadId=${threadId}`);
    await this.rpc.request("thread/resume", { threadId, ...(this.config.codexModel ? { model: this.config.codexModel } : {}) }, 60_000);
    this.emit("debug", `thread/resume ok threadId=${threadId}`);
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    this.emit("debug", `thread/name/set threadId=${threadId} name=${name.slice(0, 80)}`);
    await this.rpc.request("thread/name/set", { threadId, name }, 60_000);
    this.emit("debug", `thread/name/set ok threadId=${threadId}`);
  }

  async sendTurn(threadId: string, text: string, images: CodexTurnImage[] = [], selection:ModelSelection={}): Promise<CodexTurnResult> {
    await this.resumeThread(threadId).catch(() => undefined);
    const collected: string[] = [];
    const outputImages: CodexOutputImage[] = [];
    let turnId: string | undefined;
    let completed = false;
    let turnFailure: string | undefined;
    let completeTurn: (() => void) | undefined;
    const completedPromise = new Promise<void>((resolve) => {
      completeTurn = resolve;
    });
    const onNotification = (raw: JsonRpcMessage) => {
      const params = raw.params as Record<string, unknown> | undefined;
      if (raw.method === "item/agentMessage/delta") {
        const delta = params?.delta ?? params?.text ?? params?.content;
        if (typeof delta === "string") collected.push(delta);
      }
      if (raw.method === "item/completed") {
        const item = params?.item as Record<string, unknown> | undefined;
        const type = item?.type;
        if (type === "imageGeneration" && typeof item?.savedPath === "string") {
          outputImages.push({ path: item.savedPath, source: "imageGeneration" });
        }
        if (type === "imageView" && typeof item?.path === "string") {
          outputImages.push({ path: item.path, source: "imageView" });
        }
      }
      if (raw.method) {
        this.emit("debug", `notification ${raw.method}`);
      }
      if (raw.method === "turn/started") {
        const id = params?.turnId ?? params?.id;
        if (typeof id === "string") turnId = id;
      }
      if (raw.method === "turn/completed") {
        const turn = params?.turn as Record<string, unknown> | undefined;
        if (turn?.status === "failed") turnFailure = JSON.stringify(turn.error || "Codex turn failed");
        completed = true;
        completeTurn?.();
      }
    };
    this.on("notification", onNotification);
    try {
      this.emit("debug", `turn/start threadId=${threadId} textLen=${text.length} images=${images.length}`);
      const res = await this.rpc.request<TurnStartResponse>("turn/start", {
        threadId,
        ...((selection.model||this.config.codexModel) ? { model: selection.model||this.config.codexModel } : {}),
        ...((selection.effort||this.config.codexReasoningEffort) ? { effort: selection.effort||this.config.codexReasoningEffort } : {}),
        input: [
          { type: "text", text },
          ...images.map((image) => ({
            type: "localImage",
            path: image.path,
            detail: image.detail || "auto"
          }))
        ],
        approvalPolicy: this.config.approvalPolicy,
        approvalsReviewer: "user"
      }, 60_000);
      turnId = turnId || res.turn?.id || res.turnId || res.id;
      if (turnId) this.activeTurnIds.set(threadId, turnId);
      this.emit("debug", `turn/start accepted turnId=${turnId ?? "(unknown)"}`);
      if (!completed) {
        await Promise.race([
          completedPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for Codex turn completion")), 20 * 60_000))
        ]);
      }
      this.emit("debug", `turn/completed threadId=${threadId} textLen=${collected.join("").length}`);
      if (turnFailure) throw new Error(turnFailure);
      return {
        threadId,
        turnId,
        text: collected.join("").trim() || "Codex turn completed.",
        images: uniqueImages(outputImages)
      };
    } finally {
      this.activeTurnIds.delete(threadId);
      this.off("notification", onNotification);
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const turnId = this.activeTurnIds.get(threadId);
    if (!turnId) throw new Error("当前没有可中止的任务，请稍后重试。");
    await this.rpc.request("turn/interrupt", { threadId, turnId }, 30_000);
  }

  private handleServerRequest(msg: JsonRpcMessage): void {
    if (!msg.method || msg.id == null) return;
    if (!msg.method.includes("requestApproval")) return;
    const params = (msg.params || {}) as Record<string, unknown>;
    const shortId = String(this.approvalSeq++).padStart(4, "0");
    const approval: PendingApproval = {
      shortId,
      requestId: msg.id,
      method: msg.method,
      threadId: typeof params.threadId === "string" ? params.threadId : undefined,
      summary: summarizeApproval(msg.method, params),
      peerId: "",
      createdAt: Date.now()
    };
    this.pendingApprovals.set(shortId, approval);
    this.emit("approval", approval);
  }
}

function uniqueImages(images: CodexOutputImage[]): CodexOutputImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    if (seen.has(image.path)) return false;
    seen.add(image.path);
    return true;
  });
}

function summarizeApproval(method: string, params: Record<string, unknown>): string {
  if (method === "item/commandExecution/requestApproval") {
    return `Command approval requested:\n${String(params.command || params.cmd || "(unknown command)")}`;
  }
  if (method === "item/fileChange/requestApproval") {
    return `File change approval requested for thread ${String(params.threadId || "")}`;
  }
  if (method === "item/permissions/requestApproval") {
    return `Additional permissions requested: ${JSON.stringify(params.permissions || params.additionalPermissions || {})}`;
  }
  return `${method}: ${JSON.stringify(params).slice(0, 1000)}`;
}
