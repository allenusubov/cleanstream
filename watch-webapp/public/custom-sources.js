export const CUSTOM_SOURCE_KEY='cleanstream.customSources.v1';
const KNOWN_CATEGORIES=new Set(['NBA','WNBA','NFL','CFB','NCAAB','WNCAAB','UFC','MMA','BOXING','NHL','MLB','SOCCER','F1','NASCAR','INDYCAR','GOLF','TENNIS','RUGBY','CRICKET']);
export function likelyEventRoute(value){
  try{
    const url=new URL(value);
    const path=decodeURIComponent(url.pathname||'').toLowerCase();
    const slug=(path.split('/').filter(Boolean).at(-1)||'').replace(/[-_+]+/g,' ');
    if(/\/(?:news|blog|article|story|post)(?:\/|$)/i.test(path))return true;
    if(/(?:^|[-_/])vs(?:[-_/]|$)/i.test(path))return true;
    if(/\bversus\b/i.test(slug))return true;
    if(/(?:^|[-_/])at(?:[-_/]|$)/i.test(path) && slug.split(/\s+/).filter(Boolean).length>=4)return true;
    if(/\/\d{3,}\/?$/i.test(path) && slug.split(/\s+/).filter(Boolean).length>=3)return true;
    return false;
  }catch{return true;}
}

