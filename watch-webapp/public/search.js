import {parseQuery} from './events.js';
import {enabledCustomSources} from './custom-sources.js';
const labels={CHECKING:'CHECKING SOURCES',READY:'SOURCES READY',NO_MATCHING_SOURCES:'NO MATCHING SOURCES',
  NO_WORKING_SOURCES:'NO WORKING SOURCES',SOURCES_UNAVAILABLE:'SOURCES UNAVAILABLE',BUSY:'TRY AGAIN SHORTLY',USAGE_LIMIT:'CHECK LIMIT REACHED'};
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
export function initSearch(onWatch,onNavigate=()=>{}) {
  const form=document.querySelector('#event-form'), input=document.querySelector('#event-query');
  const results=document.querySelector('#search-results');
  let generation=0,controllers=[],lastQuery='',latest=new Map();
  const stop=()=>{generation++;controllers.forEach(c=>c.abort());controllers=[];};
  const controller=()=>{const c=new AbortController();controllers.push(c);return c;};
  const sourceRequest=(eventId,signal)=>fetch(`/api/events/${encodeURIComponent(eventId)}/sources`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({customSources:enabledCustomSources()}),
    signal
  });

  async function sources(event,row,token) {
    const state=row.querySelector('.event-state'), list=row.querySelector('.source-list'), watch=row.querySelector('.event-watch');
    state.textContent='CHECKING SOURCES';watch.disabled=true;
    const signal=controller().signal;
    try {
      let response=await sourceRequest(event.id,signal);
      if(response.status===404) {
        await fetch(`/api/events?q=${encodeURIComponent(lastQuery)}`,{signal});
        response=await sourceRequest(event.id,signal);
      }
      if(!response.ok) {const data=await response.json();throw new Error(labels[data.code]||'SOURCES UNAVAILABLE');}
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      const update=data=>{
        if(token!==generation || data.type!=='update') return;
        latest.set(event.id,data.sources);
        state.textContent=data.sources.length?`${data.sources.length} SOURCE${data.sources.length===1?'':'S'}`:labels[data.status]||'SOURCES UNAVAILABLE';
        watch.disabled=!data.sources.length;
        list.replaceChildren();
        for(const [i,source] of data.sources.entries()) {
          const button=element('button','source-choice');button.type='button';
          const left=element('span','source-copy');
          left.append(element('span','source-name',source.displayName||source.name||`SOURCE ${String(i+1).padStart(2,'0')}`));
          if(source.quality)left.append(element('span','source-detail',`${source.quality}P`));
          button.append(left);
          if(source.recommended)button.append(element('span','source-rank','RECOMMENDED'));
          button.addEventListener('click',()=>onWatch(source,latest.get(event.id)||[],event));list.append(button);
        }
      };
      while(true) {
        const {done,value}=await reader.read();if(done)break;
        buffer+=decoder.decode(value,{stream:true});let end;
        while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line)update(JSON.parse(line));}
      }
    } catch(error) {if(!signal.aborted && token===generation)state.textContent=error.message||'SOURCES UNAVAILABLE';}
  }
  function row(event,token,auto=false) {
    const article=element('article','event-row');
    const heading=element('div','event-heading');
    const info=element('div','event-info');
    info.append(element('h3','event-title',event.title));
    const date=new Date(event.startTime);
    const when=event.status==='live'?'LIVE':new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date).toUpperCase();
    const platform=event.provider==='youtube'?'YOUTUBE.COM':event.provider==='twitch'?'TWITCH.TV':'';
    const creator=event.creator && event.creator.toUpperCase()!==event.title.toUpperCase()?`${event.creator.toUpperCase()} · `:'';
    info.append(element('p','event-time',`${creator}${platform?platform+' · ':''}${when}`));
    const right=element('div','event-actions');
    const state=element('span','event-state');state.setAttribute('aria-live','polite');
    const watch=element('button','text-action event-watch','WATCH');watch.type='button';watch.disabled=true;
    watch.addEventListener('click',()=>{const available=latest.get(event.id)||[];if(available[0])onWatch(available[0],available,event);});
    right.append(state,watch);heading.append(info,right);article.append(heading,element('div','source-list'));
    const eligible=event.status!=='finished' && date.getTime()<=Date.now()+45*60000 && date.getTime()>Date.now()-6*3600000;
    if(['youtube','twitch'].includes(event.provider)) {
      latest.set(event.id,event.sources||[]);watch.disabled=!event.sources?.length;
      state.textContent=event.sources?.length?(event.provider==='twitch'?'TWITCH.TV':'YOUTUBE.COM'):'UPCOMING';
    }
    else if(eligible && auto) sources(event,article,token);
    else if(eligible) {
      const check=element('button','text-action check-sources','CHECK SOURCES');check.type='button';
      check.addEventListener('click',()=>{check.remove();sources(event,article,token);});state.append(check);
    } else state.textContent='SOURCES CHECKED NEAR START';
    return article;
  }
  function beginCustomResults(title,q='') {
    stop();const token=++generation;latest=new Map();lastQuery=q||title;results.hidden=false;results.replaceChildren();
    document.querySelector('.home').classList.add('has-results');
    results.append(element('h2','results-title',title));
    return token;
  }
  function showEvent(event) {
    if(!event)return;
    input.value=event.title||'';
    const token=beginCustomResults(`${String(event.title||'EVENT').toUpperCase()} EVENT:`,event.title||'');
    results.append(row(event,token,true));
  }
  function explore(events=[]) {
    input.value='';
    const token=beginCustomResults('LIVE / NEXT 24 HOURS:','');
    if(!events.length){results.append(element('p','results-message','NO LIVE OR UPCOMING EVENTS FOUND.'));return;}
    for(const item of events.slice(0,60)){
      const eligible=item.status==='live'||Date.parse(item.startTime)<=Date.now()+45*60000;
      results.append(row(item,token,eligible&&!['youtube','twitch'].includes(item.provider)));
    }
  }

  async function search(value=input.value.trim(),navigate=true) {
    const q=String(value).trim();if(!q)return input.focus();input.value=q;
    if(navigate)onNavigate(q);
    stop();const token=++generation;latest=new Map();lastQuery=q;results.hidden=false;results.replaceChildren();
    document.querySelector('.home').classList.add('has-results');
    const parsed=parseQuery(q);
    const title=element('h2','results-title',`${q.toUpperCase()} EVENTS:`);results.append(title);
    if(parsed.kind==='ambiguous') {
      results.append(element('p','results-message','ENTER A TEAM NAME OR A TWO-TEAM MATCHUP.'));return;
    }
    const status=element('p','results-message','LOADING EVENTS');status.setAttribute('role','status');results.append(status);
    let cached;
    try {cached=JSON.parse(sessionStorage.getItem(`events:${q.toLowerCase()}`));}catch{}
    try {
      const signal=controller().signal;
      const response=cached && Date.now()-cached.time<60000?null:await fetch(`/api/events?q=${encodeURIComponent(q)}`,{signal});
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
        for(const alternative of data.alternatives||[])results.append(row(alternative,token));
        return;
      }
      let shown=0;
      const more=element('button','text-action more-events','MORE EVENTS');more.type='button';
      const append=()=>{
        more.remove();
        for(const item of data.events.slice(shown,shown+12)){
          const eligible=Date.parse(item.startTime)<=Date.now()+45*60000;
          results.append(row(item,token,eligible && !['youtube','twitch'].includes(item.provider)));
        }
        shown+=12;if(shown<data.events.length)results.append(more);
      };
      more.addEventListener('click',append);append();
    }catch(error){if(token===generation && error.name!=='AbortError')status.textContent='SCHEDULE UNAVAILABLE. TRY AGAIN SHORTLY.';}
  }
  form.addEventListener('submit',event=>{event.preventDefault();search();});
  return {stop,search,showEvent,explore,reset(){stop();results.hidden=true;results.replaceChildren();document.querySelector('.home').classList.remove('has-results');},get query(){return lastQuery;},getSources:eventId=>latest.get(eventId)||[],async refreshSources(eventId,onUpdate,signal){
    const response=await sourceRequest(eventId,signal);if(!response.ok)return [];
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',found=[];
    while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const data=JSON.parse(line);if(data.type==='update'){found=data.sources;latest.set(eventId,found);onUpdate?.(found);}}
    }return found;
  }};
}
