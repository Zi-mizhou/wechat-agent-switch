import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2];
if(!root){console.error('Usage: node doctor.mjs <bridge-root>');process.exit(2);}
const state=path.join(path.resolve(root),'.local-state');
const file=path.join(state,'config.json');
if(!fs.existsSync(file)){console.log(JSON.stringify({configured:false}));process.exit(1);}
const c=JSON.parse(fs.readFileSync(file,'utf8'));
let alive=false;
try{const pid=Number(fs.readFileSync(c.pidFile||path.join(state,'daemon.pid'),'utf8').trim());if(pid>0){process.kill(pid,0);alive=true;}}catch{}
console.log(JSON.stringify({configured:true,daemonAlive:alive,wechatLoginPresent:!!c.weixin?.token,authorizedPeerCount:c.security?.allowFrom?.length||0,defaultEngine:c.selectedEngine||'codex',peerSelectedEngines:Object.values(c.peerEngines||{}),peersWithModelSelections:Object.keys(c.peerModels||{}).length,declaredCodexModel:c.codexModel||'native-default',declaredReasoningEffort:c.codexReasoningEffort||'native-default',configuredBackends:{codex:!!c.codexBin,deepseek:!!c.dsh,openclaw:!!c.openclaw,workbuddy:!!c.workbuddy},note:'Configuration and process evidence only; no message was sent.'},null,2));
