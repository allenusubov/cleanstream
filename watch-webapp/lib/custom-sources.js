import crypto from 'node:crypto';
import {safeURL} from './network.js';

async function safeList(values=[],limit=12){
  const out=[],seen=new Set();
  for(const value of (Array.isArray(values)?values:[]).slice(0,limit)){
    try{
      const url=await safeURL(String(value||''));
      if(seen.has(url.href))continue;seen.add(url.href);out.push(url.href);
    }catch{}
  }
  return out;
}

export async function customRegistry(values=[]){
  if(!Array.isArray(values))return [];
  const out=[],seen=new Set();
  for(const value of values.slice(0,40)){
    const raw=String(typeof value==='object'?value?.url:value||'').trim();if(!raw)continue;
    let url;try{url=await safeURL(raw.includes('://')?raw:`https://${raw}`);}catch{continue;}
    const normalized=url.href;
    if(seen.has(normalized))continue;seen.add(normalized);
    const host=url.hostname.toLowerCase().replace(/^www\./,'');
    const id=crypto.createHash('sha256').update(normalized).digest('hex').slice(0,12);
    const categories={};
    if(value&&typeof value==='object'&&value.categories&&typeof value.categories==='object'){
      for(const [key,urls] of Object.entries(value.categories).slice(0,24)){
        const clean=await safeList(urls,3);if(clean.length)categories[String(key).toUpperCase()]=clean;
      }
    }
    const eventListUrls=await safeList(value&&typeof value==='object'?value.eventLists:[],6);
    out.push({
      id:`custom-${id}`,name:host.toUpperCase(),leagues:['*'],indexUrls:[normalized],eventListUrls,categories,
      // Custom profiles may point to public pages on other hosts. Every request is
      // still checked by safeURL before it can leave the server.
      allowedHosts:[],dynamic:true,enabled:true,custom:true,displayHost:host,maxMirrors:16
    });
  }
  return out;
}
