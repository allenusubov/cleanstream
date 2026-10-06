import fs from 'node:fs';
import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {normalize,matchesParticipants} from '../public/events.js';
import {withPage,visit,resolve,validate,quickValidate} from './resolver.js';
import {AppError,WorkPool,fetchLimited} from './network.js';
import {streamedPages} from './catalog.js';
import {directoryLinks} from './directory.js';
import {CATEGORY_ALIASES} from './source-profile.js';

const registry=JSON.parse(process.env.SOURCE_REGISTRY_JSON || fs.readFileSync(new URL('../sources.json',import.meta.url),'utf8'));
const jobs=new Map(), history=new Map(), indexes=new Map(), indexJobs=new Map(), mirrorCache=new Map(), mirrorJobs=new Map(), routeHistory=new Map(), mirrorHistory=new Map(), eventPageHistory=new Map();
const pool=new WorkPool(Math.max(1,Math.min(4,Number(process.env.EVENT_JOB_CONCURRENCY)||2)));
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
        if(site.waitSelector)await page.locator(site.waitSelector).first().waitFor({timeout:1200}).catch(()=>{});
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

function structurePriority(site,link){
  try{
    const url=new URL(link.url);let score=0;
    for(const prefix of site?.structure?.eventPrefixes||[])if(prefix==='/'||url.pathname.startsWith(prefix))score+=12;
    for(const host of site?.structure?.eventHosts||[])if(url.hostname===host||url.hostname.endsWith(`.${host}`))score+=8;
    return score;
  }catch{return 0;}
}

