export const CUSTOM_SOURCE_KEY='cleanstream.customSources.v1';
export const KNOWN_CATEGORIES=['TV','MOVIES','NBA','WNBA','NFL','CFB','NCAAB','WNCAAB','UFC','MMA','BOXING','NHL','MLB','SOCCER','F1','NASCAR','INDYCAR','GOLF','TENNIS','RUGBY','CRICKET'];
const CATEGORY_SET=new Set(KNOWN_CATEGORIES);
const SUPPORT_VALUES=new Set(['YES','NO','UNKNOWN']);

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
function cleanSupport(raw={},categories={}){
  const support={};
  for(const key of KNOWN_CATEGORIES){
    const value=String(raw?.[key]||'').toUpperCase();
    if((categories[key]||[]).length)support[key]='YES';
    else if(SUPPORT_VALUES.has(value))support[key]=value;
  }
  return support;
}
function cleanStructure(raw={}){
  const list=(value,max=12)=>[...new Set((Array.isArray(value)?value:[]).map(v=>String(v||'').trim()).filter(Boolean))].slice(0,max);
  const routeStyle=['PATH','HASH','QUERY','MIXED','UNKNOWN'].includes(String(raw.routeStyle||'').toUpperCase())?String(raw.routeStyle).toUpperCase():'UNKNOWN';
  return {routeStyle,eventPrefixes:list(raw.eventPrefixes),eventHosts:list(raw.eventHosts,8),mirrorLabels:list(raw.mirrorLabels,12),playerHosts:list(raw.playerHosts,12),searchTemplates:list(raw.searchTemplates,8),episodeTemplates:list(raw.episodeTemplates,8),titleTemplates:list(raw.titleTemplates,8),browserSearch:Boolean(raw.browserSearch)};
}
function cleanTest(raw={}){
  const status=['LEARNED','PARTIAL','UNREACHABLE','FAILED'].includes(String(raw.status||'').toUpperCase())?String(raw.status).toUpperCase():'';
  return {status,reason:String(raw.reason||'').slice(0,180),testedAt:Math.max(0,Number(raw.testedAt)||0)};
}
function cleanPerformance(raw={}){
  const successes=Math.max(0,Math.min(10000,Number(raw.successes)||0));
  const failures=Math.max(0,Math.min(10000,Number(raw.failures)||0));
  const avgWatchMs=Math.max(0,Math.min(120000,Number(raw.avgWatchMs)||0));
  const lastSuccessAt=Math.max(0,Number(raw.lastSuccessAt)||0);
  return {successes,failures,avgWatchMs,lastSuccessAt};
}
function cleanProfile(item={}){
  const categories={};
  if(item.categories&&typeof item.categories==='object'){
    for(const [rawKey,values] of Object.entries(item.categories)){
      const key=String(rawKey).toUpperCase();if(!CATEGORY_SET.has(key))continue;
      const list=[],seen=new Set();
      for(const value of (Array.isArray(values)?values:[values]))try{const url=normalizeProfileUrl(value);if(!likelyEventRoute(url)&&!seen.has(url)){seen.add(url);list.push(url);}}catch{}
      if(list.length)categories[key]=list;
    }
  }
  const eventLists=[],seen=new Set();
  for(const value of (Array.isArray(item.eventLists)?item.eventLists:[]))try{const url=normalizeProfileUrl(value);if(!likelyEventRoute(url)&&!seen.has(url)){seen.add(url);eventLists.push(url);}}catch{}
  return {
    categories,eventLists,
    support:cleanSupport(item.support,categories),
    structure:cleanStructure(item.structure),
    performance:cleanPerformance(item.performance),
    test:cleanTest(item.test),
    testedAt:Math.max(0,Number(item.testedAt)||0)
  };
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
  if(existing){existing.enabled=true;return saveCustomSources(items,storage);}items.push({url,enabled:true,...cleanProfile({})});return saveCustomSources(items,storage);
}
export function setCustomSourceEnabled(url,enabled,storage=globalThis.localStorage) {
  return saveCustomSources(loadCustomSources(storage).map(item=>item.url===url?{...item,enabled:Boolean(enabled)}:item),storage);
}
export function setCustomSourceProfile(url,profile,storage=globalThis.localStorage){
  const normalized=cleanProfile(profile);return saveCustomSources(loadCustomSources(storage).map(item=>{
    if(item.url!==url)return item;
    const structure={...(item.structure||{})};
    if(profile?.structure&&Object.prototype.hasOwnProperty.call(profile.structure,'searchTemplates'))structure.searchTemplates=normalized.structure.searchTemplates;
    return {...item,categories:normalized.categories,eventLists:normalized.eventLists,support:{...(item.support||{}),...(normalized.support||{})},performance:item.performance,structure,test:item.test,testedAt:item.testedAt};
  }),storage);
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
    const support={...(item.support||{})};
    for(const key of KNOWN_CATEGORIES){
      if((categories[key]||[]).length)support[key]='YES';
      else if(learned.support?.[key])support[key]=learned.support[key];
    }
    const structure={
      routeStyle:learned.structure?.routeStyle&&learned.structure.routeStyle!=='UNKNOWN'?learned.structure.routeStyle:item.structure?.routeStyle||'UNKNOWN',
      eventPrefixes:[...new Set([...(item.structure?.eventPrefixes||[]),...(learned.structure?.eventPrefixes||[])])].slice(0,12),
      eventHosts:[...new Set([...(item.structure?.eventHosts||[]),...(learned.structure?.eventHosts||[])])].slice(0,8),
      mirrorLabels:[...new Set([...(item.structure?.mirrorLabels||[]),...(learned.structure?.mirrorLabels||[])])].slice(0,12),
      playerHosts:[...new Set([...(item.structure?.playerHosts||[]),...(learned.structure?.playerHosts||[])])].slice(0,12),
      searchTemplates:[...new Set([...(item.structure?.searchTemplates||[]),...(learned.structure?.searchTemplates||[])])].slice(0,8),
      episodeTemplates:[...new Set([...(item.structure?.episodeTemplates||[]),...(learned.structure?.episodeTemplates||[])])].slice(0,8),
      titleTemplates:[...new Set([...(item.structure?.titleTemplates||[]),...(learned.structure?.titleTemplates||[])])].slice(0,8),
      browserSearch:Boolean(item.structure?.browserSearch||learned.structure?.browserSearch)
    };
    const test=learned.test?.status?learned.test:item.test||cleanTest({});
    return {...item,categories,eventLists,support,structure,test,testedAt:learned.testedAt||Date.now()};
  }),storage);
}
export function recordCustomSourceSuccess(url,startupMs=0,details={},storage=globalThis.localStorage){
  let normalized;try{normalized=normalizeCustomSourceUrl(url);}catch{return loadCustomSources(storage);}
  return saveCustomSources(loadCustomSources(storage).map(item=>{
    if(item.url!==normalized)return item;
    const old=cleanPerformance(item.performance),successes=old.successes+1;
    const sample=Math.max(0,Number(startupMs)||0);
    const avgWatchMs=sample?Math.round(old.avgWatchMs?old.avgWatchMs*.75+sample*.25:sample):old.avgWatchMs;
    const structure=cleanStructure(item.structure);const add=(key,value,max=12)=>{if(value&&!structure[key].includes(value))structure[key]=[value,...structure[key]].slice(0,max);};
    try{const u=new URL(details.eventUrl||'');const parts=u.pathname.split('/').filter(Boolean);add('eventHosts',u.hostname.replace(/^www\./i,''),8);add('eventPrefixes',parts.length>1?'/'+parts.slice(0,-1).join('/')+'/':'/');}catch{}
    try{const u=new URL(details.mediaUrl||'');add('playerHosts',u.hostname.replace(/^www\./i,''));}catch{}
    const mirror=String(details.mirrorLabel||'').trim();if(mirror&&mirror!=='DEFAULT')add('mirrorLabels',mirror);
    const learned=cleanStructure(details.structure||{});
    for(const value of learned.searchTemplates)add('searchTemplates',value,8);
    for(const value of learned.episodeTemplates)add('episodeTemplates',value,8);
    for(const value of learned.titleTemplates)add('titleTemplates',value,8);
    if(learned.browserSearch)structure.browserSearch=true;
    return {...item,performance:{...old,successes,avgWatchMs,lastSuccessAt:Date.now()},structure};
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
    if(saved){saved.enabled=true;existing++;continue;}const item={url,enabled:true,...cleanProfile({})};items.push(item);byUrl.set(url,item);added++;}
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
  for(const [key,state] of Object.entries(item.support||{}))if(state==='NO'&&!(item.categories?.[key]||[]).length)lines.push(`${key} NO`);
  for(const url of item.eventLists||[])lines.push(`EVENTS ${compact(url)}`);
  for(const url of item.structure?.searchTemplates||[])lines.push(`SEARCH ${compact(url)}`);
  for(const url of item.structure?.episodeTemplates||[])lines.push(`EPISODE ${compact(url)}`);
  for(const url of item.structure?.titleTemplates||[])lines.push(`TITLE ${compact(url)}`);
  if(item.structure?.browserSearch)lines.push('SEARCHUI YES');
  return lines.join('\n');
}
export function parseProfileLines(value,baseUrl=''){
  const categories={},eventLists=[],support={},structure={searchTemplates:[],episodeTemplates:[],titleTemplates:[],browserSearch:false};let invalid=0;
  for(const raw of String(value||'').split(/\r?\n/)){
    const line=raw.trim();if(!line)continue;
    const supportMatch=line.match(/^(\S+)\s+(YES|NO|UNKNOWN)$/i);
    if(supportMatch){const key=supportMatch[1].toUpperCase(),state=supportMatch[2].toUpperCase();if(key==='SEARCHUI'){structure.browserSearch=state==='YES';continue;}if(!CATEGORY_SET.has(key)){invalid++;continue;}support[key]=state;continue;}
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
    if(label==='SEARCH'){if(!structure.searchTemplates.includes(url))structure.searchTemplates.push(url);continue;}
    if(label==='EPISODE'){if(!structure.episodeTemplates.includes(url))structure.episodeTemplates.push(url);continue;}
    if(label==='TITLE'){if(!structure.titleTemplates.includes(url))structure.titleTemplates.push(url);continue;}
    if(!CATEGORY_SET.has(label)){invalid++;continue;}
    categories[label]??=[];
    if(!categories[label].includes(url))categories[label].push(url);
  }
  for(const key of Object.keys(categories))support[key]='YES';
  return {categories,eventLists,support,structure,invalid};
}

export function exportCustomSourcesPayload(storage=globalThis.localStorage){
  return {version:1,exportedAt:new Date().toISOString(),sources:loadCustomSources(storage)};
}
export function importCustomSourcesPayload(payload,storage=globalThis.localStorage){
  const incoming=Array.isArray(payload)?payload:Array.isArray(payload?.sources)?payload.sources:[];
  const current=loadCustomSources(storage),byUrl=new Map(current.map(item=>[item.url,item]));let added=0,updated=0,invalid=0;
  for(const raw of incoming){
    try{
      const url=normalizeCustomSourceUrl(typeof raw==='string'?raw:raw?.url);const profile=cleanProfile(typeof raw==='object'?raw:{});const old=byUrl.get(url);
      if(old){byUrl.set(url,{...old,...profile,enabled:typeof raw==='object'?raw.enabled!==false:old.enabled,performance:profile.performance.successes?profile.performance:old.performance});updated++;}
      else {byUrl.set(url,{url,enabled:typeof raw==='object'?raw.enabled!==false:true,...profile});added++;}
    }catch{invalid++;}
  }
  const items=saveCustomSources([...byUrl.values()],storage);return {items,added,updated,invalid};
}
function bytesToBase64(bytes){let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function base64ToBytes(value){let text=String(value||'').replace(/-/g,'+').replace(/_/g,'/');while(text.length%4)text+='=';const binary=atob(text),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;}
export function encodeCustomSourcesShare(storage=globalThis.localStorage){return bytesToBase64(new TextEncoder().encode(JSON.stringify(exportCustomSourcesPayload(storage))));}
export function decodeCustomSourcesShare(value){return JSON.parse(new TextDecoder().decode(base64ToBytes(value)));}
export async function ensureDefaultCustomSources(storage=globalThis.localStorage,fetcher=globalThis.fetch){
  if(loadCustomSources(storage).length||typeof fetcher!=='function')return loadCustomSources(storage);
  try{const response=await fetcher('/default-custom-sources.json',{cache:'no-store'});if(!response.ok)return [];const data=await response.json();return importCustomSourcesPayload(data,storage).items;}catch{return [];}
}
