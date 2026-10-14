// Send discovery data only. Keep test history and unrelated category profiles on
// the device rather than resending them for every event.
export function compactSources(items,item={}){
  const category=String(item.league||item.sport||'').toUpperCase();
  return items.filter(value=>value?.enabled!==false).map(value=>{
    if(typeof value==='string')return value;
    const categories={};
    for(const key of [category,String(item.sport||'').toUpperCase(),'*']){
      if(value.categories?.[key])categories[key]=value.categories[key];
    }
    const structure={};
    for(const key of ['eventPrefixes','eventHosts','searchTemplates','browserSearch']){
      if(value.structure?.[key])structure[key]=value.structure[key];
    }
    return {url:value.url,categories,eventLists:value.eventLists||[],structure};
  });
}
export function discoveryMessage(data){
  if(data.hasMore)return 'NO SOURCES IN THIS BATCH — CHECK MORE';
  if(data.partial)return data.sources?.length?'MORE SOURCES CAN BE CHECKED':'CHECK INCOMPLETE — TRY RECHECK';
  return {SOURCE_LIST_TOO_LARGE:'SOURCE LIST TOO LARGE — EXPORT AND REDUCE IT',SOURCES_UNAVAILABLE:'SOURCES UNAVAILABLE'}[data.status]||'NO SOURCES FOUND';
}
