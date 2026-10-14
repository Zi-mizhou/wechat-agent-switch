import fs from'node:fs';import path from'node:path';import{randomUUID}from'node:crypto';
import{spawn,spawnSync,type ChildProcess}from'node:child_process';
import type{BridgeConfig,CodexThread,CodexTurnImage,CodexTurnResult,ModelSelection,ModelOption}from'./types.js';
import{parseOpenClawOutput}from'./openclaw-output.js';
type Session={nativeId:string;started:boolean;cwd:string;title?:string;updatedAt:number;requestedModel?:string;baselineModel?:string};
export class WorkBuddyAdapter{
 private sessions:Record<string,Session>={};private active=new Map<string,ChildProcess>();
 constructor(private config:BridgeConfig,private edition:'international'|'domestic'){if(fs.existsSync(this.file()))this.sessions=JSON.parse(fs.readFileSync(this.file(),'utf8'));}
 private file(){return path.join(this.config.stateDir,`workbuddy-${this.edition}-sessions.json`);}
 private persist(){const file=this.file(),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.sessions,null,2),{mode:0o600});fs.renameSync(tmp,file);}
 async initialize(){if(!this.config.workbuddy||!fs.existsSync(this.config.workbuddy.wrapper))throw new Error('WorkBuddy 原生调用入口未配置。');}
 async startThread(cwd=this.config.defaultCwd){const id=`${this.edition==='domestic'?'wbcn':'wb'}-${randomUUID()}`;this.sessions[id]={nativeId:randomUUID(),started:false,cwd,updatedAt:Date.now()};this.persist();return id;}
 async listThreads(limit=10):Promise<CodexThread[]>{return Object.entries(this.sessions).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,limit).map(([id,s])=>({id,cwd:s.cwd,title:s.title,updatedAt:s.updatedAt}));}
 async listModels():Promise<ModelOption[]>{
  const hosts=JSON.parse(fs.readFileSync(path.join(path.dirname(this.config.workbuddy!.wrapper),'.local-state/workbuddy-hosts.json'),'utf8'));
  const product=JSON.parse(fs.readFileSync(hosts[this.edition].product,'utf8'));
  return (product.models||[]).filter((m:any)=>typeof m.id==='string').map((m:any)=>({id:m.id,label:m.name||m.id,isDefault:m.isDefault===true}));
 }
 async sendTurn(id:string,text:string,images:CodexTurnImage[]=[],selection:ModelSelection={}):Promise<CodexTurnResult>{
  const session=this.sessions[id];if(!session)throw new Error('WorkBuddy 会话不存在，请发送 /new。');const host=this.config.workbuddy!;
  const task=images.length?`${text}\n用户提供的本地图片：\n${images.map(i=>i.path).join('\n')}`:text;
  if(task.length>24000)throw new Error('WorkBuddy 单条输入过长，请分段发送。');
  if(selection.model&&!session.baselineModel)session.baselineModel=(await this.listModels()).find(m=>m.isDefault)?.id;
  const effectiveModel=selection.model||(session.requestedModel?session.baselineModel:undefined);
  if(session.requestedModel&&!selection.model&&!effectiveModel)throw new Error('无法确定 WorkBuddy 默认模型，请在 /models 明确选择。');
  const args=[host.wrapper,'--print','--output-format','json',...(effectiveModel?['--model',effectiveModel]:[]),session.started?'--resume':'--session-id',session.nativeId,task];
  const child=spawn(host.node,args,{cwd:session.cwd,env:{...process.env,WECHAT_WB_EDITION:this.edition},windowsHide:true,stdio:['ignore','pipe','pipe']});this.active.set(id,child);
  let out='',err='';child.stdout!.on('data',b=>{out+=b;if(out.length>20*1024*1024)child.kill();});child.stderr!.on('data',b=>err=(err+b).slice(-3000));
  const timer=setTimeout(()=>void this.interrupt(id),600000);
  try{
   const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
   if(!out.trim()&&/401\s+Authentication|Authentication required/i.test(err)){
    const endpoint=err.match(/-> (https:\/\/[^)\s]+)/)?.[1];
    fs.appendFileSync(path.join(this.config.stateDir,'workbuddy-auth-diagnostic.jsonl'),JSON.stringify({time:new Date().toISOString(),edition:this.edition,endpoint,status:401})+'\n');
    throw new Error(`WorkBuddy ${this.edition==='domestic'?'国内版':'国际版'}认证失败，请打开对应桌面应用检查登录；若已登录需检查桥接版本配置。`);
   }
   if(code!==0)throw new Error('WorkBuddy 调用失败或已中止。');
   let parsed:any;try{parsed=JSON.parse(out);}catch{throw new Error('WorkBuddy 未返回有效结果，请检查对应版本的登录与网络。');}
   const rows=Array.isArray(parsed)?parsed:[parsed];const result=[...rows].reverse().find(r=>r.type==='result');
   if(!result||result.is_error||result.subtype!=='success')throw new Error('WorkBuddy 未完成此任务；操作审批可能需要在对应桌面应用中处理。');
   if(!selection.model)session.baselineModel ||=rows.find(r=>r.providerData?.model)?.providerData?.model;
   session.requestedModel=selection.model;
   session.nativeId=result.session_id||session.nativeId;session.started=true;session.title ||=text.slice(0,60);session.updatedAt=Date.now();this.persist();
   const output=parseOpenClawOutput({result:{payloads:[{text:result.result||''}]}},session.cwd);
   return{threadId:id,...output};
  }finally{clearTimeout(timer);this.active.delete(id);}
 }
 async interrupt(id:string){const child=this.active.get(id);if(!child?.pid)return;if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();}
 stop(){for(const id of this.active.keys())void this.interrupt(id);}
}
