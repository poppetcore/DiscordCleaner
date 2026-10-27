// Unofficial derivative of https://github.com/victornpb/undiscord (MIT + attribution).
import { installRuntime } from './runtime-install.js';
const busy = phase => ['preparing','searching','awaiting-confirmation','running','search-wait','rate-wait','retry-wait','stopping'].includes(phase);
const targetKey='discordCleaner.target.v1';
const key = id => `tab:${id}`;
const allowedUrl = value => {try {const url=new URL(value);return url.origin==='https://discord.com'&&url.pathname.startsWith('/channels/');}catch{return false;}};
const locks = new Map();
async function serialized(id, action) {
  const previous=locks.get(id)||Promise.resolve();
  const next=previous.catch(()=>{}).then(action);locks.set(id,next);
  try{return await next;}finally{if(locks.get(id)===next)locks.delete(id);}
}
async function saved(id) {return (await chrome.storage.session.get(key(id)))[key(id)];}
async function interrupt(id, message, closed=false) {
  return serialized(id,async()=>{
    const selected=(await chrome.storage.session.get(targetKey))[targetKey];
    if(closed&&selected?.tabId===id)await chrome.storage.session.set({[targetKey]:null});
    const row=await saved(id);if(!row)return;
    if(busy(row.last?.phase))row.interruption={...row.last,phase:'interrupted',reason:message};
    if(row.interruption)row.last=row.interruption;
    row.closed=closed;await chrome.storage.session.set({[key(id)]:row});
  });
}
chrome.tabs.onRemoved.addListener(id=>{void interrupt(id,'대상 탭이 닫혔습니다. 마지막 조회 이후의 완료 여부와 최종 집계는 확인할 수 없습니다.',true);});
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading'||change.discarded===true||change.url&&!allowedUrl(change.url))void interrupt(id,'탭 새로고침/이동으로 이전 작업이 종료되었습니다. 마지막 조회 시점의 집계입니다.');});
async function inspect(tab,row) {
  if(!row?.capability||tab.discarded)return null;
  const [probe]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'MAIN',func:async secret=>{
    const runtime=window[Symbol.for('undiscord.popup.runner.v2')];
    if(!runtime)return null;
    const data=await runtime.dispatch(secret,{type:'status'});
    return {phase:data.phase,scanning:!!data.prescan?.running};
  },args:[row.capability]});return probe?.result;
}
async function list() {
  const tabs=await chrome.tabs.query({url:'https://discord.com/*'});
  const [focused]=await chrome.tabs.query({active:true,currentWindow:true});
  const all=await chrome.storage.session.get(null);
  const valid=tabs.filter(tab=>allowedUrl(tab.url));
  const states=await Promise.all(valid.map(async tab=>{
    const row=all[key(tab.id)];
    if(tab.discarded){await interrupt(tab.id,'Discord 탭이 폐기되어 작업이 중단되었습니다. 마지막 조회 기준 집계입니다.');return null;}
    try {return await inspect(tab,row);}catch{return null;}
  }));
  const remembered=all[targetKey];
  const selectedTabId=valid.some(tab=>tab.id===remembered?.tabId)?remembered.tabId:null;
  if(remembered&&selectedTabId===null)await chrome.storage.session.set({[targetKey]:null});
  return {activeTabId:focused?.id,selectedTabId,
    runningTabIds:valid.filter((tab,i)=>busy(states[i]?.phase)).map(tab=>tab.id),
    scanningTabIds:valid.filter((tab,i)=>states[i]?.scanning).map(tab=>tab.id),
    tabs:valid.map(tab=>({id:tab.id,title:tab.title||'Discord',url:tab.url,active:tab.active,discarded:!!tab.discarded})),
    lost:Object.values(all).filter(row=>row?.interruption).map(row=>row.interruption).slice(-10)};
}
async function selectTarget(tabId) {
  if(!Number.isInteger(tabId))throw new Error('작업할 Discord 탭을 선택해 주세요.');
  const tab=await chrome.tabs.get(tabId);
  if(!allowedUrl(tab.url)||tab.discarded)throw new Error('Discord 탭에 연결할 수 없습니다.');
  await preventConcurrentJob(tabId);
  await chrome.storage.session.set({[targetKey]:{tabId}});
  return {tabId};
}
async function command(tabId, command) {
  if(!Number.isInteger(tabId)||!command||typeof command!=='object')throw new Error('대상 탭을 선택해 주세요.');
  if(!['status','context','dm-list','prepare','confirm','stop','clear'].includes(command.type))throw new Error('허용되지 않은 명령입니다.');
  const fields={status:['type'],context:['type','authorId'],'dm-list':['type','refresh'],clear:['type'],prepare:['type','mode','options','expectedPath'],confirm:['type','jobId'],stop:['type','jobId']};
  if(Object.keys(command).some(field=>!fields[command.type].includes(field)))throw new Error('명령 형식 오류');
  return serialized(tabId, async()=>{
    const tab=await chrome.tabs.get(tabId);
    if(!allowedUrl(tab.url))throw new Error('Discord 탭에 연결할 수 없습니다.');
    if(tab.discarded)throw new Error('Discord 탭이 폐기되어 작업이 중단되었습니다. 탭을 다시 연 뒤 확인해 주세요.');
    let row=await saved(tabId);
    if(!row){row={capability:crypto.randomUUID()+crypto.randomUUID(),last:null};await chrome.storage.session.set({[key(tabId)]:row});}
    const [installed]=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func:installRuntime,args:[row.capability]});
    if(installed?.result?.version!==12&&['dm-list','prepare','confirm'].includes(command.type))throw new Error('Discord 탭을 새로고침하여 최신 실행 코드를 적용해 주세요.');
    if(installed?.result?.fresh&&busy(row.last?.phase))row.interruption={...row.last,phase:'interrupted',reason:'페이지 실행 환경이 새로 생성되어 이전 작업은 종료되었습니다. 집계는 마지막 조회 기준입니다.'};
    const [result]=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func:async(secret,payload)=>{
      try {
        const runtime=window[Symbol.for('undiscord.popup.runner.v2')];
        if(!runtime)return {ok:false,error:'탭 실행 환경이 변경되었습니다. 다시 조회해 주세요.'};
        return {ok:true,data:await runtime.dispatch(secret,payload)};
      }catch(error){return {ok:false,error:error.message||'작업 명령에 실패했습니다.'};}
    },args:[row.capability,command]});
    if(!result?.result?.ok)throw new Error(result?.result?.error||'Discord 탭과 통신하지 못했습니다.');
    let data=result.result.data;
    if(command.type==='status'&&row.interruption&&data.phase==='idle')data={...data,...row.interruption,context:data.context,path:data.path,dmList:data.dmList,logs:[]};
    if(command.type==='status')data.runtimeChanged=!!installed?.result?.fresh;
    if(command.type==='prepare')row.interruption=null;
    if(['prepare','dm-list'].includes(command.type))await chrome.storage.session.set({[targetKey]:{tabId}});
    if(data.phase){
      // Persist only a small status mirror. No auth tokens, previews or message logs.
      row.last={phase:data.phase,jobId:data.jobId,counts:data.counts,progress:data.progress,mode:data.mode,batch:data.batch,preparation:data.preparation,result:data.result,reason:data.reason,tabId};
      row.closed=false;await chrome.storage.session.set({[key(tabId)]:row});
      data.interruption=row.interruption||null;
    }
    return data;
  });
}
async function preventConcurrentJob(tabId) {
  const all=await chrome.storage.session.get(null);
  for(const [storageKey,row] of Object.entries(all)) {
    if(!storageKey.startsWith('tab:'))continue;
    const otherId=Number(storageKey.slice(4));if(otherId===tabId)continue;
    let tab;
    try{tab=await chrome.tabs.get(otherId);}catch{continue;}
    if(!allowedUrl(tab.url)||tab.discarded)continue;
    const [probe]=await chrome.scripting.executeScript({target:{tabId:otherId,frameIds:[0]},world:'MAIN',func:async secret=>{
      const runtime=window[Symbol.for('undiscord.popup.runner.v2')];
      return runtime?await runtime.dispatch(secret,{type:'status'}):null;
    },args:[row.capability]});
    if(busy(probe?.result?.phase))throw new Error('다른 Discord 탭에서 작업이 진행 중입니다. 해당 탭의 작업을 먼저 완료하거나 중단해 주세요.');
  }
}
// Only one tab may issue background DM inspections. Drain it before another
// tab starts metadata/search/delete work; all requests within a tab share lanes.
async function stopOtherScans(tabId) {
  const all=await chrome.storage.session.get(null);
  for(const storageKey of Object.keys(all)) {
    if(!storageKey.startsWith('tab:'))continue;
    const otherId=Number(storageKey.slice(4));if(otherId===tabId)continue;
    let tab;try{tab=await chrome.tabs.get(otherId);}catch{continue;}
    if(!allowedUrl(tab.url)||tab.discarded)continue;
    const row=all[storageKey];
    await serialized(otherId,()=>chrome.scripting.executeScript({target:{tabId:otherId,frameIds:[0]},world:'MAIN',func:async secret=>{
      const runtime=window[Symbol.for('undiscord.popup.runner.v2')];
      if([8,9,10,11].includes(runtime?.version))await runtime.dispatch(secret,{type:'dm-prescan-stop'});
    },args:[row.capability]}));
  }
}
export async function handleMessage(message,sender) {
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup/popup.html')||sender.tab)throw new Error('허용되지 않은 발신자입니다.');
  if(!message||Object.keys(message).some(field=>!['type','tabId','command'].includes(field)))throw new Error('명령 형식 오류');
  if(message.type==='list')return list();
  if(message.type==='select-target'){if(message.command)throw new Error('명령 형식 오류');return serialized('prepare',()=>selectTarget(message.tabId));}
  if(message.type==='command') {
    if(['prepare','confirm','dm-list'].includes(message.command?.type))return serialized('prepare',async()=>{
      await preventConcurrentJob(message.tabId);
      await stopOtherScans(message.tabId);
      return command(message.tabId,message.command);
    });
    return command(message.tabId,message.command);
  }
  throw new Error('허용되지 않은 명령입니다.');
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  handleMessage(message,sender).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error.message||'통신 오류'}));
  return true;
});
