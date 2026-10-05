import fs from 'node:fs';
import crypto from 'node:crypto';
import {matchesParticipants} from '../public/events.js';
import {withPage,visit,resolve} from './resolver.js';
import {AppError,WorkPool,fetchLimited} from './network.js';
import {streamedPages} from './catalog.js';
import {directoryLinks} from './directory.js';
const registry=JSON.parse(process.env.SOURCE_REGISTRY_JSON || fs.readFileSync(new URL('../sources.json',import.meta.url),'utf8'));
const jobs=new Map(), history=new Map(), indexes=new Map(), indexJobs=new Map();
const pool=new WorkPool(2,12,120);
const idFor=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,16);
function hostAllowed(host,allowedHosts=[]) {
  return !allowedHosts.length || allowedHosts.some(allowed=>host===allowed || host.endsWith(`.${allowed}`));
}
function eventQuery(event) {
  return event.participants?.length ? event.participants.map(p=>p.name).join(' vs ') : event.title;
}
function fillTemplate(template,event) {
  const league=String(event.league||event.sport||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const sport=String(event.sport||event.league||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  return template.replaceAll('{league}',league).replaceAll('{sport}',sport).replaceAll('{query}',encodeURIComponent(eventQuery(event)));
}
export function linkMatchesEvent(link,event) {
  try {
    const url=new URL(link.url);
    const slug=decodeURIComponent(`${url.pathname} ${url.search}`).replace(/[-_+]+/g,' ');
    return matchesParticipants(`${link.text||''} ${slug}`,event.participants||[]);
  } catch { return false; }
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
      staticLinks=directoryLinks(response.body.toString(),response.url,site.allowedHosts);
      if(!site.dynamic || staticLinks.some(link=>linkMatchesEvent(link,event))) {
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
        const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.slice(0,800).map(a=>({
          url:a.href,
          text:a.getAttribute('aria-label')||a.textContent?.trim()||a.closest('.row')?.querySelector('.name')?.textContent||''
        })));
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
async function genericPages(site,event) {
  const templates=[...(site.indexUrls||[]),...(site.indexUrl?[site.indexUrl]:[]),...(site.searchUrls||[])];
  const urls=[...new Set(templates.map(template=>fillTemplate(template,event)))];
  const found=[];
  for(const indexUrl of urls) {
    try {
      const links=await readIndex(site,indexUrl,event);
      for(const link of links) if(linkMatchesEvent(link,event)) found.push(link);
      if(found.length>=6) break;
    } catch { /* Try the next bounded index/search page. */ }
  }
  return [...new Map(found.map(page=>[page.url,page])).values()].slice(0,6);
}
export function rank(sources) {
  return [...sources].sort((a,b)=>b.score-a.score).map((s,i)=>({...s,label:i===0?'BEST':i===1?'GOOD':'BACKUP'}));
}
export function watchable(event,now=Date.now()) {
  const start=Date.parse(event.startTime);
  return event.status!=='finished' && start<=now+45*60000 && start>now-6*3600000;
}
export function eventJob(event,origin) {
  if(!watchable(event)) throw new AppError('NOT_STARTED',409);
  const key=`${origin}|${event.id}`;
  const old=jobs.get(key);
  if(old && (!old.done || old.expiresAt>Date.now())) return old;
  const job={sources:[],done:false,status:'CHECKING',expiresAt:0,listeners:new Set(),started:false};
  job.snapshot=()=>({type:'update',eventId:event.id,sources:rank(job.sources),done:job.done,status:job.status});
  job.publish=()=>{for(const listener of job.listeners) listener(job.snapshot());};
  job.start=()=>{
    if(job.started) return;job.started=true;
    job.promise=pool.run(async()=>{
      const sites=registry.filter(s=>s.enabled && (s.type==='streamed'||event.participants?.length>=2) && (s.leagues.includes('*')||s.leagues.includes(event.league))).slice(0,5);
      let matched=0, unavailable=0;
      await Promise.allSettled(sites.map(async site=>{
        const statsKey=`${site.id}|${event.league}`;
        const stats=history.get(statsKey)||{success:0,attempts:0,totalMs:0};
        try {
          const pages=site.events?.[event.id] ? [{url:site.events[event.id],text:event.title}] : site.type==='streamed'?await streamedPages(event):await genericPages(site,event);
          const unique=[...new Map(pages.map(p=>[p.url,p])).values()].slice(0,3);
          matched+=unique.length;
          await Promise.allSettled(unique.map(async page=>{
            stats.attempts++;
            try {
              const result=await resolve(page.url,origin,{progress:true});
              // Multiple variants from one page are one source, not independent backups.
              const media=result.candidates.filter(m=>m.live).sort((a,b)=>a.startupMs-b.startupMs)[0];
              if(!media)throw new AppError('SOURCE_NOT_LIVE',422);
              stats.success++;stats.totalMs+=media.startupMs;
              const reliability=stats.success/stats.attempts;
              const score=100+reliability*20-Math.min(media.startupMs/1000,25)+Math.min(media.quality/1080,1)*5;
              if(!job.sources.some(s=>s.mediaUrl===media.mediaUrl)) job.sources.push({...media,
                id:idFor(`${event.id}|${page.url}`),siteId:site.id,name:site.name,score,eventId:event.id});
              job.publish();
            } catch { /* A rejected candidate remains unavailable. */ }
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