export function normalizeCustomSourceUrl(value) {
  const raw=String(value||'').trim();
  if(!raw)throw new Error('ENTER A SOURCE URL');
  let url;
  try{url=new URL(raw.includes('://')?raw:`https://${raw}`);}catch{throw new Error('ENTER A VALID SOURCE URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('ENTER A VALID SOURCE URL');
  if(!url.pathname)url.pathname='/';return url.href;
}
export function customSourceDomain(value) {try{return new URL(value).hostname.replace(/^www\./i,'').toUpperCase();}catch{return 'SOURCE';}}
function normalizeProfileUrl(value){return normalizeCustomSourceUrl(value);}
function cleanProfile(item={}){
  const categories={};
  if(item.categories&&typeof item.categories==='object'){
    for(const [rawKey,values] of Object.entries(item.categories)){
      const key=String(rawKey).toUpperCase();if(!KNOWN_CATEGORIES.has(key))continue;
      const list=[],seen=new Set();
      for(const value of (Array.isArray(values)?values:[values]))try{const url=normalizeProfileUrl(value);if(!likelyEventRoute(url)&&!seen.has(url)){seen.add(url);list.push(url);}}catch{}
      if(list.length)categories[key]=list;
    }
  }
  const eventLists=[],seen=new Set();
  for(const value of (Array.isArray(item.eventLists)?item.eventLists:[]))try{const url=normalizeProfileUrl(value);if(!likelyEventRoute(url)&&!seen.has(url)){seen.add(url);eventLists.push(url);}}catch{}
  return {categories,eventLists};
}
export function loadCustomSources(storage=globalThis.localStorage) {
  let parsed=[];try{parsed=JSON.parse(storage?.getItem(CUSTOM_SOURCE_KEY)||'[]');}catch{}
  if(!Array.isArray(parsed))return [];
  const seen=new Set(),out=[];
  for(const item of parsed){
    try{
      const url=normalizeCustomSourceUrl(typeof item==='string'?item:item?.url);if(seen.has(url))continue;seen.add(url);
      const profile=cleanProfile(typeof item==='object'?item:{});
      out.push({url,enabled:typeof item==='object'?item.enabled!==false:true,...profile});
    }catch{}
  }return out;
}
export function saveCustomSources(items,storage=globalThis.localStorage) {
  const clean=loadCustomSources({getItem:()=>JSON.stringify(items)});storage?.setItem(CUSTOM_SOURCE_KEY,JSON.stringify(clean));
  if(typeof globalThis.dispatchEvent==='function'&&typeof CustomEvent!=='undefined')globalThis.dispatchEvent(new CustomEvent('cleanstream:sources-changed',{detail:clean}));
  return clean;
}
export function addCustomSource(value,storage=globalThis.localStorage) {
  const url=normalizeCustomSourceUrl(value),items=loadCustomSources(storage);const existing=items.find(item=>item.url===url);
  if(existing){existing.enabled=true;return saveCustomSources(items,storage);}items.push({url,enabled:true,categories:{},eventLists:[]});return saveCustomSources(items,storage);
}
export function setCustomSourceEnabled(url,enabled,storage=globalThis.localStorage) {
  return saveCustomSources(loadCustomSources(storage).map(item=>item.url===url?{...item,enabled:Boolean(enabled)}:item),storage);
}
export function setCustomSourceProfile(url,profile,storage=globalThis.localStorage){
  const normalized=cleanProfile(profile);return saveCustomSources(loadCustomSources(storage).map(item=>item.url===url?{...item,...normalized}:item),storage);
}
export function mergeCustomSourceProfile(url,profile,storage=globalThis.localStorage){
  const learned=cleanProfile(profile);
  return saveCustomSources(loadCustomSources(storage).map(item=>{
    if(item.url!==url)return item;
    const categories={};
    const keys=new Set([...Object.keys(item.categories||{}),...Object.keys(learned.categories||{})]);
    for(const key of keys){
      const merged=[];
      for(const value of [...(item.categories?.[key]||[]),...(learned.categories?.[key]||[])])if(!merged.includes(value))merged.push(value);
      if(merged.length)categories[key]=merged;
    }
    const eventLists=[];
    for(const value of [...(item.eventLists||[]),...(learned.eventLists||[])])if(!eventLists.includes(value))eventLists.push(value);
    return {...item,categories,eventLists};
  }),storage);
}
export function removeCustomSource(url,storage=globalThis.localStorage) {return saveCustomSources(loadCustomSources(storage).filter(item=>item.url!==url),storage);}
export function enabledCustomSources(storage=globalThis.localStorage) {return loadCustomSources(storage).filter(item=>item.enabled);}
export function enabledCustomSourceUrls(storage=globalThis.localStorage) {return enabledCustomSources(storage).map(item=>item.url);}
export function splitCustomSourceInput(value) {return String(value||'').split(/\r?\n/).map(item=>item.trim()).filter(Boolean);}
export function addCustomSources(value,storage=globalThis.localStorage) {
  const entries=Array.isArray(value)?value:splitCustomSourceInput(value);if(!entries.length)throw new Error('ENTER AT LEAST ONE SOURCE URL');
  const items=loadCustomSources(storage),byUrl=new Map(items.map(item=>[item.url,item]));let added=0,existing=0,invalid=0,limit=0;
  for(const entry of entries){let url;try{url=normalizeCustomSourceUrl(entry);}catch{invalid++;continue;}const saved=byUrl.get(url);
    if(saved){saved.enabled=true;existing++;continue;}const item={url,enabled:true,categories:{},eventLists:[]};items.push(item);byUrl.set(url,item);added++;}
  if(!added&&!existing&&invalid)throw new Error('ENTER VALID SOURCE URLS');
  return {items:saveCustomSources(items,storage),added,existing,invalid,limit};
}
export function profileLines(item){
  let base=null;try{base=new URL(item.url);}catch{}
  const compact=value=>{
    try{
      const url=new URL(value);
      if(base&&url.origin===base.origin)return `${url.pathname||'/'}${url.search}${url.hash}`||'/';
      return url.href;
    }catch{return value;}
  };
  const lines=[];
  for(const [key,urls] of Object.entries(item.categories||{}))for(const url of urls)lines.push(`${key} ${compact(url)}`);
  for(const url of item.eventLists||[])lines.push(`EVENTS ${compact(url)}`);
  return lines.join('\n');
}
export function parseProfileLines(value,baseUrl=''){
  const categories={},eventLists=[];let invalid=0;
  for(const raw of String(value||'').split(/\r?\n/)){
    const line=raw.trim();if(!line)continue;
    const match=line.match(/^(\S+)\s+(\S+)$/i);if(!match){invalid++;continue;}
    let [,label,target]=match;label=label.toUpperCase();
    let url;
    try{
      if(baseUrl&&!target.includes('://'))url=normalizeProfileUrl(new URL(target,baseUrl).href);
      else url=normalizeProfileUrl(target);
    }catch{invalid++;continue;}
    if(label==='EVENT'||label==='EVENTS'||label==='LIVE'||label==='SCHEDULE'||label==='UPCOMING'||label==='GAMES'||label==='MATCHES'){
      if(!eventLists.includes(url))eventLists.push(url);continue;
    }
    if(!KNOWN_CATEGORIES.has(label)){invalid++;continue;}
    categories[label]??=[];
    if(!categories[label].includes(url))categories[label].push(url);
  }
  return {categories,eventLists,invalid};
}
