export type MenuAction = {kind:'engine';engine:string}|{kind:'model';engine:string;model?:string}|{kind:'effort';effort:string};
export type MenuChoice = {label:string;action:MenuAction};
type State={title:string;choices:MenuChoice[];page:number;expires:number};
export class ChoiceMenu {
 private states=new Map<string,State>();
 constructor(private now=()=>Date.now(),private ttl=5*60_000,private pageSize=8){}
 open(peer:string,title:string,choices:MenuChoice[]):string{const s={title,choices,page:0,expires:this.now()+this.ttl};this.states.set(peer,s);return this.render(s);}
 clear(peer:string){this.states.delete(peer);}
 consume(peer:string,text:string):{kind:'none'}|{kind:'reply';text:string}|{kind:'choice';action:MenuAction}{
  const s=this.states.get(peer);if(!s)return{kind:'none'};
  const value=text.trim();const cancel=['0','取消','/cancel','/取消'].includes(value);
  const isSelection=/^\d+$/.test(value)||cancel||['n','p','下一页','上一页'].includes(value);
  if(!isSelection){this.clear(peer);return{kind:'none'};}
  if(s.expires<=this.now()){this.clear(peer);return{kind:'reply',text:'菜单已过期，请发送 /menu 重新打开；本条未作为任务执行。'};}
  if(cancel){this.clear(peer);return{kind:'reply',text:'已关闭菜单，模型与会话保持原设置。'};}
  if(['n','下一页','p','上一页'].includes(value)){
   s.page=Math.max(0,Math.min(Math.ceil(s.choices.length/this.pageSize)-1,s.page+(['n','下一页'].includes(value)?1:-1)));
   return{kind:'reply',text:this.render(s)};
  }
  const index=Number(value)-1;
  if(!Number.isSafeInteger(index)||index<s.page*this.pageSize||index>=Math.min(s.choices.length,(s.page+1)*this.pageSize))return{kind:'reply',text:'请输入本页列出的编号。\n'+this.render(s)};
  this.clear(peer);return{kind:'choice',action:s.choices[index].action};
 }
 private render(s:State){return[s.title,...s.choices.slice(s.page*this.pageSize,(s.page+1)*this.pageSize).map((c,i)=>`${s.page*this.pageSize+i+1}. ${c.label}`),...(s.choices.length>this.pageSize?[`第 ${s.page+1}/${Math.ceil(s.choices.length/this.pageSize)} 页；n 下一页，p 上一页`]:[]),'回复编号选择；0 关闭。菜单5分钟有效；发送其他任务文字会关闭菜单并执行该任务。'].join('\n');}
}
