import crypto from 'node:crypto';
import {safeURL} from './network.js';

export async function customRegistry(values=[]) {
  if(!Array.isArray(values))return [];
  const out=[],seen=new Set();
  for(const value of values.slice(0,30)){
    const raw=String(value||'').trim();if(!raw)continue;
    let url;try{url=await safeURL(raw.includes('://')?raw:`https://${raw}`);}catch{continue;}
    url.hash='';
    const normalized=url.href;
    if(seen.has(normalized))continue;seen.add(normalized);
    const host=url.hostname.toLowerCase().replace(/^www\./,'');
    const id=crypto.createHash('sha256').update(normalized).digest('hex').slice(0,12);
    out.push({
      id:`custom-${id}`,
      name:host.toUpperCase(),
      leagues:['*'],
      indexUrls:[normalized],
      allowedHosts:[host],
      dynamic:true,
      enabled:true,
      custom:true,
      displayHost:host,
      maxMirrors:12
    });
  }
  return out;
}
