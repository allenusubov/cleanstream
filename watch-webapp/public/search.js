import {parseQuery} from './events.js';
import {enabledCustomSources} from './custom-sources.js';
import {eventCategory,EVENT_CATEGORIES} from './event-preferences.js';

const labels={
  CHECKING:'CHECKING SOURCES',READY:'SOURCES READY',NO_MATCHING_SOURCES:'NO SOURCES FOUND',
  NO_WORKING_SOURCES:'NO SOURCES FOUND',SOURCES_UNAVAILABLE:'SOURCES UNAVAILABLE'
};
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined&&text!==null)node.textContent=text;return node;};
const countLabel=count=>`${count} SOURCE${count===1?'':'S'} FOUND`;
const playableSource=source=>Boolean(source && (source.mediaUrl || ['youtube','twitch'].includes(source.provider)) && !source.unavailable);

function liveBadge(){
  const badge=element('span','inline-live');badge.append(element('span','live-dot'),element('span','live-label','LIVE'));return badge;
}

export function initSearch(onWatch,onNavigate=()=>{}) {
  const form=document.querySelector('#event-form'), input=document.querySelector('#event-query');
  const results=document.querySelector('#search-results'),home=document.querySelector('.home');
  const filterRow=document.querySelector('#explore-filter-row'),filters=document.querySelector('#explore-filters');
  let generation=0,controllers=[],lastQuery='',latest=new Map(),exploreEvents=[],selectedFilters=new Set(['ALL']);
  const discoveryState=new Map();

  const stop=()=>{
    generation++;
    controllers.forEach(c=>c.abort());controllers=[];
    discoveryState.clear();
  };
  const controller=()=>{const c=new AbortController();controllers.push(c);return c;};
  const sourceRequest=(eventId,signal,mode='deep')=>fetch(`/api/events/${encodeURIComponent(eventId)}/sources`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customSources:enabledCustomSources(),mode}),signal
  });
  const setExploreMode=value=>{home.classList.toggle('is-explore',value);filterRow.hidden=!value;form.hidden=value;};
  const bestPlayable=eventId=>(latest.get(eventId)||[]).find(playableSource)||null;

  function renderSources(event,row,sources){
    const list=row.querySelector('.source-list');if(!list)return;
    list.replaceChildren();
    for(const [i,source] of sources.entries()) {
      const ready=playableSource(source);
      const button=element('button',`source-choice${ready?'':' is-pending'}`);button.type='button';button.disabled=!ready;
      const left=element('span','source-copy');
      left.append(element('span','source-name',source.displayName||source.name||`SOURCE ${String(i+1).padStart(2,'0')}`));
      if(source.quality)left.append(element('span','source-detail',`${source.quality}P`));
      else if(source.mirrorLabel && source.mirrorLabel!=='DEFAULT')left.append(element('span','source-detail',source.mirrorLabel));
      button.append(left);
      if(ready && source.recommended)button.append(element('span','source-rank','RECOMMENDED'));
      else if(!ready)button.append(element('span','source-rank','CHECKING'));
      if(ready)button.addEventListener('click',()=>onWatch(source,latest.get(event.id)||[],event));
      list.append(button);
    }
  }

  function updateAction(event,row,{done=false,status='CHECKING'}={}){
    const state=row.querySelector('.event-state'),action=row.querySelector('.event-action');
    const sources=latest.get(event.id)||[];
    const playable=bestPlayable(event.id);
    if(state){
      if(sources.length)state.textContent=countLabel(sources.length);
      else if(done)state.textContent=labels[status]||'NO SOURCES FOUND';
      else if(discoveryState.get(event.id)?.running)state.textContent='CHECKING SOURCES';
      else state.textContent='';
    }
    if(action){
      if(playable){action.textContent='WATCH';action.disabled=false;action.dataset.mode='watch';}
      else if(discoveryState.get(event.id)?.running){action.textContent='CHECKING';action.disabled=true;action.dataset.mode='checking';}
      else {action.textContent='CHECK SOURCES';action.disabled=false;action.dataset.mode='check';}
    }
  }

  async function sources(event,row,token,{mode='deep'}={}) {
    const existing=discoveryState.get(event.id);
    if(existing?.running)return existing.promise;
    const state={running:true,done:false,promise:null};discoveryState.set(event.id,state);updateAction(event,row);
    const signal=controller().signal;
    state.promise=(async()=>{
      try {
        let response=await sourceRequest(event.id,signal,mode);
        if(response.status===404) {
          await fetch(`/api/events?q=${encodeURIComponent(lastQuery||event.title)}`,{signal});
          response=await sourceRequest(event.id,signal,mode);
        }
        if(!response.ok) throw new Error('SOURCES UNAVAILABLE');
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        const update=data=>{
          if(token!==generation || data.type!=='update') return;
          latest.set(event.id,data.sources||[]);
          if(row.classList.contains('is-expanded'))renderSources(event,row,data.sources||[]);
          state.done=Boolean(data.done);state.running=!data.done;
          updateAction(event,row,{done:data.done,status:data.status});
        };
        while(true){
          const {done,value}=await reader.read();if(done)break;
          buffer+=decoder.decode(value,{stream:true});let end;
          while((end=buffer.indexOf('\n'))>=0){
            const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;
            const data=JSON.parse(line);if(data.type==='update')update(data);
          }
        }
      } catch(error) {
        if(!signal.aborted && token===generation){state.running=false;state.done=true;updateAction(event,row,{done:true,status:error.message||'SOURCES_UNAVAILABLE'});}
      } finally {
        state.running=false;
        if(token===generation)updateAction(event,row,{done:state.done,status:'NO_WORKING_SOURCES'});
      }
    })();
    return state.promise;
  }

  function appendWhen(info,event){
    const date=new Date(event.startTime),line=element('p','event-time');
    const platform=event.provider==='youtube'?'YOUTUBE.COM':event.provider==='twitch'?'TWITCH.TV':'';
    const creator=event.creator && event.creator.toUpperCase()!==event.title.toUpperCase()?`${event.creator.toUpperCase()} · `:'';
    const prefix=`${creator}${platform?platform+' · ':''}`;
    if(prefix)line.append(document.createTextNode(prefix));
    if(event.status==='live')line.append(liveBadge());
    else line.append(document.createTextNode(new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date).toUpperCase()));
    info.append(line);
  }

  function row(event,token,{auto=false,expanded=false}={}) {
    const article=element('article','event-row');article.dataset.category=eventCategory(event)||'OTHER';article.dataset.eventId=event.id;
    const heading=element('div','event-heading'),info=element('div','event-info');
    const title=element('h3','event-title'),titleButton=element('button','event-title-button',event.title);
    titleButton.type='button';titleButton.setAttribute('aria-expanded',String(expanded));title.append(titleButton);info.append(title);appendWhen(info,event);

    const right=element('div','event-actions'),state=element('span','event-state');state.setAttribute('aria-live','polite');
    const action=element('button','text-action event-action','CHECK SOURCES');action.type='button';right.append(state,action);
    const list=element('div','source-list');list.hidden=!expanded;
    heading.append(info,right);article.append(heading,list);
    article.classList.toggle('is-expanded',expanded);

    const expandAndCheck=()=>{
      const open=!article.classList.contains('is-expanded');
      article.classList.toggle('is-expanded',open);titleButton.setAttribute('aria-expanded',String(open));list.hidden=!open;
      if(open){renderSources(event,article,latest.get(event.id)||[]);if(!['youtube','twitch'].includes(event.provider))sources(event,article,token,{mode:'deep'});}
    };
    titleButton.addEventListener('click',expandAndCheck);

    action.addEventListener('click',()=>{
      const playable=bestPlayable(event.id);
      if(playable){onWatch(playable,latest.get(event.id)||[],event);return;}
      if(!['youtube','twitch'].includes(event.provider))sources(event,article,token,{mode:'deep'});
    });

    if(['youtube','twitch'].includes(event.provider)) {
      latest.set(event.id,event.sources||[]);
      if(expanded)renderSources(event,article,event.sources||[]);
      updateAction(event,article,{done:true,status:event.sources?.length?'READY':'NO_WORKING_SOURCES'});
    } else {
      updateAction(event,article);
      if(auto){article.classList.add('is-expanded');titleButton.setAttribute('aria-expanded','true');list.hidden=false;sources(event,article,token,{mode:'deep'});}
    }
    return article;
  }

  function beginCustomResults(title,q='',exploreMode=false) {
    stop();const token=++generation;latest=new Map();lastQuery=q||title;results.hidden=false;results.replaceChildren();home.classList.add('has-results');setExploreMode(exploreMode);
    const heading=element('h2','results-title',exploreMode?'LIVE / UPCOMING':title);results.append(heading);return token;
  }

  function showEvent(event) {
    if(!event)return;
    input.value=event.title||'';
    const token=beginCustomResults(`${String(event.title||'EVENT').toUpperCase()} EVENT:`,event.title||'',false);
    results.append(row(event,token,{auto:true,expanded:true}));
  }

  function orderedExplore(events){return [...events].sort((a,b)=>{const alive=a.status==='live',blive=b.status==='live';if(alive!==blive)return alive?-1:1;return Date.parse(a.startTime)-Date.parse(b.startTime);});}
  function presentExploreCategories(events){const present=new Set(events.map(eventCategory).filter(Boolean));return EVENT_CATEGORIES.filter(key=>present.has(key));}
  function renderExploreFilterButtons(events){
    filters.replaceChildren();const categories=presentExploreCategories(events);const all=['ALL',...categories];
    for(const key of all){
      const button=element('button','explore-filter',key);button.type='button';
      const selected=selectedFilters.has('ALL')?key==='ALL':selectedFilters.has(key);button.classList.toggle('is-selected',selected);button.setAttribute('aria-pressed',String(selected));
      button.addEventListener('click',()=>{
        if(key==='ALL')selectedFilters=new Set(['ALL']);
        else {if(selectedFilters.has('ALL'))selectedFilters=new Set();if(selectedFilters.has(key))selectedFilters.delete(key);else selectedFilters.add(key);if(!selectedFilters.size)selectedFilters=new Set(['ALL']);}
        renderExploreFilterButtons(exploreEvents);renderExploreRows();
      });
      filters.append(button);
    }
  }
  function renderExploreRows(){
    const title=results.querySelector('.results-title');[...results.children].forEach(node=>{if(node!==title)node.remove();});
    const visible=orderedExplore(exploreEvents).filter(event=>selectedFilters.has('ALL')||selectedFilters.has(eventCategory(event)));
    if(!visible.length){results.append(element('p','results-message','NO LIVE OR UPCOMING EVENTS FOUND.'));return;}
    const token=generation;
    for(const item of visible.slice(0,80))results.append(row(item,token,{auto:false,expanded:false}));
  }
  function explore(events=[]) {
    input.value='';exploreEvents=orderedExplore(Array.isArray(events)?events:[]);selectedFilters=new Set(['ALL']);
    beginCustomResults('LIVE / UPCOMING','',true);renderExploreFilterButtons(exploreEvents);renderExploreRows();
  }

  async function search(value=input.value.trim(),navigate=true) {
    const q=String(value).trim();if(!q)return input.focus();input.value=q;if(navigate)onNavigate(q);
    stop();const token=++generation;latest=new Map();lastQuery=q;results.hidden=false;results.replaceChildren();home.classList.add('has-results');setExploreMode(false);
    const parsed=parseQuery(q),title=element('h2','results-title',`${q.toUpperCase()} EVENTS:`);results.append(title);
    if(parsed.kind==='ambiguous'){results.append(element('p','results-message','ENTER A TEAM NAME OR A TWO-TEAM MATCHUP.'));return;}
    const status=element('p','results-message','LOADING EVENTS');status.setAttribute('role','status');results.append(status);let cached;
    try {cached=JSON.parse(sessionStorage.getItem(`events:${q.toLowerCase()}`));}catch{}
    try {
      const signal=controller().signal;const response=cached && Date.now()-cached.time<60000?null:await fetch(`/api/events?q=${encodeURIComponent(q)}`,{signal});
      if(response && !response.ok)throw new Error('SCHEDULE UNAVAILABLE. TRY AGAIN SHORTLY.');
      const data=response?await response.json():cached.data;if(token!==generation)return;
      if(response)try{sessionStorage.setItem(`events:${q.toLowerCase()}`,JSON.stringify({time:Date.now(),data}));}catch{}
      status.remove();
      const notices={SCHEDULE_UNAVAILABLE:'PART OF THE ESPN SCHEDULE IS TEMPORARILY UNAVAILABLE.',YOUTUBE_NOT_CONFIGURED:'YOUTUBE SEARCH IS NOT CONNECTED YET. YOU CAN PASTE A YOUTUBE VIDEO LINK ON THE HOMEPAGE.',YOUTUBE_LIMIT:'YOUTUBE SEARCH LIMIT REACHED. TRY A DIRECT LINK.',YOUTUBE_UNAVAILABLE:'YOUTUBE SEARCH IS TEMPORARILY UNAVAILABLE.',TWITCH_NOT_CONFIGURED:'TWITCH SEARCH IS NOT CONNECTED YET. YOU CAN PASTE A TWITCH CHANNEL LINK ON THE HOMEPAGE.',TWITCH_UNAVAILABLE:'TWITCH SEARCH IS TEMPORARILY UNAVAILABLE.',CATALOG_UNAVAILABLE:'SPORTS LISTINGS ARE TEMPORARILY UNAVAILABLE.'};
      for(const notice of data.notices||[])if(notices[notice])results.append(element('p','results-subtext',notices[notice]));
      if(!data.complete && !data.notices?.length)results.append(element('p','results-message','PART OF THE SCHEDULE IS UNAVAILABLE. THESE ARE THE EVENTS WE COULD CONFIRM.'));
      if(!data.events.length){
        results.append(element('p','results-message',data.complete?'NO UPCOMING EVENT FOUND':'SEARCH INCOMPLETE. TRY AGAIN SHORTLY.'));
        if(data.complete && parsed.kind==='matchup')results.append(element('p','results-subtext',`${parsed.teams.map(t=>t.name.toUpperCase()).join(' AND ')} ARE NOT CURRENTLY SCHEDULED TO PLAY IN THE AVAILABLE SCHEDULE.`));
        for(const alternative of data.alternatives||[])results.append(row(alternative,token,{auto:false}));
        return;
      }
      const single=data.events.length===1;
      let shown=0;const more=element('button','text-action more-events','MORE EVENTS');more.type='button';
      const append=()=>{
        more.remove();
        for(const item of data.events.slice(shown,shown+12))results.append(row(item,token,{auto:single&&!['youtube','twitch'].includes(item.provider),expanded:single}));
        shown+=12;if(shown<data.events.length)results.append(more);
      };
      more.addEventListener('click',append);append();
    }catch(error){if(token===generation && error.name!=='AbortError')status.textContent='SCHEDULE UNAVAILABLE. TRY AGAIN SHORTLY.';}
  }

  form.addEventListener('submit',event=>{event.preventDefault();search();});
  return {
    stop,search,showEvent,explore,
    reset(){stop();results.hidden=true;results.replaceChildren();home.classList.remove('has-results','is-explore');filterRow.hidden=true;form.hidden=false;},
    get query(){return lastQuery;},
    getSources:eventId=>latest.get(eventId)||[],
    async refreshSources(eventId,onUpdate,signal){
      const response=await sourceRequest(eventId,signal,'deep');if(!response.ok)return [];
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',found=[];
      while(true){
        const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
        while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;
          const data=JSON.parse(line);if(data.type==='update'){found=data.sources;latest.set(eventId,found);onUpdate?.(found);}
        }
      }
      return found;
    }
  };
}
