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
Object.defineProperty(window, marker, {value:Object.freeze({dispatch:runner.dispatch,version:5}), configurable:false});
setInterval(runner.reconcile,500);
window.addEventListener('popstate',runner.reconcile);

},
"src/runtime/runner.js": (exports, require) => {
// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
// Nonvisual tab-owned runner: no popup lifetime or worker keepalive dependency.
const Core = require("src/undiscord-core.js").default;
const { fillToken, getAuthorId, getGuildId, getChannelId, getContext } = require("src/utils/getIds.js");
const { setLogFn } = require("src/utils/log.js");
const { validateOptions } = require("src/runtime/options.js");
function createRunner(capability, environment = {}) {
  const core = environment.core || new Core();
  const tokenProvider = environment.tokenProvider || fillToken;
  const path = environment.path || (() => location.pathname);
  const id = environment.id || (() => crypto.randomUUID());
  let phase = 'idle', jobId = '', reason = '', requestPath = '', stopRequested = false;
  let cooldownUntil = 0, jobContext = null, waitState=null, activitySeen=false;
  let resolveConfirmation = null, preview = [], logs = [], options = null, error = '';
  const active = () => ['searching','awaiting-confirmation','running','search-wait','rate-wait','retry-wait','stopping'].includes(phase);
  function record(type,args) {
    const text = Array.from(args).map(value=>String(value)).join(' ').slice(0,3000);
    logs.push({type,text});if(logs.length>500)logs.shift();
    if(type==='error')error=text;
  }
  (environment.setLogger || setLogFn)(record);
  function snapshot() {
    return { version:5, context:getContext(options?.authorId), jobContext, cooldownUntil, wait:waitState, result:core.result, phase, jobId, reason, options: options && {...options}, path:path(),
      progress:core.progress(),
      counts:{success:core.state.delCount,failed:core.state.failCount,total:core.state.targetCount,unique:core.state.uniqueCount||0,targets:core.state.targetCount||0,excluded:core.state.excludedCount||0,pending:core.state.pendingCount||0,exclusions:{...core.state.exclusions}},
      elapsed:core.stats.startTime?Math.max(0,(core.stats.endTime?.getTime()||Date.now())-core.stats.startTime.getTime()):0,
      remaining:Number.isFinite(core.stats.etr)?core.stats.etr:0,
      throttled:core.stats.throttledCount,
      preview:phase==='awaiting-confirmation'?preview:[], logs:logs.map(item=>({...item})), error,
    };
  }
  core.onStart = () => {phase='searching';};
  core.onProgress = () => {if(!stopRequested&&!activitySeen)phase='running';};
  core.onActivity = activity => {if(stopRequested)return;activitySeen=true;phase=activity.phase;waitState=activity.wait;cooldownUntil=activity.wait?.kind==='rate-limit'?activity.wait.until:0;};
  core.onStop = () => {cooldownUntil=0;waitState=null;phase=stopRequested?'stopped':core.result?.outcome||(error?'error':'partial');reason=stopRequested?reason:core.result?.reason||reason;preview=[];resolveConfirmation=null;};
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
    stopRequested=true;reason=message;phase='stopping';waitState=null;cooldownUntil=0;
    const resolve=resolveConfirmation;resolveConfirmation=null;resolve?.(false);core.stop();
  }
  function reconcile() {if(active()&&path()!==requestPath)stop('Discord 채널 이동으로 작업이 중단되었습니다.');}
  core.checkTarget=()=>{reconcile();if(stopRequested){const error=new Error('작업 대상이 변경되었거나 중단되었습니다.');error.name='AbortError';throw error;}};
  async function dispatch(secret, command) {
    if(secret!==capability)throw new Error('허용되지 않은 명령입니다.');
    if(!command||typeof command!=='object'||Array.isArray(command))throw new Error('명령 형식 오류');
    reconcile();
    switch(command.type) {
      case 'status': return snapshot();
      case 'context': return getContext(command.authorId);
      case 'prepare': {
        if(active())throw new Error('이미 실행 중인 작업이 있습니다.');
        if(!/^\/channels\/(?:@me|\d+)\/\d+/.test(path())||command.expectedPath!==path())throw new Error('대상 탭/채널이 변경되었습니다. 현재 정보를 다시 가져와 주세요.');
        const valid=validateOptions(command.options);
        if(valid.guildId!==getGuildId()||(valid.channelId&&valid.channelId!==getChannelId())||(valid.guildId==='@me'&&valid.channelId!==getChannelId()))throw new Error('현재 서버 또는 채널과 검색 대상이 다릅니다. 다시 확인해 주세요.');
        if(valid.guildId==='@me'&&valid.authorId&&!getContext(valid.authorId).participantIds.includes(valid.authorId))throw new Error('현재 DM에 참여한 작성자를 다시 선택해 주세요.');
        const token=tokenProvider();
        if(!token)throw new Error('Discord 인증 정보를 얻지 못했습니다. 현재 내부 인증 방식을 지원하지 않을 수 있습니다.');
        jobContext=getContext(valid.authorId);cooldownUntil=0;options=valid;jobId=id();requestPath=path();reason='';error='';logs=[];preview=[];stopRequested=false;
        waitState=null;activitySeen=false;core.resetState();core.stats.endTime=null;core.options={...core.options,...valid};core.configure(token);
        phase='searching';
        // The job Promise belongs to the tab. Never await it from a popup/worker request.
        void core.run().catch(()=>{error='작업 실행 오류';core.stop();core.api?.clear();cooldownUntil=0;waitState=null;phase='error';});
        return snapshot();
      }
      case 'confirm': {
        if(phase!=='awaiting-confirmation'||command.jobId!==jobId||!resolveConfirmation)throw new Error('확인 대상 작업이 변경되었습니다.');
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
const { DiscordApi, pause, stopped } = require('src/core/api.js');
const { log } = require('src/utils/log.js');
const freshState=()=>({running:false,delCount:0,failCount:0,iterations:0,
  searchComplete:false,uniqueCount:0,targetCount:0,excludedCount:0,pendingCount:0,exclusions:{},malformed:false,
  _seachResponse:null,_messagesToDelete:[],_skippedMessages:[]});
class UndiscordCore {
  options={authorId:null,guildId:null,channelId:null,minId:null,maxId:null,content:null,
    hasLink:false,hasFile:false,includeNsfw:false,includePinned:false,pattern:'',searchDelay:30000,deleteDelay:1000,askForConfirmation:true};
  state=freshState();
  stats={startTime:null,endTime:null,throttledCount:0,throttledTotalTime:0,lastPing:0,avgPing:0,etr:0};
  ledger=new Map();api=null;controller=null;result=null;
  activity='searching';waitState=null;lastSearchAt=null;prefetch=null;waits=new Map();
  // Limits bound changing indexes, repeated pages and very large searches.
  limits={pagesPerPass:1000,uniqueMessages:200000};
  constructor({fetcher=globalThis.fetch,sleeper=pause,now=()=>Date.now()}={}) {this.fetcher=fetcher;this.sleeper=sleeper;this.now=now;}
  resetState(){this.state=freshState();this.ledger.clear();this.result=null;this.waitState=null;this.lastSearchAt=null;this.prefetch=null;this.waits.clear();this.options.askForConfirmation=true;}
  configure(token){
    this.controller=new AbortController();
    this.api=new DiscordApi(token,{signal:this.controller.signal,fetcher:this.fetcher,
      sleeper:(ms,signal,kind)=>this.wait(ms,kind),guard:()=>{this.checkTarget?.();if(!this.state.running)throw stopped();},
      now:this.now,beforeAttempt:method=>{if(method==='GET')this.lastSearchAt=this.now();},
      onThrottle:ms=>{this.stats.throttledCount++;this.stats.throttledTotalTime+=ms;}});
  }
  emitActivity(){
    const waits=[...this.waits.values()];
    const wait=waits.find(item=>item.kind==='rate-limit')||waits.find(item=>item.kind==='retry')||waits.find(item=>item.kind==='next-search');
    const phase=wait?.kind==='rate-limit'?'rate-wait':wait?.kind==='retry'?'retry-wait':this.activity;
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
  setOutcome(id,status,reason=''){
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
    this.onProgress?.(this.state,this.stats);
  }
  progress(){
    const processed=this.state.delCount+this.state.failCount;
    const known=this.state.searchComplete&&!this.state.malformed;
    const total=this.state.targetCount;
    return {processed,total:known?total:null,known,
      value:known?(total?processed/total*100:100):null};
  }
  // Only this consumer mutates filtering/ledger state. The producer holds one
  // response (or request) and never writes the deletion queue.
  async sweep(){
    let cursor=null;
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
      if(result.data.doing_deep_historical_index===true){this.state.malformed=true;log.warn('검색 인덱싱이 진행 중이므로 검색 결과의 완전성을 확정할 수 없습니다.');}
      const ids=this.state._pageIds;
      if(!result.data.messages.length){this.state.searchComplete=true;this.onProgress?.(this.state,this.stats);return;}
      if(!ids.length){const error=new Error('검색 결과에서 유효한 메시지를 확인하지 못했습니다.');error.incomplete=true;throw error;}
      const oldest=ids.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b);
      if(cursor&&BigInt(oldest)>=BigInt(cursor)){
        const error=new Error('검색 커서가 진행되지 않아 안전하게 중단했습니다.');error.incomplete=true;throw error;
      }
      if(cursor&&ids.some(id=>BigInt(id)>=BigInt(cursor))){
        const error=new Error('검색 경계 밖의 응답으로 검색을 안전하게 중단했습니다.');error.incomplete=true;throw error;
      }
      const queue=this.state._messagesToDelete;
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
      if(!this.state.running||this.controller.signal.aborted)throw stopped();
      const consistent=this.state.targetCount===this.state.delCount+this.state.failCount+this.state.pendingCount;
      if(!consistent)throw new Error('메시지 집계 상태가 일치하지 않습니다.');
      const complete=this.state.searchComplete&&!this.state.malformed&&this.state.failCount===0&&this.state.pendingCount===0;
      this.result={outcome:complete?'completed':'partial',
        reason:complete?'검색 및 삭제 작업이 완료되었습니다.':
          this.state.malformed?'검색 응답 또는 인덱싱 상태로 전체 검색 결과를 확정하지 못했습니다.':
          `삭제 실패 ${this.state.failCount}건, 미처리 ${this.state.pendingCount}건이 남았습니다.`};
    }catch(error){
      const cancelled=this.controller?.signal.aborted||!this.state.running;
      this.result={outcome:cancelled?'stopped':error.incomplete?'partial':'error',reason:cancelled?'작업이 중단되었습니다.':error.message||'작업 중 오류가 발생했습니다.'};
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
      if(this.ledger.get(message.id)?.status!=='pending')continue;
      // The filter is rechecked immediately before the destructive request.
      const reason=this.exclusionReason(message);
      if(reason){this.setOutcome(message.id,'excluded',reason);continue;}
      try{
        const result=await this.deleteMessage(message);
        // A confirmed response remains authoritative even if stop was requested in flight.
        this.setOutcome(message.id,result==='OK'?'success':'failed');
      }catch(error){
        if(error.definiteFailure)this.setOutcome(message.id,'failed');
        throw error; // Ambiguous responses stay pending and are never retried.
      }
      if(!this.state.running||this.controller.signal.aborted)throw stopped();
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
    const remaining=this.lastSearchAt===null?0:this.options.searchDelay-(this.now()-this.lastSearchAt);
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
      ]), 'GET', this.options.searchDelay);
    this.afterRequest();
    if (!resp.ok) throw new Error(`검색 실패: Discord HTTP ${resp.status}`);
    let data;try{data=await resp.json();}catch{throw new Error('Discord 검색 응답을 읽지 못했습니다.');}
    if (!data || !Array.isArray(data.messages) ||
        data.messages.some(group => !Array.isArray(group))) throw new Error('Discord 검색 응답 형식이 변경되었습니다.');
    return data;
  }

async function filterSearchResponse() {
    const data=this.state._seachResponse;
    const validId=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
    // Stable exclusion precedence assigns exactly one reason to each unique ID.
    const exclusion=message=>{
      if(message.hit!==true)return 'other';
      if(!validId(message.id)||!validId(message.channel_id)){this.state.malformed=true;return 'other';}
      if(this.options.guildId!=='@me'&&message.guild_id&&message.guild_id!==this.options.guildId)return 'channel';
      if(this.options.authorId&&message.author?.id!==this.options.authorId)return 'author';
      if(this.options.channelId&&message.channel_id!==this.options.channelId)return 'channel';
      const id=BigInt(message.id);
      if(this.options.minId&&id<=BigInt(toSnowflake(this.options.minId)))return 'range';
      if(this.options.maxId&&id>=BigInt(toSnowflake(this.options.maxId)))return 'range';
      if(!(message.type===0||(message.type>=6&&message.type<=21)))return 'system';
      if(message.pinned&&!this.options.includePinned)return 'pinned';
      // Discord's content search selects hits server-side; also check the actual text.
      const content=String(message.content||'');
      const terms=(this.options.content||'').match(/"[^"]+"|\S+/g)||[];
      if(terms.some(term=>!content.toLocaleLowerCase().includes(term.replace(/^"|"$/g,'').toLocaleLowerCase())))return 'content';
      if(this.options.hasLink&&!/https?:\/\/\S+/i.test(content))return 'link';
      if(this.options.hasFile&&!message.attachments?.length)return 'file';
      if(!new RegExp(this.options.pattern||'','i').test(content))return 'regex';
      return '';
    };
    this.exclusionReason=exclusion;
    const unique=new Map();
    for(const group of data.messages)for(const message of group){
      if(message?.hit!==true)continue;
      if(!validId(message.id)){this.state.malformed=true;continue;}
      unique.set(String(message.id),message);
    }
    this.state._pageIds=[...unique.keys()];
    const targets=[],skipped=[];
    for(const [id,message] of unique){
      const previous=this.ledger?.get(id);
      if(previous&&previous.status!=='pending'){
        skipped.push(message);continue;
      }
      const reason=exclusion(message);
      // Compatibility for source-level filtering tests; production always owns a ledger.
      if(this.setOutcome)this.setOutcome(id,reason?'excluded':'pending',reason);
      if(reason)skipped.push(message);else targets.push(message);
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
    if(resp.status>=500){const error=new Error('서버 오류로 삭제 결과를 확정하지 못했습니다. 중복 요청을 중단했습니다.');error.incomplete=true;throw error;}
    if (!resp.ok) {log.warn(`메시지 삭제 실패: HTTP ${resp.status}`);return 'FAILED';}
    return 'OK';
}


exports.deleteMessage = deleteMessage;
},
"src/core/api.js": (exports, require) => {
// Adapted from Victornpb's Undiscord search/delete request handling.
// Original project: https://github.com/victornpb/undiscord (MIT + attribution).
const stopped = () => new DOMException('Stopped', 'AbortError');
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(stopped()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
class DiscordApi {
  #token;
  constructor(token, { signal, onThrottle = () => {}, fetcher = globalThis.fetch, sleeper = pause, guard = () => {}, now = () => Date.now(), beforeAttempt = () => {} } = {}) {
    this.#token = token; this.signal = signal; this.onThrottle = onThrottle;
    this.fetcher = fetcher; this.sleeper = sleeper; this.guard=guard;this.now=now;this.beforeAttempt=beforeAttempt;this.globalUntil=0;this.routeUntil=new Map();
  }
  clear() { this.#token = null; }
  async request(path, method = 'GET', delay = 1000) {
    if (!/^\/(?:guilds\/\d+\/messages\/search\?|channels\/\d+\/messages\/search\?|channels\/\d+\/messages\/\d+$)/.test(path)) throw new Error('허용되지 않은 API 경로입니다.');
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.signal?.aborted) throw stopped();
      this.guard();
      const route=method==='GET'?'search':'delete';
      let remaining;
      while((remaining=Math.max(this.globalUntil,this.routeUntil.get(route)||0)-this.now())>0){
        await this.sleeper(remaining,this.signal,'rate-limit');
        if(this.signal?.aborted)throw stopped();
      }
      if(this.signal?.aborted)throw stopped();this.guard();this.beforeAttempt(method);
      let response;
      try {
        response = await this.fetcher('https://discord.com/api/v9' + path, {
          method, headers: { Authorization: this.#token }, signal: this.signal,
          credentials: 'same-origin', redirect: 'error',
        });
      } catch (error) {
        if (this.signal?.aborted || error.name === 'AbortError') throw stopped();
        if(method==='DELETE'){const uncertain=new Error('삭제 응답을 확인하지 못했습니다. 중복 삭제 요청을 중단했습니다.');uncertain.incomplete=true;throw uncertain;}
        if (attempt === 3) throw new Error('네트워크 요청에 실패했습니다. 연결 상태를 확인해 주세요.');
        await this.sleeper(delay * (attempt + 1), this.signal, 'retry'); continue;
      }
      const reset=response.headers.get('x-ratelimit-reset-after');
      if(response.headers.get('x-ratelimit-remaining')==='0'&&reset!==null&&Number.isFinite(Number(reset))){
        this.routeUntil.set(route,this.now()+Math.max(0,Number(reset))*1000);
      }
      if (response.status === 429 || response.status === 202) {
        const data = await response.json().catch(() => ({}));
        const header=response.headers.get('retry-after');
        const headerSeconds=Number.isFinite(Number(header))?Number(header):Math.max(0,(Date.parse(header)-Date.now())/1000);
        const seconds=Math.max(Number.isFinite(Number(data.retry_after))?Number(data.retry_after):0,Number.isFinite(headerSeconds)?headerSeconds:0);
        const ms = Math.max(delay, seconds * 1000) + 250;
        if(data.global===true||response.headers.get('x-ratelimit-global')==='true')this.globalUntil=Math.max(this.globalUntil,this.now()+ms);
        else this.routeUntil.set(route,this.now()+ms);
        this.onThrottle(ms);
        // Wait even on the final attempt, then end; never ignore a server cooldown.
        await this.sleeper(ms, this.signal, 'rate-limit');
        if(method==='DELETE'&&response.status===202){const error=new Error('삭제 결과가 아직 확정되지 않아 중복 요청을 중단했습니다.');error.incomplete=true;throw error;}
        if (attempt === 3){const error=new Error('요청 제한 또는 검색 인덱싱 대기가 반복되어 중단했습니다. 나중에 다시 시도해 주세요.');error.incomplete=true;error.definiteFailure=method==='DELETE'&&response.status===429;throw error;}
        continue;
      }
      if (response.status >= 500 && attempt < 3 && method!=='DELETE') {
        await this.sleeper(delay * (attempt + 1), this.signal, 'retry'); continue;
      }
      if ([401, 403].includes(response.status)){const error=new Error(`Discord HTTP ${response.status}: 인증 또는 접근 권한을 확인해 주세요.`);error.definiteFailure=method==='DELETE';throw error;}
      return response;
    }
  }
}

exports.stopped = stopped;
exports.pause = pause;
exports.DiscordApi = DiscordApi;
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
let discordRequire;
function stores() {
  // Read cached Discord stores only. Never fetch profiles or copy auth exports.
  const chunks=window.webpackChunkdiscord_app;
  if(!discordRequire&&Array.isArray(chunks)) {
    const key='undiscord-context-'+Date.now();
    try {chunks.push([[key],{},runtime=>{discordRequire=runtime;}]);}
    catch {} finally {const index=chunks?.findIndex(item=>item?.[0]?.[0]===key);if(index>=0)chunks.splice(index,1);}
  }
  const found={};
  for(const mod of Object.values(discordRequire?.c||{})) {
    try {
      const candidates=[mod?.exports,...Object.values(mod?.exports||{})];
      for(const value of candidates) {
        if(!value||typeof value!=='object')continue;
        if(typeof value.getUser==='function')found.users=value;
        if(typeof value.getCurrentUser==='function')found.current=value;
        if(typeof value.getGuild==='function')found.guilds=value;
        if(typeof value.getChannel==='function')found.channels=value;
        if(typeof value.getMember==='function')found.members=value;
      }
    } catch {} // One changed export must not break ID/path resolution.
  }
  return found;
}
function safely(read,fallback=null) {try{return read()??fallback;}catch{return fallback;}}
function getAuthorId() {
  const st=stores();
  return safely(()=>st.current?.getCurrentUser()?.id,'')||safely(()=>readExistingStorage('user_id_cache'),'');
}
function getContext(authorId='') {
  const guildId=getGuildId(),channelId=getChannelId(),isDM=guildId==='@me';
  const info={path:location.pathname,guildId,channelId,isDM,guildName:'',channelName:'',authorId:'',authorDisplayName:'',authorUsername:'',users:[]};
  const st=stores(),list=new Map();
  let channel=safely(()=>st.channels?.getChannel(channelId)),guild=safely(()=>st.guilds?.getGuild(guildId));
  info.authorId=safely(()=>st.current?.getCurrentUser()?.id,'')||safely(()=>readExistingStorage('user_id_cache'),'');
  const add=user=>{
    if(!user||!/^\d+$/.test(String(user.id))||typeof user.username!=='string'||!user.username)return;
    const nickname=safely(()=>st.members?.getMember(guildId,user.id)?.nick,'');
    const item={id:String(user.id),displayName:nickname||user.globalName||user.global_name||user.displayName||user.username,username:user.username};
    const old=list.get(item.id);if(old&&old.displayName!==old.username&&item.displayName===item.username)item.displayName=old.displayName;
    list.set(item.id,item);
  };
  add(safely(()=>st.current?.getCurrentUser()));
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
    if(p.currentUser?.id)info.authorId=String(p.currentUser.id);
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

return {fresh:true,version:5};
}
