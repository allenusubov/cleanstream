import {historyFor,historyPriority} from './playback-history.js';
export function sourceAvailable(source,now=Date.now()){
  return Boolean(source&&(source.mediaUrl||source.embedUrl||source.externalUrl||source.hasStreamOptions&&source.sourceUrl)&&!source.unavailable&&(!source.expiresAt||source.expiresAt>now+3000));
}
export function orderedSources(items,event,context,history,now=Date.now()){
  const score=source=>{
    if(source.externalUrl)return -50;if(source.embedUrl)return 5;if(!source.mediaUrl)return 0;
    const record=historyFor(source,event,context,history);
    if(record?.lastFailureAt>record?.lastSuccessAt&&now-record.lastFailureAt<6*3600000)return -100+historyPriority(record,now);
    return record?.lastSuccessAt?100+historyPriority(record,now):10;
  };
  return items.filter(source=>sourceAvailable(source,now)).map((source,index)=>({source,index,score:score(source)})).sort((a,b)=>b.score-a.score||a.index-b.index).map(value=>value.source);
}
export function sourceCountLabel(items){
  if(items.every(source=>source.externalUrl))return `${items.length} PROVIDER LINK${items.length===1?'':'S'}`;
  if(items.some(source=>source.externalUrl))return `${items.length} SOURCE OPTION${items.length===1?'':'S'}`;
  if(items.some(source=>source.embedUrl))return `${items.length} PLAYER OPTION${items.length===1?'':'S'}`;
  const videos=items.filter(source=>source.mediaUrl).length,pages=items.length-videos;
  const pieces=[];
  if(videos)pieces.push(`${videos} VIDEO LINK${videos===1?'':'S'}`);
  if(pages)pieces.push(`${pages} STREAM PAGE${pages===1?'':'S'}`);
  return pieces.join(' · ');
}
// Exhaust the event's alternatives before revisiting a failed provider page.
// This queue runs only inside the user's WATCH/source click.
export async function playSourceChoices({items,selected,event,context,history=[],tryMedia,tryPage,onFailure=()=>{},signal}){
  const ordered=orderedSources(items,event,context,history),choices=[selected,...ordered.filter(value=>value!==selected)].filter(Boolean);
  const media=new Set(),pages=new Set(),deferred=[];let lastError;
  const check=()=>{if(signal.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');};
  for(const item of choices){
    check();
    if(item.mediaUrl||item.embedUrl){
      const identity=item.mediaUrl||item.embedUrl;if(media.has(identity))continue;media.add(identity);
      try{await tryMedia(item);return item;}catch(error){check();lastError=error;onFailure(item,error);if(item.sourceUrl)deferred.push(item);}
    }else if(item.hasStreamOptions&&item.sourceUrl){
      if(pages.has(item.sourceUrl))continue;pages.add(item.sourceUrl);
      try{await tryPage(item);return item;}catch(error){check();lastError=error;onFailure(item,error);}
    }
  }
  for(const item of deferred){
    check();if(pages.has(item.sourceUrl))continue;pages.add(item.sourceUrl);
    try{await tryPage(item);return item;}catch(error){check();lastError=error;}
  }
  if(choices.some(item=>item.externalUrl)){const error=new Error('ORIGINAL_SITE_REQUIRED');error.cause=lastError;throw error;}
  throw lastError||new Error('NO_MEDIA');
}
