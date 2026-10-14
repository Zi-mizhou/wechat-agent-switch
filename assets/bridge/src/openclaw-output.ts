import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import type {CodexOutputImage} from "./types.js";

export function parseOpenClawOutput(data:any,cwd:string):{text:string;images:CodexOutputImage[]}{
  const result=data.result||{};
  const payloads=Array.isArray(result.payloads)?result.payloads:[];
  let text=payloads.map((p:any)=>typeof p.text==="string"?p.text:"").filter(Boolean).join("\n\n");
  if(!text)text=result.meta?.finalAssistantVisibleText||result.meta?.finalAssistantRawText||"";
  const media:string[]=[];
  for(const payload of payloads){
    if(typeof payload.mediaUrl==="string")media.push(payload.mediaUrl);
    if(Array.isArray(payload.mediaUrls))media.push(...payload.mediaUrls.filter((x:any)=>typeof x==="string"));
  }
  text=text.replace(/^\s*MEDIA:\s*(.*?)\s*$/gm,(_line:string,target:string)=>{media.push(target);return "";}).trim();
  const images:CodexOutputImage[]=[];
  const seen=new Set<string>();
  for(const raw of media){
    let value=raw.trim().replace(/^["']|["']$/g,"");
    if(/^https?:\/\//i.test(value))continue;
    try{
      if(value.startsWith("file://"))value=fileURLToPath(value);
      const candidate=path.resolve(cwd,value);
      if(!/\.(png|jpe?g|webp|gif|bmp)$/i.test(candidate)||seen.has(candidate)||!fs.existsSync(candidate)||!fs.statSync(candidate).isFile())continue;
      seen.add(candidate);images.push({path:candidate,source:"local"});
    }catch{}
  }
  if(!text&&images.length)text=images.length===1?"图片已生成，正在发送。":`已生成 ${images.length} 张图片，正在发送。`;
  if(!text&&media.length)text="OpenClaw 返回了附件，但当前桥接无法转发该附件：它可能不是本地图片，或文件已无法读取。";
  if(!text)throw new Error("OpenClaw 本次未返回文字或可发送的图片。任务是否完成需进一步确认，请勿重复提交可能产生实际操作的任务。");
  return{text,images};
}
