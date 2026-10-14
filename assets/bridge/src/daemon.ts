import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, saveConfig } from "./config.js";
import { Logger } from "./logger.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { HybridAdapter, engineForThread } from "./hybrid.js";
import { ChoiceMenu, type MenuAction } from "./menu.js";
import { addDesktopIndex, desktopIndexStatus } from "./desktop-index.js";
import { getUpdates, sendImages, sendText } from "./weixin.js";
import type { BridgeConfig, InboundTextMessage, ModelProviderCapabilities, PeerSession, PendingApproval, Engine,ModelSelection,ModelOption } from "./types.js";

type CodexAdapter = CodexAppServerAdapter | CodexCliAdapter | DeepSeekAdapter;

const POLL_ERROR_BACKOFF_MS = 10_000;
const DESKTOP_INDEX_MAINTAIN_MS = 30_000;

type MirrorState = {
  threads: Record<string, { path: string; offset: number }>;
};

type SessionTaskComplete = {
  turnId: string;
  message: string;
  images: string[];
};

export class BridgeDaemon extends EventEmitter {
  private config: BridgeConfig;
  private readonly logger: Logger;
  private readonly codex: CodexAdapter;
  private stopping = false;
  private threadPeers = new Map<string, string>();
  private promptBuffers = new Map<string, string[]>();
  private mirrorTimer?: ReturnType<typeof setInterval>;
  private mirrorState: MirrorState = { threads: {} };
  private bridgeActiveThreads = new Set<string>();
  private turnBusy = false;
  private lastDesktopIndexMaintainAt = 0;
  private capabilities?: ModelProviderCapabilities;
  private menus=new ChoiceMenu();

  constructor() {
    super();
    this.config = loadConfig();
    this.logger = new Logger(this.config.logFile);
    this.codex = this.config.hybridEnabled ? new HybridAdapter(this.config) : this.config.adapter === "dsh" ? new DeepSeekAdapter(this.config) : this.config.adapter === "cli"
      ? new CodexCliAdapter(this.config)
      : new CodexAppServerAdapter(this.config);
  }

