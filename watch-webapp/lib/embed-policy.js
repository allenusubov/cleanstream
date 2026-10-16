import {fetchLimited} from './network.js';
import {MetadataCache} from './provider-cache.js';
const cache=new MetadataCache(200);
export function clearEmbedPolicies(){cache.values.clear();}
function allowsSource(source,parent,resource){
  if(source==="'none'")return false;
  if(source==='*')return true;
  if(source==="'self'")return parent.origin===resource.origin;
  if(/^[a-z]+:$/.test(source))return parent.protocol===source;
  try{
    const pattern=new URL(source.includes('://')?source:resource.protocol+'//'+source);
    const host=pattern.hostname.startsWith('*.')?parent.hostname.endsWith(pattern.hostname.slice(1))&&parent.hostname!==pattern.hostname.slice(2):parent.hostname===pattern.hostname;
    return host&&parent.protocol===pattern.protocol&&(pattern.port==='*'||parent.port===pattern.port);
  }catch{return false;}
}
export function allowsEmbedding(headers,parentOrigin,resourceUrl){
  const parent=new URL(parentOrigin),resource=new URL(resourceUrl),csp=headers.get('content-security-policy')||'';
  let directives=0;
  for(const policy of csp.split(',')){
    const ancestors=policy.split(';').map(value=>value.trim()).find(value=>/^frame-ancestors\b/i.test(value));
    if(!ancestors)continue;directives++;
    if(!ancestors.split(/\s+/).slice(1).some(source=>allowsSource(source,parent,resource)))return false;
  }
  if(directives)return true;
  const xfo=(headers.get('x-frame-options')||'').toUpperCase();
  if(xfo.includes('DENY'))return false;
  if(xfo.includes('SAMEORIGIN'))return parent.origin===resource.origin;
  return true;
}
export async function inspectEmbedPolicy(url,origin){
  if(!origin)return null;
  try{return await cache.get(origin+'|'+url,60000,async()=>{
    const response=await fetchLimited(url,{limit:8192,partial:true,signal:AbortSignal.timeout(5000),headers:{Range:'bytes=0-8191'}});return allowsEmbedding(response.headers,origin,response.url);
  });}catch{return null;}
}
