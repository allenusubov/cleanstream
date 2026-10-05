export const CUSTOM_SOURCE_KEY='cleanstream.customSources.v1';

export function normalizeCustomSourceUrl(value) {
  const raw=String(value||'').trim();
  if(!raw)throw new Error('ENTER A SOURCE URL');
  let url;
  try{url=new URL(raw.includes('://')?raw:`https://${raw}`);}catch{throw new Error('ENTER A VALID SOURCE URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('ENTER A VALID SOURCE URL');
  url.hash='';
  if(!url.pathname)url.pathname='/';
  return url.href;
}

export function customSourceDomain(value) {
  try{return new URL(value).hostname.replace(/^www\./i,'').toUpperCase();}
  catch{return 'SOURCE';}
}

export function loadCustomSources(storage=globalThis.localStorage) {
  let parsed=[];
  try{parsed=JSON.parse(storage?.getItem(CUSTOM_SOURCE_KEY)||'[]');}catch{}
  if(!Array.isArray(parsed))return [];
  const seen=new Set(),out=[];
  for(const item of parsed.slice(0,40)){
    try{
      const url=normalizeCustomSourceUrl(typeof item==='string'?item:item?.url);
      if(seen.has(url))continue;seen.add(url);
      out.push({url,enabled:typeof item==='object'?item.enabled!==false:true});
    }catch{}
  }
  return out;
}

export function saveCustomSources(items,storage=globalThis.localStorage) {
  const clean=loadCustomSources({getItem:()=>JSON.stringify(items)});
  storage?.setItem(CUSTOM_SOURCE_KEY,JSON.stringify(clean));
  if(typeof globalThis.dispatchEvent==='function'&&typeof CustomEvent!=='undefined'){
    globalThis.dispatchEvent(new CustomEvent('cleanstream:sources-changed',{detail:clean}));
  }
  return clean;
}

export function addCustomSource(value,storage=globalThis.localStorage) {
  const url=normalizeCustomSourceUrl(value),items=loadCustomSources(storage);
  const existing=items.find(item=>item.url===url);
  if(existing){existing.enabled=true;return saveCustomSources(items,storage);}
  items.push({url,enabled:true});
  return saveCustomSources(items,storage);
}

export function setCustomSourceEnabled(url,enabled,storage=globalThis.localStorage) {
  const items=loadCustomSources(storage).map(item=>item.url===url?{...item,enabled:Boolean(enabled)}:item);
  return saveCustomSources(items,storage);
}

export function removeCustomSource(url,storage=globalThis.localStorage) {
  return saveCustomSources(loadCustomSources(storage).filter(item=>item.url!==url),storage);
}

export function enabledCustomSourceUrls(storage=globalThis.localStorage) {
  return loadCustomSources(storage).filter(item=>item.enabled).map(item=>item.url);
}

export function splitCustomSourceInput(value) {
  return String(value||'').split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
}

export function addCustomSources(value,storage=globalThis.localStorage) {
  const entries=Array.isArray(value)?value:splitCustomSourceInput(value);
  if(!entries.length)throw new Error('ENTER AT LEAST ONE SOURCE URL');
  const items=loadCustomSources(storage);
  const byUrl=new Map(items.map(item=>[item.url,item]));
  let added=0,existing=0,invalid=0,limit=0;
  for(const entry of entries){
    let url;
    try{url=normalizeCustomSourceUrl(entry);}catch{invalid++;continue;}
    const saved=byUrl.get(url);
    if(saved){saved.enabled=true;existing++;continue;}
    if(items.length>=40){limit++;continue;}
    const item={url,enabled:true};
    items.push(item);byUrl.set(url,item);added++;
  }
  if(!added&&!existing&&invalid)throw new Error('ENTER VALID SOURCE URLS');
  const saved=saveCustomSources(items,storage);
  return {items:saved,added,existing,invalid,limit};
}
