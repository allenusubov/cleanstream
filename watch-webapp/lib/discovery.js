import fs from 'node:fs';
import crypto from 'node:crypto';
import {normalize,matchesParticipants} from '../public/events.js';
import {withPage,visit,resolve,validate} from './resolver.js';
import {AppError,WorkPool,fetchLimited} from './network.js';
import {streamedPages} from './catalog.js';
import {directoryLinks} from './directory.js';
import {CATEGORY_ALIASES} from './source-profile.js';

const registry=JSON.parse(process.env.SOURCE_REGISTRY_JSON || fs.readFileSync(new URL('../sources.json',import.meta.url),'utf8'));
const jobs=new Map(), history=new Map(), indexes=new Map(), indexJobs=new Map(), mirrorCache=new Map(), mirrorJobs=new Map();
const pool=new WorkPool(2,12,120);
const idFor=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,16);
const MEDIA=/\.(m3u8|mp4|m4v|mov|webm)(?:$|\?)/i;
const HLS=/\.m3u8(?:$|\?)/i;
const MIRROR_WORDS=/\b(stream|mirror|server|feed|source|player|english|spanish|espanol|alt|backup|hd|sd)\b|#\s*\d+/i;

function hostAllowed(host,allowedHosts=[]) {
  return !allowedHosts.length || allowedHosts.some(allowed=>host===allowed || host.endsWith(`.${allowed}`));
}
function cleanUrl(value,base) {
  try {
    const url=new URL(value,base);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
    return url.href;
  } catch { return null; }
}
function eventQuery(event) {
  return event.participants?.length ? event.participants.map(p=>p.name).join(' vs ') : event.title;
}
function fillTemplate(template,event) {
  const league=String(event.league||event.sport||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const sport=String(event.sport||event.league||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  return template.replaceAll('{league}',league).replaceAll('{sport}',sport).replaceAll('{query}',encodeURIComponent(eventQuery(event)));
}
function configuredUrls(site,value,event,base) {
  const items=Array.isArray(value)?value:value?[value]:[];
  return items.map(item=>cleanUrl(fillTemplate(String(item),event),base)).filter(Boolean);
}
function rootsFor(site,event) {
  return [...new Set([...(site.eventListUrls||[]),...(site.indexUrls||[]),...(site.indexUrl?[site.indexUrl]:[]),...(site.searchUrls||[])]
    .map(template=>cleanUrl(fillTemplate(template,event))).filter(Boolean))];
}
function categoryTerms(site,event) {
  const key=String(event.league||event.sport||'').toUpperCase();
  const explicit=site.categoryAliases?.[key]||site.categoryAliases?.[String(event.sport||'').toUpperCase()]||[];
  const terms=[key,String(event.sport||''),...(CATEGORY_ALIASES[key]||[]),...(Array.isArray(explicit)?explicit:[explicit])];
  return [...new Set(terms.map(normalize).filter(term=>term.length>=2))];
}
export function linkMatchesCategory(link,site,event) {
  try {
    const url=new URL(link.url);
    const text=normalize(`${link.text||''} ${decodeURIComponent(url.pathname)} ${decodeURIComponent(url.search)} ${decodeURIComponent(url.hash)}`);
    return categoryTerms(site,event).some(term=>` ${text} `.includes(` ${term} `));
  } catch { return false; }
}
export function linkMatchesEvent(link,event) {
  try {
    const url=new URL(link.url);
    const slug=decodeURIComponent(`${url.pathname} ${url.search}`).replace(/[-_+]+/g,' ');
    const haystack=normalize(`${link.text||''} ${slug}`);
    const participants=event.participants||[];
    if(participants.length>=2)return matchesParticipants(haystack,participants);
    const words=normalize(event.title||'').split(' ').filter(word=>word.length>=3);
    return words.length>0 && words.filter(word=>haystack.includes(word)).length>=Math.min(2,words.length);
  } catch { return false; }
}
function likelyMirror(text,url,site) {
  const configured=site.mirrorTextPattern;
  let custom=false;
  if(configured)try{custom=new RegExp(configured,'i').test(`${text} ${url}`);}catch{}
  return custom||MIRROR_WORDS.test(`${text} ${url}`);
}
async function readIndex(site,indexUrl,event) {
  const cacheKey=`${site.id}|${indexUrl}`;
  const old=indexes.get(cacheKey);
  if(old && Date.now()-old.time<120000) return old.links;
  if(indexJobs.has(cacheKey)) return indexJobs.get(cacheKey);
  const job=(async()=>{
    let staticLinks=[], staticError=null;
    try {
      const response=await fetchLimited(indexUrl,{limit:2*1024*1024});
      staticLinks=directoryLinks(response.body.toString(),response.url,site.allowedHosts,site.custom?1500:600);
      const fragmentRoute=Boolean(new URL(indexUrl).hash);
      // Hash routes (for example /#nfl) are client-side navigation. A normal HTTP
      // fetch only sees the root document, so it cannot prove the selected
      // category is loaded; dynamic sources must visit the fragment in-browser.
      if(!site.dynamic || (!fragmentRoute && staticLinks.some(link=>linkMatchesEvent(link,event)||linkMatchesCategory(link,site,event)))) {
        indexes.set(cacheKey,{time:Date.now(),links:staticLinks});
        return staticLinks;
      }
    } catch(error) { staticError=error; }
    if(!site.dynamic) {
      if(staticError) throw staticError;
      indexes.set(cacheKey,{time:Date.now(),links:staticLinks});
      return staticLinks;
    }
    try {
      const dynamicLinks=await withPage(async page=>{
        await visit(page,indexUrl);
        if(site.waitSelector)await page.locator(site.waitSelector).first().waitFor({timeout:5000}).catch(()=>{});
        const links=await page.locator('a[href],[data-href],[data-url],[onclick]').evaluateAll((nodes,max)=>nodes.slice(0,max).flatMap(node=>{
          let raw=node.href||node.getAttribute('data-href')||node.getAttribute('data-url')||'';
          if(!raw){
            const code=node.getAttribute('onclick')||'';
            raw=code.match(/(?:location(?:\.href)?\s*=|open\s*\()\s*['\"]([^'\"]+)['\"]/i)?.[1]||'';
          }
          if(!raw)return [];
          try{const u=new URL(raw,document.baseURI);if(!/^https?:$/.test(u.protocol))return [];return [{url:u.href,text:node.getAttribute('aria-label')||node.textContent?.trim()||node.getAttribute('title')||''}];}
          catch{return [];}
        }),site.custom?2200:1000);
        return links.filter(link=>{try{const u=new URL(link.url);return ['http:','https:'].includes(u.protocol)&&hostAllowed(u.hostname,site.allowedHosts);}catch{return false;}});
      });
      const merged=[...new Map([...staticLinks,...dynamicLinks].map(link=>[link.url,link])).values()];
      indexes.set(cacheKey,{time:Date.now(),links:merged});
      return merged;
    } catch(error) {
      if(staticLinks.length) return staticLinks;
      throw staticError||error;
    }
  })().finally(()=>indexJobs.delete(cacheKey));
  indexJobs.set(cacheKey,job);return job;
}

// Resolve the site's own SITE -> CATEGORY step first. Explicit category URLs are
// supported, but ordinary navigation links such as "NFL", "NBA" or "Tennis"
// are discovered automatically and cached. If no category is found we fall back
// to the site's bounded root/search pages rather than crawling arbitrary pages.
export async function categoryPages(site,event) {
  const roots=rootsFor(site,event);
  const key=String(event.league||event.sport||'').toUpperCase();
  const configured=site.categories?.[key]??site.categories?.[String(event.sport||'').toUpperCase()]??site.categories?.['*'];
  const explicit=configuredUrls(site,configured,event,roots[0]);
  if(explicit.length)return [...new Set(explicit)].slice(0,site.custom?10:4);
  const found=[];
  for(const root of roots.slice(0,site.custom?10:4)) {
    try {
      const links=await readIndex(site,root,event);
      for(const link of links)if(linkMatchesCategory(link,site,event))found.push(link.url);
      if(found.length>=(site.custom?10:4))break;
    } catch { /* Try the next configured root. */ }
  }
  return [...new Set(found)].slice(0,site.custom?10:4);
}

async function genericPages(site,event) {
  const roots=rootsFor(site,event);
  const categories=await categoryPages(site,event);
  // Category pages are the fast path. Search URLs and roots are bounded fallbacks
  // for sites that list events directly on the homepage or expose a search page.
  const urls=[...new Set([...categories,...roots])];
  const found=[];
  for(const indexUrl of urls) {
    try {
      const links=await readIndex(site,indexUrl,event);
      for(const link of links) if(linkMatchesEvent(link,event)) found.push(link);
      if(found.length>=(site.custom?18:8)) break;
    } catch { /* Try the next bounded category/index/search page. */ }
  }
  return [...new Map(found.map(page=>[page.url,page])).values()].slice(0,site.custom?18:8);
}

function targetKey(target) {return `${target.kind||'page'}|${target.url}`;}
function addTarget(targets,target,base) {
  const url=cleanUrl(target.url,base);if(!url)return;
  const key=targetKey({...target,url});
  if(targets.has(key))return;
  targets.set(key,{...target,url});
}

// Resolve EVENT -> MIRRORS. The event page itself is mirror 1. Then discover
// separate mirror/server/feed links, iframe players and media URLs revealed by
// bounded tab/button interactions. Each distinct mirror is later validated and
// returned as an independent source result, while keeping the same site name.
export async function mirrorTargets(site,page,event) {
  const cacheKey=`${site.id}|${page.url}`;
  const old=mirrorCache.get(cacheKey);
  if(old && Date.now()-old.time<60000)return old.targets;
  if(mirrorJobs.has(cacheKey))return mirrorJobs.get(cacheKey);
  const job=(async()=>{
    const targets=new Map();
    addTarget(targets,{kind:'page',url:page.url,text:'DEFAULT'},page.url);
    if(site.mirrors===false)return [...targets.values()];
    try {
      await withPage(async browserPage=>{
        const media=new Map();
        const rememberMedia=(url,type='')=>{
          if(!url||!/^(https?:)/i.test(url)||/doubleclick|\/ads?\/|preroll|analytics/i.test(url))return;
          if(MEDIA.test(url)||/mpegurl|^video\/(mp4|webm)/i.test(type))media.set(url,{kind:'media',url,text:'MEDIA',isHls:HLS.test(url)||/mpegurl/i.test(type)});
        };
        browserPage.on('request',request=>rememberMedia(request.url()));
        browserPage.on('response',async response=>{try{rememberMedia(response.url(),(await response.allHeaders())['content-type']||'');}catch{}});
        await visit(browserPage,page.url);

        const collect=async label=>{
          for(const frame of browserPage.frames()) {
            if(frame===browserPage.mainFrame())continue;
            const url=cleanUrl(frame.url(),page.url);if(url)addTarget(targets,{kind:'page',url,text:label||'FRAME'},page.url);
          }
          const frames=await browserPage.locator('iframe[src]').evaluateAll(nodes=>nodes.slice(0,30).map(node=>({url:node.src,text:node.title||node.getAttribute('aria-label')||''}))).catch(()=>[]);
          for(const frame of frames)addTarget(targets,{kind:'page',url:frame.url,text:frame.text||label||'FRAME'},page.url);
          for(const item of media.values())addTarget(targets,{...item,text:label||item.text},page.url);
        };
        await collect('DEFAULT');

        const selector=site.mirrorSelector||'a[href],button,[role="tab"],[role="button"],input[type="button"]';
        const controls=browserPage.locator(selector);
        const items=await controls.evaluateAll(nodes=>nodes.slice(0,120).map((node,index)=>({
          index,
          tag:node.tagName,
          href:node.href||'',
          text:(node.getAttribute('aria-label')||node.textContent||node.value||'').replace(/\s+/g,' ').trim()
        }))).catch(()=>[]);
        const candidates=items.filter(item=>likelyMirror(item.text,item.href,site)).slice(0,Number(site.maxMirrors)||10);
        for(const item of candidates) {
          if(item.href) {
            addTarget(targets,{kind:'page',url:item.href,text:item.text||'MIRROR'},page.url);
            continue;
          }
          try {
            const before=new Set(media.keys());
            await controls.nth(item.index).click({timeout:1000,force:true});
            await browserPage.waitForTimeout(Number(site.mirrorSettleMs)||500);
            await collect(item.text||'MIRROR');
            // Preserve only newly revealed media as separately labelled mirrors too.
            for(const [url,target] of media)if(!before.has(url))addTarget(targets,{...target,text:item.text||'MIRROR'},page.url);
          } catch { /* A broken mirror control must not block other mirrors. */ }
        }
      });
    } catch { /* The event page itself can still be resolved as the default mirror. */ }
    const result=[...targets.values()].slice(0,Number(site.maxMirrors)||10);
    mirrorCache.set(cacheKey,{time:Date.now(),targets:result});
    return result;
  })().finally(()=>mirrorJobs.delete(cacheKey));
  mirrorJobs.set(cacheKey,job);return job;
}

function displayName(site,pageUrl='') {
  let host=site.displayHost||'';
  if(!host && site.type==='streamed')host='streamed.pk';
  if(!host) {
    const seed=site.indexUrls?.[0]||site.indexUrl||pageUrl;
    try{host=new URL(seed).hostname;}catch{}
  }
  host=host.replace(/^www\./i,'');
  return (host||site.name||'SOURCE').toUpperCase();
}
export function rank(sources) {
  return [...sources].sort((a,b)=>b.score-a.score).map((s,i)=>({...s,recommended:i===0}));
}
export function watchable(event,now=Date.now()) {
  const start=Date.parse(event.startTime);
  return event.status!=='finished' && start<=now+45*60000 && start>now-6*3600000;
}
export function siteSupportsEvent(site,event) {
  // Source adapters are general by default. A registry entry is only sport-gated
  // when it explicitly opts into restriction with restrictLeagues=true.
  if(site?.restrictLeagues!==true)return true;
  const leagues=Array.isArray(site?.leagues)?site.leagues.map(value=>String(value).toUpperCase()):[];
  const eventKeys=[event?.league,event?.sport].map(value=>String(value||'').toUpperCase()).filter(Boolean);
  return leagues.includes('*')||eventKeys.some(key=>leagues.includes(key));
}
async function fastCandidates(target,origin) {
  if(target.kind==='media') {
    const item=await validate({url:target.url,isHls:Boolean(target.isHls||HLS.test(target.url))},origin,{progress:false});
    return [{...item,sourceUrl:target.parentUrl||target.url}];
  }
  const result=await resolve(target.url,origin,{progress:false});
  return result.candidates.filter(candidate=>candidate.live).map(candidate=>({...candidate,sourceUrl:target.url}));
}
export function eventJob(event,origin,customSites=[]) {
  if(!watchable(event)) throw new AppError('NOT_STARTED',409);
  const customKey=idFor(customSites.map(site=>JSON.stringify({
    root:site.indexUrls?.[0]||site.id,
    categories:site.categories||{},
    eventListUrls:site.eventListUrls||[]
  })).sort().join('|'));
  const key=`${origin}|${event.id}|${customKey}`;
  const old=jobs.get(key);
  if(old && (!old.done || old.expiresAt>Date.now())) return old;
  const job={sources:[],done:false,status:'CHECKING',expiresAt:0,listeners:new Set(),started:false};
  job.snapshot=()=>({type:'update',eventId:event.id,sources:rank(job.sources),done:job.done,status:job.status});
  job.publish=()=>{for(const listener of job.listeners) listener(job.snapshot());};
  job.start=()=>{
    if(job.started) return;job.started=true;
    job.promise=pool.run(async()=>{
      const merged=[...customSites,...registry];
      const byHost=new Map();
      for(const site of merged){
        if(!site?.enabled)continue;
        const root=site.displayHost||site.indexUrls?.[0]||site.indexUrl||site.id;
        let identity=String(root||site.id);
        try{identity=new URL(identity).hostname.replace(/^www\./i,'');}catch{}
        if(!byHost.has(identity))byHost.set(identity,site);
      }
      const sites=[...byHost.values()].filter(s=>(s.type==='streamed'||s.custom||event.participants?.length>=2) && siteSupportsEvent(s,event)).slice(0,24);
      let matched=0, unavailable=0;
      await Promise.allSettled(sites.map(async site=>{
        const statsKey=`${site.id}|${event.league}`;
        const stats=history.get(statsKey)||{success:0,attempts:0,totalMs:0};
        try {
          const pages=site.events?.[event.id] ? [{url:site.events[event.id],text:event.title}] : site.type==='streamed'?await streamedPages(event):await genericPages(site,event);
          const uniquePages=[...new Map(pages.map(p=>[p.url,p])).values()].slice(0,site.custom?12:6);
          matched+=uniquePages.length;
          if(!uniquePages.length)return;
          const mirrorLists=await Promise.allSettled(uniquePages.map(page=>mirrorTargets(site,page,event)));
          const targets=[];
          for(let i=0;i<mirrorLists.length;i++)if(mirrorLists[i].status==='fulfilled'){
            for(const target of mirrorLists[i].value)targets.push({...target,parentUrl:uniquePages[i].url});
          }
          const uniqueTargets=[...new Map(targets.map(target=>[targetKey(target),target])).values()].slice(0,Math.max(4,Number(site.maxMirrors)||10));
          await Promise.allSettled(uniqueTargets.map(async target=>{
            stats.attempts++;
            try {
              const candidates=(await fastCandidates(target,origin)).sort((a,b)=>a.startupMs-b.startupMs).slice(0,4);
              if(!candidates.length)throw new AppError('SOURCE_NOT_LIVE',422);
              for(const media of candidates) {
                stats.success++;stats.totalMs+=media.startupMs;
                const reliability=stats.success/stats.attempts;
                const score=100+reliability*20-Math.min(media.startupMs/1000,25)+Math.min(media.quality/1080,1)*5;
                const source={...media,id:idFor(`${event.id}|${site.id}|${target.url}|${media.mediaUrl}`),siteId:site.id,name:site.name,
                  displayName:displayName(site,target.parentUrl||target.url),score,eventId:event.id,deepVerified:!media.isHls,
                  mirrorLabel:target.text||'',sourceUrl:target.kind==='page'?target.url:(target.parentUrl||media.sourceUrl)};
                const duplicate=job.sources.some(s=>s.siteId===source.siteId&&s.mediaUrl===source.mediaUrl);
                if(duplicate)continue;
                job.sources.push(source);job.publish();

                // Deeper live-progression verification happens after publication. A
                // mirror appears as soon as one real direct media segment works.
                if(media.isHls && media.live) {
                  try {
                    const deep=await validate({url:media.mediaUrl,isHls:true},origin,{progress:true});
                    Object.assign(source,{segmentDuration:deep.segmentDuration,quality:deep.quality||source.quality,
                      deepVerified:true,verifiedAt:deep.verifiedAt,expiresAt:deep.expiresAt});
                    source.score+=4;job.publish();
                  } catch {
                    const index=job.sources.indexOf(source);
                    if(index>=0)job.sources.splice(index,1);
                    job.publish();
                  }
                }
              }
            } catch { /* A rejected mirror remains unavailable. */ }
          }));
        } catch {unavailable++;}
        finally {history.set(statsKey,stats);}
      }));
      job.status=job.sources.length?'READY':unavailable===sites.length && sites.length?'SOURCES_UNAVAILABLE':matched?'NO_WORKING_SOURCES':'NO_MATCHING_SOURCES';
    }).catch(error=>{job.status=error.code||'SOURCES_UNAVAILABLE';}).finally(()=>{
      job.done=true;job.expiresAt=Date.now()+(job.sources.length?60000:30000);job.publish();
      if(jobs.size>100) for(const [k,v] of jobs) if(v.done && v.expiresAt<Date.now()) jobs.delete(k);
    });
  };
  jobs.set(key,job);return job;
}
