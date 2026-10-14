import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { BridgeConfig, CodexTurnImage, CodexTurnResult, CodexThread,ModelOption,ModelSelection } from "./types.js";
import {parseOpenClawOutput} from "./openclaw-output.js";
const execFileAsync=promisify(execFile);
type ClawSession={key:string;cwd:string;title?:string;updatedAt:number;model?:string;requestedModel?:string};
export class OpenClawAdapter {
  private sessions:Record<string,ClawSession>={};
  private active=new Map<string,ChildProcess>();
  constructor(private config:BridgeConfig){if(fs.existsSync(this.file()))this.sessions=JSON.parse(fs.readFileSync(this.file(),"utf8"));}
  private file():string{return path.join(this.config.stateDir,"openclaw-sessions.json");}
  private persist():void{fs.writeFileSync(this.file(),JSON.stringify(this.sessions,null,2),{mode:0o600});}
  async initialize():Promise<void>{if(!this.config.openclaw||!fs.existsSync(this.config.openclaw.entry))throw new Error("OpenClaw installation is unavailable");}
  async startThread(cwd=this.config.defaultCwd):Promise<string>{
    const id=`claw-${randomUUID()}`;
    this.sessions[id]={key:`agent:${this.config.openclaw!.agentId}:weixin-bridge:${id}`,cwd,updatedAt:Date.now()};this.persist();return id;
  }
  async listThreads(limit=10):Promise<CodexThread[]>{return Object.entries(this.sessions).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,limit).map(([id,s])=>({id,cwd:s.cwd,title:s.title,updatedAt:s.updatedAt}));}
  async listModels():Promise<ModelOption[]>{
    const data=await this.gateway('models.list',{});
    return (data.models||[]).filter((m:any)=>typeof m.id==='string'&&typeof m.provider==='string').map((m:any)=>({id:`${m.provider}/${m.id}`,label:m.name||m.id}));
  }
  private async gateway(method:string,params:object):Promise<any>{
    const s=this.config.openclaw!;
    try{const{stdout}=await execFileAsync(s.node,[s.entry,'gateway','call',method,'--params',JSON.stringify(params),'--json'],{windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});return JSON.parse(stdout);}catch(error){
      if(/scope upgrade|pairing required|missing scope/i.test(String((error as any).stderr)))throw new Error('OpenClaw 当前设备没有会话设置权限，请在原生管理端审核设备权限请求后重新选择；模型选择未保存。');
      throw new Error('OpenClaw 模型接口不可用，请检查 Gateway、账号和版本。');
    }
  }
  async selectModel(id:string,model?:string){
    const session=this.sessions[id];if(!session)throw new Error('OpenClaw 会话不存在。');
    if(session.requestedModel!==model){await this.gateway('sessions.patch',{key:session.key,model:model||null});session.requestedModel=model;this.persist();}
  }
  async sendTurn(id:string,text:string,images:CodexTurnImage[]=[],selection:ModelSelection={}):Promise<CodexTurnResult>{
    const session=this.sessions[id];if(!session)throw new Error("找不到此 OpenClaw 会话，请发送 /new。");
    const settings=this.config.openclaw!;
    const task=images.length?`${text}\n用户提供的图片在本机：\n${images.map(i=>i.path).join("\n")}`:text;
    if(task.length>24000)throw new Error("OpenClaw 单条输入过长，请分段发送。");
    await this.selectModel(id,selection.model);
    const child=spawn(settings.node,[settings.entry,"agent","--agent",settings.agentId,"--session-key",session.key,"--message",task,"--json","--timeout","600"],{cwd:session.cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    this.active.set(id,child);let stdout="",stderr="";
    child.stdout!.setEncoding("utf8");child.stderr!.setEncoding("utf8");
    child.stdout!.on("data",chunk=>{stdout+=chunk;if(stdout.length>16*1024*1024)child.kill();});
    child.stderr!.on("data",chunk=>{stderr=(stderr+chunk).slice(-2000);});
    const timer=setTimeout(()=>void this.interrupt(id),610000);
    try{
      const code=await new Promise<number|null>((resolve,reject)=>{child.on("error",reject);child.on("close",resolve);});
      if(code!==0)throw new Error("OpenClaw 调用失败或已中止，请确认 Gateway 正在运行。");
      let data:any;try{data=JSON.parse(stdout);}catch{const start=stdout.indexOf("{");const end=stdout.lastIndexOf("}");data=JSON.parse(stdout.slice(start,end+1));}
      if(data.status!=="ok"||data.result?.meta?.aborted)throw new Error("OpenClaw 未完成当前任务。");
      const output=parseOpenClawOutput(data,session.cwd);
      session.title ||= text.slice(0,60);session.updatedAt=Date.now();session.model=data.result?.meta?.agentMeta?.model;this.persist();
      return{threadId:id,...output};
    }finally{clearTimeout(timer);this.active.delete(id);}
  }
  async interrupt(id:string):Promise<void>{
    const child=this.active.get(id),session=this.sessions[id];if(!child?.pid||!session)return;
    const settings=this.config.openclaw!;
    await execFileAsync(settings.node,[settings.entry,"gateway","call","chat.abort","--params",JSON.stringify({sessionKey:session.key}),"--timeout","5000"],{windowsHide:true,timeout:8000}).catch(()=>undefined);
    if(process.platform==="win32")spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else child.kill();
  }
  stop():void{for(const id of this.active.keys())void this.interrupt(id);}
}
