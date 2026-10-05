import {chromium} from 'playwright';
import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {safeURL, fetchLimited, AppError, WorkPool} from './network.js';
const pool=new WorkPool(Math.max(1,Math.min(6,Number(process.env.BROWSER_CONCURRENCY)||4)));
let browserPromise=null;
const cache=new Map(), inflight=new Map();
const HLS=/\.m3u8(?:$|\?)/i;
const MEDIA=/\.(m3u8|mp4|m4v|mov|webm)(?:$|\?)/i;
export async function withPage(task) {
  return pool.run(async()=>{
    let context;
    try {
      // Keep one Chromium process warm for the lifetime of a Cloud Run instance.
      // Contexts are still isolated and closed after every job.
      browserPromise ||= chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || undefined,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
      const browser=await browserPromise;
      context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,
        userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'});
      context.setDefaultTimeout(1200);
      let page=null, requests=0;
      context.on('page',p=>{if(page && p!==page) p.close().catch(()=>{});});
      await context.route('**/*',async route=>{
        if(++requests>180 || ['image','font','media'].includes(route.request().resourceType())) return route.abort();
        try { await safeURL(route.request().url()); await route.continue(); }
        catch { await route.abort().catch(()=>{}); }
      });
      page=await context.newPage();
      const timer=setTimeout(()=>context.close().catch(()=>{}),16000);
      try { return await task(page); } finally {clearTimeout(timer);}
    } finally {
      await context?.close().catch(()=>{});
    }
  });
}
export async function visit(page,url) {
  await safeURL(url);
  try {await page.goto(url,{waitUntil:'domcontentloaded',timeout:6000});}
  catch(error){if(page.url()==='about:blank') throw error;}
  // Give client-side routers one short turn, but do not impose a multi-second sleep.
  await page.waitForTimeout(250);
}
function htmlMedia(body,base){
  const text=String(body||'').replace(/\u0026/g,'&').replace(/&amp;/g,'&');
  const found=new Map();
  const add=value=>{
    if(!value)return;
    try{const url=new URL(value.replace(/\\\//g,'/'),base).href;if(MEDIA.test(url))found.set(url,{url,isHls:HLS.test(url),contentType:''});}catch{}
  };
  for(const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/ig))add(match[1]);
  for(const match of text.matchAll(/https?:\/\/[^"'<>\s]+?\.(?:m3u8|mp4|m4v|mov|webm)(?:\?[^"'<>\s]*)?/ig))add(match[0]);
  for(const match of text.matchAll(/https?:\\\/\\\/[^"'<>\s]+?\.(?:m3u8|mp4|m4v|mov|webm)(?:\?[^"'<>\s]*)?/ig))add(match[0]);
  return [...found.values()].slice(0,8);
}
async function staticExtract(url){
  try{
    const response=await fetchLimited(url,{limit:1536*1024,partial:true});
    const type=response.headers.get('content-type')||'';
    if(MEDIA.test(response.url)||/mpegurl|^video\/(mp4|webm|quicktime)/i.test(type))return [{url:response.url,isHls:HLS.test(response.url)||/mpegurl/i.test(type),contentType:type}];
    if(/text\/html|application\/xhtml/i.test(type)||!type)return htmlMedia(response.body.toString(),response.url);
  }catch{}
  return [];
}
async function extract(url) {
  if(MEDIA.test(url)) return [{url,isHls:HLS.test(url),contentType:''}];
  const quick=await staticExtract(url);
  if(quick.length)return quick;
  return withPage(async page=>{
    const found=new Map();
    const add=(url,type='',status=200)=>{
      if(!/^https?:/.test(url) || /doubleclick|\/ads?\/|preroll|analytics/i.test(url)) return;
      if(MEDIA.test(url) || /mpegurl|^video\/(mp4|webm)/i.test(type)) {
        const old=found.get(url);
        found.set(url,{url,isHls:HLS.test(url)||/mpegurl/i.test(type),contentType:type||old?.contentType||'',status});
      }
    };
    page.on('request',r=>add(r.url()));
    page.on('response',async r=>{try{add(r.url(),(await r.allHeaders())['content-type'],r.status());}catch{}});
    await visit(page,url);
    for(const frame of page.frames()) {
      try {
        for(const entry of await frame.locator('video,video source').evaluateAll(nodes=>nodes.map(n=>({url:n.currentSrc||n.src,type:n.type})))) add(entry.url,entry.type);
        if(!found.size) {
          await frame.locator('video').evaluateAll(nodes=>nodes.forEach(v=>{v.muted=true; v.play().catch(()=>{});}));
          const button=frame.locator('button[aria-label*="play" i],.vjs-big-play-button,.jw-icon-playback,.plyr__control[data-plyr="play"]').first();
          if(await button.isVisible()) await button.click({timeout:800});
        }
      } catch {}
    }
    if(!found.size) await page.waitForTimeout(1200);
    return [...found.values()].filter(x=>x.status<400).sort((a,b)=>Number(b.isHls)-Number(a.isHls)).slice(0,8);
  });
}
function cors(response,origin) {
  const allowed=response.headers.get('access-control-allow-origin');
  if(allowed!=='*' && allowed!==origin) throw new AppError('DIRECT_BLOCKED',422);
  if(new URL(response.url).protocol!=='https:') throw new AppError('DIRECT_BLOCKED',422);
  return allowed==='*';
}
export function parsePlaylist(text,base) {
  if(!text.trimStart().startsWith('#EXTM3U')) throw new AppError('SOURCE_UNAVAILABLE',502);
  const lines=text.split(/\r?\n/).map(x=>x.trim());
  const variants=[], segments=[], assets=[], audio=[];
  let variant=null;
  for(const line of lines) {
    if(line.startsWith('#EXT-X-STREAM-INF:')) {
      variant={height:Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1])||0,bandwidth:Number(line.match(/BANDWIDTH=(\d+)/)?.[1])||0};
    } else if(line && !line.startsWith('#')) {
      const url=new URL(line,base).href;
      if(variant) {variants.push({...variant,url});variant=null;} else segments.push(url);
    } else if(line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(line)) {
      const uri=line.match(/URI="([^"]+)"/)?.[1];if(uri)audio.push({url:new URL(uri,base).href,preferred:/DEFAULT=YES/.test(line)});
    } else if(/^#EXT-X-(KEY|MAP):/.test(line)) {
      if(line.startsWith('#EXT-X-KEY:') && !/METHOD=(AES-128|NONE)(?:,|$)/.test(line)) throw new AppError('DIRECT_BLOCKED',422);
      const uri=line.match(/URI="([^"]+)"/)?.[1]; if(uri) assets.push(new URL(uri,base).href);
    }
  }
  return {variants,segments,assets,audio,live:!/#EXT-X-ENDLIST|#EXT-X-PLAYLIST-TYPE:VOD/.test(text),
    sequence:Number(text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1])||0,
    duration:Number(text.match(/#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/)?.[1])||6};
}
export async function validate(item,origin,{progress=false,depth=0}={}) {
  if(depth>2)throw new AppError('DIRECT_BLOCKED',422);
  const start=Date.now(); let castEligible=true, quality=0;
  let url=item.url;
  if(new URL(url).protocol!=='https:') throw new AppError('DIRECT_BLOCKED',422);
  const headers={Origin:origin};
  if(!item.isHls) {
    const response=await fetchLimited(url,{headers:{...headers,Range:'bytes=0-65535'},limit:65536,partial:true});
    castEligible=cors(response,origin);
    if(!/^video\/(mp4|webm|quicktime)/i.test(response.headers.get('content-type')||'') || response.body.length<64) throw new AppError('NO_MEDIA',422);
    return {...item,mediaUrl:url,live:false,castEligible,quality,startupMs:Date.now()-start,verifiedAt:Date.now(),expiresAt:Date.now()+90000};
  }
  let playlist, audioTrack=null;
  const originalUrl=url;
  for(let level=0;level<4;level++) {
    const response=await fetchLimited(url,{headers,limit:512000});
    castEligible=cors(response,origin)&&castEligible;
    playlist=parsePlaylist(response.body.toString(),response.url);
    if(playlist.audio.length)audioTrack=playlist.audio.find(a=>a.preferred)||playlist.audio[0];
    if(!playlist.variants.length) {url=response.url;break;}
    const sorted=playlist.variants.sort((a,b)=>Math.abs((a.height||720)-720)-Math.abs((b.height||720)-720));
    quality=sorted[0].height;url=sorted[0].url;playlist=null;
  }
  if(!playlist?.segments.length) throw new AppError('NO_MEDIA',422);
  // A bounded sample, never a full stream relay. Also check keys and init fragments.
  for(const asset of [...new Set(playlist.assets)].slice(0,4).concat(playlist.segments.slice(-1))) {
    const response=await fetchLimited(asset,{headers:{...headers,Range:'bytes=0-65535'},limit:65536,partial:true});
    castEligible=cors(response,origin)&&castEligible;
    if(!response.body.length || /text\/html|application\/json/i.test(response.headers.get('content-type')||'')) throw new AppError('NO_MEDIA',422);
  }
  if(progress && playlist.live) {
    if(playlist.duration>20) throw new AppError('SOURCE_UNAVAILABLE',422);
    await delay(Math.max(1000,playlist.duration*1100));
    const response=await fetchLimited(url,{headers,limit:512000});
    castEligible=cors(response,origin)&&castEligible;
    const next=parsePlaylist(response.body.toString(),response.url);
    if(next.sequence<=playlist.sequence && next.segments.at(-1)===playlist.segments.at(-1)) throw new AppError('SOURCE_FROZEN',422);
  }
  if(audioTrack){const audio=await validate({url:audioTrack.url,isHls:true},origin,{depth:depth+1});castEligible=audio.castEligible&&castEligible;}
  // Preserve the master when a separate audio rendition is required.
  return {mediaUrl:audioTrack?originalUrl:url,isHls:true,contentType:'application/vnd.apple.mpegurl',live:playlist.live,
    segmentDuration:playlist.duration,castEligible,quality,startupMs:Date.now()-start,
    verifiedAt:Date.now(),expiresAt:Date.now()+90000};
}

export async function quickValidate(item,{depth=0}={}) {
  if(depth>2) throw new AppError('NO_MEDIA',422);
  const start=Date.now();
  let url=item.mediaUrl||item.url;
  if(!url || new URL(url).protocol!=='https:') throw new AppError('DIRECT_BLOCKED',422);
  if(!(item.isHls||HLS.test(url))){
    const response=await fetchLimited(url,{headers:{Range:'bytes=0-4095'},limit:4096,partial:true});
    const type=response.headers.get('content-type')||'';
    if(response.body.length<64 || /text\/html|application\/json/i.test(type)) throw new AppError('NO_MEDIA',422);
    return {...item,mediaUrl:response.url,isHls:false,live:false,castEligible:true,provisional:false,startupMs:Date.now()-start,verifiedAt:Date.now(),expiresAt:Date.now()+90000};
  }
  let playlist=null,quality=item.quality||0,original=url;
  for(let level=0;level<3;level++){
    const response=await fetchLimited(url,{limit:384000});
    playlist=parsePlaylist(response.body.toString(),response.url);
    if(!playlist.variants.length){url=response.url;break;}
    const sorted=playlist.variants.sort((a,b)=>Math.abs((a.height||720)-720)-Math.abs((b.height||720)-720));
    quality=sorted[0].height||quality;url=sorted[0].url;playlist=null;
  }
  if(!playlist?.segments.length) throw new AppError('NO_MEDIA',422);
  const segment=playlist.segments.at(-1);
  const response=await fetchLimited(segment,{headers:{Range:'bytes=0-4095'},limit:4096,partial:true});
  if(!response.body.length || /text\/html|application\/json/i.test(response.headers.get('content-type')||'')) throw new AppError('NO_MEDIA',422);
  return {...item,mediaUrl:original,isHls:true,live:playlist.live,segmentDuration:playlist.duration,quality,castEligible:true,provisional:false,startupMs:Date.now()-start,verifiedAt:Date.now(),expiresAt:Date.now()+90000};
}

export function provisionalCandidate(item,sourceUrl=''){
  const mediaUrl=item?.url||item?.mediaUrl;
  if(!mediaUrl)return null;
  try{if(new URL(mediaUrl).protocol!=='https:')return null;}catch{return null;}
  return {
    ...item,mediaUrl,isHls:Boolean(item.isHls||HLS.test(mediaUrl)),castEligible:false,provisional:true,
    startupMs:0,verifiedAt:0,expiresAt:Date.now()+30000,
    id:crypto.createHash('sha256').update(mediaUrl).digest('hex').slice(0,16),sourceUrl:sourceUrl||mediaUrl
  };
}
export function clearResolved(url,origin) {for(const key of cache.keys()) if(key.startsWith(`${origin}|${url}|`)) cache.delete(key);}
export async function resolve(url,origin,{progress=false}={}) {
  url=(await safeURL(url)).href;
  const key=`${origin}|${url}|${progress}`;
  const old=cache.get(key);
  if(old && old.expiresAt>Date.now()) return old.value;
  if(inflight.has(key)) return inflight.get(key);
  const job=(async()=>{
    const extracted=await extract(url);
    if(!extracted.length)throw new AppError('NO_MEDIA',422);
    // Browser playback is the compatibility test. Do not reject a discovered
    // media URL just because a server-side CORS probe cannot approve it first.
    const candidates=[...new Map(extracted.map(item=>{
      const candidate=provisionalCandidate(item,url);return candidate?[candidate.mediaUrl,candidate]:null;
    }).filter(Boolean)).values()];
    if(!candidates.length)throw new AppError('DIRECT_BLOCKED',422);
    const value={sourceUrl:url,candidates};
    cache.set(key,{expiresAt:Date.now()+30000,value});
    if(cache.size>100) cache.delete(cache.keys().next().value);
    return value;
  })().finally(()=>inflight.delete(key));
  inflight.set(key,job);return job;
}
