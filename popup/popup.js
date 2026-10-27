// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
// Popup owns controls only. All jobs and status live in the automatically resolved Discord tab.
const $=selector=>document.querySelector(selector);
const valueIds=['authorId','guildId','channelId','minId','maxId','minDate','maxDate','search','pattern','searchDelay','deleteDelay'];
const flagIds=['hasLink','hasFile','includeNsfw','includePinned'];
const phases={preparing:'삭제 작업 준비 중',idle:'대기 중',searching:'검색 중', 'awaiting-confirmation':'삭제 확인 대기',running:'삭제 중',stopping:'중단 처리 중',interrupted:'중단됨',stopped:'중단됨',unprocessed:'미처리',completed:'완료',partial:'일부 미처리','search-wait':'다음 검색 대기 중','rate-wait':'Discord 요청 제한 대기 중','retry-wait':'요청 재시도 대기 중',error:'오류'};
const preferenceKey='discordCleaner.popupPreferences.v1';
let preferences={};
let actionError='',clientLogs=[],commandRevision=0;
let interruptionSeen='';
const dmSelectionKey='discordCleaner.dmSelection.v1';
let rememberedDMSelection=null,selectionRestoredFor='',selectionSaved='',selectionWrite=Promise.resolve();
const delayBounds={searchDelay:{min:100,max:60000,fallback:30000,label:'검색 간격'},deleteDelay:{min:50,max:10000,fallback:1000,label:'삭제 간격'}};
const lastValidDelay={searchDelay:30000,deleteDelay:1000};
let preferenceWrite=Promise.resolve();
let filterMode='',pinnedByMode={single:false,batch:true};
let dmData=null, dmSelected=new Set(),dmLoading=false,dmLoadedFor='',dmEpoch=0;
let liveContext=null, jobContext=null, selectionIssue='', initialized=false, refreshQueued=false;
let selected=null,current=null,currentPath='',polling=false,generation=0,lastLogs='',restoredJob='',busyCommand=false;
const active=state=>state&&['preparing','searching','awaiting-confirmation','running','search-wait','rate-wait','retry-wait','stopping'].includes(state.phase);
function notice(text){$('#noticeBox').hidden=!text&&$('#openDiscord').hidden;$('#notice').textContent=text;$('#notice').dataset.tone=/실패|오류|불가|없습니다|올바른/.test(text)?'error':'info';}
function jobNotice(text){$('#jobNotice').textContent=text;$('#jobNotice').hidden=!text;}
let modalReturnFocus=null,confirmationLayout=null;
function resizeConfirmation(){
  if(!confirmationLayout||$('#confirmation').hidden)return;
  const extra=$('#confirmationFilters').open?$('#confirmationConditions').scrollHeight+12:0;
  $('#panel-delete').style.height=Math.min(confirmationLayout.limit,confirmationLayout.base+extra)+'px';
}
function setConfirmationLayout(open){
  const panel=$('#panel-delete');
  if(open&&!confirmationLayout){
    activateTab($('#tab-delete'));
    const rect=panel.getBoundingClientRect();
    const base=rect.height;
    const maximum=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--popup-limit'))||600;
    const bottom=parseFloat(getComputedStyle(document.body).paddingBottom)||16;
    confirmationLayout={base,limit:Math.max(base,maximum-rect.top-bottom),height:panel.style.height};
    panel.style.height=base+'px';panel.scrollTop=0;
  }
  $('#appContent').classList.toggle('confirmation-open',open);
  // The dialog is inside appContent: never inert its own ancestor.
  $('#appHeader').inert=open;$('#appTabs').inert=open;
  for(const child of panel.children)if(child.id!=='confirmation')child.inert=open;
  if(!open&&confirmationLayout){panel.style.height=confirmationLayout.height;confirmationLayout=null;}
}
$('#confirmationFilters').ontoggle=resizeConfirmation;
function setModal(id,open){
  if(id==='confirmation'&&open)$('#linkDialog').hidden=true;
  const element=$('#'+id),wasOpen=!element.hidden;
  if(open&&!wasOpen){
    modalReturnFocus=document.activeElement;
    if(id==='confirmation'){$('#confirmationFilters').open=false;$('#confirmationContent').scrollTop=0;setConfirmationLayout(true);}
  }
  element.hidden=!open;
  if(id==='confirmation'&&!open&&wasOpen)setConfirmationLayout(false);
  const anyOpen=!$('#confirmation').hidden||!$('#linkDialog').hidden;
  $('#appContent').inert=!$('#linkDialog').hidden;
  document.body?.classList.toggle('modal-open',anyOpen);
  if(open&&!wasOpen)$('#'+(id==='confirmation'?'reject':'messageLink')).focus?.();
  if(!open&&wasOpen&&!anyOpen){
    if(modalReturnFocus?.isConnected&&!modalReturnFocus.disabled)modalReturnFocus.focus?.();
    else $('#'+(active(current)?'stop':'start')).focus?.();
  }
}
document.addEventListener?.('keydown',event=>{
  const modal=!$('#confirmation').hidden?$('#confirmation'):!$('#linkDialog').hidden?$('#linkDialog'):null;
  if(!modal)return;
  if(event.key==='Escape') {event.preventDefault();if(modal.id==='confirmation')$('#reject').click();else $('#cancelLink').click();return;}
  if(event.key!=='Tab')return;
  const focusable=Array.from(modal.querySelectorAll('button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')).filter(element=>element.getClientRects().length>0);
  if(!focusable.length){event.preventDefault();return;}
  const first=focusable[0],last=focusable.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
async function send(message){const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw new Error(result?.error||'확장프로그램과 통신하지 못했습니다.');return result.data;}
async function command(type,fields={}) {
  if(selected===null)throw new Error('작업할 Discord 탭을 선택해 주세요.');
  return send({type:'command',tabId:selected,command:{type,...fields}});
}
function restore(options) {
  for(const id of valueIds)$('#'+id).value=id==='searchDelay'?'30000':id==='deleteDelay'?'1000':'';
  for(const id of flagIds)$('#'+id).checked=false;
  if(options){
    for(const id of ['authorId','guildId','channelId','pattern','searchDelay','deleteDelay'])$('#'+id).value=options[id]??'';
    $('#search').value=options.content||'';
    for(const id of ['minId','maxId']) {const value=options[id]||'';$('#'+(value.includes(':')?id==='minId'?'minDate':'maxDate':id)).value=value;}
    for(const id of flagIds)$('#'+id).checked=!!options[id];
  }
  $('#serverScope').checked=!!options&&options.guildId!=='@me'&&!options.channelId;
  delays();
}
function delayValue(id){
  const raw=$('#'+id).value.trim(),rule=delayBounds[id];
  if(!/^\d+$/.test(raw))return null;
  const value=Number(raw);return Number.isSafeInteger(value)&&value>=rule.min&&value<=rule.max?value:null;
}
function delays(){
  for(const id of Object.keys(delayBounds)){
    const value=delayValue(id);if(value!==null)lastValidDelay[id]=value;
    $('#'+id+'Value').textContent=value===null?'':value+'ms';
    $('#'+id).setAttribute('aria-invalid',String($('#'+id).value!==''&&value===null));
  }
}
function checkedDelay(id){
  const value=delayValue(id),rule=delayBounds[id];
  if(value===null){$('#'+id).setAttribute('aria-invalid','true');throw new Error(`${rule.label}은 ${rule.min}~${rule.max} 사이의 정수로 입력해 주세요.`);}
  return value;
}
function savePreferences(changes){
  Object.assign(preferences,changes);const next={...preferences};
  preferenceWrite=preferenceWrite.catch(()=>{}).then(()=>chrome.storage.local.set({[preferenceKey]:next}));
  // Keep controls responsive if the browser refuses a preference write.
  void preferenceWrite.catch(()=>notice('설정을 저장하지 못했습니다. 팝업을 다시 열기 전에 설정을 확인해 주세요.'));
}
function applyPrivacy(){
  $('#undiscord').classList.toggle('redact',$('#redact').checked);
  maskProgressTitles();
  if(liveContext)updateContext(liveContext);
}
async function initializePopup(){
  restore(null);$('#start').disabled=true;
  try{
    const data=(await chrome.storage.local.get(preferenceKey))?.[preferenceKey];
    if(data&&typeof data==='object'&&!Array.isArray(data)){
      for(const key of ['redact'])if(typeof data[key]==='boolean')preferences[key]=data[key];
      for(const key of Object.keys(delayBounds)){
        const rule=delayBounds[key];
        if(Number.isInteger(data[key])&&data[key]>=rule.min&&data[key]<=rule.max)preferences[key]=data[key];
      }
    }
  }catch{notice('저장된 설정을 불러오지 못했습니다.');}
  for(const key of Object.keys(delayBounds))if(key in preferences)$('#'+key).value=preferences[key];
  if('redact' in preferences)$('#redact').checked=preferences.redact;
  try{rememberedDMSelection=(await chrome.storage.session?.get(dmSelectionKey))?.[dmSelectionKey]||null;}catch{}
  delays();applyPrivacy();await poll();setInterval(poll,1000);
}
function readOptions(){
  const text=id=>$('#'+id).value.trim();
  const options={authorId:text('authorId'),guildId:text('guildId'),channelId:text('channelId'),minId:text('minId')||text('minDate'),maxId:text('maxId')||text('maxDate'),content:text('search'),pattern:text('pattern'),searchDelay:liveContext?.isFriends?2000:checkedDelay('searchDelay'),deleteDelay:checkedDelay('deleteDelay')};
  for(const id of flagIds)options[id]=$('#'+id).checked;
  return options;
}
function readBatchFilters(){const {authorId,guildId,channelId,...filters}=readOptions();filters.includeNsfw=false;return filters;}
$('#includePinned').onchange=()=>{if(filterMode)pinnedByMode[filterMode]=$('#includePinned').checked;};
// The tab runner owns the global denominator and final outcome ledger.
function calculateProgress(state) {
  const p=state?.progress;
  if(!p||!p.known||!Number.isFinite(p.value))return {known:false,value:0};
  return {...p,value:Math.min(100,Math.max(0,p.value))};
}
function updateProgressBar(state) {
  const bar=$('#progressBar'),progress=calculateProgress(state);
  bar.hidden=!state?.jobId;
  bar.max=100;
  if(progress.known)bar.value=progress.value;
  else bar.removeAttribute('value');
  bar.setAttribute('aria-valuetext',progress.known?
    `${state.batch?'DM':'확인된 대상'} ${progress.total}개 중 ${progress.processed}개 처리`:'전체 검색 건수 확인 중');
}
// Display-only mapping: options continue to be sent unchanged to the runner.
function confirmationRows(state) {
  /* Batch and single jobs share the same filter summary below. */
  const o=state.options||{},info=state.jobContext||{};
  const user=info.users?.find(user=>user.id===o.authorId);
  const author=!o.authorId?'전체 작성자':user?.displayName&&user.username?`${user.displayName} (${user.username})`:user?.displayName||user?.username||`사용자 ID ${o.authorId}`;
  const summary=state.batch?[['선택한 DM',`${state.batch.channels.length}개`],['삭제 대상','현재 로그인한 본인의 메시지'],['보존 대상','선택하지 않은 DM은 검색·삭제하지 않습니다.']]:info.isDM?[['DM 대상',info.guildName||'정보 확인 불가']]:[
    ['서버',info.guildName||'정보 확인 불가'],['채널',!o.channelId?'서버 전체 채널':info.channelName?`# ${info.channelName}`:'정보 확인 불가']];
  summary.push(['작성자',state.batch?'현재 로그인한 본인':author],['확인된 삭제 대상',`${state.counts?.targets||0}개 (검색 중 추가될 수 있음)`]);
  const boundary=(value,direction)=>!value?'제한 없음':/^\d+$/.test(value)?`메시지 ID ${value} ${direction}`:`${value.replace('T',' ')} ${direction} (현지 시간)`;
  return {summary,conditions:[
    ['검색어',o.content||'없음'],['시작 경계',boundary(o.minId,'이후')],['종료 경계',boundary(o.maxId,'이전')],
    ['링크 조건',o.hasLink?'링크가 포함된 메시지만':'미적용'],['파일 조건',o.hasFile?'첨부파일이 포함된 메시지만':'미적용'],
    ['고정 메시지',o.includePinned?'포함':'제외'],['NSFW 채널',state.batch?'DM에는 미적용':o.includeNsfw?'검색에 포함':'검색에 포함하지 않음'],
    ['정규식',o.pattern||'미사용'],['페이지 검색 간격',Number.isFinite(o.searchDelay)?`${o.searchDelay}ms`:'확인 불가'],['삭제 간격',Number.isFinite(o.deleteDelay)?`${o.deleteDelay}ms`:'확인 불가']
  ]};
}
function renderConfirmation(state) {
  if(state.phase!=='awaiting-confirmation')return;
  const rows=confirmationRows(state);
  for(const [id,values] of [['confirmationScope',rows.summary],['confirmationConditions',rows.conditions]]){
    const container=$('#'+id),signature=JSON.stringify(values);
    if(container.dataset.signature===signature)continue;
    container.dataset.signature=signature;container.replaceChildren();
    for(const [label,value] of values){
      const term=document.createElement('dt'),description=document.createElement('dd');
      term.textContent=label;description.textContent=value;if(['작성자','서버','채널','DM 대상','검색어','시작 경계','종료 경계','정규식'].includes(label))description.setAttribute('priv','');
      container.append(term,description);
    }
  }
}
// Presentation only: disjoint DM categories; no API calls or job-state writes.
let progressViewKey='',historyExpanded=false;
const rowCategories={done:'삭제 완료',empty:'메시지 없음',uncertain:'확인 불가',error:'오류',pending:'처리 대기',active:'처리 중'};
function dmCategory(row){
  if(row.status==='unprocessed')return 'pending';
  if(row.status==='running')return 'active';
  if(row.status==='error'||(row.counts?.failed||0)>0)return 'error';
  if(row.status==='completed'&&row.searchComplete===true){
    if(row.presence==='none-in-query')return 'empty';
    if(row.presence==='present'&&(row.counts?.success||0)>0&&!(row.counts?.pending||0))return 'done';
  }
  return 'uncertain';
}
function conciseReason(reason){
  const text=String(reason||'');
  if(/401|인증.*만료/.test(text))return '인증 만료 · 다시 로그인해 주세요.';
  if(/403|접근 권한/.test(text))return '접근 권한을 확인할 수 없습니다.';
  if(/계정.*변경|계정.*확인/.test(text))return '로그인 계정을 다시 확인해 주세요.';
  if(/채널 이동|대상.*변경|접근 정보.*변경/.test(text))return '작업 대상이 변경되었습니다.';
  if(/중단|Stopped|AbortError/.test(text))return '작업이 중단되었습니다.';
  if(/인덱싱/.test(text))return '검색 인덱싱을 확인하지 못했습니다.';
  if(/요청 제한/.test(text))return '요청 제한 · 상세 로그를 확인해 주세요.';
  if(/미확정|삭제 응답/.test(text))return '삭제 결과를 확인하지 못했습니다.';
  if(/네트워크/.test(text))return '네트워크 연결을 확인해 주세요.';
  if(/불완전|검색|커서|응답/.test(text))return '검색 결과를 확정할 수 없습니다.';
  return '상세 로그에서 사유를 확인해 주세요.';
}
function privateProgressTitle(node,value){node.title=$('#redact').checked?'':String(value||'');}
function maskProgressTitles(){
  for(const id of ['targetName','targetFilters'])privateProgressTitle($('#'+id),$('#'+id).textContent);
  for(const row of $('#recentResults').children)privateProgressTitle(row.children[0],row.children[0].textContent);
}
function setProgressText(id,value){const node=$('#'+id),text=String(value);if(node.textContent!==text)node.textContent=text;}
function filterSummary(options){
  const o=options||{},parts=[];
  if(o.content)parts.push('검색어: '+o.content);
  if(o.pattern)parts.push('정규식');
  if(o.minId||o.maxId)parts.push('기간·ID 범위');
  if(o.hasLink)parts.push('링크');if(o.hasFile)parts.push('첨부파일');
  if(o.includePinned===false)parts.push('고정 메시지 제외');
  return parts.length?parts.join(' · '):'전체 메시지';
}
function renderProgressCards(state){
  const key=`${selected}:${state.jobId||'idle'}`;
  if(key!==progressViewKey){progressViewKey=key;historyExpanded=false;$('#logDetails').open=false;$('#recentResults').scrollTop=0;}
  const known=!!state.jobId,working=active(state),rows=state.batch?.channels||[];
  const terminal=['completed','partial','error','stopped','interrupted'].includes(state.phase);
  setProgressText('jobStatus',({searching:'검색 중',running:'삭제 중','search-wait':'검색 대기','rate-wait':'요청 제한 대기','retry-wait':'재시도 대기',completed:'완료',partial:'일부 미완료',stopped:'중단',interrupted:'중단',error:'오류',preparing:'준비 중','awaiting-confirmation':'확인 대기',stopping:'중단 중'})[state.phase]||'대기 중');
  $('#jobStatus').dataset.phase=state.phase;
  const count=state.counts||{},p=calculateProgress(state);
  setProgressText('messageScope',!known?'작업 대기':rows.some(r=>!r.searchComplete)||!p.known?'메시지 수 미확정':'확인된 결과');
  setProgressText('pendingMessages',`미처리 메시지 ${known?(count.pending||0):'—'}`);
  const classified=rows.map(row=>({row,category:dmCategory(row)}));
  const totals={done:0,empty:0,uncertain:0,error:0,pending:0,active:0};
  for(const item of classified)totals[item.category]++;
  const processed=Number.isFinite(state.progress?.processed)?state.progress.processed:rows.filter(row=>['completed','partial','error'].includes(row.status)).length;
  setProgressText('progressScope',!known?'진행 대기':state.batch?`DM ${processed} / ${rows.length}개 처리`:p.known?`메시지 ${p.processed||0} / ${p.total||0}개 처리`:'메시지 수 확인 중');
  const row=working&&state.batch&&state.batch.current>=0&&rows[state.batch.current]?.status==='running'?rows[state.batch.current]:null;
  const single=working&&!state.batch&&state.options&&state.phase!=='preparing';
  const info=state.jobContext||{};
  const name=row?row.displayName||row.username||'DM':single?state.options.channelId?(info.channelName||info.guildName||'현재 채널'):'서버 전체 채널':state.phase==='preparing'?'대상 확인 중':!terminal&&state.batch?'선택한 DM '+rows.length+'개':'진행 중인 대상 없음';
  setProgressText('currentTargetHeading',terminal?'작업 대상':'현재 처리 중');
  setProgressText('targetName',name);privateProgressTitle($('#targetName'),name);
  setProgressText('targetStatus',row||single?state.phase==='running'?'메시지 삭제 중':state.phase==='searching'?'메시지 검색 중':phases[state.phase]||'처리 중':terminal?'처리 종료':state.phase==='awaiting-confirmation'?'확인 대기':'대기');
  $('#targetStatus').dataset.kind=row||single?'active':'pending';
  const targetCounts=row?.counts||(single?count:null);
  setProgressText('targetCount',targetCounts?.targets??'—');setProgressText('targetSuccess',targetCounts?.success??'—');
  const summary=known?filterSummary(state.options):'전체 메시지';setProgressText('targetFilters',summary);privateProgressTitle($('#targetFilters'),summary);
  const seconds=Math.max(0,Math.ceil((Number(state.wait?.until||0)-Date.now())/1000));
  const waitLabels={'rate-limit':'서버 요청 제한',indexing:'검색 인덱싱',retry:'연결 재시도','next-search':'다음 검색',scheduler:'요청 간격'};
  $('#waitStatus').hidden=!(working&&seconds&&waitLabels[state.wait?.kind]);
  setProgressText('waitStatus',`${seconds}초 후 재개`);
  $('#waitStatus').setAttribute('aria-label',`${waitLabels[state.wait?.kind]||'대기'} · ${seconds}초 후 재개`);
  $('#dmResultCard').hidden=!state.batch;$('#recentCard').hidden=!state.batch;
  for(const [id,value] of Object.entries({dmDone:totals.done,dmEmpty:totals.empty,dmUncertain:totals.uncertain,dmErrors:totals.error,dmPending:totals.pending}))setProgressText(id,value);
  setProgressText('dmProcessed',`${processed} / ${rows.length}개 처리`);
  const finished=classified.filter(item=>!['active','pending'].includes(item.category)).reverse();
  const visible=historyExpanded?[...finished,...classified.filter(item=>['active','pending'].includes(item.category))]:finished.slice(0,3);
  $('#toggleHistory').hidden=rows.length<=3;$('#toggleHistory').setAttribute('aria-expanded',String(historyExpanded));
  setProgressText('toggleHistory',historyExpanded?'최근만 보기':'전체 보기');setProgressText('recentHeading',historyExpanded?'DM 처리 내역':'최근 처리 내역');
  $('#recentEmpty').hidden=visible.length>0;
  const list=$('#recentResults'),scrollTop=list.scrollTop,existing=new Map(Array.from(list.children).map(node=>[node.dataset.channelId,node]));
  const wanted=new Set(visible.map(item=>item.row.channelId));
  for(const node of Array.from(list.children))if(!wanted.has(node.dataset.channelId))list.removeChild(node);
  for(const [index,{row,category}] of visible.entries()){
    let item=existing.get(row.channelId);
    if(!item){
      item=document.createElement('div');item.className='recent-item';item.dataset.channelId=row.channelId;item.setAttribute('role','listitem');
      const name=document.createElement('strong'),badge=document.createElement('span'),detail=document.createElement('span');
      name.className='recent-name';name.setAttribute('priv','');badge.className='state-chip';detail.className='recent-detail';item.append(name,badge,detail);
    }
    const signature=JSON.stringify([row.displayName,row.username,category,row.status,row.counts?.success,row.counts?.failed,row.reason]);
    if(item.dataset.signature!==signature){
      const [name,badge,detail]=item.children;name.textContent=row.displayName||row.username||'DM';privateProgressTitle(name,name.textContent);
      badge.textContent=['stopped','interrupted'].includes(row.status)?'작업 중단':rowCategories[category];badge.dataset.kind=category;
      detail.textContent=category==='done'?`${row.counts?.success||0}개 삭제`:category==='error'&&(row.counts?.failed||0)>0?`삭제 실패 ${row.counts.failed}개`:['error','uncertain'].includes(category)?conciseReason(row.reason):category==='empty'?'현재 검색 조건 기준':category==='active'?'진행 중':'아직 시작하지 않음';
      item.dataset.signature=signature;
    }
    if(list.children[index]!==item)list.insertBefore(item,list.children[index]||null);
  }
  list.scrollTop=scrollTop;
}
$('#toggleHistory').onclick=()=>{$('#recentResults').scrollTop=0;historyExpanded=!historyExpanded;if(current)renderProgressCards(current);};
function render(state) {
  current=state;currentPath=state.path;
  $('#confirmTitle').textContent=state.batch?'DM 메시지 일괄 삭제 확인':'메시지 삭제 확인';
  jobContext=state.jobContext||null;
  if(state.context)updateContext(state.context);
  if(state.jobId&&state.jobId!==restoredJob){
    restore(state.options);
    if(!active(state)){
      for(const key of Object.keys(delayBounds))if(key in preferences)$('#'+key).value=preferences[key];
      delays();
    }
    pinnedByMode[state.batch?'batch':'single']=$('#includePinned').checked;if(filterMode)$('#includePinned').checked=pinnedByMode[filterMode];restoredJob=state.jobId;
  }
  const running=active(state);
  $('#busyDot').hidden=!running;
  $('#start').disabled=running||selected===null||busyCommand||!canStart(liveContext);
  $('#stop').disabled=!running;
  for(const id of ['clear'])$('#'+id).disabled=selected===null;
  // Pending confirmation is restored by polling after any popup reopen.
  renderConfirmation(state);
  setModal('confirmation',state.phase==='awaiting-confirmation');
  for(const id of ['approve','reject','closeConfirmation'])$('#'+id).disabled=busyCommand;
  const count=state.counts||{};
  const known=!!state.jobId;
  const validCount=value=>Number.isFinite(value)&&value>=0;
  setProgressText('countTotal',known&&validCount(count.targets)?String(count.targets):'—');
  setProgressText('countSuccess',known&&validCount(count.success)?String(count.success):'—');
  setProgressText('countFailed',known&&validCount(count.failed)?String(count.failed):'—');
  renderProgressCards(state);
  updateProgressBar(state);
  updateDMSelection();
  const important=actionError||state.interruption?.reason||(['error','stopped','interrupted','partial'].includes(state.phase)?state.reason||state.error:'');
  jobNotice(important?conciseReason(important):'');
  notice(actionError|| (state.phase==='error'?(state.error||state.reason):state.phase==='preparing'?(state.preparation?.stage||'삭제 작업 준비 중'):state.phase==='awaiting-confirmation'?'범위를 확인하고 “삭제 시작”을 눌러주세요.':''));
  const displayLogs=[...(state.logs||[]),...clientLogs];
  const signature=JSON.stringify(displayLogs);
  if(signature!==lastLogs){
    lastLogs=signature;const logScrollTop=$('#logArea').scrollTop;$('#logArea').replaceChildren();
    for(const [index,item] of displayLogs.entries()){
      const row=document.createElement('div');row.className='log';
      const order=document.createElement('span'),level=document.createElement('span'),message=document.createElement('span');
      const timestamp=item.timestamp??item.at;
      const date=timestamp===undefined?null:new Date(timestamp);
      order.textContent=date&&Number.isFinite(date.getTime())?date.toLocaleTimeString('ko-KR',{hour12:false}):String(index+1).padStart(3,'0');
      order.className='log-order';order.setAttribute('aria-label',date&&Number.isFinite(date.getTime())?'기록 시각':'기록 순서');
      level.textContent=({error:'오류',warn:'주의',info:'정보',debug:'상세'})[item.type]||'기록';level.className='log-level';
      message.textContent=String(item.text||'');message.className='log-message';row.append(order,level,message);$('#logArea').appendChild(row);
    }
    if($('#autoScroll').checked)$('#logArea').scrollTop=$('#logArea').scrollHeight;else $('#logArea').scrollTop=logScrollTop;
  }
}
function authorLabel(id,info=liveContext) {
  if(!id)return '전체 작성자';
  if($('#redact').checked)return '••••••';
  const user=info?.users?.find(user=>user.id===id);
  return user?.displayName&&user.username?`${user.displayName} (${user.username})`:'정보 확인 불가';
}
function authorAllowed(info=liveContext) {
  const wanted=$('#authorId').value;
  return !info?.isDM||!wanted||(info.users||[]).some(user=>user.id===wanted);
}
function updateContext(info) {
  const moved=!!liveContext&&liveContext.path!==info.path;
  const entering=info.isFriends&&!liveContext?.isFriends;
  liveContext=info;currentPath=info.path;
  $('#appContent').classList.toggle('batch-mode',!!info.isFriends);$('#undiscord').classList.toggle('batch-mode',!!info.isFriends);
  $('#refreshDMs').hidden=!info.isFriends;$('#singleControls').hidden=!!info.isFriends;$('#dmControls').hidden=!info.isFriends;
  $('#tab-delete').textContent=$('#deleteTitle').textContent=info.isFriends?'DM 일괄 삭제':'메시지 삭제';
  $('#tab-filter').hidden=false;
  const nextMode=info.isFriends?'batch':'single';
  if(filterMode!==nextMode){if(filterMode)pinnedByMode[filterMode]=$('#includePinned').checked;$('#includePinned').checked=pinnedByMode[nextMode];filterMode=nextMode;}
  $('#includeNsfw').disabled=!!info.isFriends||active(current)||busyCommand;
  $('#start').textContent=current?.phase==='preparing'?'삭제 작업 준비 중':info.isFriends?'선택한 DM 메시지 삭제':'검색 및 삭제';
  if(entering)activateTab($('#tab-delete'));
  const ownerChanged=dmData&&dmData.ownerId!==info.authorId;
  if(ownerChanged){dmEpoch++;dmData=null;dmSelected.clear();dmLoadedFor='';$('#dmList').replaceChildren();resetDMProgress();}
  if(info.isFriends&&!active(current)&&!dmLoading&&dmLoadedFor!==`${selected}:${info.authorId}`)void loadDMs();
  $('#guildId').value=info.guildId||'';
  if(moved)$('#serverScope').checked=false;
  $('#serverScopeField').hidden=info.isDM;
  $('#channelId').value=info.isDM||!$('#serverScope').checked?info.channelId||'':'';
  $('#guildLabel').textContent=info.isDM?'대화방':'서버';
  $('#guildName').textContent=info.guildName||'정보 확인 불가';
  $('#channelField').hidden=info.isDM;
  $('#channelName').textContent=!info.isDM&&$('#serverScope').checked?'서버 전체 채널':info.channelName?'#'+info.channelName:'정보 확인 불가';
  const wanted=$('#authorId').value;
  const signature=JSON.stringify([info.users,info.authorId,wanted,info.isDM,$('#redact').checked]);
  if($('#authorSelect').dataset.signature!==signature) {
    $('#authorSelect').dataset.signature=signature;
    $('#authorSelect').replaceChildren(new Option('전체 작성자',''));
    for(const user of info.users||[])$('#authorSelect').add(new Option(authorLabel(user.id,info)+(user.id===info.authorId?' · 나':''),user.id));
    if(wanted&&!(info.users||[]).some(user=>user.id===wanted)) {
      const option=new Option(info.isDM?'작성자를 다시 선택해 주세요':'정보 확인 불가 (기존 작성자)',wanted);
      option.disabled=!!info.isDM;$('#authorSelect').add(option);
    }
    $('#authorSelect').value=wanted;
  }
  $('#start').disabled=active(current)||busyCommand||selected===null||!canStart(info);
}
async function resolveTarget() {
  const result=await send({type:'list'});
  const valid=id=>result.tabs.some(tab=>tab.id===id);
  const running=(result.runningTabIds||[]).filter(valid);
  const scanning=(result.scanningTabIds||[]).filter(valid);
  const next=running.length>1?null:running[0]??(valid(selected)?selected:null)??(valid(result.selectedTabId)?result.selectedTabId:null)??(scanning.length===1?scanning[0]:null)??(result.tabs.length===1?result.tabs[0].id:null)??(valid(result.activeTabId)?result.activeTabId:null);
  const picker=$('#targetTab');
  const signature=JSON.stringify([result.tabs,$('#redact').checked]);
  if(picker.dataset.signature!==signature){
    picker.dataset.signature=signature;picker.replaceChildren(new Option('Discord 탭 선택',''));
    for(const [index,tab] of result.tabs.entries()){
      let channel='';try{channel=new URL(tab.url).pathname;}catch{}
      picker.add(new Option($('#redact').checked?`Discord 탭 ${index+1}`:`${tab.title||'Discord'}${channel?' · '+channel:''}`,String(tab.id)));
    }
  }
  picker.value=next===null?'':String(next);picker.disabled=busyCommand||running.length>0||active(current);
  $('#targetControl').hidden=result.tabs.length<2;
  selectionIssue=result.tabs.length?'작업할 Discord 탭을 선택해 주세요.':'열려 있는 Discord 탭이 없습니다.';
  if(result.lost?.length){const last=result.lost.at(-1);selectionIssue+=` 이전 작업이 중단되었습니다. 마지막 조회 기준 성공 ${last.counts?.success??0} / 실패 ${last.counts?.failed??0}. 최종 결과는 확인할 수 없습니다.`;}
  $('#openDiscord').hidden=result.tabs.length!==0;
  if(!initialized||next!==selected) {
    initialized=true;generation++;dmEpoch++;selectionRestoredFor='';dmData=null;dmSelected.clear();dmLoadedFor='';$('#dmList').replaceChildren();resetDMProgress();jobNotice('');actionError='';clientLogs=[];selected=next;current=null;liveContext=null;currentPath='';restoredJob='';lastLogs='';
    // Reset only for an actual target change, never for browser focus changes.
    $('#guildId').value='';$('#channelId').value='';
    $('#guildName').textContent=$('#channelName').textContent='정보 확인 불가';
    setModal('confirmation',false);$('#start').disabled=true;$('#stop').disabled=true;
  }
  if(next===null){notice(selectionIssue);$('#jobStatus').textContent='대상 확인 필요';$('#busyDot').hidden=true;$('#progressBar').hidden=true;for(const id of ['countTotal','countSuccess','countFailed'])$('#'+id).textContent='—';$('#logArea').replaceChildren();$('#clear').disabled=true;}
  return next;
}
async function poll(){
  if(polling){refreshQueued=true;return;}polling=true;refreshQueued=false;
  try {
    if(await resolveTarget()===null)return;
    const epoch=generation;
    const revision=commandRevision;const state=await command('status');if(epoch!==generation||revision!==commandRevision)return;
    const interruptionKey=state.phase==='interrupted'?`${selected}:${state.jobId}:${state.reason}`:'';
    if((state.runtimeChanged&&dmData)||(interruptionKey&&interruptionKey!==interruptionSeen)){
      interruptionSeen=interruptionKey;dmEpoch++;dmData=null;dmSelected.clear();rememberedDMSelection=null;
      selectionRestoredFor=`${selected}:${state.context?.authorId}`;
      dmLoadedFor=interruptionKey?`${selected}:${state.context?.authorId}`:'';
      $('#dmList').replaceChildren();resetDMProgress();
    }
    render(state);
    if(state.dmList&&state.phase!=='preparing')renderDMs(state.dmList);
    // Include selected cached author, even when it is outside the default candidate list.
    const info=await command('context',{authorId:$('#authorId').value});
    if(epoch===generation)updateContext(info);
  } catch(error) {
    notice(error.message||'Discord 탭에 연결할 수 없습니다.');$('#start').disabled=true;$('#stop').disabled=true;
    setModal('confirmation',false);$('#jobStatus').textContent='상태 확인 불가';
  } finally{polling=false;if(refreshQueued)queueMicrotask(poll);}
}
function canStart(info){return info?.isFriends?!!dmData&&!dmLoading&&dmData.ownerId===info.authorId&&dmSelected.size>0:!!info?.channelId&&authorAllowed(info);}
function updateDMSelection(){
  const busy=active(current)||busyCommand;
  const count=dmData?.channels.length||0;
  $('#dmSelection').textContent=dmLoading?'목록 불러오는 중':dmData?`${dmSelected.size}개 선택`:'0개 선택';
  $('#dmList').hidden=!count;$('#dmTotalLabel').textContent=count?`전체 선택 (${count})`:'전체 선택';
  $('#selectAllDMs').checked=count>0&&dmSelected.size===count;
  $('#selectAllDMs').indeterminate=dmSelected.size>0&&dmSelected.size<count;
  $('#selectAllDMs').disabled=busy||dmLoading||!count;
  $('#refreshDMs').disabled=busy||dmLoading;
  for(const input of $('#dmList').querySelectorAll('input'))input.disabled=busy||dmLoading;
  for(const id of [...valueIds,...flagIds])if(!['authorId','guildId','channelId'].includes(id))$('#'+id).disabled=busy||(['includeNsfw','searchDelay'].includes(id)&&!!liveContext?.isFriends);
  $('#batchSearchHint').hidden=!liveContext?.isFriends;
  if(liveContext?.isFriends)$('#start').disabled=busy||!canStart(liveContext);
  if(dmData?.ownerId&&!dmData.loading&&selected!==null){
    const record={tabId:selected,ownerId:dmData.ownerId,channelIds:[...dmSelected]};
    const signature=JSON.stringify(record);
    if(signature!==selectionSaved){selectionSaved=signature;rememberedDMSelection=record;selectionWrite=selectionWrite.catch(()=>{}).then(()=>chrome.storage.session?.set({[dmSelectionKey]:record}));void selectionWrite.catch(()=>{});}
  }
}
function resetDMProgress(){$('#dmCount').textContent='조회된 DM 0개';}
function syncDMRows(container,rows){
  const existing=new Map(Array.from(container.children).map(node=>[node.dataset.channelId,node]));
  const scrollTop=container.scrollTop,wanted=new Set(rows.map(row=>row.channelId));
  for(const node of Array.from(container.children))if(!wanted.has(node.dataset.channelId))container.removeChild(node);
  for(const [index,row] of rows.entries()){
    let label=existing.get(row.channelId);
    if(!label){
      label=document.createElement('label');label.className='check-field dm-row';label.dataset.channelId=row.channelId;
      const input=document.createElement('input');input.type='checkbox';input.dataset.channelId=row.channelId;
      input.onchange=()=>{if(input.checked)dmSelected.add(row.channelId);else dmSelected.delete(row.channelId);updateDMSelection();};label.append(input);
      const text=document.createElement('span');text.className='dm-person';text.setAttribute('priv','');label.append(text);
    }
    const clean=value=>typeof value==='string'?value.trim():'';
    const account=clean(row.username),display=clean(row.displayName)||account||'사용자';
    const signature=JSON.stringify([display,account]);
    if(label.dataset.signature!==signature){
      const name=document.createElement('strong'),username=document.createElement('small');
      name.textContent=display;username.textContent=account&&account!==display?`(${account})`:'';username.hidden=!username.textContent;
      label.children[1].replaceChildren(name,username);label.dataset.signature=signature;
    }
    label.children[0].checked=dmSelected.has(row.channelId);
    if(container.children[index]!==label)container.insertBefore(label,container.children[index]||null);
  }
  container.scrollTop=scrollTop;
}
function renderDMs(data){
  if(!data)return;
  const ownerChanged=dmData?.ownerId!==data.ownerId;
  if(ownerChanged){dmSelected.clear();$('#dmList').replaceChildren();}
  const restoreKey=`${selected}:${data.ownerId}`;
  if(!data.loading&&selectionRestoredFor!==restoreKey){
    selectionRestoredFor=restoreKey;
    if(rememberedDMSelection?.tabId===selected&&rememberedDMSelection.ownerId===data.ownerId)dmSelected=new Set(rememberedDMSelection.channelIds||[]);
  }
  const available=new Set(data.channels.map(row=>row.channelId));
  dmSelected=new Set([...dmSelected].filter(id=>available.has(id)));
  dmData=data;
  $('#dmCount').textContent=`조회된 DM ${data.channels.length}개`;
  $('#dmError').textContent=data.error||(!data.channels.length?'조회 가능한 1:1 DM이 없습니다.':'');
  syncDMRows($('#dmList'),data.channels);
  updateDMSelection();applyPrivacy();
}
async function loadDMs(refresh=false){
  if(dmLoading||active(current))return;
  dmLoading=true;const epoch=++dmEpoch,tab=selected;
  dmLoadedFor=`${selected}:${liveContext?.authorId}`;$('#dmError').textContent='DM 목록을 불러오는 중입니다.';updateDMSelection();
  try {
    const data=await command('dm-list',{refresh});if(epoch!==dmEpoch||tab!==selected)return;
    renderDMs(data);dmLoadedFor=`${selected}:${data?.ownerId||liveContext?.authorId}`;
  }catch(e){if(epoch===dmEpoch){dmData=null;dmSelected.clear();$('#dmError').textContent=e.message;$('#dmList').replaceChildren();}}
  finally{dmLoading=false;updateDMSelection();}
}
$('#refreshDMs').onclick=()=>void loadDMs(true);
$('#selectAllDMs').onchange=()=>{
  if($('#selectAllDMs').checked)dmSelected=new Set(dmData.channels.map(row=>row.channelId));else dmSelected.clear();
  for(const input of $('#dmList').querySelectorAll('input'))input.checked=dmSelected.has(input.dataset.channelId);
  updateDMSelection();
};
function guard(action){return async()=>{try{await action();}catch(error){actionError=error.message||'작업 요청에 실패했습니다.';clientLogs.push({type:'error',text:'요청 실패 · '+actionError});if(clientLogs.length>30)clientLogs.shift();notice(actionError);jobNotice(actionError);}};}
$('#targetTab').onchange=guard(async()=>{
  if(active(current)||busyCommand)return;
  const tabId=Number($('#targetTab').value);if(!Number.isInteger(tabId)||!$('#targetTab').value)return;
  generation++;dmEpoch++;busyCommand=true;$('#targetTab').disabled=true;
  try{await send({type:'select-target',tabId});initialized=false;selected=null;current=null;}
  finally{busyCommand=false;await poll();}
});
$('#openDiscord').onclick=guard(()=>chrome.tabs.create({url:'https://discord.com/channels/@me'}));
$('#authorSelect').onchange=()=>{$('#authorId').value=$('#authorSelect').value;if(liveContext)updateContext(liveContext);};
$('#serverScope').onchange=()=>{if(liveContext)updateContext(liveContext);};
const tabs=Array.from(document.querySelectorAll('[role="tab"]'));
function activateTab(tab,focus=false) {
  for(const item of tabs){const chosen=item===tab;item.setAttribute('aria-selected',String(chosen));item.tabIndex=chosen?0:-1;$('#'+item.getAttribute('aria-controls')).hidden=!chosen;}
  if(focus)tab.focus();
  void poll(); // User-requested refresh on every navigation tab switch.
}
for(const [index,tab] of tabs.entries()) {
  tab.onclick=()=>activateTab(tab);
  tab.onkeydown=event=>{
    const visible=tabs.filter(item=>!item.hidden),position=visible.indexOf(tab);
    const target=event.key==='Home'?0:event.key==='End'?visible.length-1:event.key==='ArrowRight'?(position+1)%visible.length:event.key==='ArrowLeft'?(position+visible.length-1)%visible.length:null;
    if(target!==null){event.preventDefault();activateTab(visible[target],true);}
  };
}
$('#toggleSidebar').onclick=()=>{const hidden=!$('#filterFields').hidden;$('#filterFields').hidden=hidden;$('#toggleSidebar').setAttribute('aria-expanded',String(!hidden));$('#toggleSidebar').textContent=hidden?'상세 필터 펼치기':'상세 필터 접기';};
$('#redact').onchange=()=>{applyPrivacy();savePreferences({redact:$('#redact').checked});};
for(const id of Object.keys(delayBounds)){
  $('#'+id).oninput=()=>{delays();$('#delayError').hidden=true;const value=delayValue(id);if(value!==null)savePreferences({[id]:value});};
  $('#'+id).onblur=()=>{
    if($('#'+id).value===''){$('#'+id).value=lastValidDelay[id];delays();$('#delayError').hidden=true;return;}
    try{const value=checkedDelay(id);savePreferences({[id]:value});$('#delayError').hidden=true;}
    catch(error){$('#delayError').textContent=error.message;$('#delayError').hidden=false;}
  };
}
let linkInputTarget='';
for(const [button,input] of [['pickMessageAfter','minId'],['pickMessageBefore','maxId']])$('#'+button).onclick=()=>{
  linkInputTarget=input;$('#messageLink').value='';$('#linkError').textContent='';setModal('linkDialog',true);
};
$('#cancelLink').onclick=()=>setModal('linkDialog',false);
$('#applyLink').onclick=()=>{
  const match=$('#messageLink').value.trim().match(/^(?:https:\/\/discord\.com\/channels\/(?:@me|\d+)\/\d+\/)?(\d+)$/);
  if(!match){$('#linkError').textContent='올바른 메시지 링크 또는 숫자 ID를 입력해 주세요.';return;}
  $('#'+linkInputTarget).value=match[1];setModal('linkDialog',false);
};
async function applyCommand(type,fields={}) {
  const epoch=generation;const revision=++commandRevision;
  try{const state=await command(type,fields);if(epoch===generation&&revision===commandRevision)render(state);}
  finally{commandRevision++;}
}
$('#start').onclick=guard(async()=>{
  if(busyCommand||active(current)){actionError='현재 작업이 진행 중입니다.';notice(actionError);return;}actionError='';busyCommand=true;$('#start').disabled=true;notice('삭제 작업 준비 중');
  try{
    const previous=selected,expectedPath=currentPath;
    if(await resolveTarget()===null||previous!==selected)throw new Error('대상이 변경되었습니다. 현재 Discord 정보를 확인한 뒤 다시 시작해 주세요.');
    const info=await command('context',{authorId:$('#authorId').value});
    if(info.path!==expectedPath){updateContext(info);throw new Error('Discord 채널이 변경되었습니다. 현재 정보를 확인한 뒤 다시 시작해 주세요.');}
    updateContext(info);
    if(!info.isFriends&&!authorAllowed(info))throw new Error('현재 DM에 참여한 작성자를 다시 선택해 주세요.');
    if(info.isFriends){
      if(!canStart(info))throw new Error('DM 목록을 확인하고 삭제할 대화를 선택해 주세요.');
      const channelIds=dmData.channels.filter(row=>dmSelected.has(row.channelId)).map(row=>row.channelId);
      await applyCommand('prepare',{mode:'dm-batch-delete',options:{channelIds,ownerId:dmData.ownerId,filters:readBatchFilters()},expectedPath});
    }else await applyCommand('prepare',{mode:'single-channel-delete',options:readOptions(),expectedPath});
  }finally{busyCommand=false;if(current)render(current);}
});
$('#approve').onclick=guard(async()=>{
  if(busyCommand||current?.phase!=='awaiting-confirmation')return;actionError='';busyCommand=true;
  for(const id of ['approve','reject','closeConfirmation'])$('#'+id).disabled=true;
  try{await applyCommand('confirm',{jobId:current.jobId});activateTab($('#tab-progress'));}
  finally{busyCommand=false;if(current)render(current);if($('#confirmation').hidden)$('#'+(active(current)?'stop':'tab-progress')).focus();}
});
$('#stop').onclick=guard(async()=>{if(current?.jobId)await applyCommand('stop',{jobId:current.jobId});});
const cancelConfirmation=guard(async()=>{
  if(busyCommand||current?.phase!=='awaiting-confirmation')return;
  busyCommand=true;for(const id of ['approve','reject','closeConfirmation'])$('#'+id).disabled=true;
  try{await applyCommand('stop',{jobId:current.jobId});activateTab($('#tab-delete'));}
  finally{busyCommand=false;if(current)render(current);if($('#confirmation').hidden)($('#start').disabled?$('#tab-delete'):$('#start')).focus();}
});
$('#reject').onclick=$('#closeConfirmation').onclick=cancelConfirmation;
$('#clear').onclick=guard(async()=>{clientLogs=[];actionError='';await applyCommand('clear');});
chrome.tabs.onRemoved?.addListener(()=>void poll());
chrome.tabs.onActivated?.addListener(()=>void poll());
chrome.tabs.onUpdated?.addListener((id,change)=>{if(id===selected&&(change.url||change.status==='complete'))void poll();});
window.addEventListener?.('focus',()=>void poll());
void initializePopup();