async function genericPages(site,event,{light=false}={}) {
  const roots=rootsFor(site,event);
  const categories=await categoryPages(site,event,{light});
  const routeKey=`${site.id}|${String(event.league||event.sport||'').toUpperCase()}`;
  const learned=routeHistory.get(routeKey);
  const urls=[...new Set([...(learned?[learned]:[]),...categories,...roots])];
  const found=[];
  const shortcut=eventPageHistory.get(`${site.id}|${event.id}`);
  if(shortcut&&Date.now()-shortcut.time<8*60*60*1000){found.push({url:shortcut.url,text:event.title,shortcut:true});if(light)return found;}
  for(const indexUrl of urls) {
    try {
      const links=await readIndex(site,indexUrl,event);
      const ordered=[...links].sort((a,b)=>structurePriority(site,b)-structurePriority(site,a));
      for(const link of ordered) if(linkMatchesEvent(link,event)) {
        found.push(link);
        routeHistory.set(routeKey,indexUrl);
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
        const historyKey=`${site.id}|${String(event.league||event.sport||'').toUpperCase()}`;
        const preferred=new Set([...(site.structure?.mirrorLabels||[]),...(mirrorHistory.get(historyKey)||[])]);
        const candidates=items.filter(item=>likelyMirror(item.text,item.href,site)).sort((a,b)=>Number(preferred.has(b.text))-Number(preferred.has(a.text)));
        for(const item of candidates) {
          if(item.href) {
            addTarget(targets,{kind:'page',url:item.href,text:item.text||'MIRROR'},page.url);
            continue;
          }
          try {
            const before=new Set(media.keys());
            await controls.nth(item.index).click({timeout:1000,force:true});
            await browserPage.waitForTimeout(Number(site.mirrorSettleMs)||250);
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
  const ordered=[...sources].sort((a,b)=>{
    const readyDiff=Number(Boolean(b.mediaUrl))-Number(Boolean(a.mediaUrl));
    if(readyDiff)return readyDiff;
    return (b.score||0)-(a.score||0);
  });
  const hasReady=ordered.some(source=>Boolean(source.mediaUrl)&&!source.unavailable);
  let recommendedAssigned=false;
  return ordered.map(source=>{
    const ready=Boolean(source.mediaUrl)&&!source.unavailable;
    const recommended=!recommendedAssigned && (hasReady?ready:true);
    if(recommended)recommendedAssigned=true;
    return {...source,recommended};
  });
}
export function watchable(event) {
  return Boolean(event) && event.status!=='finished';
}
export function siteSupportsEvent(site,event) {
  // Explicit adapter restrictions stay explicit. Custom/general adapters are not
  // sport-gated merely because only one route has been learned.
  if(site?.restrictLeagues!==true)return true;
  const leagues=Array.isArray(site?.leagues)?site.leagues.map(value=>String(value).toUpperCase()):[];
  const eventKeys=[event?.league,event?.sport].map(value=>String(value||'').toUpperCase()).filter(Boolean);
  return leagues.includes('*')||eventKeys.some(key=>leagues.includes(key));
}
async function fastCandidates(target,origin) {
  // Surface discovered direct media immediately; actual device playback is the
  // final compatibility test.
  const result=await resolve(target.url,origin,{progress:false});
  const checks=await Promise.allSettled(result.candidates.slice(0,8).map(candidate=>quickValidate(candidate)));
  return checks.filter(item=>item.status==='fulfilled').map(item=>({...item.value,sourceUrl:target.parentUrl||target.url}));
}
function siteStats(site,event){
  const key=`${site.id}|${String(event.league||event.sport||'').toUpperCase()}`;
  return [key,history.get(key)||{success:0,attempts:0,totalMs:0}];
}
export function sourceSupportState(site,event){
  const keys=[String(event?.league||'').toUpperCase(),String(event?.sport||'').toUpperCase()].filter(Boolean);
  for(const key of keys){
    if((site?.categories?.[key]||[]).length)return 'YES';
    const state=String(site?.support?.[key]||'').toUpperCase();if(['YES','NO','UNKNOWN'].includes(state))return state;
  }
  return 'UNKNOWN';
}
function sitePriority(site,event){
  const [,stats]=siteStats(site,event);
  const persisted=site?.performance||{};
  const attempts=stats.attempts+(Number(persisted.successes)||0)+(Number(persisted.failures)||0);
  const success=stats.success+(Number(persisted.successes)||0);
  const avgNow=stats.success?stats.totalMs/stats.success:0;
  const avgSaved=Number(persisted.avgWatchMs)||0;
  const avg=avgNow&&avgSaved?(avgNow+avgSaved)/2:(avgNow||avgSaved||15000);
  const reliability=attempts?success/attempts:0;
  const support=sourceSupportState(site,event)==='YES'?45:0;
  const recent=Number(persisted.lastSuccessAt)&&Date.now()-Number(persisted.lastSuccessAt)<7*86400000?8:0;
  return support+recent+reliability*100-Math.min(avg/250,40);
}
function pendingSource(site,target,event,score=25){
  const stableId=idFor(`${event.id}|${site.id}|${target.kind||'page'}|${target.url}`);
  return {
    id:stableId,siteId:site.id,name:site.name,displayName:displayName(site,target.parentUrl||target.url),score,eventId:event.id,
    pending:true,deepVerified:false,mirrorLabel:target.text||'',sourceRoot:site.sourceRoot||site.indexUrls?.[0]||'',sourceUrl:target.kind==='page'?target.url:(target.parentUrl||target.url)
  };
}
export function eventJob(event,origin,customSites=[],{mode='deep'}={}) {
  if(!watchable(event)) throw new AppError('EVENT_UNAVAILABLE',409);
  const light=mode==='light';
  const customKey=idFor(customSites.map(site=>JSON.stringify({
    root:site.indexUrls?.[0]||site.id,categories:site.categories||{},eventListUrls:site.eventListUrls||[],support:site.support||{},structure:site.structure||{}
  })).sort().join('|'));
  const baseKey=`${origin}|${event.id}|${customKey}`;
  const key=`${baseKey}|${light?'light':'deep'}`;
  const old=jobs.get(key);
  if(old && (!old.done || old.expiresAt>Date.now())) return old;
  const seed=!light?jobs.get(`${baseKey}|light`)?.sources||[]:[];
  const job={sources:seed.map(source=>({...source})),done:false,status:'CHECKING',expiresAt:0,listeners:new Set(),started:false,mode:light?'light':'deep'};
  job.snapshot=()=>({type:'update',eventId:event.id,sources:rank(job.sources),done:job.done,status:job.status,mode:job.mode});
  job.publish=()=>{for(const listener of job.listeners)listener(job.snapshot());};
  const upsert=source=>{
    const existing=job.sources.find(item=>item.id===source.id);
    if(existing)Object.assign(existing,source);
    else job.sources.push(source);
    job.publish();
    return existing||source;
  };
  const remove=id=>{
    const index=job.sources.findIndex(item=>item.id===id);
    if(index>=0){job.sources.splice(index,1);job.publish();}
  };
  job.start=()=>{
    if(job.started)return;job.started=true;
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
      const sites=[...byHost.values()]
        .filter(site=>(site.type==='streamed'||site.custom||event.participants?.length>=2)&&siteSupportsEvent(site,event)&&sourceSupportState(site,event)!=='NO')
        .sort((a,b)=>{
          const ar=sourceSupportState(a,event)==='YES'?1:0,br=sourceSupportState(b,event)==='YES'?1:0;
          return br-ar||sitePriority(b,event)-sitePriority(a,event);
        });
      let matched=0,unavailable=0;
      const checkSite=async site=>{
        const [statsKey,stats]=siteStats(site,event);
        const mirrorKey=`${site.id}|${String(event.league||event.sport||'').toUpperCase()}`;
        const resolveTarget=async target=>{
          const pending=pendingSource(site,target,event,25+sitePriority(site,event));
          stats.attempts++;
          try{
            const candidates=(await fastCandidates(target,origin)).sort((a,b)=>(a.startupMs||0)-(b.startupMs||0));
            if(!candidates.length)throw new AppError('SOURCE_NOT_LIVE',422);
            stats.success++;stats.totalMs+=candidates[0]?.startupMs||0;
            const durablePage=target.parentUrl||target.url;if(durablePage)eventPageHistory.set(`${site.id}|${event.id}`,{url:durablePage,time:Date.now()});
            const reliability=stats.success/stats.attempts;
            for(const [index,media] of candidates.entries()){
              const score=100+reliability*20-Math.min((media.startupMs||0)/1000,25)+Math.min((media.quality||0)/1080,1)*5-index*.25;
              const id=index===0?pending.id:idFor(`${pending.id}|${media.mediaUrl}|${index}`);
              const active=upsert({...pending,...media,id,pending:false,unavailable:false,score,deepVerified:!media.isHls,verifiedAt:media.verifiedAt});
              if(!light && !media.provisional && media.isHls && media.live && !active.deepVerified){
                validate({url:media.mediaUrl,isHls:true},origin,{progress:true}).then(deep=>{
                  Object.assign(active,{segmentDuration:deep.segmentDuration,quality:deep.quality||active.quality,deepVerified:true,verifiedAt:deep.verifiedAt,expiresAt:deep.expiresAt,score:active.score+4});
                  job.publish();
                }).catch(()=>{});
              }
            }
            if(target.text){const remembered=mirrorHistory.get(mirrorKey)||new Set();remembered.add(target.text);mirrorHistory.set(mirrorKey,remembered);}
          }catch{}
        };
        try{
          const pages=site.events?.[event.id]?[{url:site.events[event.id],text:event.title}]:site.type==='streamed'?await streamedPages(event):await genericPages(site,event,{light});
          const uniquePages=[...new Map(pages.map(page=>[page.url,page])).values()];
          const pagesToCheck=light?uniquePages.slice(0,1):uniquePages;
          matched+=pagesToCheck.length;if(!pagesToCheck.length)return;
          const defaultTasks=[],mirrorTasks=[];
          for(const page of pagesToCheck){
            const baseTarget={kind:'page',url:page.url,text:'DEFAULT',parentUrl:page.url};
            defaultTasks.push(resolveTarget(baseTarget));
            if(!light)mirrorTasks.push((async()=>{
              const targets=await mirrorTargets(site,page,event,{light:false});
              const unique=[...new Map(targets.map(target=>[targetKey(target),{...target,parentUrl:page.url}])).values()].filter(target=>target.url!==page.url||target.kind!=='page');
              await Promise.allSettled(unique.map(resolveTarget));
            })());
          }
          await Promise.allSettled([...defaultTasks,...mirrorTasks]);
        }catch{unavailable++;}
        finally{history.set(statsKey,stats);}
      };
      const known=sites.filter(site=>sourceSupportState(site,event)==='YES');
      const fallback=sites.filter(site=>sourceSupportState(site,event)!=='YES');
      const primary=known.slice(0,6);
      const secondary=[...known.slice(6),...fallback];
      const primaryWork=Promise.allSettled(primary.map(checkSite));
      const secondaryWork=(async()=>{if(primary.length)await delay(550);return Promise.allSettled(secondary.map(checkSite));})();
      await Promise.allSettled([primaryWork,secondaryWork]);
      const ready=job.sources.filter(source=>source.mediaUrl&&!source.unavailable).length;
      job.status=ready?'READY':unavailable===sites.length&&sites.length?'SOURCES_UNAVAILABLE':matched?'NO_WORKING_SOURCES':'NO_MATCHING_SOURCES';
    }).catch(error=>{job.status=error.code||'SOURCES_UNAVAILABLE';}).finally(()=>{
      job.done=true;job.expiresAt=Date.now()+(job.sources.some(source=>source.mediaUrl)?60000:30000);job.publish();
      if(jobs.size>300)for(const [k,v] of jobs)if(v.done&&v.expiresAt<Date.now())jobs.delete(k);
    });
  };
  jobs.set(key,job);return job;
}
