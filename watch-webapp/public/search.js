import {compactSources,eligibleEvent,discoveryMessage} from './source-request.js';
import {parseQuery} from './events.js';
import {enabledCustomSources,recordCustomSourceSuccess} from './custom-sources.js';
import {eventCategory,EVENT_CATEGORIES} from './event-preferences.js';

const labels={
  CHECKING:'CHECKING SOURCES',READY:'SOURCES READY',NO_MATCHING_SOURCES:'NO SOURCES FOUND',
  NO_WORKING_SOURCES:'NO SOURCES FOUND',SOURCES_UNAVAILABLE:'SOURCES UNAVAILABLE'
};
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined&&text!==null)node.textContent=text;return node;};
const countLabel=count=>`${count} SOURCE${count===1?'':'S'} FOUND`;
const playableSource=source=>Boolean(source && (source.mediaUrl || ['youtube','twitch'].includes(source.provider)) && !source.unavailable && (!source.expiresAt||source.expiresAt>Date.now()+3000));
const SOURCE_CACHE_PREFIX='cleanstream.eventSources.v2.';
function readSourceCache(eventId){try{const value=JSON.parse(sessionStorage.getItem(`${SOURCE_CACHE_PREFIX}${eventId}`)||'null');if(value&&Date.now()-value.time<10*60*1000){value.sources=(value.sources||[]).filter(playableSource);return value;}}catch{}return null;}
function writeSourceCache(eventId,sources,meta={}){try{sessionStorage.setItem(`${SOURCE_CACHE_PREFIX}${eventId}`,JSON.stringify({time:Date.now(),sources:sources.filter(playableSource),...meta}));}catch{}}
function isTvm(item){return item?.contentType==='tvm'&&['tv','movie'].includes(item.kind);}
function contentCategory(item){return isTvm(item)?(item.kind==='movie'?'MOVIES':'TV'):(eventCategory(item)||'OTHER');}
function dateLabel(value){if(!value)return '';const date=new Date(`${value}T12:00:00`);if(Number.isNaN(date.getTime()))return '';return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric'}).format(date).toUpperCase();}
function liveBadge(){const badge=element('span','inline-live');badge.append(element('span','live-separator','·'),document.createTextNode(' '),element('span','live-label','LIVE'));return badge;}
function sectionLabel(text){return element('h3','results-section-title',text);}

export function initSearch(onWatch,onNavigate=()=>{},onContentNavigate=()=>{}) {
  const form=document.querySelector('#event-form'), input=document.querySelector('#event-query');
  const results=document.querySelector('#search-results'),home=document.querySelector('.home');
  const filterRow=document.querySelector('#explore-filter-row'),filters=document.querySelector('#explore-filters');
  let generation=0,controllers=[],lastQuery='',latest=new Map(),exploreEvents=[],selectedFilters=new Set(['ALL']);
  const discoveryState=new Map(),recordedSuccesses=new Set();
  let activeChecks=0;const waitingChecks=[];
  function scheduled(task,signal,priority=false){return new Promise((resolve,reject)=>{
    const cancel=()=>{const i=waitingChecks.indexOf(entry);if(i>=0)waitingChecks.splice(i,1);reject(new DOMException('Cancelled','AbortError'));};
    const entry=()=>{signal.removeEventListener('abort',cancel);activeChecks++;Promise.resolve().then(()=>{if(signal.aborted)throw new DOMException('Cancelled','AbortError');return task();}).then(resolve,reject).finally(()=>{activeChecks--;waitingChecks.shift()?.();});};
    if(signal.aborted)return cancel();
    if(activeChecks<2)entry();else {priority?waitingChecks.unshift(entry):waitingChecks.push(entry);signal.addEventListener('abort',cancel,{once:true});}
  });}

  const stop=()=>{generation++;controllers.forEach(c=>c.abort());controllers=[];discoveryState.clear();};
  const controller=()=>{const c=new AbortController();controllers.push(c);return c;};
  const sourceRequest=(item,signal,mode='deep',resume=false)=>isTvm(item)?fetch('/api/tvm/sources',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({item,customSources:compactSources(enabledCustomSources(),item),mode,resume}),signal
  }):fetch(`/api/events/${encodeURIComponent(item.id)}/sources`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customSources:compactSources(enabledCustomSources(),item),mode,resume}),signal
  });
  const setExploreMode=value=>{home.classList.toggle('is-explore',value);filterRow.hidden=!value;form.hidden=value;};
  const bestPlayable=id=>(latest.get(id)||[]).find(playableSource)||null;

  function renderSources(item,row,sources){
    const list=row.querySelector('.source-list');if(!list)return;list.replaceChildren();
    const readySources=(sources||[]).filter(playableSource);
    for(const [i,source] of readySources.entries()) {
      const button=element('button','source-choice');button.type='button';
      const left=element('span','source-copy');left.append(element('span','source-name',source.displayName||source.name||`SOURCE ${String(i+1).padStart(2,'0')}`));
      if(source.quality)left.append(element('span','source-detail',`${source.quality}P`));
      else if(source.mirrorLabel && source.mirrorLabel!=='DEFAULT')left.append(element('span','source-detail',source.mirrorLabel));
      button.append(left);button.append(element('span','source-rank',source.provisional?'TRY SOURCE':'AVAILABLE'));
      if(source.mirrorLabel&&source.mirrorLabel!=='DEFAULT'&&source.quality)left.append(element('span','source-detail',source.mirrorLabel));
      button.addEventListener('click',()=>onWatch(source,latest.get(item.id)||[],item));list.append(button);
    }
    const state=discoveryState.get(item.id);
    if(state?.partial&&!state.running){const more=element('button','text-action source-more','CHECK MORE');more.type='button';more.addEventListener('click',()=>sources(item,row,generation,{mode:'deep',resume:true}));list.append(more);}
  }
  function updateAction(item,row,{done=false,status='CHECKING'}={}){
    const state=row.querySelector('.event-state'),action=row.querySelector('.event-action');
    const sources=(latest.get(item.id)||[]).filter(playableSource),playable=bestPlayable(item.id);
    if(state){if(sources.length)state.textContent=countLabel(sources.length);else if(done)state.textContent=discoveryMessage({status,partial:discoveryState.get(item.id)?.partial});else state.textContent='';}
    if(action){if(playable){action.textContent='WATCH';action.disabled=false;action.dataset.mode='watch';}
      else if(discoveryState.get(item.id)?.running){action.textContent='CHECKING SOURCES';action.disabled=true;action.dataset.mode='checking';}
      else {action.textContent=discoveryState.get(item.id)?.partial?'CHECK MORE':'CHECK SOURCES';action.disabled=false;action.dataset.mode='check';}}
  }
  function recordSuccess(item,source){
    if(source.provisional)return;
    const key=`${item.id}|${source.sourceRoot||source.siteId||source.id}`;
    if(source.sourceRoot&&!recordedSuccesses.has(key)){recordedSuccesses.add(key);recordCustomSourceSuccess(source.sourceRoot,source.startupMs||0,{eventUrl:source.sourceUrl,mediaUrl:source.mediaUrl,mirrorLabel:source.mirrorLabel,structure:source.learnedStructure||{}});}
  }
  async function consumeStream(response,item,onUpdate=()=>{}){
    if(!response.ok){let error;try{error=await response.json();}catch{}throw new Error(error?.code==='SOURCE_LIST_TOO_LARGE'?'SOURCE_LIST_TOO_LARGE':'SOURCES_UNAVAILABLE');}
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',found=[],finalStatus='CHECKING',doneState=false;
    while(true){
      const read=await reader.read();if(read.done)break;buffer+=decoder.decode(read.value,{stream:true});let end;
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;let data;try{data=JSON.parse(line);}catch{continue;}if(data.type!=='update')continue;
        found=(data.sources||[]).filter(playableSource);finalStatus=data.status||finalStatus;doneState=Boolean(data.done);
        for(const source of found)recordSuccess(item,source);latest.set(item.id,found);writeSourceCache(item.id,found,{done:doneState,status:finalStatus,partial:Boolean(data.partial)});
        window.dispatchEvent(new CustomEvent('cleanstream:sources-updated',{detail:{eventId:item.id,sources:found}}));onUpdate(found,data);
      }
    }
    return {sources:found,status:finalStatus,done:doneState};
  }
  async function sources(item,row,token,{mode='deep',resume=false}={}) {
    const existing=discoveryState.get(item.id);if(existing?.running){if(mode==='deep'&&existing.mode==='light')return existing.promise.then(()=>token===generation?sources(item,row,token,{mode:'deep'}):null);return existing.promise;}
    resume=resume||Boolean(existing?.partial);
    const state={mode,running:true,done:false,status:'CHECKING',partial:false,promise:null};discoveryState.set(item.id,state);updateAction(item,row);
    const signal=controller().signal;
    state.promise=scheduled(async()=>{
      try {
        let response=await sourceRequest(item,signal,mode,resume);
        if(!isTvm(item)&&response.status===404){await fetch(`/api/events?q=${encodeURIComponent(lastQuery||item.title)}`,{signal});response=await sourceRequest(item,signal,mode,resume);}
        const result=await consumeStream(response,item,(visible,data)=>{
          if(token!==generation)return;state.partial=Boolean(data.partial);state.running=!data.done;if(row.classList.contains('is-expanded'))renderSources(item,row,visible);
          state.done=Boolean(data.done);state.running=!data.done;state.status=data.status||state.status;updateAction(item,row,{done:data.done,status:state.status});
        });
        state.done=result.done;state.status=result.status||state.status;
      } catch(error) {if(!signal.aborted&&token===generation){state.running=false;state.done=true;state.status=error.message||'SOURCES_UNAVAILABLE';updateAction(item,row,{done:true,status:state.status});}}
      finally {state.running=false;if(token===generation)updateAction(item,row,{done:state.done,status:state.status});}
    },signal,mode==='deep').catch(()=>{});return state.promise;
  }

  function appendWhen(info,item){
    const line=element('p','event-time');
    if(isTvm(item)){
      if(item.kind==='tv')line.textContent=dateLabel(item.airDate)||'AIR DATE UNAVAILABLE';
      else line.textContent=item.year?`MOVIE · ${item.year}`:'MOVIE';
      info.append(line);return;
    }
    const date=new Date(item.startTime),platform=item.provider==='youtube'?'YOUTUBE.COM':item.provider==='twitch'?'TWITCH.TV':'';
    const creator=item.creator&&item.creator.toUpperCase()!==item.title.toUpperCase()?`${item.creator.toUpperCase()} · `:'';const prefix=`${creator}${platform?platform+' · ':''}`;
    if(prefix)line.append(document.createTextNode(prefix));if(item.status==='live')line.append(liveBadge());else line.append(document.createTextNode(new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date).toUpperCase()));info.append(line);
  }

  function row(item,token,{auto=false,expanded=false}={}) {
    if(!latest.has(item.id)){const cached=readSourceCache(item.id);if(cached?.sources?.length)latest.set(item.id,cached.sources);}
    const article=element('article','event-row');article.dataset.category=contentCategory(item);article.dataset.eventId=item.id;
    const heading=element('div','event-heading'),info=element('div','event-info');
    const title=element('h3','event-title'),titleButton=element('button','event-title-button',item.title);titleButton.type='button';titleButton.setAttribute('aria-expanded',String(expanded));title.append(titleButton);info.append(title);appendWhen(info,item);
    const right=element('div','event-actions'),state=element('span','event-state');state.setAttribute('aria-live','polite');
    const action=element('button','text-action event-action','CHECK SOURCES');action.type='button';right.append(state,action);
    const list=element('div','source-list');list.hidden=!expanded;heading.append(info,right);article.append(heading,list);article.classList.toggle('is-expanded',expanded);
    const expandAndCheck=()=>{const open=!article.classList.contains('is-expanded');article.classList.toggle('is-expanded',open);titleButton.setAttribute('aria-expanded',String(open));list.hidden=!open;if(open){renderSources(item,article,latest.get(item.id)||[]);if(!['youtube','twitch'].includes(item.provider)&&discoveryState.get(item.id)?.mode!=='deep')sources(item,article,token,{mode:'deep'});}};
    titleButton.addEventListener('click',expandAndCheck);
    action.addEventListener('click',()=>{const playable=bestPlayable(item.id);if(playable){onWatch(playable,latest.get(item.id)||[],item);return;}if(!['youtube','twitch'].includes(item.provider))sources(item,article,token,{mode:'deep'});});
    if(['youtube','twitch'].includes(item.provider)){latest.set(item.id,item.sources||[]);if(expanded)renderSources(item,article,item.sources||[]);updateAction(item,article,{done:true,status:item.sources?.length?'READY':'NO_WORKING_SOURCES'});}
    else {updateAction(item,article);if(expanded)renderSources(item,article,latest.get(item.id)||[]);if(auto&&!bestPlayable(item.id))sources(item,article,token,{mode:'light'});}
    return article;
  }

  function beginCustomResults(title,q='',exploreMode=false) {
    stop();const token=++generation;latest=new Map();lastQuery=q||title;results.hidden=false;results.replaceChildren();home.classList.add('has-results');setExploreMode(exploreMode);
    const heading=element('h2',`results-title${exploreMode?' is-explore-title':''}`);if(exploreMode)heading.append(element('span','results-title-part','LIVE'),element('span','results-title-part','/'),element('span','results-title-part','UPCOMING'));else heading.textContent=title;results.append(heading);return token;
  }
  function showEvent(event) {if(!event)return;input.value='';const token=beginCustomResults(`${String(event.title||'EVENT').toUpperCase()} EVENT:`,event.title||'',false);results.append(row(event,token,{auto:false,expanded:true}));}

  function catalogTvRow(show){
    const article=element('article','event-row catalog-row'),heading=element('div','event-heading'),info=element('div','event-info');
    const year=show.year?` (${show.year})`:'';const title=element('h3','event-title'),button=element('button','event-title-button',`${show.title}${year}`);button.type='button';title.append(button);info.append(title,element('p','event-time',show.seasonCount?`${show.seasonCount} SEASON${show.seasonCount===1?'':'S'}`:'SEASONS'));
    heading.append(info);article.append(heading);button.addEventListener('click',()=>{onContentNavigate({view:'tvm',kind:'tv',id:show.tmdbId,q:lastQuery});showTv(show);});return article;
  }
  function seasonRow(show,season,token){
    const article=element('article','event-row season-row'),heading=element('div','event-heading'),info=element('div','event-info');
    const title=element('h3','event-title'),button=element('button','event-title-button',`SEASON ${season.seasonNumber}${season.year?` · ${season.year}`:''}`);button.type='button';button.setAttribute('aria-expanded','false');title.append(button);info.append(title);
    const right=element('div','event-actions'),toggle=element('button','text-action event-action','+');toggle.type='button';right.append(toggle);const body=element('div','season-episodes');body.hidden=true;heading.append(info,right);article.append(heading,body);
    let loaded=false;
    const open=async()=>{const next=body.hidden;body.hidden=!next;article.classList.toggle('is-expanded',next);button.setAttribute('aria-expanded',String(next));toggle.textContent=next?'−':'+';if(!next||loaded)return;loaded=true;body.append(element('p','results-message','LOADING EPISODES'));
      try{const response=await fetch(`/api/tvm/tv/${encodeURIComponent(show.tmdbId)}/season/${encodeURIComponent(season.seasonNumber)}`);if(!response.ok)throw new Error();const data=await response.json();body.replaceChildren();for(const episode of data.season?.episodes||[])body.append(row(episode,token,{auto:false,expanded:false}));if(!body.children.length)body.append(element('p','results-message','NO EPISODES FOUND'));}catch{body.replaceChildren(element('p','results-message','EPISODES UNAVAILABLE'));}};
    button.addEventListener('click',open);toggle.addEventListener('click',open);return article;
  }
  async function showTv(showOrId){
    const id=typeof showOrId==='object'?showOrId.tmdbId:showOrId;input.value='';const token=beginCustomResults('LOADING SHOW','',false);const title=results.querySelector('.results-title');
    try{const response=await fetch(`/api/tvm/tv/${encodeURIComponent(id)}`);if(!response.ok)throw new Error();const show=await response.json();if(token!==generation)return;lastQuery=String(show.title||'TV SHOW');title.textContent=String(show.title||'TV SHOW').toUpperCase();for(const season of show.seasons||[])results.append(seasonRow(show,season,token));if(!(show.seasons||[]).length)results.append(element('p','results-message','NO SEASONS FOUND'));}
    catch{title.textContent='TV SHOW';results.append(element('p','results-message','SHOW DATA UNAVAILABLE'));}
  }

  function orderedExplore(events){return [...events].sort((a,b)=>{const alive=a.status==='live',blive=b.status==='live';if(alive!==blive)return alive?-1:1;return Date.parse(a.startTime)-Date.parse(b.startTime);});}
  function presentExploreCategories(events){const present=new Set(events.map(eventCategory).filter(Boolean));return EVENT_CATEGORIES.filter(key=>present.has(key));}
  function renderExploreFilterButtons(events){filters.replaceChildren();const categories=presentExploreCategories(events),all=['ALL',...categories];for(const key of all){const button=element('button','explore-filter',key);button.type='button';const selected=selectedFilters.has('ALL')?key==='ALL':selectedFilters.has(key);button.classList.toggle('is-selected',selected);button.setAttribute('aria-pressed',String(selected));button.addEventListener('click',()=>{if(key==='ALL')selectedFilters=new Set(['ALL']);else {if(selectedFilters.has('ALL'))selectedFilters=new Set();if(selectedFilters.has(key))selectedFilters.delete(key);else selectedFilters.add(key);if(!selectedFilters.size)selectedFilters=new Set(['ALL']);}renderExploreFilterButtons(exploreEvents);renderExploreRows();});filters.append(button);}}
  function renderExploreRows(){const title=results.querySelector('.results-title');[...results.children].forEach(node=>{if(node!==title)node.remove();});const visible=orderedExplore(exploreEvents).filter(event=>selectedFilters.has('ALL')||selectedFilters.has(eventCategory(event)));if(!visible.length){results.append(element('p','results-message','NO LIVE OR UPCOMING EVENTS FOUND.'));return;}const token=generation;for(const item of visible)results.append(row(item,token,{auto:eligibleEvent(item),expanded:false}));}
  function explore(events=[]){input.value='';exploreEvents=orderedExplore(Array.isArray(events)?events:[]);selectedFilters=new Set(['ALL']);beginCustomResults('LIVE / UPCOMING','',true);renderExploreFilterButtons(exploreEvents);renderExploreRows();}

  async function search(value=input.value.trim(),navigate=true) {
    const q=String(value).trim();if(!q)return input.focus();input.value=q;if(navigate)onNavigate(q);
    stop();const token=++generation;latest=new Map();lastQuery=q;results.hidden=false;results.replaceChildren();home.classList.add('has-results');setExploreMode(false);
    const title=element('h2','results-title',`${q.toUpperCase()} RESULTS:`);results.append(title);const status=element('p','results-message','SEARCHING');status.setAttribute('role','status');results.append(status);
    let cached;try{cached=JSON.parse(sessionStorage.getItem(`universal:${q.toLowerCase()}`));}catch{}
    try{
      const signal=controller().signal;const response=cached&&Date.now()-cached.time<60000?null:await fetch(`/api/search?q=${encodeURIComponent(q)}`,{signal});if(response&&!response.ok)throw new Error();const data=response?await response.json():cached.data;if(token!==generation)return;if(response)try{sessionStorage.setItem(`universal:${q.toLowerCase()}`,JSON.stringify({time:Date.now(),data}));}catch{}
      status.remove();const live=data.live||{events:[],alternatives:[],complete:false,notices:[]},tv=data.tv||[],movies=data.movies||[];const liveEvents=live.events||[];const totalTypes=Number(liveEvents.length>0)+Number(tv.length>0)+Number(movies.length>0);
      if(totalTypes===1){if(liveEvents.length)title.textContent=`${q.toUpperCase()} EVENTS:`;else if(tv.length)title.textContent=`${q.toUpperCase()} TV:`;else title.textContent=`${q.toUpperCase()} MOVIES:`;}
      const notices={SCHEDULE_UNAVAILABLE:'PART OF THE LIVE SCHEDULE IS TEMPORARILY UNAVAILABLE.',TMDB_NOT_CONFIGURED:'TV / MOVIE SEARCH NEEDS THE TMDB TOKEN TO BE ADDED TO THE SERVER.',TMDB_UNAVAILABLE:'TV / MOVIE CATALOG IS TEMPORARILY UNAVAILABLE.'};
      for(const notice of [...new Set([...(data.notices||[]),...(live.notices||[])])])if(notices[notice])results.append(element('p','results-subtext',notices[notice]));
      if(liveEvents.length){if(totalTypes>1)results.append(sectionLabel('LIVE'));const single=totalTypes===1&&liveEvents.length===1;for(const item of liveEvents)results.append(row(item,token,{auto:eligibleEvent(item),expanded:single}));}
      if(tv.length){if(totalTypes>1)results.append(sectionLabel('TV'));for(const show of tv)results.append(catalogTvRow(show));}
      if(movies.length){if(totalTypes>1)results.append(sectionLabel('MOVIES'));for(const movie of movies)results.append(row(movie,token,{auto:false,expanded:false}));}
      if(!liveEvents.length&&!tv.length&&!movies.length){results.append(element('p','results-message','NO RESULTS FOUND'));const parsed=parseQuery(q);if(live.complete&&parsed.kind==='matchup')results.append(element('p','results-subtext',`${parsed.teams.map(t=>t.name.toUpperCase()).join(' AND ')} ARE NOT CURRENTLY SCHEDULED TO PLAY IN THE AVAILABLE SCHEDULE.`));}
    }catch(error){if(token===generation&&error.name!=='AbortError')status.textContent='SEARCH UNAVAILABLE. TRY AGAIN SHORTLY.';}
  }


  async function firstResolvedSource(item,signal,onUpdate){
    const response=await sourceRequest(item,signal,'deep');if(!response.ok){let error;try{error=await response.json();}catch{}throw new Error(error?.code==='SOURCE_LIST_TOO_LARGE'?'SOURCE_LIST_TOO_LARGE':'SOURCES_UNAVAILABLE');}
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',last=[];
    try{
      while(true){
        const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
        while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;let data;try{data=JSON.parse(line);}catch{continue;}if(data.type!=='update')continue;
          last=(data.sources||[]).filter(playableSource);for(const source of last)recordSuccess(item,source);latest.set(item.id,last);writeSourceCache(item.id,last,{done:Boolean(data.done),status:data.status||'CHECKING'});
          window.dispatchEvent(new CustomEvent('cleanstream:sources-updated',{detail:{eventId:item.id,sources:last}}));onUpdate?.(last,data);
          if(last.length){await reader.cancel().catch(()=>{});return last;}
          if(data.done)return [];
        }
      }
    }finally{}
    return last;
  }
  form.addEventListener('submit',event=>{event.preventDefault();search();});
  return {
    stop,search,showEvent,showTv,explore,
    reset(){stop();results.hidden=true;results.replaceChildren();home.classList.remove('has-results','is-explore');filterRow.hidden=true;form.hidden=false;},
    get query(){return lastQuery;},getSources:id=>latest.get(id)||[],
    async refreshSources(itemOrId,onUpdate,signal){const item=typeof itemOrId==='object'?itemOrId:{id:itemOrId};const response=await sourceRequest(item,signal,'deep');const result=await consumeStream(response,item,(found)=>onUpdate?.(found));return result.sources;},
    async resolveSources(item,signal,onUpdate){const response=await sourceRequest(item,signal,'deep');const result=await consumeStream(response,item,(found)=>onUpdate?.(found));return result.sources;},
    resolveFirstSource:firstResolvedSource
  };
}
