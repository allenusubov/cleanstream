// Send discovery data only. Keep test history and unrelated category profiles on
// the device rather than resending them for every event.
export function compactSources(items,item={}){
  const category=item.contentType==='tvm'?(item.kind==='movie'?'MOVIES':'TV'):String(item.league||item.sport||'').toUpperCase();
  return items.filter(value=>value?.enabled!==false).map(value=>{
    if(typeof value==='string')return value;
    const categories={};
    for(const key of [category,String(item.sport||'').toUpperCase(),'*']){
      if(value.categories?.[key])categories[key]=value.categories[key];
    }
    const structure={};
    for(const key of ['eventPrefixes','eventHosts','searchTemplates','browserSearch','episodeTemplates','titleTemplates']){
      if(value.structure?.[key])structure[key]=value.structure[key];
    }
    return {url:value.url,categories,eventLists:value.eventLists||[],structure};
  });
}
export function eligibleEvent(item,now=Date.now()){
  return !['youtube','twitch'].includes(item.provider)&&
    (item.status==='live'||item.status==='scheduled'&&Date.parse(item.startTime)<=now+45*60*1000);
}
export function discoveryMessage(data){
  if(data.partial)return data.sources?.length?'MORE SOURCES CAN BE CHECKED':'CHECK INCOMPLETE — TRY CHECK MORE';
  return {SOURCE_LIST_TOO_LARGE:'SOURCE LIST TOO LARGE — EXPORT AND REDUCE IT',SOURCES_UNAVAILABLE:'SOURCES UNAVAILABLE'}[data.status]||'NO SOURCES FOUND';
}
