import crypto from 'node:crypto';
import {publicURL,AppError} from './network.js';

async function safeList(values=[]){
  const out=[],seen=new Set();
  for(const value of (Array.isArray(values)?values:[]).slice(0,12)){
    try{
      const url=publicURL(String(value||''));
      if(seen.has(url.href))continue;seen.add(url.href);out.push(url.href);
    }catch{}
  }
  return out;
}

export async function customRegistry(values=[]){
  if(!Array.isArray(values))return [];
  if(values.length>3000)throw new AppError('SOURCE_LIST_TOO_LARGE',413);
  const out=[],seen=new Set();
  for(const value of values){
    if(value?.enabled===false)continue;
    const raw=String(typeof value==='object'?value?.url:value||'').trim();if(!raw||raw.length>2048)continue;
    let url;try{url=publicURL(raw.includes('://')?raw:`https://${raw}`);}catch{continue;}
    const normalized=url.href;
    if(seen.has(normalized))continue;seen.add(normalized);
    const host=url.hostname.toLowerCase().replace(/^www\./,'');
    const id=crypto.createHash('sha256').update(normalized).digest('hex').slice(0,12);
    const categories={};
    if(value&&typeof value==='object'&&value.categories&&typeof value.categories==='object'){
      for(const [key,urls] of Object.entries(value.categories).slice(0,25)){
        const clean=await safeList(urls);if(clean.length)categories[String(key).toUpperCase()]=clean;
      }
    }
    const eventListUrls=await safeList(value&&typeof value==='object'?value.eventLists:[]);
    const support={};
    if(value&&typeof value==='object'&&value.support&&typeof value.support==='object'){
      for(const [key,state] of Object.entries(value.support).slice(0,25)){const clean=String(state||'').toUpperCase();if(['YES','NO','UNKNOWN'].includes(clean))support[String(key).toUpperCase()]=clean;}
    }
    const performance=value&&typeof value==='object'&&value.performance&&typeof value.performance==='object'?{
      successes:Number(value.performance.successes)||0,failures:Number(value.performance.failures)||0,avgWatchMs:Number(value.performance.avgWatchMs)||0,lastSuccessAt:Number(value.performance.lastSuccessAt)||0
    }:{successes:0,failures:0,avgWatchMs:0,lastSuccessAt:0};
    out.push({
      id:`custom-${id}`,name:host.toUpperCase(),leagues:['*'],indexUrls:[normalized],eventListUrls,categories,support,performance,structure:value?.structure||{},sourceRoot:normalized,
      // Custom profiles may point to public pages on other hosts. Every request is
      // still checked by safeURL before it can leave the server.
      allowedHosts:[],dynamic:true,enabled:true,custom:true,displayHost:host,maxMirrors:16
    });
  }
  return out;
}