  async run(): Promise<void> {
    this.logger.info(`starting bridge adapter=${this.config.adapter}`);
    await this.codex.initialize();
    await this.loadCapabilities();
    this.loadMirrorState();
    this.startDesktopMirrorLoop();
    await this.processDesktopMirror().catch((err) => {
      this.logger.error(`desktop mirror initial scan failed: ${formatError(err)}`);
    });
    if (this.codex instanceof CodexAppServerAdapter) {
      this.codex.on("stderr", (chunk) => this.logger.warn(`codex app-server stderr: ${String(chunk).trim()}`));
      this.codex.on("approval", (approval) => void this.onApproval(approval));
      this.codex.on("debug", (message) => this.logger.info(`codex ${String(message)}`));
      this.codex.on("rpcRequest", (message) => this.logger.info(`codex rpc request ${safeJson(message)}`));
      this.codex.on("rpcResponse", (message) => this.logger.info(`codex rpc response ${safeJson(message)}`));
      this.codex.on("exit", (info) => {
        this.logger.error(`codex app-server exited ${safeJson(info)}`);
        if (!this.stopping) process.exit(1);
      });
    }

    process.on("uncaughtException", (err) => {
      this.logger.error(`uncaughtException: ${formatError(err)}`);
      this.stopping = true;
    });
    process.on("unhandledRejection", (err) => {
      this.logger.error(`unhandledRejection: ${formatError(err)}`);
      this.stopping = true;
    });
    process.on("SIGTERM", () => void this.stop());
    process.on("SIGINT", () => void this.stop());

    while (!this.stopping) {
      try {
        this.config = loadConfig();
        await this.maintainDesktopIndexesIfDue();
        await this.processInjectedMessages();
        const result = await getUpdates(this.config);
        for (const file of result.rawCaptureFiles) {
          this.logger.info(`captured non-text weixin message raw=${file}`);
        }
        if (result.getUpdatesBuf) {
          this.config.weixin.getUpdatesBuf = result.getUpdatesBuf;
          saveConfig(this.config);
        }
        for (const msg of result.messages) {
          await this.handleMessage(msg);
        }
      } catch (err) {
        this.logger.error(`poll loop error: ${formatError(err)}`);
        await sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
    if (this.mirrorTimer) clearInterval(this.mirrorTimer);
    this.codex.stop();
    this.logger.info("bridge stopped");
  }

  async stop(): Promise<void> {
    this.stopping = true;
  }

  private async handleMessage(msg: InboundTextMessage): Promise<void> {
    this.logger.info(`inbound peer=${msg.peerId} text=${msg.text.slice(0, 80)} images=${msg.images?.length || 0}`);
    if (!this.isAllowed(msg.peerId)) {
      this.logger.warn(`blocked unauthorized peer=${msg.peerId}`);
      return;
    }
    this.rememberPeerContext(msg);
    if(this.codex instanceof HybridAdapter)this.codex.setEngine(this.peerEngine(msg.peerId));
    if(!msg.images?.length){
      const choice=this.menus.consume(msg.peerId,msg.text);
      if(choice.kind==='reply'){await this.reply(msg,choice.text);return;}
      if(choice.kind==='choice'){
        if(this.turnBusy){await this.reply(msg,'任务仍在运行，请完成后重新发送 /menu；设置未更改。');return;}
        try{await this.applyMenuAction(msg,choice.action);}catch(err){await this.reply(msg,err instanceof Error?err.message:'菜单操作失败，请重试。');}
        return;
      }
    }else this.menus.clear(msg.peerId);

    if (!msg.images?.length && await this.maybeHandleDirectImageSend(msg)) {
      return;
    }

    const command = msg.text.trim();
    if ((command.startsWith("/") || isBareCommand(command)) && !msg.images?.length) {
      await this.handleCommand(msg, command);
      return;
    }

    if (this.promptBuffers.has(msg.peerId) && !msg.images?.length) {
      this.promptBuffers.get(msg.peerId)?.push(msg.text);
      await this.reply(msg, `Added to prompt buffer (${this.promptBuffers.get(msg.peerId)?.length || 0}). Send /prompt-done when ready.`);
      return;
    }

    await this.dispatchTurn(msg, msg.text || (msg.images?.length ? "请分析这张图片。" : ""));
  }

  private async dispatchTurn(msg: InboundTextMessage, text: string): Promise<void> {
    if (this.turnBusy) {
      await this.reply(msg, "当前任务仍在运行。可以发送 /status 查看状态、/approve 编号 批准操作，或 /interrupt 中止；完成后再发新任务。");
      return;
    }
    this.turnBusy = true;
    void this.handleCodexText(msg, text).catch(async (err) => {
      this.logger.error(`turn failed: ${formatError(err)}`);
      const brief=err instanceof Error?err.message:String(err);
      await this.reply(msg, `任务未完成：${brief.split(/\r?\n/)[0].slice(0,600)}`).catch(() => undefined);
    }).finally(() => { this.turnBusy = false; });
  }

  private async handleCodexText(msg: InboundTextMessage, text: string): Promise<void> {
    const session = this.ensureSession(msg.peerId);
    let createdThread = false;
    if (!session.threadId) {
      const cwd = path.resolve(session.cwd || this.config.defaultCwd);
      if (!this.isAllowedCwd(cwd)) {
        await this.reply(msg, `CWD is not allowed:\n${cwd}\nAllowed roots:\n${this.allowedCwdRoots().join("\n")}`);
        return;
      }
      this.logger.info(`peer=${msg.peerId} creating codex thread cwd=${cwd}`);
      session.threadId = await (this.codex instanceof CodexAppServerAdapter?this.codex.startThread(cwd,this.modelSelection(msg.peerId)):this.codex.startThread(cwd));
      createdThread = true;
      this.threadPeers.set(session.threadId, msg.peerId);
      this.saveSession(msg.peerId, session.threadId, cwd);
      this.logger.info(`peer=${msg.peerId} created codex thread=${session.threadId}`);
    } else {
      this.logger.info(`peer=${msg.peerId} using codex thread=${session.threadId}`);
    }

    this.threadPeers.set(session.threadId, msg.peerId);
    if (createdThread) {
      await this.maybeAutoRegisterDesktopIndex(session.threadId, msg.text);
    }
    this.logger.info(`peer=${msg.peerId} sending working ack`);
    await sendText(this.config,msg.peerId,`${this.engineLabel(this.peerEngine(msg.peerId))} 正在处理…`,msg.contextToken)
      .catch((err) => this.logger.error(`working ack send failed: ${formatError(err)}`));
    this.logger.info(`peer=${msg.peerId} working ack sent`);
    this.logger.info(`peer=${msg.peerId} starting codex turn thread=${session.threadId}`);
    this.bridgeActiveThreads.add(session.threadId);
    try {
      const images = (msg.images || []).map((image) => ({ path: image.path, detail: "auto" as const }));
      if (images.length > 0) {
        this.logger.info(`peer=${msg.peerId} sending ${images.length} image(s) to codex thread=${session.threadId} paths=${images.map((image) => image.path).join(",")}`);
      }
      const result = await (this.codex instanceof CodexAppServerAdapter?this.codex.sendTurn(session.threadId,text,images,this.modelSelection(msg.peerId)):this.codex.sendTurn(session.threadId,text,images));
      this.logger.info(`peer=${msg.peerId} codex turn completed responseLen=${result.text.length}`);
      this.saveSession(msg.peerId, result.threadId, session.cwd);
      await this.maybeAutoRegisterDesktopIndex(result.threadId, text);
      await this.processDesktopMirrorForThread(result.threadId, msg.peerId);
      this.logger.info(`peer=${msg.peerId} sending codex response`);
      await sendText(this.config, msg.peerId, result.text || "(empty response)", msg.contextToken);
      this.logger.info(`peer=${msg.peerId} codex response sent`);
      const outboundImages = this.collectOutboundImages(result, session.cwd || this.config.defaultCwd);
      if (outboundImages.length > 0) {
        this.logger.info(`peer=${msg.peerId} sending ${outboundImages.length} codex output image(s) paths=${outboundImages.join(",")}`);
        await sendImages(this.config, msg.peerId, outboundImages, msg.contextToken)
          .then(() => this.logger.info(`peer=${msg.peerId} codex output image(s) sent`))
          .catch(async (err) => {
            this.logger.error(`codex output image send failed peer=${msg.peerId}: ${formatError(err)}`);
            await sendText(this.config, msg.peerId, `图片发送到微信失败：${err instanceof Error ? err.message : String(err)}`, msg.contextToken)
              .catch((sendErr) => this.logger.error(`image failure notice send failed: ${formatError(sendErr)}`));
          });
      }
    } finally {
      this.bridgeActiveThreads.delete(session.threadId);
    }
  }

  private async handleCommand(msg: InboundTextMessage, raw: string): Promise<void> {
    const [name, ...rest] = raw.split(/\s+/);
    const commandName = normalizeCommandName(name);
    const arg = rest.join(" ").trim();
    if (this.turnBusy && ["/new", "/use", "/deepseek", "/dsh", "/codex", "/openclaw", "/workbuddy", "/workbuddycn", "/model", "/models", "/effort"].includes(commandName)) {
      await this.reply(msg, "请先等待当前任务完成，或发送 /interrupt 中止后再切换会话。");
      return;
    }
    switch (commandName) {
      case '/menu':
        await this.reply(msg,this.menus.open(msg.peerId,'选择 Agent（仅影响你的微信会话）',this.availableEngines().map(engine=>({label:this.engineLabel(engine),action:{kind:'engine',engine}}))));
        break;
      case '/models':
      case '/model':
        try{await this.showModelMenu(msg,arg||undefined);}catch(err){await this.reply(msg,err instanceof Error?err.message:'读取模型列表失败。');}
        break;
      case '/effort':
        try{await this.showEffortMenu(msg,arg||undefined);}catch(err){await this.reply(msg,err instanceof Error?err.message:'读取推理强度失败。');}
        break;
      case "/deepseek":
      case "/dsh":
      case "/openclaw":
      case "/workbuddy":
      case "/workbuddycn":
      case "/codex": {
        if (!(this.codex instanceof HybridAdapter)) { await this.reply(msg, "当前未启用双后端。"); break; }
        const target = commandName === "/workbuddycn" ? "workbuddycn" : commandName === "/workbuddy" ? "workbuddy" : commandName === "/codex" ? "codex" : commandName === "/openclaw" ? "openclaw" : "deepseek";
        if(target.startsWith('workbuddy')&&!this.config.workbuddy){await this.reply(msg,'WorkBuddy 尚未配置。');break;}
        if(target==="openclaw"&&!this.config.openclaw){await this.reply(msg,"OpenClaw 尚未配置。");break;}
        if(target==="deepseek"&&!this.config.dsh){await this.reply(msg,"DeepSeek Harness 尚未配置。");break;}
        this.switchEngine(msg.peerId,target);
        await this.reply(msg, `已切换到 ${this.engineLabel(target)}，各后端会话分别保留。发送 /models 选择模型。`);
        if (arg) await this.dispatchTurn(msg,arg);
        break;
      }
      case "/help":
        await this.reply(msg, [
          "Commands:",
          '/menu — 编号选择 Agent，再选择模型',
          '/models 或 /model 模型ID — 模型选择',
          '/effort — Codex 推理强度选择',
          "/codex — 切换到 Codex",
          "/deepseek — 切换到 DeepSeek Harness",
          "/openclaw — 切换到本机 OpenClaw",
          "/workbuddy — 切换到 WorkBuddy 国际版",
          "/workbuddycn — 切换到 WorkBuddy 国内版",
          "/status",
          "/threads",
          "/new [cwd]",
          "/use <thread-id>",
          "/approve <id>",
          "/deny <id>",
          "/interrupt",
          "/prompt-start",
          "/prompt-done",
          "/prompt-cancel",
          "/send-image <path>",
          "/stop-bridge"
        ].join("\n"));
        break;
      case "/status":
        await this.reply(msg, this.statusText(msg.peerId));
        break;
      case "/threads":
        await this.reply(msg, await this.threadsText());
        break;
      case "/new": {
        const cwd = path.resolve(arg || this.config.defaultCwd);
        if (!this.isAllowedCwd(cwd)) {
          await this.reply(msg, `CWD is not allowed:\n${cwd}\nAllowed roots:\n${this.allowedCwdRoots().join("\n")}`);
          break;
        }
        const threadId = await (this.codex instanceof CodexAppServerAdapter?this.codex.startThread(cwd,this.modelSelection(msg.peerId)):this.codex.startThread(cwd));
        this.threadPeers.set(threadId, msg.peerId);
        this.saveSession(msg.peerId, threadId, cwd);
        await this.maybeAutoRegisterDesktopIndex(threadId, "New Weixin Codex session");
        await this.reply(msg, `Created Codex thread:\n${threadId}\ncwd=${cwd}`);
        break;
      }
      case "/use":
        if (!arg) {
          await this.reply(msg, "Usage: /use <thread-id>");
          break;
        }
        if (this.codex instanceof HybridAdapter && engineForThread(arg) !== this.codex.engine) {
          await this.reply(msg, "请先切换到对应后端，再选择此会话。");
          break;
        }
        this.saveSession(msg.peerId, arg, this.ensureSession(msg.peerId).cwd);
        this.threadPeers.set(arg, msg.peerId);
        await this.reply(msg, `Using Codex thread:\n${arg}`);
        break;
      case "/approve":
        await this.resolveApproval(msg, arg, "accept");
        break;
      case "/deny":
        await this.resolveApproval(msg, arg, "decline");
        break;
      case "/interrupt": {
        const threadId = this.ensureSession(msg.peerId).threadId;
        if (!threadId) await this.reply(msg, "No active Codex thread.");
        else {
          await this.codex.interrupt(threadId);
          await this.reply(msg, `Interrupted ${threadId}`);
        }
        break;
      }
      case "/prompt-start":
        this.promptBuffers.set(msg.peerId, []);
        await this.reply(msg, "Prompt buffer started. Send text messages, then /prompt-done.");
        break;
      case "/prompt-done": {
        const items = this.promptBuffers.get(msg.peerId);
        if (!items || items.length === 0) {
          this.promptBuffers.delete(msg.peerId);
          await this.reply(msg, "Prompt buffer is empty.");
          break;
        }
        this.promptBuffers.delete(msg.peerId);
        await this.dispatchTurn(msg, items.join("\n\n"));
        break;
      }
      case "/prompt-cancel":
        this.promptBuffers.delete(msg.peerId);
        await this.reply(msg, "Prompt buffer cleared.");
        break;
      case "/stop-bridge":
        if (!this.config.security.allowStopFromWeixin) {
          await this.reply(msg, "Remote stop is disabled. Run codex-weixin stop on this computer.");
          break;
        }
        await this.reply(msg, "Stopping weixin-codex bridge.");
        await this.stop();
        break;
      default:
        await this.reply(msg, "Unknown command. Try /help.");
    }
  }

  private peerEngine(peer:string):Engine {
    return this.config.peerEngines?.[peer]||(this.config.sessions[peer]?.threadId?engineForThread(this.config.sessions[peer].threadId!):this.config.selectedEngine)||(this.config.adapter==='dsh'?'deepseek':'codex');
  }
  private modelSelection(peer:string):ModelSelection {return this.config.peerModels?.[peer]?.[this.peerEngine(peer)]||{};}
  private engineLabel(engine:Engine){return{codex:'Codex',deepseek:'DeepSeek Harness',openclaw:'OpenClaw',workbuddy:'WorkBuddy 国际版',workbuddycn:'WorkBuddy 国内版'}[engine];}
  private availableEngines():Engine[]{return this.codex instanceof HybridAdapter?['codex',...(this.config.dsh?['deepseek' as const]:[]),...(this.config.openclaw?['openclaw' as const]:[]),...(this.config.workbuddy?['workbuddy' as const,'workbuddycn' as const]:[])]:[this.peerEngine('')];}
  private switchEngine(peerId:string,target:Engine){
    if(!(this.codex instanceof HybridAdapter)){if(target!==this.peerEngine(peerId))throw new Error('此部署未启用多 Agent。');return;}
    if(!this.availableEngines().includes(target))throw new Error('该 Agent 尚未配置。');
    const routes=this.config.routedSessions||={};const peer=routes[peerId]||={};const previous=this.ensureSession(peerId);
    peer[this.peerEngine(peerId)]={...previous};
    this.config.sessions[peerId]={...(peer[target]||{peerId,cwd:this.config.defaultCwd,updatedAt:Date.now()}),lastContextToken:previous.lastContextToken};
    (this.config.peerEngines||={})[peerId]=target;this.codex.setEngine(target);saveConfig(this.config);
  }
  private async modelOptions(engine:Engine):Promise<ModelOption[]>{
    if(this.codex instanceof HybridAdapter)return this.codex.modelsFor(engine);
    if(engine==='codex'&&this.codex instanceof CodexAppServerAdapter)return this.codex.listModels();
    return[];
  }
  private async showModelMenu(msg:InboundTextMessage,requested?:string){
    const engine=this.peerEngine(msg.peerId);
    if(engine==='deepseek'){
      await this.reply(msg,this.config.dsh?.workbuddyProxy?'此 Harness 路由固定使用 WorkBuddy 国际版 deepseek-v4.1-flash，微信菜单暂不支持改模型。切换需要在电脑修改专用 profile 和代理配置。':'此 Harness 的模型由专用 profile/patch 管理，微信菜单暂不支持修改。');return;
    }
    if(requested){await this.chooseModel(msg,engine,requested==='default'?undefined:requested);return;}
    const options=await this.modelOptions(engine);
    const selected=this.modelSelection(msg.peerId).model;
    await this.reply(msg,this.menus.open(msg.peerId,`${this.engineLabel(engine)}：选择模型\n当前选择：${selected||this.defaultModelLabel(engine)}\n列表来自本机原生接口/配置，账号权限以实际调用结果为准。`,[
      {label:`沿用默认：${this.defaultModelLabel(engine)}`,action:{kind:'model',engine}},
      ...options.map(m=>({label:`${m.label} [${m.id}]`,action:{kind:'model' as const,engine,model:m.id}}))
    ]));
  }
  private defaultModelLabel(engine:Engine){return engine==='codex'?(this.config.codexModel||'Codex 原生默认'):engine==='deepseek'&&this.config.dsh?.workbuddyProxy?'deepseek-v4.1-flash':'对应 Agent 的原生配置';}
  private async chooseModel(msg:InboundTextMessage,engine:Engine,model?:string){
    if(engine!==this.peerEngine(msg.peerId))throw new Error('当前 Agent 已变化，请重新发送 /menu。');
    if(engine==='deepseek')throw new Error('Harness 模型暂不支持从微信修改。');
    const option=model?(await this.modelOptions(engine)).find(m=>m.id===model):undefined;
    if(model&&!option)throw new Error('该模型不在当前原生模型列表中，设置未更改。发送 /models 查看。');
    if(engine==='openclaw'&&this.codex instanceof HybridAdapter){
      const session=this.ensureSession(msg.peerId);
      if(!session.threadId){session.threadId=await this.codex.startThread(session.cwd);this.saveSession(msg.peerId,session.threadId,session.cwd);}
      await this.codex.applyModelChoice(session.threadId,model);
    }
    const selection:ModelSelection=model?{model}:{};
    if(engine==='codex'&&option?.efforts?.length){
      const preferred=this.config.codexReasoningEffort;
      selection.effort=(preferred&&option.efforts.includes(preferred)?preferred:option.efforts[0]) as ModelSelection['effort'];
    }
    const peers=this.config.peerModels||={};(peers[msg.peerId]||={})[engine]=selection;saveConfig(this.config);
    await this.reply(msg,`已保存 ${this.engineLabel(engine)} 的模型选择：${model||this.defaultModelLabel(engine)}${selection.effort?' / '+selection.effort:''}。从下一条任务生效，保留当前会话；使用 /new 可另开会话。${engine==='codex'?' 发 /effort 可选推理强度。':''}`);
  }
  private async showEffortMenu(msg:InboundTextMessage,requested?:string){
    if(this.peerEngine(msg.peerId)!=='codex')throw new Error('目前微信推理强度菜单仅支持 Codex，其他后端沿用原生设置。');
    const current=this.modelSelection(msg.peerId);const model=current.model||this.config.codexModel;
    const option=(await this.modelOptions('codex')).find(m=>m.id===model);
    const efforts=(option?.efforts||[]).filter(e=>['none','minimal','low','medium','high','xhigh','max','ultra'].includes(e));
    if(!efforts.length)throw new Error('请先用 /models 明确选择一个支持推理强度的模型。');
    if(requested){
      if(!efforts.includes(requested))throw new Error('该模型不支持此推理强度，设置未更改。');
      const peers=this.config.peerModels||={};(peers[msg.peerId]||={}).codex={...current,effort:requested as ModelSelection['effort']};saveConfig(this.config);
      await this.reply(msg,`已保存 Codex 推理强度 ${requested}，从下一条任务生效。`);return;
    }
    await this.reply(msg,this.menus.open(msg.peerId,`选择 ${model} 的推理强度`,efforts.map(e=>({label:e,action:{kind:'effort',effort:e}}))));
  }
  private async applyMenuAction(msg:InboundTextMessage,action:MenuAction){
    if(action.kind==='engine'){
      const engine=action.engine as Engine;this.switchEngine(msg.peerId,engine);
      await this.reply(msg,`已切换到 ${this.engineLabel(engine)}，各后端会话分别保留。`);
      await this.showModelMenu(msg);return;
    }
    if(action.kind==='model'){await this.chooseModel(msg,action.engine as Engine,action.model);return;}
    await this.showEffortMenu(msg,action.effort);
  }

  private async resolveApproval(msg: InboundTextMessage, shortId: string, decision: "accept" | "decline"): Promise<void> {
    if (!shortId) {
      await this.reply(msg, `Pending approvals:\n${this.codex.listPendingApprovals().filter((approval) => this.canPeerResolveApproval(msg.peerId, approval)).map(formatApproval).join("\n\n") || "(none)"}`);
      return;
    }
    const approval = this.codex.listPendingApprovals().find((item) => item.shortId === shortId);
    if (approval && !this.canPeerResolveApproval(msg.peerId, approval)) {
      await this.reply(msg, `Approval ${shortId} belongs to another Weixin peer.`);
      return;
    }
    const ok = await this.codex.resolveApproval(shortId, decision);
    await this.reply(msg, ok ? `Approval ${shortId}: ${decision}` : `No pending approval ${shortId}`);
  }

  private async onApproval(approval: PendingApproval): Promise<void> {
    const peerId = this.approvalPeerForThread(approval.threadId);
    approval.peerId = peerId || "";
    const targets = peerId ? [peerId] : this.adminPeers();
    if (targets.length === 0) {
      this.logger.warn(`approval ${approval.shortId} has no target peer thread=${approval.threadId || "(none)"}`);
      return;
    }
    for (const target of targets) {
      await sendText(this.config, target, [
        `Approval required: ${approval.shortId}`,
        approval.summary,
        "",
        `Reply /approve ${approval.shortId} or /deny ${approval.shortId}`
      ].join("\n")).catch((err) => this.logger.error(`failed to send approval to ${target}: ${String(err)}`));
    }
  }

  private ensureSession(peerId: string): PeerSession {
    const existing = this.config.sessions[peerId];
    if (existing) return existing;
    const created: PeerSession = { peerId, cwd: this.config.defaultCwd, updatedAt: Date.now() };
    this.config.sessions[peerId] = created;
    saveConfig(this.config);
    return created;
  }

  private saveSession(peerId: string, threadId?: string, cwd?: string): void {
    const existing = this.config.sessions[peerId];
    this.config.sessions[peerId] = {
      peerId,
      threadId,
      cwd,
      lastContextToken: existing?.lastContextToken,
      updatedAt: Date.now()
    };
    if (threadId) {
      this.config.threadBindings[threadId] = {
        peerId,
        updatedAt: Date.now()
      };
    }
    saveConfig(this.config);
  }

  private rememberPeerContext(msg: InboundTextMessage): void {
    if (!msg.contextToken) return;
    const existing = this.config.sessions[msg.peerId];
    if (existing?.lastContextToken === msg.contextToken) return;
    this.config.sessions[msg.peerId] = {
      peerId: msg.peerId,
      threadId: existing?.threadId,
      cwd: existing?.cwd || this.config.defaultCwd,
      lastContextToken: msg.contextToken,
      updatedAt: Date.now()
    };
    saveConfig(this.config);
  }

  private isAllowed(peerId: string): boolean {
    return this.config.security.allowFrom.includes(peerId);
  }

  private statusText(peerId: string): string {
    const session = this.config.sessions[peerId];
    const engine=this.peerEngine(peerId),selection=this.modelSelection(peerId);
    return [
      "weixin-codex bridge",
      `adapter=${this.config.adapter}`,
      `engine=${engine}`,
      `configuredModel=${selection.model||this.defaultModelLabel(engine)}`,
      ...(engine==='codex'?[`effort=${selection.effort||this.config.codexReasoningEffort||'default'}`]:[]),
      `task=${this.turnBusy?'running':'idle'}`,
      '模型显示为已保存的选择，实际服务端模型以任务响应元数据为准。',
      `cwd=${this.config.defaultCwd}`,
      `allowedCwdRoots=${this.allowedCwdRoots().length}`,
      `allowed=${this.config.security.allowFrom.length}`,
      `thread=${session?.threadId || "(none)"}`,
      `desktopMirror=${this.config.desktopMirror.enabled ? "on" : "off"}`,
      `desktopMirrorBindings=${Object.keys(this.config.threadBindings).length}`,
      `imageGeneration=${this.capabilities?.imageGeneration == null ? "unknown" : this.capabilities.imageGeneration ? "on" : "off"}`,
      `webSearch=${this.capabilities?.webSearch == null ? "unknown" : this.capabilities.webSearch ? "on" : "off"}`,
      `lastContextToken=${session?.lastContextToken ? "yes" : "no"}`,
      `pendingApprovals=${this.codex.listPendingApprovals().length}`
    ].join("\n");
  }

  private async loadCapabilities(): Promise<void> {
    try {
      this.capabilities = await this.codex.readModelProviderCapabilities();
      this.logger.info(`codex capabilities imageGeneration=${this.capabilities.imageGeneration} namespaceTools=${this.capabilities.namespaceTools} webSearch=${this.capabilities.webSearch}`);
    } catch (err) {
      this.logger.warn(`codex capabilities unavailable: ${formatError(err)}`);
    }
  }

  private canPeerResolveApproval(peerId: string, approval: PendingApproval): boolean {
    if (this.isAdminPeer(peerId)) return true;
    return Boolean(approval.peerId && approval.peerId === peerId);
  }

  private isAdminPeer(peerId: string): boolean {
    return this.config.security.adminPeers.includes(peerId);
  }

  private approvalPeerForThread(threadId?: string): string | undefined {
    if (!threadId) return undefined;
    return this.threadPeers.get(threadId) || this.config.threadBindings[threadId]?.peerId;
  }

  private adminPeers(): string[] {
    return this.config.security.adminPeers.filter((peerId) => this.config.security.allowFrom.includes(peerId));
  }

  private allowedCwdRoots(): string[] {
    return uniqueStrings([
      this.config.defaultCwd,
      ...this.config.security.allowedCwds
    ]).map((root) => path.resolve(root));
  }

  private isAllowedCwd(cwd: string): boolean {
    const resolved = path.resolve(cwd);
    return this.allowedCwdRoots().some((root) => isSameOrChildPath(resolved, root));
  }

  private async threadsText(): Promise<string> {
    const threads = await this.codex.listThreads(10);
    if (threads.length === 0) return "No threads returned by adapter.";
    return threads.map((thread) => {
      const title = thread.title || "(untitled)";
      return `${thread.id}\n${title}\n${thread.cwd || ""}`;
    }).join("\n\n");
  }

  private async reply(msg: InboundTextMessage, text: string): Promise<void> {
    await sendText(this.config, msg.peerId, text, msg.contextToken);
    this.logger.info(`command reply sent peer=${msg.peerId} chars=${text.length}`);
  }

  private async maybeHandleDirectImageSend(msg: InboundTextMessage): Promise<boolean> {
    const session = this.ensureSession(msg.peerId);
    const paths = extractImageSendRequestPaths(msg.text, session.cwd || this.config.defaultCwd);
    if (paths.length === 0) return false;
    const existing = paths.filter((imagePath) => fs.existsSync(imagePath) && fs.statSync(imagePath).isFile() && isSupportedImagePath(imagePath));
    if (existing.length === 0) {
      await this.reply(msg, `未找到可发送的本地图片：\n${paths.join("\n")}`);
      return true;
    }
    this.logger.info(`peer=${msg.peerId} direct image send paths=${existing.join(",")}`);
    await this.reply(msg, `准备发送 ${existing.length} 张图片...`);
    try {
      await sendImages(this.config, msg.peerId, existing, msg.contextToken);
      await this.reply(msg, "图片已发送。");
    } catch (err) {
      this.logger.error(`direct image send failed peer=${msg.peerId}: ${formatError(err)}`);
      await this.reply(msg, `图片发送失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  private collectOutboundImages(result: { text: string; images?: Array<{ path: string }> }, cwd: string): string[] {
    const candidates = [
      ...(result.images || []).map((image) => image.path),
      ...extractLocalImagePaths(result.text, cwd)
    ];
    const seen = new Set<string>();
    return candidates
      .map((candidate) => path.resolve(candidate))
      .filter((candidate) => {
        if (seen.has(candidate)) return false;
        seen.add(candidate);
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile() && isSupportedImagePath(candidate);
      });
  }

  private async processInjectedMessages(): Promise<void> {
    const file = path.join(this.config.stateDir, "inject.ndjson");
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "", "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const injected = JSON.parse(line) as { peerId?: string; text?: string };
        const peerId = injected.peerId || this.config.security.allowFrom[0];
        if (!peerId || !injected.text) continue;
        await this.handleMessage({
          peerId,
          text: injected.text,
          contextToken: this.config.sessions[peerId]?.lastContextToken,
          raw: {}
        });
      } catch (err) {
        this.logger.error(`inject message failed: ${formatError(err)}`);
      }
    }
  }

  private async maybeAutoRegisterDesktopIndex(threadId: string, firstMessage: string): Promise<void> {
    if(engineForThread(threadId)!=='codex')return;
    if (!this.config.desktopIndex.autoRegister) return;
    const title = this.desktopTitle(firstMessage);
    try {
      if (this.codex instanceof CodexAppServerAdapter) {
        await this.codex.setThreadName(threadId, title);
      }
      await addDesktopIndex({
        threadId,
        title,
        skipAppServerRefresh: true
      });
      this.logger.info(`desktop index auto-registered thread=${threadId} title=${title}`);
    } catch (err) {
      this.logger.error(`desktop index auto-register failed thread=${threadId}: ${formatError(err)}`);
    }
  }

  private async maintainDesktopIndexesIfDue(): Promise<void> {
    if (!this.config.desktopIndex.autoRegister) return;
    const now = Date.now();
    if (now - this.lastDesktopIndexMaintainAt < DESKTOP_INDEX_MAINTAIN_MS) return;
    this.lastDesktopIndexMaintainAt = now;
    const threadIds = new Set<string>();
    for (const session of Object.values(this.config.sessions)) {
      if (session.threadId) threadIds.add(session.threadId);
    }
    for (const threadId of Object.keys(this.config.threadBindings)) threadIds.add(threadId);
    for (const threadId of threadIds) {
      try {
        const status = await desktopIndexStatus({ threadId });
        if (!status.jsonIndexed || !status.pinned) {
          await addDesktopIndex({
            threadId,
            title: status.title || "Weixin Codex session",
            skipAppServerRefresh: true
          });
          this.logger.info(`desktop index maintained thread=${threadId} jsonIndexed=${status.jsonIndexed} pinned=${status.pinned}`);
        }
      } catch (err) {
        this.logger.error(`desktop index maintain failed thread=${threadId}: ${formatError(err)}`);
      }
    }
  }

  private desktopTitle(firstMessage: string): string {
    const normalized = firstMessage.replace(/\s+/g, " ").trim();
    const suffix = normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
    return `${this.config.desktopIndex.titlePrefix}: ${suffix || "New session"}`;
  }

  private startDesktopMirrorLoop(): void {
    if (!this.config.desktopMirror.enabled || this.mirrorTimer) return;
    this.mirrorTimer = setInterval(() => {
      void this.processDesktopMirror().catch((err) => {
        this.logger.error(`desktop mirror failed: ${formatError(err)}`);
      });
    }, Math.max(1_000, this.config.desktopMirror.pollIntervalMs));
  }

  private async processDesktopMirror(): Promise<void> {
    this.config = loadConfig();
    if (!this.config.desktopMirror.enabled) return;
    const bindings = new Map<string, string>();
    for (const [threadId, binding] of Object.entries(this.config.threadBindings)) {
      bindings.set(threadId, binding.peerId);
    }
    for (const session of Object.values(this.config.sessions)) {
      if (!session.threadId) continue;
      bindings.set(session.threadId, session.peerId);
    }
    for (const [threadId, peerId] of bindings) {
      await this.processDesktopMirrorForThread(threadId, peerId);
    }
  }

  private async processDesktopMirrorForThread(threadId: string, peerId: string): Promise<void> {
    const file = this.resolveSessionFile(threadId);
    if (!file) return;
    const size = fs.statSync(file).size;
    const existing = this.mirrorState.threads[threadId];
    if (!existing || existing.path !== file) {
      this.mirrorState.threads[threadId] = { path: file, offset: size };
      this.saveMirrorState();
      return;
    }
    if (size <= existing.offset) return;

    const fd = fs.openSync(file, "r");
    try {
      const length = size - existing.offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, existing.offset);
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline < 0) return;
      const completeBuffer = buffer.subarray(0, lastNewline + 1);
      const tasks = parseTaskCompletes(completeBuffer.toString("utf8"));
      if (this.bridgeActiveThreads.has(threadId)) {
        existing.offset += completeBuffer.length;
        this.saveMirrorState();
        return;
      }
      for (const task of tasks) {
        if (!task.message.trim() && task.images.length === 0) continue;
        const session = this.config.sessions[peerId];
        this.logger.info(`desktop mirror sending thread=${threadId} turn=${task.turnId} peer=${peerId} contextToken=${session?.lastContextToken ? "yes" : "no"}`);
        if (task.message.trim()) {
          await sendText(this.config, peerId, task.message, session?.lastContextToken)
            .catch((err) => {
              this.logger.error(`desktop mirror send failed thread=${threadId} turn=${task.turnId} peer=${peerId}: ${formatError(err)}`);
              throw err;
            });
        }
        const images = this.collectOutboundImages({ text: task.message, images: task.images.map((imagePath) => ({ path: imagePath })) }, this.config.sessions[peerId]?.cwd || this.config.defaultCwd);
        if (images.length > 0) {
          this.logger.info(`desktop mirror sending ${images.length} image(s) thread=${threadId} turn=${task.turnId} peer=${peerId} paths=${images.join(",")}`);
          await sendImages(this.config, peerId, images, session?.lastContextToken)
          .catch((err) => {
            this.logger.error(`desktop mirror image send failed thread=${threadId} turn=${task.turnId} peer=${peerId}: ${formatError(err)}`);
            throw err;
          });
        }
      }
      existing.offset += completeBuffer.length;
      this.saveMirrorState();
    } finally {
      fs.closeSync(fd);
    }
  }

  private resolveSessionFile(threadId: string): string | null {
    const cached = this.mirrorState.threads[threadId]?.path;
    if (cached && fs.existsSync(cached)) return cached;
    const sessionsDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
    if (!fs.existsSync(sessionsDir)) return null;
    const found = findSessionFile(sessionsDir, threadId);
    return found;
  }

  private mirrorStateFile(): string {
    return path.join(this.config.stateDir, "desktop-mirror-state.json");
  }

  private loadMirrorState(): void {
    const file = this.mirrorStateFile();
    if (!fs.existsSync(file)) return;
    try {
      this.mirrorState = JSON.parse(fs.readFileSync(file, "utf8")) as MirrorState;
    } catch (err) {
      this.logger.error(`failed to load desktop mirror state: ${formatError(err)}`);
      this.mirrorState = { threads: {} };
    }
  }

  private saveMirrorState(): void {
    fs.mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.mirrorStateFile(), JSON.stringify(this.mirrorState, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`;
  }
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatApproval(approval: PendingApproval): string {
  return `${approval.shortId}: ${approval.summary}`;
}

function normalizeCommandName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === "/cancel" || normalized === "/取消" || normalized === "取消") return "/interrupt";
  if (normalized === "/buffer-start" || normalized === "/开始输入" || normalized === "开始输入") return "/prompt-start";
  if (normalized === "/buffer-done" || normalized === "/发送" || normalized === "发送") return "/prompt-done";
  if (normalized === "/buffer-cancel" || normalized === "/取消输入" || normalized === "取消输入") return "/prompt-cancel";
  return normalized;
}

function isBareCommand(text: string): boolean {
  return ["取消", "开始输入", "发送", "取消输入"].includes(text.trim());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTaskCompletes(text: string): SessionTaskComplete[] {
  const tasks: SessionTaskComplete[] = [];
  let pendingImages: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      pendingImages.push(...extractOutputImagePathsFromJson(parsed));
      if (parsed.type !== "event_msg") continue;
      const payload = parsed.payload as Record<string, unknown> | undefined;
      if (payload?.type !== "task_complete") continue;
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : "";
      const message = typeof payload.last_agent_message === "string" ? payload.last_agent_message : "";
      if (!turnId || (!message && pendingImages.length === 0)) continue;
      tasks.push({ turnId, message, images: uniqueStrings(pendingImages) });
      pendingImages = [];
    } catch {
      continue;
    }
  }
  return tasks;
}

function extractOutputImagePathsFromJson(value: unknown): string[] {
  const paths: string[] = [];
  visitJson(value, (record) => {
    if (record.type === "imageGeneration" && typeof record.savedPath === "string") {
      paths.push(record.savedPath);
    }
    if (record.type === "imageView" && typeof record.path === "string") {
      paths.push(record.path);
    }
  });
  return paths;
}

function visitJson(value: unknown, visitor: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visitor(record);
  for (const child of Object.values(record)) visitJson(child, visitor);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function extractLocalImagePaths(text: string, cwd: string): string[] {
  const out: string[] = [];
  const markdownImage = /!\[[^\]]*]\(([^)]+)\)/g;
  for (const match of text.matchAll(markdownImage)) {
    const raw = normalizeMarkdownTarget(match[1]);
    if (raw && !isRemoteUrl(raw)) out.push(resolveMaybeRelative(raw, cwd));
  }

  const inlinePath = /(?:^|\s)([~/.][^\s`'")<>]+?\.(?:png|jpe?g|gif|webp))(?:\s|$)/gi;
  for (const match of text.matchAll(inlinePath)) {
    out.push(resolveMaybeRelative(match[1], cwd));
  }
  return out;
}

function extractImageSendRequestPaths(text: string, cwd: string): string[] {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  const isExplicitCommand = lower.startsWith("/send-image") || lower.startsWith("/sendimg");
  const looksLikeSendRequest = isExplicitCommand || /发送|发给|给我|send/i.test(normalized);
  if (!looksLikeSendRequest) return [];

  const out: string[] = [];
  if (isExplicitCommand) {
    const arg = normalized.replace(/^\/send-?image\s*/i, "").replace(/^\/sendimg\s*/i, "").trim();
    if (arg) out.push(resolveMaybeRelative(stripWrappingQuotes(arg), cwd));
  }

  const absolutePath = /\/[^\n`'"]+?\.(?:png|jpe?g|gif|webp)/gi;
  for (const match of normalized.matchAll(absolutePath)) {
    out.push(match[0]);
  }
  out.push(...extractLocalImagePaths(normalized, cwd));
  return uniqueStrings(out.map((candidate) => resolveMaybeRelative(stripWrappingQuotes(candidate), cwd)));
}

function stripWrappingQuotes(value: string): string {
  let out = value.trim();
  if ((out.startsWith("\"") && out.endsWith("\"")) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1);
  }
  if (out.startsWith("<") && out.endsWith(">")) out = out.slice(1, -1);
  return out.trim();
}

function normalizeMarkdownTarget(value: string): string {
  let target = value.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  const spaceIndex = target.indexOf(" ");
  if (spaceIndex > 0 && !fs.existsSync(target)) target = target.slice(0, spaceIndex);
  return target;
}

function resolveMaybeRelative(value: string, cwd: string): string {
  if (value.startsWith("~")) return path.join(os.homedir(), value.slice(1));
  if (path.isAbsolute(value)) return value;
  return path.resolve(cwd, value);
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^data:/i.test(value);
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSupportedImagePath(value: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(value);
}

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
