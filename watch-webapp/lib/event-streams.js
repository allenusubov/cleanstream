import {publicURL,AppError} from './network.js';
import {decodeText} from './directory.js';
import {excludedPlatform} from '../public/live-only.js';
import {aborted} from './discovery-control.js';

const attr=(tag,name)=>decodeText(tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`,'i'))?.[2]||'');
const media=/\.(m3u8|mp4|m4v|mov|webm)(?:$|\?)/i;
const ignored=/doubleclick|googlesyndication|\/ads?\/|preroll|analytics|live_chat|\/chat(?:\/|\?)/i;
const words=value=>String(value).toLowerCase().match(/[a-z]{4,}/g)?.filter(word=>!['https','http','www','live','stream','streams','watch','event','events','html','online','versus'].includes(word))||[];

// Only player frames and event-specific source rows. Navigation, chat and other
// events must never turn a pasted event URL into an unrestricted site crawl.
export function eventStreamRoutes(html,base,{limit=64,eventUrl=base}={}){
  const clean=String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,'');
  const routes=new Map(),baseUrl=new URL(base);baseUrl.hash='';
  const eventWords=new Set(words(new URL(eventUrl).pathname));
  const add=(href,label,kind)=>{
    if(!href||href.startsWith('#')||ignored.test(href))return;
    try{
      const url=publicURL(new URL(href,base).href);url.hash='';
      if(excludedPlatform(url.href))return;
      if(url.href===baseUrl.href||url.href.length>4096)return;
      if(!routes.has(url.href))routes.set(url.href,{url:url.href,label:String(label||url.hostname).replace(/\s+/g,' ').trim().slice(0,100),kind});
    }catch{}
  };
  for(const match of clean.matchAll(/<iframe\b[^>]*>/gi))add(attr(match[0],'src')||attr(match[0],'data-src'),attr(match[0],'title'),'frame');
  for(const match of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)){
    const href=attr(match[1],'href');if(!href)continue;
    const text=decodeText(match[2].replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
    const explicit=/\bnocolor\b|(?:stream|source|mirror|server|player|watch)[-_](?:link|row|option)|data-(?:stream|source|player)/i.test(match[1]);
    const shared=words(href+' '+text).filter(word=>eventWords.has(word));
    const sameEvent=new Set(shared).size>=2&&/\bvs\b|[-/]vs[-/]|versus/i.test(href+' '+text);
    if(eventWords.size>=2&&/[-/](?:vs|versus)[-/]/i.test(href)&&new Set(shared).size<2)continue;
    const player=/\/(?:embed|player|stream)(?:[/.?_-]|$)|\/watch\?/i.test(href);
    const context=decodeText(clean.slice(Math.max(0,match.index-300),match.index).replace(/<[^>]*>/g,' '))+text;
    const contextualWatch=/^(?:watch|play|stream|source|server|mirror)(?:\s+(?:now|live|hd|\d+))*$/i.test(text)&&new Set(words(context).filter(word=>eventWords.has(word))).size>=2;
    if(explicit||sameEvent||media.test(href)||player||contextualWatch)add(href,text,'link');
  }
  return [...routes.values()].slice(0,limit);
}

export function extractionError(cause){
  if(cause instanceof AppError)return cause;
  const text=String(cause?.message||'');
  const code=/Timeout|timed out/i.test(text)?'SOURCE_TIMEOUT':/net::|ENOTFOUND|EAI_AGAIN|ECONN|fetch failed/i.test(text)?'SOURCE_NETWORK_ERROR':'EXTRACTION_FAILED';
  const error=new AppError(code,code==='SOURCE_TIMEOUT'?504:502);error.cause=cause;return error;
}

// Fetch lightweight pages concurrently; use a smaller, separate browser queue.
// A broken route cannot prevent sibling routes from producing candidates.
export async function walkEventStreams(root,{inspectStatic,inspectBrowser,onCandidate=()=>{},onProgress=()=>{},priority=()=>0,signal,maxRoutes=64,maxDepth=3,maxCandidates=48,scanAll=true}={}){
  const pending=[{url:root,depth:0,label:'',kind:'page'}],seen=new Set([root]),browserQueue=[],candidates=new Map(),errors=[];
  let fetching=0,browsing=0,checked=0,stopped=false,limited=false;
  return new Promise((resolve,reject)=>{
    let finished=false;
    const finish=()=>{
      if(finished||fetching||browsing||(!stopped&&(pending.length||browserQueue.length)))return;
      finished=true;signal?.removeEventListener('abort',cancel);
      if(signal?.aborted){reject(signal.reason||new DOMException('Cancelled','AbortError'));return;}
      resolve({candidates:[...candidates.values()],checkedRoutes:checked,totalRoutes:seen.size,partial:limited,failures:errors});
    };
    const report=()=>onProgress({checkedRoutes:checked,totalRoutes:seen.size,found:candidates.size});
    const cancel=()=>{stopped=true;pending.length=0;browserQueue.length=0;finish();};
    signal?.addEventListener('abort',cancel,{once:true});
    const accept=(items,route)=>{
      for(const item of items||[]){
        const url=item.url||item.mediaUrl||item.embedUrl||item.externalUrl;if(!url||candidates.has(url))continue;
        const candidate={...item,routeUrl:route.url,routeLabel:route.label};candidates.set(url,candidate);onCandidate(candidate);
        if(candidates.size>=maxCandidates){limited=true;stopped=true;break;}
      }
      if([...candidates.values()].some(item=>!item.externalUrl)&&!scanAll)stopped=true;
      if(stopped){pending.length=0;browserQueue.length=0;}
    };
    const addRoutes=(routes,parent)=>{
      if(parent.depth>=maxDepth){if(routes?.length)limited=true;return;}
      for(const route of routes||[]){
        if(seen.has(route.url))continue;
        if(seen.size>=maxRoutes){limited=true;break;}
        seen.add(route.url);pending.push({...route,depth:parent.depth+1,parentUrl:parent.url,eventUrl:root});
      }
      pending.sort((a,b)=>priority(b.url)-priority(a.url)||(a.kind==='player-media'?-2:a.kind==='frame'?-1:0)-(b.kind==='player-media'?-2:b.kind==='frame'?-1:0)||a.depth-b.depth);
    };
    const run=async(route,browser)=>{
      try{
        aborted(signal);
        if(browser){const result=await inspectBrowser(route.url,route);accept(result.media||[],route);if(!stopped)addRoutes(result.routes,route);}
        else {
          const result=await inspectStatic(route.url,route);
          accept(result.media,route);
          if(!stopped)accept(result.players,route);
          if(!stopped){addRoutes(result.routes,route);if(!result.media?.length&&result.browser!==false)browserQueue.push({...route,directory:Boolean(result.routes?.length)});}
        }
      }catch(cause){if(!signal?.aborted){errors.push({code:extractionError(cause).code,cause});if(!browser&&!stopped&&!['EVENT_UNAVAILABLE','FEED_FORMAT_CHANGED','FEED_UNAVAILABLE','STREAMS_NOT_POSTED'].includes(cause.code))browserQueue.push(route);}}
      finally{if(browser)browsing--;else{fetching--;checked++;}if(!signal?.aborted)report();pump();}
    };
    const pump=()=>{
      if(signal?.aborted)cancel();
      if(!stopped){
        while(fetching<4&&pending.length){fetching++;void run(pending.shift(),false);}
        // Prefer leaf players; parent directory pages remain fallbacks.
        browserQueue.sort((a,b)=>priority(b.url)-priority(a.url)||b.depth-a.depth);
        while(browsing<2&&browserQueue.length){
          const next=browserQueue.findIndex(route=>!route.directory||(!fetching&&!pending.length));
          if(next<0)break;
          browsing++;void run(browserQueue.splice(next,1)[0],true);
        }
      }
      finish();
    };
    pump();
  });
}
