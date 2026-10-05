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
const pool=new WorkPool(2);
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
// preferred. Light discovery stops at the first useful route; deep discovery
// follows every mapped/discovered route while the lower-level network/browser
// timeouts keep broken pages bounded.
export async function categoryPages(site,event,{light=false}={}) {
  const roots=rootsFor(site,event);
  const key=String(event.league||event.sport||'').toUpperCase();
  const configured=site.categories?.[key]??site.categories?.[String(event.sport||'').toUpperCase()]??site.categories?.['*'];
  const explicit=[...new Set(configuredUrls(site,configured,event,roots[0]))];
  if(explicit.length)return light?explicit.slice(0,1):explicit;
  const found=[];
  for(const root of roots) {
    try {
      const links=await readIndex(site,root,event);
      for(const link of links)if(linkMatchesCategory(link,site,event)){
        found.push(link.url);
        if(light)return [link.url];
      }
    } catch { /* Try the next configured root. */ }
  }
  return [...new Set(found)];
}

async function genericPages(site,event,{light=false}={}) {
  const roots=rootsFor(site,event);
  const categories=await categoryPages(site,event,{light});
  const urls=[...new Set([...categories,...roots])];
  const found=[];
  for(const indexUrl of urls) {
    try {
      const links=await readIndex(site,indexUrl,event);
      for(const link of links) if(linkMatchesEvent(link,event)) {
        found.push(link);
        if(light)return [link];
      }
    } catch { /* Try the next category/index/search page. */ }
  }
  return [...new Map(found.map(page=>[page.url,page])).values()];
}

function targetKey(target) {return `${target.kind||'page'}|${target.url}`;}
function addTarget(targets,target,base) {
  const url=cleanUrl(target.url,base);if(!url)return;
  const key=targetKey({...target,url});
  if(targets.has(key))return;
  targets.set(key,{...target,url});
}

