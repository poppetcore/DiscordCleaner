// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
export function installRuntime(capability) {
const marker=Symbol.for('undiscord.popup.runner.v2');
if(window[marker])return {fresh:false,version:window[marker].version||2};
if(location.origin!=='https://discord.com'||!location.pathname.startsWith('/channels/'))throw new Error('Discord 채널을 열어주세요.');
const modules = {
"src/runtime/entry.js": (exports, require) => {
// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
const { createRunner } = require("src/runtime/runner.js");
const runner = createRunner(capability);
Object.defineProperty(window, marker, {value:Object.freeze({dispatch:runner.dispatch,version:12}), configurable:false});
setInterval(runner.reconcile,500);
window.addEventListener('popstate',runner.reconcile);
},
"src/runtime/runner.js": (exports, require) => {
// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
// Nonvisual tab-owned runner: no popup lifetime or worker keepalive dependency.
const Core = require("src/undiscord-core.js").default;
const { fillToken, getAuthorId, getGuildId, getChannelId, getContext, getDMList, getCurrentAccount } = require("src/utils/getIds.js");
const { setLogFn } = require("src/utils/log.js");
const { validateOptions } = require("src/runtime/options.js");
function createRunner(capability, environment = {}) {
  const core = environment.core || new Core();
  const tokenProvider = environment.tokenProvider || fillToken;
  const path = environment.path || (() => location.pathname);
  const id = environment.id || (() => crypto.randomUUID());
  let jobOwner='',jobToken='',prepareController=null,preparation=null;
  let batch=null, batchOwner='', batchToken='', batchController=null, cachedDMs=null;
  let phase = 'idle', jobId = '', reason = '', requestPath = '', stopRequested = false;
  let cooldownUntil = 0, jobContext = null, waitState=null, activitySeen=false;
  let resolveConfirmation = null, preview = [], logs = [], options = null, error = '';
  const active = () => ['preparing','searching','awaiting-confirmation','running','search-wait','rate-wait','retry-wait','stopping'].includes(phase);
  function record(type,args) {
    const text = Array.from(args).map(value=>String(value)).join(' ').slice(0,3000);
    logs.push({type,text});if(logs.length>500)logs.shift();
    if(type==='error')error=text;
  }
  (environment.setLogger || setLogFn)(record);
  function snapshot() {
    const counts={success:core.state.delCount,failed:core.state.failCount,total:core.state.targetCount,unique:core.state.uniqueCount||0,targets:core.state.targetCount||0,excluded:core.state.excludedCount||0,pending:core.state.pendingCount||0,exclusions:{...core.state.exclusions}};
    if(batch) {
      if(batch.current>=0)Object.assign(batch.channels[batch.current],{activity:phase,counts:{...counts},searchComplete:core.state.searchComplete&&!core.state.malformed,presence:core.state.ownMessageSeen?'present':core.state.searchComplete&&!core.state.malformed?'none-in-query':'unknown'});
      for(const key of ['success','failed','total','unique','targets','excluded','pending'])counts[key]=batch.channels.reduce((sum,row)=>sum+(row.counts?.[key]||0),0);
    }
    return { version:12, preparation:preparation?structuredClone(preparation):null, mode:batch?'dm-batch-delete':'single-channel-delete',batch:batch?structuredClone(batch):null, dmList:cachedDMs?structuredClone(cachedDMs):null, context:getContext(options?.authorId), jobContext, cooldownUntil, wait:waitState, result:batch?{outcome:phase,verified:phase==='completed',reason}:core.result, phase, jobId, reason, options: options && {...options}, path:path(),
      progress:batch?{known:true,total:batch.channels.length,processed:batch.channels.filter(row=>['completed','partial','error'].includes(row.status)).length,value:phase==='completed'?100:Math.min(99,batch.channels.filter(row=>['completed','partial','error'].includes(row.status)).length/batch.channels.length*100)}:core.progress(),
      counts,
      elapsed:core.stats.startTime?Math.max(0,(core.stats.endTime?.getTime()||Date.now())-core.stats.startTime.getTime()):0,
      remaining:Number.isFinite(core.stats.etr)?core.stats.etr:0,
      throttled:core.stats.throttledCount,
      preview:phase==='awaiting-confirmation'?preview:[], logs:logs.map(item=>({...item})), error,
    };
  }
  core.onStart = () => {phase='searching';};
  core.onProgress = () => {if(!stopRequested&&!activitySeen)phase='running';};
  core.onActivity = activity => {if(stopRequested)return;activitySeen=true;phase=activity.phase;waitState=activity.wait;cooldownUntil=activity.wait?.kind==='rate-limit'?activity.wait.until:0;};
  core.onStop = () => {if(batch)return;cooldownUntil=0;waitState=null;phase=stopRequested?'stopped':core.result?.outcome||(error?'error':'partial');reason=stopRequested?reason:core.result?.reason||reason;preview=[];resolveConfirmation=null;};
  core.confirm = async () => {
    if(!core.options.askForConfirmation)return true;
    if(stopRequested)return false;
    preview=core.state._messagesToDelete.slice(0,25).map(message=>({
      id:String(message.id), author:String(message.author?.username||''),
      content:String(message.content||'').slice(0,800), attachments:message.attachments?.length||0,
    }));
    phase='awaiting-confirmation';
    return new Promise(resolve=>{resolveConfirmation=resolve;});
  };
  function stop(message) {
    if(!active())return;
    const preparing=phase==='preparing';stopRequested=true;reason=message;phase='stopping';prepareController?.abort();if(preparing)phase='stopped';waitState=null;cooldownUntil=0;
    const resolve=resolveConfirmation;resolveConfirmation=null;resolve?.(false);batchController?.abort();core.stop();if(batch&&batch.current<0){phase='stopped';batch.reason=message;}
  }
  function reconcile() {if(active()&&path()!==requestPath)stop('Discord 채널 이동으로 작업이 중단되었습니다.');if(active()&&jobOwner&&(getCurrentAccount()!==jobOwner||tokenProvider()!==jobToken)){cachedDMs=null;stop('로그인 계정이 변경되었거나 계정을 확인할 수 없습니다.');}}
  core.checkTarget=()=>{reconcile();if(stopRequested){const error=new Error('작업 대상이 변경되었거나 중단되었습니다.');error.name='AbortError';throw error;}};
  async function runBatch() {
    try {
      for(let index=0;index<batch.channels.length;index++) {
        reconcile();if(stopRequested)break;
        const row=batch.channels[index];
        const list=await getDMList({refresh:false,signal:batchController.signal,guard:core.checkTarget});
        reconcile();if(stopRequested)break;
        if(list.ownerId!==batchOwner||!list.channels.some(item=>item.channelId===row.channelId&&item.userId===row.userId))throw new Error('계정 또는 DM 접근 정보가 변경되었습니다.');
        const token=tokenProvider();if(!token)throw new Error('인증 정보를 확인하지 못했습니다.');
        core.resetState();batch.current=index;row.status='running';
        core.options={...options,authorId:batchOwner,guildId:'@me',channelId:row.channelId,includeNsfw:false,askForConfirmation:false,batchMode:true};
        core.configure(token);activitySeen=false;await core.run();snapshot();
        row.status=stopRequested?'stopped':core.result.outcome;row.reason=core.result.reason;
        row.presence=core.state.ownMessageSeen?'present':row.searchComplete?'none-in-query':'unknown';
        if(row.status==='completed'&&row.presence==='none-in-query')row.reason='현재 검색 조건에 맞는 본인 메시지 없음 · 건너뜀';
        record('info',[`${row.displayName} · ${row.presence==='none-in-query'?'현재 검색 조건에 맞는 본인 메시지 없음 · 건너뜀':row.presence==='present'?`삭제 대상 ${core.state.targetCount}개 확인`:row.reason}`]);
        batch.current=-1;
        if(stopRequested||/HTTP 401/.test(row.reason))break;
      }
      batch.current=-1;cooldownUntil=0;waitState=null;
      const complete=batch.channels.every(row=>row.status==='completed');
      phase=stopRequested?'stopped':complete?'completed':'partial';
      reason=stopRequested?reason:complete?'선택한 DM의 검색 및 삭제 처리를 마쳤습니다. 검색 인덱스에 노출된 메시지 기준입니다.':'오류 또는 미처리 DM이 있습니다. DM별 결과를 확인해 주세요.';
    }catch(e){record('error',[`DM 일괄 삭제 실행 실패 · ${e.message}`]);snapshot();if(batch.current>=0){batch.channels[batch.current].status=stopRequested?'stopped':'error';batch.channels[batch.current].reason=e.message;}batch.current=-1;phase=stopRequested?'stopped':'error';reason=e.message;core.stop();core.api?.clear();}
  }
  async function prepare(command,preparationId,controller){
    const check=()=>{if(jobId!==preparationId||controller.signal.aborted)throw new DOMException('Stopped','AbortError');core.checkTarget();};
        check();
        if(command.mode==='dm-batch-delete') {
          if(!/^\/channels\/@me\/?$/.test(path())||command.expectedPath!==path())throw new Error('친구 목록에서 다시 시작해 주세요.');
          const input=command.options;
          if(!input||Object.keys(input).some(k=>!['channelIds','ownerId','filters','automaticTransitions'].includes(k)))throw new Error('일괄 작업 조건 오류');
          if(!Array.isArray(input.channelIds)||!input.channelIds.length||input.channelIds.length>10000||input.channelIds.some(id=>typeof id!=='string'||!/^\d{1,22}$/.test(id))||new Set(input.channelIds).size!==input.channelIds.length)throw new Error('DM 선택 목록 오류');
          if(!input.filters||Object.keys(input.filters).some(key=>['authorId','guildId','channelId'].includes(key)))throw new Error('일괄 검색 필터 형식 오류');
          // Legacy boolean is accepted for compatibility only; it cannot alter scheduler policy.
          if(input.automaticTransitions!==undefined&&typeof input.automaticTransitions!=='boolean')throw new Error('DM 전환 간격 설정 오류');
          const valid=validateOptions({...input.filters,authorId:input.ownerId,guildId:'@me',channelId:input.channelIds[0]});
          valid.includeNsfw=false;
          preparation.stage='선택한 DM 확인 중';const list=await getDMList({signal:controller.signal,guard:check});check();
          if(!cachedDMs||input.ownerId!==cachedDMs.ownerId||input.ownerId!==list.ownerId)throw new Error('계정이 변경되었습니다. DM 목록을 다시 불러와 주세요.');
          const rows=input.channelIds.map(channelId=>{
            const old=cachedDMs.channels.find(row=>row.channelId===channelId);
            const row=list.channels.find(row=>row.channelId===channelId);
            if(!old||!row||old.userId!==row.userId)throw new Error('선택한 DM의 접근 정보가 변경되었습니다. 목록을 다시 불러와 주세요.');
            return {...row,status:'unprocessed',presence:'unknown',counts:null,searchComplete:false,reason:''};
          });
          valid.searchDelay=2000;
          check();
          if(!tokenProvider())throw new Error('Discord 인증 정보를 얻지 못했습니다.');
          if(command.expectedPath!==path())throw new Error('조회 도중 Discord 화면이 변경되었습니다.');
          batchOwner=list.ownerId;batchToken=tokenProvider();jobOwner=batchOwner;jobToken=batchToken;batchController=new AbortController();batch={channels:rows,current:-1,ownerId:batchOwner,reason:''};
          options=valid;
          jobContext=getContext();requestPath=path();reason=preparation.issues?.length?`선택한 DM ${preparation.issues.length}개를 제외했습니다. 작업 진행 상황에서 결과를 확인해 주세요.`:'';error='';preview=[];stopRequested=false;waitState=null;cooldownUntil=0;core.resetState();
          phase='awaiting-confirmation';return snapshot();
        }
        if(command.mode&&command.mode!=='single-channel-delete')throw new Error('지원하지 않는 실행 모드입니다.');
        batch=null;batchOwner='';
        if(!/^\/channels\/(?:@me|\d+)\/\d+/.test(path())||command.expectedPath!==path())throw new Error('대상 탭/채널이 변경되었습니다. 현재 정보를 다시 가져와 주세요.');
        const valid=validateOptions(command.options);
        if(valid.guildId!==getGuildId()||(valid.channelId&&valid.channelId!==getChannelId())||(valid.guildId==='@me'&&valid.channelId!==getChannelId()))throw new Error('현재 서버 또는 채널과 검색 대상이 다릅니다. 다시 확인해 주세요.');
        if(valid.guildId==='@me'&&valid.authorId&&!getContext(valid.authorId).participantIds.includes(valid.authorId))throw new Error('현재 DM에 참여한 작성자를 다시 선택해 주세요.');
        check();const token=tokenProvider();
        if(!token)throw new Error('Discord 인증 정보를 얻지 못했습니다. 현재 내부 인증 방식을 지원하지 않을 수 있습니다.');
        jobOwner=getCurrentAccount();jobToken=token;if(!jobOwner)throw new Error('현재 로그인 계정을 확인할 수 없습니다.');
        jobContext=getContext(valid.authorId);cooldownUntil=0;options=valid;requestPath=path();reason=preparation.issues?.length?`선택한 DM ${preparation.issues.length}개를 제외했습니다. 작업 진행 상황에서 결과를 확인해 주세요.`:'';error='';preview=[];stopRequested=false;
        waitState=null;activitySeen=false;core.resetState();core.stats.endTime=null;core.options={...core.options,...valid,batchMode:false};core.configure(token);
        phase='searching';
        // The job Promise belongs to the tab. Never await it from a popup/worker request.
        void core.run().catch(()=>{error='작업 실행 오류';core.stop();core.api?.clear();cooldownUntil=0;waitState=null;phase='error';});
        return snapshot();
  }
  async function dispatch(secret, command) {
    if(secret!==capability)throw new Error('허용되지 않은 명령입니다.');
    if(!command||typeof command!=='object'||Array.isArray(command))throw new Error('명령 형식 오류');
    const fields={status:['type'],context:['type','authorId'],'dm-list':['type','refresh'],prepare:['type','mode','options','expectedPath'],confirm:['type','jobId'],stop:['type','jobId'],clear:['type']};
    if(!fields[command.type]||Object.keys(command).some(k=>!fields[command.type].includes(k)))throw new Error('명령 형식 오류');
    reconcile();
    switch(command.type) {
      case 'status': return snapshot();
      case 'context': return getContext(command.authorId);
      case 'dm-list': {if(active())throw new Error('작업 중에는 목록을 갱신할 수 없습니다.');if(command.refresh!==undefined&&typeof command.refresh!=='boolean')throw new Error('새로고침 형식 오류');const list=await getDMList({refresh:command.refresh!==false});if(getCurrentAccount()!==list.ownerId)throw new Error('계정이 변경되었습니다.');cachedDMs=list;return structuredClone(list);}
      case 'prepare': {
        if(active())throw new Error('현재 작업이 진행 중입니다.');
        jobId=id();requestPath=path();stopRequested=false;jobOwner=getCurrentAccount();jobToken=tokenProvider();
        preparation={stage:'삭제 작업 준비 중',issues:[]};reason='';error='';logs=[];batch=null;options=null;preview=[];waitState=null;core.resetState();
        phase='preparing';prepareController=new AbortController();
        const preparationId=jobId,controller=prepareController;
        void prepare(command,preparationId,controller).catch(e=>{
          if(jobId!==preparationId)return;
          waitState=null;if(stopRequested||controller.signal.aborted){phase='stopped';return;}
          phase='error';error=e.message||'삭제 작업을 준비하지 못했습니다.';reason=error;record('error',[`${preparation.stage} · ${error}`]);
        });
        return snapshot();
      }
      case 'confirm': {
        if(phase!=='awaiting-confirmation'||command.jobId!==jobId||(!batch&&!resolveConfirmation))throw new Error('확인 대상 작업이 변경되었습니다.');
        if(batch) {
          if(command.jobId!==jobId||phase!=='awaiting-confirmation')throw new Error('확인 대상 오류');
          const list=await getDMList({signal:batchController.signal,guard:core.checkTarget});
          reconcile();if(stopRequested||phase!=='awaiting-confirmation')throw new Error('확인 대기 중 작업이 중단되었습니다.');
          if(list.ownerId!==batchOwner||batch.channels.some(row=>!list.channels.some(item=>item.channelId===row.channelId&&item.userId===row.userId)))throw new Error('계정 또는 선택한 DM이 변경되었습니다. 취소 후 목록을 갱신해 주세요.');
          phase='running';void runBatch();return snapshot();
        }
        core.options.askForConfirmation=false;phase='running';preview=[];
        const resolve=resolveConfirmation;resolveConfirmation=null;resolve(true);return snapshot();
      }
      case 'stop': {
        if(command.jobId!==jobId)throw new Error('중단 대상 작업이 변경되었습니다.');
        stop('사용자가 작업을 중단했습니다.');return snapshot();
      }
      case 'clear': logs=[];return snapshot();
      default:throw new Error('알 수 없는 명령입니다.');
    }
  }
  return {dispatch,reconcile,snapshot};
}

exports.createRunner = createRunner;
},
"src/undiscord-core.js": (exports, require) => {
// Adapted from Victornpb/undiscord (MIT + attribution).
const { searchMessages, filterSearchResponse } = require('src/core/message-search.js');
const { deleteMessage } = require('src/core/message-delete.js');
const { DiscordApi, pause, stopped, sharedRateLimits } = require('src/core/api.js');
const { log } = require('src/utils/log.js');
const freshState=()=>({running:false,delCount:0,failCount:0,grandTotal:0,offset:0,iterations:0,
  totalKnown:false,searchComplete:false,uniqueCount:0,targetCount:0,excludedCount:0,pendingCount:0,exclusions:{},malformed:false,ownMessageSeen:false,
  _seachResponse:null,_messagesToDelete:[],_skippedMessages:[]});
class UndiscordCore {
  options={authorId:null,guildId:null,channelId:null,minId:null,maxId:null,content:null,
    hasLink:false,hasFile:false,includeNsfw:false,includePinned:false,pattern:'',searchDelay:30000,deleteDelay:1000,askForConfirmation:true};
  state=freshState();
  stats={startTime:null,endTime:null,throttledCount:0,throttledTotalTime:0,lastPing:0,avgPing:0,etr:0};
  ledger=new Map();finishedIds=new Set();api=null;controller=null;result=null;
  activity='searching';waitState=null;lastSearchAt=null;prefetch=null;waits=new Map();
  // Limits bound changing indexes, repeated pages and very large searches.
  limits={pagesPerPass:1000,uniqueMessages:200000};
  constructor({fetcher=globalThis.fetch,sleeper=pause,now=()=>Date.now()}={}) {this.fetcher=fetcher;this.sleeper=sleeper;this.now=now;}
  resetState(){this.state=freshState();this.ledger.clear();this.finishedIds.clear();this.result=null;this.waitState=null;this.lastSearchAt=null;this.prefetch=null;this.waits.clear();this.options.askForConfirmation=true;}
  configure(token){
    this.controller=new AbortController();
    this.api=new DiscordApi(token,{rateLimits:sharedRateLimits,signal:this.controller.signal,fetcher:this.fetcher,
      sleeper:(ms,signal,kind)=>this.wait(ms,kind),guard:()=>{this.checkTarget?.();if(!this.state.running)throw stopped();},
      now:this.now,searchSpacing:this.options.batchMode?2000:0,beforeAttempt:method=>{if(method==='GET')this.lastSearchAt=this.now();},
      onThrottle:ms=>{this.stats.throttledCount++;this.stats.throttledTotalTime+=ms;}});
  }
  emitActivity(){
    const waits=[...this.waits.values()];
    const wait=waits.find(item=>item.kind==='rate-limit')||waits.find(item=>item.kind==='indexing')||waits.find(item=>item.kind==='retry')||waits.find(item=>['next-search','scheduler'].includes(item.kind));
    const phase=wait?.kind==='rate-limit'?'rate-wait':['retry','indexing'].includes(wait?.kind)?'retry-wait':['next-search','scheduler'].includes(wait?.kind)?'search-wait':this.activity;
    this.onActivity?.({phase,wait:wait?{...wait}:null});
  }
  report(phase){this.activity=phase;if(this.state.running)this.emitActivity();}
  async wait(ms,kind='delete-delay'){
    if(!this.state.running||this.controller?.signal.aborted)throw stopped();
    const key=Symbol(kind),wait={kind,until:this.now()+ms,resumePhase:this.activity};
    this.waits.set(key,wait);this.emitActivity();
    try {await this.sleeper(ms,this.controller.signal,kind);}
    finally{this.waits.delete(key);if(this.state.running)this.emitActivity();}
    if(!this.state.running||this.controller.signal.aborted)throw stopped();
  }
  async sleep(ms){return this.wait(ms,'delete-delay');}
  ledgerKey(id){return `${this.options.channelId||this.options.guildId}:${id}`;}
  setOutcome(id,status,reason=''){
    id=this.ledgerKey(id);
    const previous=this.ledger.get(id);
    if(previous&&previous.status!=='pending')return;
    if(!previous&&this.ledger.size>=this.limits.uniqueMessages){const error=new Error('확인 가능한 메시지 수 한도에 도달했습니다.');error.incomplete=true;throw error;}
    const update=(item,delta)=>{
      if(!item)return;
      const key={success:'delCount',failed:'failCount',excluded:'excludedCount',pending:'pendingCount'}[item.status];
      this.state[key]+=delta;
      if(item.status!=='excluded')this.state.targetCount+=delta;
      else {this.state.exclusions[item.reason]=(this.state.exclusions[item.reason]||0)+delta;if(!this.state.exclusions[item.reason])delete this.state.exclusions[item.reason];}
    };
    update(previous,-1);const item={status,reason};this.ledger.set(id,item);update(item,1);this.state.uniqueCount=this.ledger.size;
    if(status==='success'||status==='failed')this.finishedIds.add(id);
    this.state.grandTotal=this.state.targetCount;
    this.onProgress?.(this.state,this.stats);
  }
  progress(){
    const processed=this.state.delCount+this.state.failCount;
    const verified=this.result?.verified===true&&this.state.searchComplete&&this.state.pendingCount===0;
    const total=this.state.targetCount;
    const known=verified||this.state.totalKnown;
    const raw=total>0?processed/total*100:0;
    return {processed,total:known?total:null,verified,known,
      value:verified?100:Math.min(99,Math.max(0,Number.isFinite(raw)?raw:0))};
  }
  // Only this consumer mutates filtering/ledger state. The producer holds one
  // response (or request) and never writes the deletion queue.
  async sweep(){
    let cursor=null,candidates=0,stale=false;
    this.state.searchComplete=false;
    const launch=bound=>{
      const task=this.search(bound).then(data=>({data}),error=>({error}));
      this.prefetch=task;return task;
    };
    let next=launch(cursor);
    for(let page=0;page<this.limits.pagesPerPass;page++){
      this.report('searching');
      const result=await next;this.prefetch=null;
      if(!this.state.running)throw stopped();
      if(result.error)throw result.error;
      this.state.iterations++;
      this.state._seachResponse=result.data;
      await this.filterResponse();
      if(result.data.doing_deep_historical_index===true){this.state.malformed=true;log.warn('검색 인덱싱이 진행 중이므로 검색 결과의 완전성을 보장할 수 없습니다.');}
      const ids=this.state._pageIds;
      if(!result.data.messages.length){this.state.searchComplete=true;return {candidates,stale};}
      if(!ids.length){const error=new Error('검색 결과에서 유효한 메시지를 확인하지 못했습니다.');error.incomplete=true;throw error;}
      const oldest=ids.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b);
      if(cursor&&BigInt(oldest)>=BigInt(cursor)){
        const error=new Error('검색 커서가 진행되지 않아 안전하게 중단했습니다.');error.incomplete=true;throw error;
      }
      if(cursor&&ids.some(id=>BigInt(id)>=BigInt(cursor))){
        const error=new Error('검색 경계 밖의 응답으로 검색을 완료할 수 없습니다.');error.incomplete=true;throw error;
      }
      stale ||= this.state._pageStaleSuccess;
      const queue=this.state._messagesToDelete;
      candidates+=queue.length;
      if(queue.length&&await this.confirm()===false){this.stop();throw stopped();}
      if(!this.state.running)throw stopped();
      cursor=oldest;
      // Launch before draining the queue: at most one additional page is held.
      next=launch(cursor);
      this.report('running');
      await this.deleteMessagesFromList(queue);
      this.state._messagesToDelete=[];
    }
    const error=new Error('검색 페이지 순회 한도에 도달했습니다.');error.incomplete=true;throw error;
  }
  async run(){
    if(this.state.running)throw new Error('이미 실행 중인 작업입니다.');
    this.state.running=true;this.result=null;this.stats.startTime=new Date(this.now());this.stats.endTime=null;
    this.stats.throttledCount=0;this.stats.throttledTotalTime=0;this.stats.etr=0;
    this.onStart?.();log.info('검색·삭제 작업을 시작합니다.');
    try{
      await this.sweep();
      const complete=this.state.searchComplete&&!this.state.malformed&&this.state.failCount===0&&this.state.pendingCount===0;
      this.state.totalKnown=this.state.searchComplete&&!this.state.malformed;
      this.result={outcome:complete?'completed':'partial',verified:complete,reason:complete?'검색 및 삭제 처리를 마쳤습니다. 검색 인덱스에 노출된 메시지 기준입니다.':'검색 불완전 또는 삭제 실패/미처리 메시지가 있습니다.'};
    }catch(error){
      const cancelled=this.controller?.signal.aborted||!this.state.running;
      this.result={outcome:cancelled?'stopped':error.incomplete?'partial':'error',verified:false,reason:cancelled?'작업이 중단되었습니다.':error.message||'작업 중 오류가 발생했습니다.'};
      log[cancelled||error.incomplete?'warn':'error'](this.result.reason);
    }finally{
      this.state.running=false;this.controller?.abort();
      if(this.prefetch)await this.prefetch;this.prefetch=null;this.waits.clear();
      this.waitState=null;this.api?.clear();this.api=null;
      this.state._seachResponse=null;this.state._messagesToDelete=[];this.state._skippedMessages=[];
      this.stats.endTime=new Date(this.now());this.stats.etr=0;
      log.info(`작업 종료: ${this.result?.outcome||'error'} · 성공 ${this.state.delCount} / 실패 ${this.state.failCount} / 제외 ${this.state.excludedCount} / 미처리 ${this.state.pendingCount}`);
      this.onStop?.(this.state,this.stats);
    }
  }
  stop(){this.state.running=false;this.waitState=null;this.controller?.abort();}
  calcEtr(){this.stats.etr=0;} // No known global denominator; do not invent an ETA.
  async confirm(){return false;} // Replaced by the tab runner's explicit confirmation dialog.
  async search(cursor=null){return searchMessages.call(this,cursor);}
  async filterResponse(){return filterSearchResponse.call(this);}
  async deleteMessagesFromList(queue=this.state._messagesToDelete){
    for(const message of queue){
      if(!this.state.running||this.controller.signal.aborted)throw stopped();
      if(this.ledger.get(this.ledgerKey(message.id))?.status!=='pending')continue;
      // The filter is rechecked immediately before the destructive request.
      const reason=this.exclusionReason(message);
      if(reason){this.setOutcome(message.id,'excluded',reason);continue;}
      try{const result=await this.deleteMessage(message);this.setOutcome(message.id,result==='OK'?'success':'failed');if(!this.state.running||this.controller.signal.aborted)throw stopped();}
      catch(error){throw error;} // An unconfirmed response remains pending, never a final failure.
      this.onProgress?.(this.state,this.stats);
      if(this.state.running)await this.sleep(this.options.deleteDelay);
    }
  }
  async deleteMessage(message){return deleteMessage.call(this,message);}
  beforeRequest(){this.checkTarget?.();this.beforeTs=this.now();}
  afterRequest(){this.stats.lastPing=this.now()-this.beforeTs;}
}
exports.default=UndiscordCore;
},
"src/core/message-search.js": (exports, require) => {
// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
// Extracted and hardened from upstream search/filter methods.
const { queryString, toSnowflake } = require("src/utils/helpers.js");
async function searchMessages(cursor=null) {
    const remaining=this.options.batchMode||this.lastSearchAt===null?0:this.options.searchDelay-(this.now()-this.lastSearchAt);
    if(remaining>0)await this.wait(remaining,'next-search');
    const base = this.options.guildId === '@me'
      ? `/channels/${this.options.channelId}/messages/`
      : `/guilds/${this.options.guildId}/messages/`;
    this.beforeRequest();
    const resp = await this.api.request(base + 'search?' + queryString([
        ['author_id', this.options.authorId || undefined],
        ['channel_id', (this.options.guildId !== '@me' ? this.options.channelId : undefined) || undefined],
        ['min_id', this.options.minId ? toSnowflake(this.options.minId) : undefined],
        ['max_id', cursor || (this.options.maxId ? toSnowflake(this.options.maxId) : undefined)],
        ['sort_by', 'timestamp'],
        ['sort_order', 'desc'],
        ['offset', 0],
        ['has', this.options.hasLink ? 'link' : undefined],
        ['has', this.options.hasFile ? 'file' : undefined],
        ['content', this.options.content || undefined],
        ['include_nsfw', this.options.includeNsfw ? true : undefined],
      ]), 'GET', 1000);
    this.afterRequest();
    if (!resp.ok) throw new Error(`검색 실패: Discord HTTP ${resp.status}`);
    let data;try{data=await resp.json();}catch{throw new Error('Discord 검색 응답을 읽지 못했습니다.');}
    if (!Array.isArray(data.messages) ||
        data.messages.some(group => !Array.isArray(group))) throw new Error('Discord 검색 응답 형식이 변경되었습니다.');
    if(data.doing_deep_historical_index===true||data.indexing||data.retry_after||data.code){const error=new Error('검색 인덱싱이 완료되지 않았습니다. 빈 DM으로 확정하지 않습니다.');error.incomplete=true;throw error;}
    if(!data.messages.length&&data.total_results!==0){const error=new Error('검색 응답이 불완전하여 빈 DM으로 확정할 수 없습니다.');error.incomplete=true;throw error;}
    return data;
  }

async function filterSearchResponse() {
    const data=this.state._seachResponse;
    // Full-query total is captured by sweep; cursor totals are never global.
    // Stable exclusion precedence assigns exactly one reason to each unique ID.
    const exclusion=message=>{
      if(!/^\d+$/.test(String(message.channel_id||''))){this.state.malformed=true;return 'other';}
      if(this.options.guildId!=='@me'&&message.guild_id&&message.guild_id!==this.options.guildId)return 'channel';
      if(this.options.authorId&&message.author?.id!==this.options.authorId)return 'author';
      if(this.options.channelId&&message.channel_id!==this.options.channelId){if(this.options.batchMode)this.state.malformed=true;return 'channel';}
      const id=BigInt(message.id);
      if(this.options.minId&&id<=BigInt(toSnowflake(this.options.minId)))return 'range';
      if(this.options.maxId&&id>=BigInt(toSnowflake(this.options.maxId)))return 'range';
      if(![0,19,20,21,23].includes(message.type))return 'system';
      if(message.pinned&&!this.options.includePinned)return 'pinned';
      if(!new RegExp(this.options.pattern||'','i').test(message.content||''))return 'regex';
      return '';
    };
    this.exclusionReason=exclusion;
    const unique=new Map();
    for(const group of data.messages)for(const message of group){
      if(message?.hit!==true)continue;
      if(!/^\d+$/.test(String(message.id||''))){this.state.malformed=true;continue;}
      if(!/^\d+$/.test(String(message.channel_id||''))||!/^\d+$/.test(String(message.author?.id||''))||!Number.isInteger(message.type))this.state.malformed=true;
      unique.set(String(message.id),message);
    }
    this.state._pageIds=[...unique.keys()];this.state._pageStaleSuccess=false;
    const targets=[],skipped=[];
    for(const [id,message] of unique){
      const previous=this.ledger?.get(this.ledgerKey(id));
      if(previous&&previous.status!=='pending'){
        if(previous.status==='success')this.state._pageStaleSuccess=true;
        skipped.push(message);continue;
      }
      const reason=exclusion(message);
      if(!reason&&message.author?.id===this.options.authorId&&message.channel_id===this.options.channelId)this.state.ownMessageSeen=true;
      // Compatibility for source-level filtering tests; production always owns a ledger.
      if(this.setOutcome)this.setOutcome(id,reason?'excluded':'pending',reason);
      if(reason)skipped.push(message);else if(!this.finishedIds?.has(this.ledgerKey(id)))targets.push(message);
    }
    this.state._messagesToDelete=targets;this.state._skippedMessages=skipped;
}


exports.searchMessages = searchMessages;
exports.filterSearchResponse = filterSearchResponse;
},
"src/utils/helpers.js": (exports, require) => {
// Original project: https://github.com/victornpb/undiscord
// Copyright (c) 2019-2025 Victornpb and contributors. MIT + attribution.
// Modified for the unofficial standalone MV3 port (2026).
// Helpers
const wait = async ms => new Promise(done => setTimeout(done, ms));
const msToHMS = s => `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`;
const escapeHTML = html => String(html).replace(/[&<"']/g, m => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;', '\'': '&#039;' })[m]);
const redact = str => `<x>${escapeHTML(str)}</x>`;
const queryString = params => params.filter(p => p[1] !== undefined).map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
const ask = async msg => new Promise(resolve => setTimeout(() => resolve(window.confirm(msg)), 10));
const toSnowflake = (date) => /:/.test(date) ? (BigInt(new Date(date).getTime() - 1420070400000) * (1n << 22n)).toString() : date;
const replaceInterpolations = (str, obj, removeMissing = false) => str.replace(/\{\{([\w_]+)\}\}/g, (m, key) => obj[key] || (removeMissing ? '' : m));

exports.wait = wait;
exports.msToHMS = msToHMS;
exports.escapeHTML = escapeHTML;
exports.redact = redact;
exports.queryString = queryString;
exports.ask = ask;
exports.toSnowflake = toSnowflake;
exports.replaceInterpolations = replaceInterpolations;
},
"src/core/message-delete.js": (exports, require) => {
// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
// Extracted from upstream; failed HTTP responses never count as success.
const { stopped } = require("src/core/api.js");
const { log } = require("src/utils/log.js");
async function deleteMessage(message) {
    if (!this.state.running) throw stopped();
    this.beforeRequest();
    const resp=await this.api.request(`/channels/${message.channel_id}/messages/${message.id}`, 'DELETE', this.options.deleteDelay);
    this.afterRequest();
    if(resp.status>=500)throw new Error('Discord 서버 오류로 삭제 결과가 미확정입니다. 중복 요청을 중단합니다.');
    if (resp.status!==204) {log.warn(`메시지 삭제 실패: HTTP ${resp.status}`);return 'FAILED';}
    return 'OK';
}


exports.deleteMessage = deleteMessage;
},
"src/core/api.js": (exports, require) => {
// Adapted from Victornpb/undiscord (MIT + attribution).
// One tab-owned scheduler shared by metadata, searches and deletes.
const sharedRateLimits={globalUntil:0,routes:new Map()};
const stopped=()=>new DOMException('Stopped','AbortError');
function pause(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(stopped());
    const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(done,ms);
    const abort=()=>{clearTimeout(timer);reject(stopped());};
    signal?.addEventListener('abort',abort,{once:true});
  });
}
// The tail remains in order even if an enqueued caller is cancelled.
async function acquire(state,key,signal){
  state.locks ||= new Map();
  const previous=state.locks.get(key)||Promise.resolve();
  let release;const turn=new Promise(resolve=>{release=resolve;});
  state.locks.set(key,turn);
  let abort;
  try{
    if(signal?.aborted)throw stopped();
    await Promise.race([previous,new Promise((_,reject)=>{
      abort=()=>reject(stopped());signal?.addEventListener('abort',abort,{once:true});
    })]);
    if(signal?.aborted)throw stopped();
  }catch(error){previous.then(release);throw error;}
  finally{if(abort)signal?.removeEventListener('abort',abort);}
  return ()=>{release();if(state.locks.get(key)===turn)state.locks.delete(key);};
}
class DiscordApi{
  #token;
  constructor(token,{rateLimits={globalUntil:0,routes:new Map()},signal,onThrottle=()=>{},fetcher=globalThis.fetch,sleeper=pause,guard=()=>{},now=()=>Date.now(),beforeAttempt=()=>{},searchSpacing=0}={}){
    this.#token=token;Object.assign(this,{rateLimits,signal,onThrottle,fetcher,sleeper,guard,now,beforeAttempt,searchSpacing});
    rateLimits.aliases ||= new Map();rateLimits.pacing ||= new Map();rateLimits.laneUntil ||= new Map();
  }
  clear(){this.#token=null;}
  async request(path,method='GET',delay=1000){
    const search=method==='GET'&&/^\/(?:guilds|channels)\/\d+\/messages\/search\?[^#]*$/.test(path);
    const metadata=method==='GET'&&/^\/users\/@me(?:\/channels)?$/.test(path);
    if(!(search||metadata||(method==='DELETE'&&/^\/channels\/\d+\/messages\/\d+$/.test(path))))throw new Error('허용되지 않은 API 경로입니다.');
    // One GET and one DELETE may be in flight; known common buckets also lock.
    const lane=method==='DELETE'?'delete':'get',state=this.rateLimits;
    const release=await acquire(state,'lane:'+lane,this.signal);
    try{
      const match=path.match(/^\/(channels|guilds)\/(\d+)\//);
      const major=match?match[1]+':'+match[2]:'@me';
      const route=method+':'+path.split('?')[0].replace(/\/\d+$/,'/:id');
      const floor=search?this.searchSpacing:metadata?1000:0;
      for(let attempt=0;attempt<4;attempt++){
        let bucket=state.aliases.get(route)||'route:'+route;
        const unlock=await acquire(state,'bucket:'+bucket,this.signal);
        let response,retry=null,kind='retry';
        try{
          // Recheck after every wait: another lane can extend global cooldowns.
          while(true){
            this.check();
            const server=Math.max(state.globalUntil||0,state.routes.get(bucket)||0,state.laneUntil.get(lane)||0);
            const local=state.pacing.get(lane)||0;
            const remaining=Math.max(server,local)-this.now();
            if(remaining<=0)break;
            await this.sleeper(remaining,this.signal,server>=local?'rate-limit':'scheduler');
          }
          this.check();this.beforeAttempt(method);
          state.pacing.set(lane,this.now()+floor);
          try{
            response=await this.fetcher('https://discord.com/api/v9'+path,{method,headers:{Authorization:this.#token},signal:this.signal,credentials:'same-origin',redirect:'error'});
          }catch(error){
            if(this.signal?.aborted||error.name==='AbortError')throw stopped();
            if(method==='DELETE')throw new Error('삭제 응답을 확인하지 못했습니다. 결과 미확정 상태로 중단합니다.');
            if(attempt===3)throw new Error('네트워크 요청 재시도 한도에 도달했습니다.');
            retry=Math.max(1000,delay)*(attempt+1);
          }
          if(response){
            const h=response.headers;
            const hash=h.get('x-ratelimit-bucket');
            if(hash){
              const identified='bucket:'+hash+':'+major;
              const old=state.routes.get(bucket)||0;
              state.routes.set(identified,Math.max(old,state.routes.get(identified)||0));
              state.aliases.set(route,identified);bucket=identified;
            }
            const reset=h.get('x-ratelimit-reset-after');
            const validReset=reset!==null&&Number.isFinite(Number(reset))&&Number(reset)>=0;
            const absolute=h.get('x-ratelimit-reset');
            const absoluteMs=absolute!==null&&Number.isFinite(Number(absolute))?Math.max(0,Number(absolute)*1000-this.now()):0;
            const resetMs=validReset?Number(reset)*1000:absoluteMs;
            if(h.get('x-ratelimit-remaining')==='0'){
              state.routes.set(bucket,Math.max(state.routes.get(bucket)||0,this.now()+Math.max(resetMs,!validReset&&!absoluteMs?1000:0)+250));
            }
            if(response.status===429||response.status===202){
              const data=await response.json().catch(()=>({}));
              const header=h.get('retry-after');
              const headerMs=header===null?0:Number.isFinite(Number(header))?Number(header)*1000:Math.max(0,Date.parse(header)-this.now());
              const bodyMs=Number.isFinite(Number(data.retry_after))?Number(data.retry_after)*1000:0;
              retry=Math.max(1000,resetMs,Number.isFinite(headerMs)?headerMs:0,bodyMs)+250;
              kind=response.status===202?'indexing':'rate-limit';
              if(kind==='rate-limit'){
                if(data.global===true||h.get('x-ratelimit-global')==='true'||h.get('x-ratelimit-scope')==='global')state.globalUntil=Math.max(state.globalUntil||0,this.now()+retry);
                else {state.routes.set(bucket,Math.max(state.routes.get(bucket)||0,this.now()+retry));if(!hash)state.laneUntil.set(lane,Math.max(state.laneUntil.get(lane)||0,this.now()+retry));}
                this.onThrottle(retry);
              }
              // DELETE 202 is not proof of failure and must never be retried.
              if(method==='DELETE'&&response.status===202)throw new Error('삭제 결과가 미확정이므로 중복 요청을 중단했습니다.');
            }else if(response.status>=500&&method!=='DELETE'&&attempt<3)retry=Math.max(1000,delay)*(attempt+1);
            if(response.status===401)throw new Error('Discord HTTP 401: 인증이 만료되었습니다.');
            if(response.status===403&&method!=='DELETE')throw new Error('Discord HTTP 403: 접근 권한이 없습니다.');
          }
        }finally{unlock();}
        if(retry!==null){
          await this.sleeper(retry,this.signal,kind);
          if(attempt===3)throw new Error('요청 제한 또는 검색 인덱싱 재시도 한도에 도달했습니다.');
          continue;
        }
        return response;
      }
    }finally{release();}
  }
  check(){if(this.signal?.aborted)throw stopped();this.guard();}
}
exports.sharedRateLimits=sharedRateLimits;
exports.stopped=stopped;
exports.pause=pause;
exports.DiscordApi=DiscordApi;
},
"src/utils/log.js": (exports, require) => {
// Original project: https://github.com/victornpb/undiscord; disable console fallback.

const log = {
  debug() { return logFn ? logFn('debug', arguments) : undefined; },
  info() { return logFn ? logFn('info', arguments) : undefined; },
  verb() { return logFn ? logFn('verb', arguments) : undefined; },
  warn() { return logFn ? logFn('warn', arguments) : undefined; },
  error() { return logFn ? logFn('error', arguments) : undefined; },
  success() { return logFn ? logFn('success', arguments) : undefined; },
};

var logFn; // custom console.log function
const setLogFn = (fn) => logFn = fn;

exports.log = log;
exports.setLogFn = setLogFn;
},
"src/utils/getIds.js": (exports, require) => {
// Adapted from Victornpb's Undiscord: https://github.com/victornpb/undiscord
// MIT + attribution; standalone port removes unload dispatch, globals and leaked iframes.
const { log } = require("src/utils/log.js");
function readExistingStorage(key) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  document.body.appendChild(frame);
  try { return JSON.parse(frame.contentWindow.localStorage.getItem(key)); }
  finally { frame.remove(); }
}
let discordRequire, inspectedFactories=new Set(), factoryStores=[];
const validId=id=>typeof id==='string'&&/^\d{1,22}$/.test(id);
function safely(read,fallback=null) {try{return read()??fallback;}catch{return fallback;}}
function stores() {
  const chunks=window.webpackChunkdiscord_app;
  if(!discordRequire&&Array.isArray(chunks)) {
    const key='undiscord-context-'+Date.now();
    try {chunks.push([[key],{},runtime=>{discordRequire=runtime;}]);}
    catch {} finally {const index=chunks.findIndex(item=>item?.[0]?.[0]===key);if(index>=0)chunks.splice(index,1);}
  }
  const values=[],seen=new Set();
  function collect(value,depth=0) {
    if(!value||!['object','function'].includes(typeof value)||seen.has(value)||depth>2)return;
    seen.add(value);values.push(value);
    for(const key of safely(()=>Object.keys(value),[]).slice(0,100))collect(safely(()=>value[key]),depth+1);
  }
  for(const mod of Object.values(discordRequire?.c||{}))collect(safely(()=>mod.exports));
  // Some webpack builds hide .c. Load only factories identifying the concrete
  // user/channel stores, not every module mentioning a user or message.
  if(typeof discordRequire==='function') {
    let loaded=0;
    for(const [id,factory] of Object.entries(discordRequire.m||{})) {
      if(inspectedFactories.has(id))continue;
      const source=safely(()=>Function.prototype.toString.call(factory),'');
      if(!/(?:UserStore|ChannelStore|PrivateChannelSortStore)/.test(source)||!/(?:getCurrentUser|getPrivateChannelIds|getSortedPrivateChannels|getChannel\()/.test(source))continue;
      if(loaded++>=12)break;inspectedFactories.add(id);
      const exported=safely(()=>discordRequire(id));if(exported)factoryStores.push(exported);
    }
  }
  for(const exported of factoryStores)collect(exported);
  const found={};
  for(const value of values) {
    if(typeof value.getUser==='function'&&!found.users)found.users=value;
    if(typeof value.getCurrentUser==='function') {
      const account=safely(()=>value.getCurrentUser());
      if(!found.current||validId(account?.id))found.current=value;
      if(validId(account?.id)){if(found.accountId&&found.accountId!==account.id)found.accountConflict=true;found.accountId=account.id;}
    }
    if(typeof value.getGuild==='function'&&!found.guilds)found.guilds=value;
    if(typeof value.getChannel==='function'&&!found.channels)found.channels=value;
    if(typeof value.getPrivateChannelIds==='function'&&!found.privateChannels)found.privateChannels=value;
    if(typeof value.getSortedPrivateChannels==='function'&&!found.sortedPrivate)found.sortedPrivate=value;
    if(typeof value.getMember==='function'&&!found.members)found.members=value;
  }
  return found;
}
// Verified identities and API list snapshots never outlive their session token.
// user_id_cache is intentionally not an identity source.
let verifiedSession=null,apiList=null;
function getCurrentAccount() {
  const st=stores();
  if(st.accountConflict)return '';
  if(validId(st.accountId))return st.accountId;
  if(verifiedSession&&fillToken()===verifiedSession.token)return verifiedSession.user.id;
  verifiedSession=null;apiList=null;return '';
}
async function contextRequest(path,token,ownerId='',{signal,guard}={}) {
  const {DiscordApi,pause,sharedRateLimits}=require('src/core/api.js');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const api=new DiscordApi(token,{signal:controller.signal,rateLimits:sharedRateLimits,sleeper:pause,guard:()=>{
    guard?.();const st=stores();
    if(fillToken()!==token||st.accountConflict||(ownerId&&st.accountId&&st.accountId!==ownerId))throw new Error('로그인 계정이 변경되었습니다. 목록을 다시 불러와 주세요.');
  }});
  try {
    const response=await api.request(path,'GET',1000);
    if(response.status===401)throw new Error('Discord 인증이 만료되었습니다. 로그인 상태를 확인해 주세요.');
    if(!response.ok)throw new Error(`Discord 목록 조회 실패: HTTP ${response.status}`);
    let data;try{data=await response.json();}catch{throw new Error('Discord 목록 응답을 읽을 수 없습니다.');}
    if(fillToken()!==token)throw new Error('목록 조회 중 로그인 계정이 변경되었습니다.');
    return data;
  }catch(error){
    if(error.name==='AbortError'&&signal?.aborted)throw error;
    if(error.name==='AbortError')throw new Error('Discord 계정/목록 응답 대기 시간이 초과되었습니다. 잠시 후 목록을 다시 불러와 주세요.');
    throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);api.clear();}
}
async function resolveAccount({refresh=false,signal,guard}={}) {
  for(let attempt=0;attempt<5;attempt++) {
    if(signal?.aborted)throw require('src/core/api.js').stopped();guard?.();
    const st=stores();
    if(st.accountConflict)throw new Error('계정 정보가 서로 일치하지 않습니다. 작업을 시작하지 않았습니다.');
    if(validId(st.accountId))return {ownerId:st.accountId,st};
    if(verifiedSession&&fillToken()===verifiedSession.token)break;
    if(attempt<4)await require('src/core/api.js').pause(250,signal);
  }
  const token=fillToken();
  if(!token)throw new Error('Discord 로그인 정보가 아직 준비되지 않았거나 로그인되어 있지 않습니다. 잠시 후 목록을 다시 불러와 주세요.');
  if(refresh||!verifiedSession||verifiedSession.token!==token) {
    const user=await contextRequest('/users/@me',token,'',{signal,guard});
    if(!validId(user?.id))throw new Error('Discord 계정 응답 형식이 변경되었습니다.');
    const st=stores();if(st.accountConflict||(st.accountId&&st.accountId!==user.id))throw new Error('계정 정보가 조회 중 변경되었습니다.');
    verifiedSession={token,user};
  }
  return {ownerId:verifiedSession.user.id,st:stores(),identityVerified:true};
}
async function getDMList({refresh=true,signal,guard}={}) {
  const {ownerId,st,identityVerified}=await resolveAccount({refresh,signal,guard});
  let data,source='store';
  const provider=st.privateChannels||st.channels;
  // The sort store corresponds to the private-channel list, not relationships.
  // Normalize known shapes without depending on virtualized DOM rows.
  if(typeof st.sortedPrivate?.getSortedPrivateChannels==='function') {
    source='sorted-store';
    const rows=safely(()=>st.sortedPrivate.getSortedPrivateChannels());
    if(!Array.isArray(rows))throw new Error('DM 정렬 스토어 응답 형식이 변경되었습니다.');
    data=rows.map(row=>{
      const item=row?.channel||row;
      if(typeof item==='string')return safely(()=>st.channels?.getChannel(item))||{unavailable:true};
      if(item&&validId(item.id)&&!Number.isInteger(item.type))return safely(()=>st.channels?.getChannel(item.id))||{unavailable:true};
      return item;
    });
  }else if(typeof provider?.getPrivateChannelIds==='function'&&typeof st.channels?.getChannel==='function') {
    source='channel-store';
    const ids=safely(()=>provider.getPrivateChannelIds());
    if(!Array.isArray(ids)||ids.some(id=>!validId(id)))throw new Error('DM 목록 응답 형식이 변경되었습니다.');
    data=ids.map(id=>safely(()=>st.channels.getChannel(id))||{unavailable:true});
  }else {
    source='api';const token=fillToken();
    if(!token)throw new Error('Discord 인증 정보를 확인할 수 없습니다.');
    if(!verifiedSession||verifiedSession.token!==token||(refresh&&!identityVerified)) {
      const user=await contextRequest('/users/@me',token,ownerId,{signal,guard});
      if(!validId(user?.id)||user.id!==ownerId)throw new Error('현재 계정과 인증된 계정이 일치하지 않습니다.');
      verifiedSession={token,user};
    }
    if(refresh||!apiList||apiList.ownerId!==ownerId||apiList.token!==token) {
      const rows=await contextRequest('/users/@me/channels',token,ownerId,{signal,guard});
      if(!Array.isArray(rows))throw new Error('Discord DM 목록 응답 형식이 변경되었습니다.');
      apiList={ownerId,token,rows};
    }
    data=apiList.rows;
  }
  const channels=new Map();let unavailable=0;
  for(const channel of data) {
    if(channel?.unavailable){unavailable++;continue;}
    if(!channel||!validId(channel.id)||!Number.isInteger(channel.type))throw new Error('DM 채널 응답 형식이 변경되었습니다.');
    if(channel.type!==1||channel.closed===true)continue;
    if(!Array.isArray(channel.recipients)||channel.recipients.length!==1){unavailable++;continue;}
    const recipient=channel.recipients[0],userId=typeof recipient==='string'?recipient:recipient?.id;
    if(!validId(userId)||userId===ownerId){unavailable++;continue;}
    const user=safely(()=>st.users.getUser(userId))||(typeof recipient==='object'?recipient:null);
    channels.set(channel.id,{channelId:channel.id,userId,displayName:String(user?.globalName||user?.global_name||user?.username||`사용자 ID ${userId}`),username:String(user?.username||userId),presence:'unknown'});
  }
  if(signal?.aborted)throw require('src/core/api.js').stopped();guard?.();
  if(getCurrentAccount()!==ownerId)throw new Error('목록 조회 도중 계정이 변경되었습니다.');
  return {ownerId,channels:[...channels.values()].sort((a,b)=>a.displayName.localeCompare(b.displayName,'ko')||a.channelId.localeCompare(b.channelId)),unavailable,source,scope:'현재 Discord에서 조회 가능한 1:1 DM만 표시합니다. 닫힌 과거 DM이나 검색 인덱스 밖의 메시지는 보장하지 않습니다.'};
}
function getAuthorId() {return getCurrentAccount();}
function getContext(authorId='') {
  const guildId=getGuildId(),channelId=getChannelId(),isDM=guildId==='@me';
  const info={isFriends:/^\/channels\/@me\/?$/.test(location.pathname),path:location.pathname,guildId,channelId,isDM,guildName:'',channelName:'',authorId:'',authorDisplayName:'',authorUsername:'',users:[]};
  const st=stores(),list=new Map();
  let channel=safely(()=>st.channels?.getChannel(channelId)),guild=safely(()=>st.guilds?.getGuild(guildId));
  info.authorId=getCurrentAccount();
  const add=user=>{
    if(!user||!/^\d+$/.test(String(user.id))||typeof user.username!=='string'||!user.username)return;
    const nickname=safely(()=>st.members?.getMember(guildId,user.id)?.nick,'');
    const item={id:String(user.id),displayName:nickname||user.globalName||user.global_name||user.displayName||user.username,username:user.username};
    const old=list.get(item.id);if(old&&old.displayName!==old.username&&item.displayName===item.username)item.displayName=old.displayName;
    list.set(item.id,item);
  };
  add(safely(()=>st.current?.getCurrentUser())||verifiedSession?.user);
  if(authorId)add(safely(()=>st.users?.getUser(authorId)));
  for(const user of Object.values(safely(()=>st.users?.getUsers(),{})).slice(0,200))add(user);
  // Discord can hide webpack's module cache or rename exports. Read concrete
  // guild/channel/user props already attached to rendered React nodes as fallback.
  // Never traverse stateNode, arbitrary stores, auth objects or message contents.
  const seen=new Set();let inspected=0;
  function props(p,depth=0) {
    if(!p||typeof p!=='object'||depth>2)return;
    if(p.guild?.id===guildId&&p.guild.name)guild=p.guild;
    if(p.channel?.id===channelId)channel=p.channel;
    for(const user of [p.user,p.currentUser,p.author,p.message?.author])add(user);
    // Rendered users supply display names only, never authenticated identity.
    if(Array.isArray(p.recipients))for(const user of p.recipients.slice(0,50))add(user);
    for(const child of (Array.isArray(p.children)?p.children:[p.children]).slice(0,30))if(child?.props)props(child.props,depth+1);
  }
  const nodes=safely(()=>document.querySelectorAll('[data-list-item-id], [id^="chat-messages"], [data-message-id], header, nav, [class*="panels"], [class*="account"], img[src*="/avatars/"], [class*="username"], a[href^="/channels/"], [role="main"]'),[]);
  for(const node of Array.from(nodes).slice(0,1600)) {
    for(const key of Object.keys(node)) {
      if(key.startsWith('__reactProps$'))safely(()=>props(node[key]));
      if(!key.startsWith('__reactFiber$')&&!key.startsWith('__reactInternalInstance$'))continue;
      let fiber=node[key];
      for(let depth=0;fiber&&depth<24&&inspected<5000;depth++,fiber=fiber.return) {
        if(seen.has(fiber))break;seen.add(fiber);inspected++;
        safely(()=>props(fiber.memoizedProps));
      }
    }
  }
  // Only DOM elements explicitly linked to the exact path IDs may supply names.
  const text=node=>node?.textContent?.trim()||'';
  if(!isDM&&!guild?.name) {
    const node=safely(()=>document.querySelector(`[data-list-item-id="guildsnav___${guildId}"]`));
    const image=safely(()=>node?.querySelector('img[alt]'));
    const name=image?.getAttribute('alt')||node?.getAttribute('aria-label')||'';
    if(name)guild={id:guildId,name};
  }
  if(!isDM&&!channel?.name) {
    const node=safely(()=>document.querySelector(`a[href="/channels/${guildId}/${channelId}"]`));
    const name=text(safely(()=>node?.querySelector('[class*="name"]')))||node?.getAttribute('aria-label')||'';
    if(name)channel={...(channel||{}),id:channelId,name};
  }
  for(const recipient of channel?.recipients||[]) {
    add(recipient);
    const id=typeof recipient==='string'?recipient:recipient.id;
    add(safely(()=>st.users?.getUser(id)));
  }
  if(info.authorId)add(safely(()=>st.users?.getUser(info.authorId)));
  const participantIds=new Set([info.authorId,...(channel?.recipients||[]).map(value=>typeof value==='string'?value:value?.id)].filter(Boolean).map(String));
  info.participantIds=isDM?[...participantIds]:[];
  info.users=[...list.values()].filter(user=>!isDM||participantIds.has(user.id));
  const author=info.users.find(user=>user.id===(authorId||info.authorId));
  info.authorDisplayName=author?.displayName||'';info.authorUsername=author?.username||'';
  if(isDM) {
    if(channel?.type===3)info.guildName=channel.name||'그룹 DM';
    else if(channel?.type===1) {
      const recipient=(channel.recipients||[]).find(value=>(typeof value==='string'?value:value.id)!==info.authorId);
      const user=list.get(typeof recipient==='string'?recipient:recipient?.id);
      info.guildName=user?`${user.displayName}(${user.username})`:'정보 확인 불가';
    } else info.guildName='정보 확인 불가';
  } else {info.guildName=guild?.name||'';info.channelName=channel?.name||'';}
  return info;
}
function getGuildId() { return location.pathname.match(/^\/channels\/([\w@]+)\/(\d+)/)?.[1] || ''; }
function getChannelId() { return location.pathname.match(/^\/channels\/([\w@]+)\/(\d+)/)?.[2] || ''; }
function fillToken() {
  try {
    const token = readExistingStorage('token');
    if (typeof token === 'string' && token) return token;
  } catch { /* Try only the original upstream webpack getter below. */ }
  // Same internal getter as upstream. Unsupported by Discord; fail closed if unavailable.
  const chunks = window.webpackChunkdiscord_app;
  if (Array.isArray(chunks)) {
    let token = '';
    const id = 'undiscord-' + Date.now();
    try {
      chunks.push([[id], {}, runtime => {
        for (const module of Object.values(runtime.c || {})) {
          const getter = module?.exports?.default;
          if (typeof getter?.getToken === 'function') {
            const value = getter.getToken();
            if (typeof value === 'string') { token = value; break; }
          }
        }
      }]);
      if (token) return token;
    } catch { /* Do not expose internal exceptions or authentication data. */ }
    finally {
      const index = chunks.findIndex(item => item?.[0]?.[0] === id);
      if (index >= 0) chunks.splice(index, 1);
    }
  }
  log.error('Discord 인증 정보를 얻을 수 없습니다. 현재 내부 인증 방식이 변경되었을 수 있습니다. 작업을 시작하지 않았습니다.');
  return '';
}

exports.getDMList=getDMList;
exports.getCurrentAccount=getCurrentAccount;
exports.getContext = getContext;
exports.getAuthorId = getAuthorId;
exports.getGuildId = getGuildId;
exports.getChannelId = getChannelId;
exports.fillToken = fillToken;
},
"src/runtime/options.js": (exports, require) => {
// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
// Boundary validation: never accept token or executable code fields.
const strings = ['authorId','guildId','channelId','minId','maxId','content','pattern'];
const flags = ['hasLink','hasFile','includeNsfw','includePinned'];
function validateOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('검색 조건이 필요합니다.');
  const allowed = [...strings,...flags,'searchDelay','deleteDelay'];
  if (Object.keys(input).some(key=>!allowed.includes(key))) throw new Error('허용하지 않은 검색 조건입니다.');
  const result = {};
  for (const key of strings) {
    if (typeof input[key] !== 'string' || input[key].length > (key==='pattern'?500:1024)) throw new Error('검색 조건 형식이 올바르지 않습니다.');
    result[key]=input[key].trim();
  }
  for(const key of flags) { if(typeof input[key]!=='boolean')throw new Error('필터 형식이 올바르지 않습니다.');result[key]=input[key]; }
  for(const key of ['searchDelay','deleteDelay']) {
    const min=key==='searchDelay'?100:50;
    if(!Number.isInteger(input[key])||input[key]<min||input[key]>3600000) throw new Error('요청 대기 시간을 확인해 주세요.');
    result[key]=input[key];
  }
  if(!/^(?:@me|\d{1,22})$/.test(result.guildId))throw new Error('Server ID를 입력해 주세요. DM은 @me입니다.');
  for(const key of ['authorId','channelId']) if(result[key]&&!/^\d{1,22}$/.test(result[key]))throw new Error('작성자/채널 ID는 숫자 하나여야 합니다.');
  if(result.guildId==='@me'&&!result.channelId)throw new Error('DM의 Channel ID가 필요합니다.');
  for(const key of ['minId','maxId']) {
    const value=result[key];
    if(value&&!/^\d{1,22}$/.test(value)&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))throw new Error('메시지 ID 또는 날짜 형식을 확인해 주세요.');
    if(value.includes(':')&&(!Number.isFinite(new Date(value).getTime())||new Date(value).getTime()<1420070400000))throw new Error('날짜가 올바르지 않습니다.');
  }
  const bound=value=>value.includes(':')?BigInt(new Date(value).getTime()-1420070400000)*4194304n:BigInt(value);
  if(result.minId&&result.maxId&&bound(result.minId)>=bound(result.maxId))throw new Error('검색 범위의 시작이 끝보다 작아야 합니다.');
  try {new RegExp(result.pattern,'i');}catch{throw new Error('정규식이 올바르지 않습니다.');}
  return result;
}

exports.validateOptions = validateOptions;
}
};
const cache = {};
function require(id) { if (cache[id]) return cache[id]; const exports = {}; cache[id] = exports; modules[id](exports, require); return exports; }
require('src/runtime/entry.js');

return {fresh:true,version:12};
}
