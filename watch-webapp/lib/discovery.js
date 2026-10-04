import fs from 'node:fs';
import crypto from 'node:crypto';
import {matchesParticipants} from '../public/events.js';
import {withPage,visit,resolve} from './resolver.js';
import {AppError,WorkPool} from './network.js';
const registry=JSON.parse(process.env.SOURCE_REGISTRY_JSON || fs.readFileSync(new URL('../sources.json',import.meta.url),'utf8'));
const jobs=new Map(), history=new Map(), indexes=new Map(), indexJobs=new Map();
const pool=new WorkPool(2,8,120);
const idFor=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,16);
async function index(site) {
  const old=indexes.get(site.id);
  if(old && Date.now()-old.time<120000) return old.links;
  if(indexJobs.has(site.id)) return indexJobs.get(site.id);
  const job=withPage(async page=>{
    await visit(page,site.indexUrl);
    const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.slice(0,500).map(a=>({url:a.href,text:a.textContent?.trim()})));
    const valid=links.filter(link=>{try{return ['http:','https:'].includes(new URL(link.url).protocol)&&site.allowedHosts.includes(new URL(link.url).hostname);}catch{return false;}});
    indexes.set(site.id,{time:Date.now(),links:valid});return valid;
  }).finally(()=>indexJobs.delete(site.id));
  indexJobs.set(site.id,job);return job;
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
      const sites=registry.filter(s=>s.enabled && s.leagues.includes(event.league)).slice(0,4);
      let matched=0, unavailable=0;
      await Promise.allSettled(sites.map(async site=>{
        const statsKey=`${site.id}|${event.league}`;
        const stats=history.get(statsKey)||{success:0,attempts:0,totalMs:0};
        try {
          const pages=site.events?.[event.id] ? [{url:site.events[event.id],text:event.title}] :
            (await index(site)).filter(link=>matchesParticipants(link.text,event.participants));
          const unique=[...new Map(pages.map(p=>[p.url,p])).values()].slice(0,3);
          matched+=unique.length;
          await Promise.allSettled(unique.map(async page=>{
            stats.attempts++;
            try {
              const result=await resolve(page.url,origin,{progress:true});
              // Multiple variants from one page are one source, not independent backups.
              const media=result.candidates.sort((a,b)=>a.startupMs-b.startupMs)[0];
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