// Resolve EVENT -> MIRRORS. Light mode intentionally checks only the default
// event page. Deep mode enumerates the event page, frames, media and mirror
// controls so expanding an event can reveal the complete ordered source list.
export async function mirrorTargets(site,page,event,{light=false}={}) {
  if(light)return [{kind:'page',url:page.url,text:'DEFAULT'}];
  const cacheKey=`deep|${site.id}|${page.url}`;
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
          const frames=await browserPage.locator('iframe[src]').evaluateAll(nodes=>nodes.slice(0,60).map(node=>({url:node.src,text:node.title||node.getAttribute('aria-label')||''}))).catch(()=>[]);
          for(const frame of frames)addTarget(targets,{kind:'page',url:frame.url,text:frame.text||label||'FRAME'},page.url);
          for(const item of media.values())addTarget(targets,{...item,text:label||item.text},page.url);
        };
        await collect('DEFAULT');

        const selector=site.mirrorSelector||'a[href],button,[role="tab"],[role="button"],input[type="button"]';
        const controls=browserPage.locator(selector);
        const items=await controls.evaluateAll(nodes=>nodes.slice(0,240).map((node,index)=>({
          index,
          tag:node.tagName,
          href:node.href||'',
          text:(node.getAttribute('aria-label')||node.textContent||node.value||'').replace(/\s+/g,' ').trim()
        }))).catch(()=>[]);
        const candidates=items.filter(item=>likelyMirror(item.text,item.href,site));
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
            for(const [url,target] of media)if(!before.has(url))addTarget(targets,{...target,text:item.text||'MIRROR'},page.url);
          } catch { /* A broken mirror control must not block other mirrors. */ }
        }
      });
    } catch { /* The event page itself can still be resolved as the default mirror. */ }
    const result=[...targets.values()];
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
export function watchable(event) {
  return Boolean(event) && event.status!=='finished';
}
export function siteSupportsEvent(site,event) {
  // Explicit adapter restrictions are preserved. Custom/general adapters are not
  // sport-gated simply because only one category route happens to be known.
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
export function eventJob(event,origin,customSites=[],{mode='deep'}={}) {
  if(!watchable(event)) throw new AppError('EVENT_UNAVAILABLE',409);
  const light=mode==='light';
  const customKey=idFor(customSites.map(site=>JSON.stringify({
    root:site.indexUrls?.[0]||site.id,
    categories:site.categories||{},
    eventListUrls:site.eventListUrls||[]
  })).sort().join('|'));
  const baseKey=`${origin}|${event.id}|${customKey}`;
  const key=`${baseKey}|${light?'light':'deep'}`;
  const old=jobs.get(key);
  if(old && (!old.done || old.expiresAt>Date.now())) return old;
  const seed=!light?jobs.get(`${baseKey}|light`)?.sources||[]:[];
  const job={sources:seed.map(source=>({...source})),done:false,status:'CHECKING',expiresAt:0,listeners:new Set(),started:false,mode:light?'light':'deep'};
  job.snapshot=()=>({type:'update',eventId:event.id,sources:rank(job.sources),done:job.done,status:job.status,mode:job.mode});
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
      const sites=[...byHost.values()].filter(s=>(s.type==='streamed'||s.custom||event.participants?.length>=2) && siteSupportsEvent(s,event));
      let matched=0, unavailable=0;
      await Promise.allSettled(sites.map(async site=>{
        const statsKey=`${site.id}|${event.league}`;
        const stats=history.get(statsKey)||{success:0,attempts:0,totalMs:0};
        try {
          const pages=site.events?.[event.id] ? [{url:site.events[event.id],text:event.title}] : site.type==='streamed'?await streamedPages(event):await genericPages(site,event,{light});
          const uniquePages=[...new Map(pages.map(p=>[p.url,p])).values()];
          const pagesToCheck=light?uniquePages.slice(0,1):uniquePages;
          matched+=pagesToCheck.length;
          if(!pagesToCheck.length)return;
          const mirrorLists=await Promise.allSettled(pagesToCheck.map(page=>mirrorTargets(site,page,event,{light})));
          const targets=[];
          for(let i=0;i<mirrorLists.length;i++)if(mirrorLists[i].status==='fulfilled'){
            for(const target of mirrorLists[i].value)targets.push({...target,parentUrl:pagesToCheck[i].url});
          }
          const uniqueTargets=[...new Map(targets.map(target=>[targetKey(target),target])).values()];
          const targetsToCheck=light?uniqueTargets.slice(0,1):uniqueTargets;
          await Promise.allSettled(targetsToCheck.map(async target=>{
            stats.attempts++;
            try {
              const candidates=(await fastCandidates(target,origin)).sort((a,b)=>a.startupMs-b.startupMs);
              if(!candidates.length)throw new AppError('SOURCE_NOT_LIVE',422);
              for(const media of candidates) {
                stats.success++;stats.totalMs+=media.startupMs;
                const reliability=stats.success/stats.attempts;
                const score=100+reliability*20-Math.min(media.startupMs/1000,25)+Math.min(media.quality/1080,1)*5;
                const source={...media,id:idFor(`${event.id}|${site.id}|${target.url}|${media.mediaUrl}`),siteId:site.id,name:site.name,
                  displayName:displayName(site,target.parentUrl||target.url),score,eventId:event.id,deepVerified:!media.isHls,
                  mirrorLabel:target.text||'',sourceUrl:target.kind==='page'?target.url:(target.parentUrl||media.sourceUrl)};
                let activeSource=job.sources.find(s=>s.id===source.id);
                if(!activeSource){activeSource=source;job.sources.push(activeSource);job.publish();}

                if(!light && media.isHls && media.live && !activeSource.deepVerified) {
                  try {
                    const deep=await validate({url:media.mediaUrl,isHls:true},origin,{progress:true});
                    Object.assign(activeSource,{segmentDuration:deep.segmentDuration,quality:deep.quality||activeSource.quality,
                      deepVerified:true,verifiedAt:deep.verifiedAt,expiresAt:deep.expiresAt});
                    activeSource.score+=4;job.publish();
                  } catch {
                    const index=job.sources.indexOf(activeSource);
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
      if(jobs.size>300) for(const [k,v] of jobs) if(v.done && v.expiresAt<Date.now()) jobs.delete(k);
    });
  };
  jobs.set(key,job);return job;
}
