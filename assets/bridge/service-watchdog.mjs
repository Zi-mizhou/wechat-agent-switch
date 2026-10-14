import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const state=path.join(root,'.local-state');
const log=text=>fs.appendFileSync(path.join(state,'watchdog.log'),`${new Date().toISOString()} ${text}\n`);
let delay=3000;
for(;;){
 const started=Date.now();
 log('Starting bridge from Windows background task');
 const child=spawn(process.execPath,[path.join(root,'dist/cli.js'),'run-daemon'],{cwd:root,env:{...process.env,CODEX_WEIXIN_STATE_DIR:state},windowsHide:true,stdio:['ignore','ignore','pipe']});
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',data=>log(`bridge stderr: ${data.slice(0,1000).trim()}`));
 const outcome=await new Promise(resolve=>{child.on('error',error=>resolve(error.message));child.on('close',(code,signal)=>resolve(`exit=${code} signal=${signal}`));});
 log(`Bridge stopped: ${outcome}; restarting in ${delay}ms`);
 await new Promise(resolve=>setTimeout(resolve,delay));
 delay=Date.now()-started>60000?3000:Math.min(delay*2,60000);
}
