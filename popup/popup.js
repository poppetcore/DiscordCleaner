// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
// Popup owns controls only. All jobs and status live in the automatically resolved Discord tab.
const $=selector=>document.querySelector(selector);
const valueIds=['authorId','guildId','channelId','minId','maxId','minDate','maxDate','search','pattern','searchDelay','deleteDelay'];
const flagIds=['hasLink','hasFile','includeNsfw','includePinned'];
const phases={idle:'대기 중',searching:'검색 중', 'awaiting-confirmation':'삭제 확인 대기',running:'삭제 중',stopping:'중단 처리 중',stopped:'중단됨',completed:'완료',partial:'일부 미처리','search-wait':'다음 검색 대기 중','rate-wait':'Discord 요청 제한 대기 중','retry-wait':'요청 재시도 대기 중',verifying:'잔여 메시지 확인 중',error:'오류'};
let liveContext=null, jobContext=null, selectionIssue='', initialized=false, refreshQueued=false;
let selected=null,current=null,currentPath='',polling=false,generation=0,lastLogs='',restoredJob='',busyCommand=false;
const active=state=>state&&['searching','awaiting-confirmation','running','search-wait','rate-wait','retry-wait','verifying','stopping'].includes(state.phase);
function notice(text){$('#noticeBox').hidden=!text&&$('#openDiscord').hidden;$('#notice').textContent=text;$('#notice').dataset.tone=/실패|오류|불가|없습니다|올바른/.test(text)?'error':'info';}
function jobNotice(text){$('#jobNotice').textContent=text;$('#jobNotice').hidden=!text;}
let modalReturnFocus=null;
function setModal(id,open){
  if(id==='confirmation'&&open)$('#linkDialog').hidden=true;
  const element=$('#'+id),wasOpen=!element.hidden;
  if(open&&!wasOpen){
    modalReturnFocus=document.activeElement;
    if(id==='confirmation'){$('#confirmationFilters').open=false;$('#confirmationContent').scrollTop=0;}
  }
  element.hidden=!open;
  const anyOpen=!$('#confirmation').hidden||!$('#linkDialog').hidden;
  $('#appContent').inert=anyOpen;
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
  if(selected===null)throw new Error('작업할 Discord 탭을 활성화해 주세요.');
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
function delays(){for(const id of ['searchDelay','deleteDelay'])$('#'+id+'Value').textContent=$('#'+id).value+'ms';}
function readOptions(){
  const text=id=>$('#'+id).value.trim();
  const options={authorId:text('authorId'),guildId:text('guildId'),channelId:text('channelId'),minId:text('minId')||text('minDate'),maxId:text('maxId')||text('maxDate'),content:text('search'),pattern:text('pattern'),searchDelay:Number(text('searchDelay')),deleteDelay:Number(text('deleteDelay'))};
  for(const id of flagIds)options[id]=$('#'+id).checked;
  return options;
}
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
    `전체 검색 대상 ${progress.total}건 중 ${progress.processed}건 처리`:'전체 검색 건수 확인 중');
}
// Display-only mapping: options continue to be sent unchanged to the runner.
function confirmationRows(state) {
  const o=state.options||{},info=state.jobContext||{};
  const user=info.users?.find(user=>user.id===o.authorId);
  const author=!o.authorId?'전체 작성자':user?.displayName&&user.username?`${user.displayName} (${user.username})`:user?.displayName||user?.username||`사용자 ID ${o.authorId}`;
  const count=state.counts?.total;
  const known=state.progress?.known===true&&Number.isSafeInteger(count)&&count>=0;
  const summary=info.isDM?[['DM 대상',info.guildName||'정보 확인 불가']]:[
    ['서버',info.guildName||'정보 확인 불가'],['채널',!o.channelId?'서버 전체 채널':info.channelName?`# ${info.channelName}`:'정보 확인 불가']];
  summary.push(['작성자',author],['검색 결과(추정)',known?`${count.toLocaleString('ko-KR')}개`:'확인 중']);
  const boundary=(value,direction)=>!value?'제한 없음':/^\d+$/.test(value)?`메시지 ID ${value} ${direction}`:`${value.replace('T',' ')} ${direction} (현지 시간)`;
  return {summary,conditions:[
    ['검색어',o.content||'없음'],['시작 경계',boundary(o.minId,'이후')],['종료 경계',boundary(o.maxId,'이전')],
    ['링크 조건',o.hasLink?'링크가 포함된 메시지만':'미적용'],['파일 조건',o.hasFile?'첨부파일이 포함된 메시지만':'미적용'],
    ['고정 메시지',o.includePinned?'포함':'제외'],['NSFW 채널',o.includeNsfw?'검색에 포함':'검색에 포함하지 않음'],
    ['정규식',o.pattern||'미사용'],['검색 간격',Number.isFinite(o.searchDelay)?`${o.searchDelay}ms`:'확인 불가'],['삭제 간격',Number.isFinite(o.deleteDelay)?`${o.deleteDelay}ms`:'확인 불가']
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
      term.textContent=label;description.textContent=value;description.title=value;
      container.append(term,description);
    }
  }
}
function render(state) {
  current=state;currentPath=state.path;
  jobContext=state.jobContext||null;
  if(state.jobId&&state.jobId!==restoredJob){restore(state.options);restoredJob=state.jobId;}
  if(state.context)updateContext(state.context);
  const running=active(state);
  $('#busyDot').hidden=!running;
  $('#start').disabled=running||selected===null||busyCommand||!liveContext?.channelId||!authorAllowed();
  $('#stop').disabled=!running;
  for(const id of ['clear'])$('#'+id).disabled=selected===null;
  // Pending confirmation is restored by polling after any popup reopen.
  renderConfirmation(state);
  setModal('confirmation',state.phase==='awaiting-confirmation');
  for(const id of ['approve','reject','closeConfirmation'])$('#'+id).disabled=busyCommand;
  const count=state.counts;
  const known=!!state.jobId;
  const validCount=value=>Number.isFinite(value)&&value>=0;
  $('#countTotal').textContent=known&&validCount(count.total)?String(count.total):'—';
  $('#countSuccess').textContent=known&&validCount(count.success)?String(count.success):'—';
  $('#countFailed').textContent=known&&validCount(count.failed)?String(count.failed):'—';
  const seconds=Math.max(0,Math.ceil((Number(state.wait?.until||0)-Date.now())/1000));
  const waiting=running&&seconds>0&&['rate-limit','next-search','retry'].includes(state.wait?.kind);
  const label=waiting&&state.wait.kind==='rate-limit'?`Discord 요청 제한 · ${seconds}초 후 재시도`:
    waiting&&state.wait.kind==='next-search'?`다음 검색까지 ${seconds}초`:
    waiting&&state.wait.kind==='retry'?`요청 재시도까지 ${seconds}초`:phases[state.phase]||state.phase;
  $('#jobStatus').textContent=label;$('#jobStatus').dataset.phase=state.phase;
  updateProgressBar(state);
  jobNotice(state.interruption?.reason||state.reason||state.error||'');
  notice(state.phase==='awaiting-confirmation'?'범위를 확인하고 “삭제 시작”을 눌러주세요.':'');
  const signature=JSON.stringify(state.logs);
  if(signature!==lastLogs){
    lastLogs=signature;$('#logArea').replaceChildren();
    for(const item of state.logs){const row=document.createElement('div');row.className='log log-'+item.type;row.textContent=item.text;$('#logArea').appendChild(row);}
    if($('#autoScroll').checked)$('#logArea').scrollTop=$('#logArea').scrollHeight;
  }
}
function authorLabel(id,info=liveContext) {
  if(!id)return '전체 작성자';
  const user=info?.users?.find(user=>user.id===id);
  return user?.displayName&&user.username?`${user.displayName} (${user.username})`:'정보 확인 불가';
}
function authorAllowed(info=liveContext) {
  const wanted=$('#authorId').value;
  return !info?.isDM||!wanted||(info.users||[]).some(user=>user.id===wanted);
}
function updateContext(info) {
  const moved=!!liveContext&&liveContext.path!==info.path;
  liveContext=info;currentPath=info.path;
  $('#guildId').value=info.guildId||'';
  if(moved)$('#serverScope').checked=false;
  $('#serverScopeField').hidden=info.isDM;
  $('#channelId').value=info.isDM||!$('#serverScope').checked?info.channelId||'':'';
  $('#guildLabel').textContent=info.isDM?'DM':'서버';
  $('#guildName').textContent=info.guildName||'정보 확인 불가';
  $('#channelField').hidden=info.isDM;
  $('#channelName').textContent=!info.isDM&&$('#serverScope').checked?'서버 전체 채널':info.channelName?'#'+info.channelName:'정보 확인 불가';
  const wanted=$('#authorId').value;
  const signature=JSON.stringify([info.users,info.authorId,wanted,info.isDM]);
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
  $('#start').disabled=active(current)||busyCommand||!info.channelId||selected===null||!authorAllowed(info);
}
async function resolveTarget() {
  const result=await send({type:'list'});
  const next=result.tabs.find(tab=>tab.id===result.activeTabId)?.id??(result.tabs.length===1?result.tabs[0].id:null);
  selectionIssue=result.tabs.length?'작업할 Discord 탭을 활성화한 뒤 확장프로그램을 열어주세요.':'Discord를 열고 서버 채널 또는 DM으로 이동해 주세요.';
  if(result.lost?.length){const last=result.lost.at(-1);selectionIssue+=` 이전 대상 탭이 닫혔습니다. 마지막 조회 기준 성공 ${last.counts?.success??0} / 실패 ${last.counts?.failed??0}. 최종 결과는 확인할 수 없습니다.`;}
  $('#openDiscord').hidden=result.tabs.length!==0;
  if(!initialized||next!==selected) {
    initialized=true;generation++;jobNotice('');selected=next;current=null;liveContext=null;currentPath='';restoredJob='';lastLogs='';
    // Preserve search filters when the active Discord tab changes.
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
    const state=await command('status');if(epoch!==generation)return;
    render(state);
    // Include selected cached author, even when it is outside the default candidate list.
    const info=await command('context',{authorId:$('#authorId').value});
    if(epoch===generation)updateContext(info);
  } catch(error) {
    notice(error.message);$('#start').disabled=true;$('#stop').disabled=true;
    setModal('confirmation',false);$('#jobStatus').textContent='상태 확인 불가';
  } finally{polling=false;if(refreshQueued)queueMicrotask(poll);}
}
function guard(action){return async()=>{try{await action();}catch(error){notice(error.message);}};}
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
    const target=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:null;
    if(target!==null){event.preventDefault();activateTab(tabs[target],true);}
  };
}
$('#toggleSidebar').onclick=()=>{const hidden=!$('#filterFields').hidden;$('#filterFields').hidden=hidden;$('#toggleSidebar').setAttribute('aria-expanded',String(!hidden));$('#toggleSidebar').textContent=hidden?'상세 필터 펼치기':'상세 필터 접기';};
$('#redact').onchange=()=>{$('#undiscord').classList.toggle('redact',$('#redact').checked);};
for(const id of ['searchDelay','deleteDelay'])$('#'+id).oninput=delays;
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
  const epoch=generation;const state=await command(type,fields);
  if(epoch===generation)render(state);
}
$('#start').onclick=guard(async()=>{
  if(busyCommand||active(current))return;busyCommand=true;$('#start').disabled=true;
  try{
    const previous=selected,expectedPath=currentPath;
    if(await resolveTarget()===null||previous!==selected)throw new Error('대상이 변경되었습니다. 현재 Discord 정보를 확인한 뒤 다시 시작해 주세요.');
    const info=await command('context',{authorId:$('#authorId').value});
    if(info.path!==expectedPath){updateContext(info);throw new Error('Discord 채널이 변경되었습니다. 현재 정보를 확인한 뒤 다시 시작해 주세요.');}
    updateContext(info);
    if(!authorAllowed(info))throw new Error('현재 DM에 참여한 작성자를 다시 선택해 주세요.');
    await applyCommand('prepare',{options:readOptions(),expectedPath});
  }finally{busyCommand=false;if(current)render(current);}
});
$('#approve').onclick=guard(async()=>{
  if(busyCommand||current?.phase!=='awaiting-confirmation')return;busyCommand=true;
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
$('#clear').onclick=guard(async()=>{await applyCommand('clear');});
chrome.tabs.onActivated?.addListener(()=>void poll());
chrome.tabs.onUpdated?.addListener((id,change)=>{if(id===selected&&(change.url||change.status==='complete'))void poll();});
window.addEventListener?.('focus',()=>void poll());
restore(null);$('#start').disabled=true;poll();setInterval(poll,1000);
