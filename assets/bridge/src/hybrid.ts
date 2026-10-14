import { CodexAppServerAdapter } from "./codex-app-server.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { OpenClawAdapter } from "./openclaw.js";
import { WorkBuddyAdapter } from "./workbuddy.js";
import type { BridgeConfig, CodexTurnImage, Engine, ModelSelection, ModelOption } from "./types.js";

export function engineForThread(id:string):Engine{return id.startsWith('wbcn-')?'workbuddycn':id.startsWith('wb-')?'workbuddy':id.startsWith('claw-')?'openclaw':id.startsWith('dsh-')?'deepseek':'codex';}

export class HybridAdapter extends CodexAppServerAdapter {
  private extras: Partial<Record<Engine,DeepSeekAdapter|OpenClawAdapter|WorkBuddyAdapter>>={};
  engine: Engine;
  constructor(config: BridgeConfig) {
    super(config);
    if(config.dsh)this.extras.deepseek = new DeepSeekAdapter(config);
    if(config.openclaw)this.extras.openclaw=new OpenClawAdapter(config);
    if(config.workbuddy){this.extras.workbuddy=new WorkBuddyAdapter(config,'international');this.extras.workbuddycn=new WorkBuddyAdapter(config,'domestic');}
    this.engine = config.selectedEngine || "codex";
  }
  private extra(engine:Engine){const adapter=this.extras[engine];if(!adapter)throw new Error(`${engine} 未配置`);return adapter;}
  async initialize(): Promise<void> { await super.initialize();for(const adapter of Object.values(this.extras))await adapter.initialize(); }
  setEngine(engine:Engine):void{if(engine!=='codex')this.extra(engine);this.engine=engine;}
  async modelsFor(engine:Engine):Promise<ModelOption[]>{
    if(engine==='codex')return super.listModels();
    const adapter=this.extra(engine);
    return adapter instanceof WorkBuddyAdapter||adapter instanceof OpenClawAdapter?adapter.listModels():[];
  }
  async applyModelChoice(id:string,model?:string){const engine=engineForThread(id);if(engine==='openclaw')await (this.extra(engine) as OpenClawAdapter).selectModel(id,model);}
  async startThread(cwd?:string,selection:ModelSelection={}){return this.engine==='codex'?super.startThread(cwd,selection):this.extra(this.engine).startThread(cwd);}
  async resumeThread(id:string){if(engineForThread(id)==='codex')await super.resumeThread(id);}
  async setThreadName(id:string,name:string){if(engineForThread(id)==='codex')await super.setThreadName(id,name);}
  async listThreads(limit=10){return this.engine==='codex'?super.listThreads(limit):this.extra(this.engine).listThreads(limit);}
  async sendTurn(id:string,text:string,images:CodexTurnImage[]=[],selection:ModelSelection={}){const engine=engineForThread(id);if(engine==='codex')return super.sendTurn(id,text,images,selection);const adapter=this.extra(engine);return adapter instanceof WorkBuddyAdapter||adapter instanceof OpenClawAdapter?adapter.sendTurn(id,text,images,selection):adapter.sendTurn(id,text,images);}
  async interrupt(id:string){const engine=engineForThread(id);if(engine==='codex')await super.interrupt(id);else await this.extra(engine).interrupt(id);}
  stop(){for(const adapter of Object.values(this.extras))adapter.stop();super.stop();}
}
