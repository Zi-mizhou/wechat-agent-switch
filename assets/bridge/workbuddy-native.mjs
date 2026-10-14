import fs from'node:fs';
import path from'node:path';
import Module from'node:module';
import {fileURLToPath,pathToFileURL}from'node:url';
import {createHash}from'node:crypto';
import {spawnSync}from'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const edition=process.env.WECHAT_WB_EDITION||'international';
const host=JSON.parse(fs.readFileSync(path.join(root,'.local-state/workbuddy-hosts.json'),'utf8'))[edition];
if(!host)throw new Error('WorkBuddy edition is not configured');
// Product identity must exist before loading modules that cache authentication paths.
process.env.ACC_PRODUCT_CONFIG_PATH=host.product;
process.env.ACC_PRODUCT_CONFIG_V3=fs.readFileSync(host.product,'utf8');
delete process.env.ACC_PRODUCT_CONFIG_V2;
process.env.CODEBUDDY_CONFIG_DIR=path.join(root,'.local-state',`workbuddy-native-${edition}`);
fs.mkdirSync(process.env.CODEBUDDY_CONFIG_DIR,{recursive:true});
const original=host.entry;
let source=fs.readFileSync(original,'utf8'),runtime,entryId;
if(original.endsWith('.mjs')){
 const match=source.match(/,__webpack_require__\(__webpack_require__\.s=(\d+)\);\s*$/);
 if(!match)throw new Error('WorkBuddy native entry format changed');
 entryId=Number(match[1]);
 source=source.replace(match[0],';export default __webpack_require__;');
 const originalUrl=pathToFileURL(original).href;
 source=source.replaceAll('import.meta.url',JSON.stringify(originalUrl));
 source=source.replace(/import\("\.\/"\+__webpack_require__\.u\((\w+)\)\)/g,(_m,v)=>`import(new URL("./"+__webpack_require__.u(${v}),${JSON.stringify(originalUrl)}).href)`);
 const cache=path.join(root,'.local-state/runtime-cache');fs.mkdirSync(cache,{recursive:true});
 const cached=path.join(cache,createHash('sha256').update(source).digest('hex')+'.mjs');
 if(!fs.existsSync(cached))fs.writeFileSync(cached,source);
 runtime=(await import(pathToFileURL(cached).href)).default;
}else{
 const match=source.match(/var __webpack_exports__=__webpack_require__\(__webpack_require__\.s=(\d+)\);return __webpack_exports__/);
 if(!match)throw new Error('WorkBuddy native entry format changed');
 entryId=Number(match[1]);source=source.replace(match[0],'return __webpack_require__');
 const module=new Module(original);module.filename=original;module.paths=Module._nodeModulePaths(path.dirname(original));module._compile(source,original);runtime=module.exports;
}
const protectionId=Object.entries(runtime.m).find(([_id,fn])=>fn.toString().includes('function configureCredentialProtection('))?.[0];
if(!protectionId)throw new Error('WorkBuddy credential API changed');
const decrypt="Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($d))";
const decoded=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',decrypt],{input:fs.readFileSync(host.protectedKey,'utf8'),encoding:'utf8',windowsHide:true});
if(decoded.status!==0)throw new Error('Cannot load Windows-protected WorkBuddy configuration');
const key=JSON.parse(Buffer.from(decoded.stdout.trim(),'base64').toString('utf8'));
if(!runtime(protectionId).configureCredentialProtection({policy:'fields',symmetricKey:{keyId:key.keyId,key:Buffer.from(key.keyBase64,'base64')}}))throw new Error('WorkBuddy credential configuration conflict');
process.env.ACC_PRODUCT_CONFIG_PATH=host.product;
process.argv=[process.execPath,original,...process.argv.slice(2)];
runtime(entryId);
