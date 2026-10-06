import crypto from 'node:crypto';
import {directoryLinks} from './directory.js';
import {fetchLimited,WorkPool,AppError} from './network.js';
import {withPage,visit,resolve,quickValidate} from './resolver.js';
import {mirrorTargets} from './discovery.js';

const jobs=new Map(),pageCache=new Map(),pageJobs=new Map();
const pool=new WorkPool(Math.max(1,Math.min(4,Number(process.env.TVM_JOB_CONCURRENCY)||2)));
const idFor=value=>crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const norm=value=>String(value||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const tokens=value=>norm(value).split(' ').filter(word=>word.length>=2);
const keyFor=item=>item?.kind==='movie'?`movie:${item.tmdbId}`:`tv:${item.tmdbId}:s${item.seasonNumber}:e${item.episodeNumber}`;
const sourceKind=item=>item?.kind==='movie'?'MOVIES':'TV';
function domain(site){
  if(site.displayHost)return String(site.displayHost).replace(/^www\./i,'').toUpperCase();
  try{return new URL(site.indexUrls?.[0]||site.sourceRoot||'').hostname.replace(/^www\./i,'').toUpperCase();}catch{return String(site.name||'SOURCE').toUpperCase();}
}
function supportState(site,item){
  const key=sourceKind(item);if((site.categories?.[key]||[]).length)return 'YES';
  const state=String(site.support?.[key]||'').toUpperCase();return ['YES','NO','UNKNOWN'].includes(state)?state:'UNKNOWN';
}
function fillTemplate(template,query){
  const raw=String(template||'');
  return raw.replaceAll('{query}',encodeURIComponent(query)).replaceAll('%7Bquery%7D',encodeURIComponent(query)).replaceAll('%7BQUERY%7D',encodeURIComponent(query));
}
function itemQueries(item){
  if(item.kind==='movie')return [...new Set([`${item.title}${item.year?` ${item.year}`:''}`,item.title].filter(Boolean))];
  const s=String(item.seasonNumber).padStart(2,'0'),e=String(item.episodeNumber).padStart(2,'0');
  return [...new Set([`${item.showTitle} S${s}E${e}`,`${item.showTitle} ${item.episodeTitle||''}`.trim(),item.showTitle].filter(Boolean))];
}
function linkHaystack(link){
  try{const u=new URL(link.url);return norm(`${link.text||''} ${decodeURIComponent(u.pathname)} ${decodeURIComponent(u.search)} ${decodeURIComponent(u.hash)}`);}catch{return norm(link.text||'');}
}
function titleCoverage(haystack,title){
  const words=tokens(title).filter(word=>!['the','and','of','a','an'].includes(word));if(!words.length)return 0;
  const hits=words.filter(word=>haystack.includes(word)).length;return hits/words.length;
}
function scoreLink(link,item,{episodeOnly=false}={}){
  const text=linkHaystack(link);let score=0;
  const baseTitle=item.kind==='movie'?item.title:item.showTitle;
  const coverage=titleCoverage(text,baseTitle);score+=Math.round(coverage*70);
  if(coverage<.5)return -100;
  if(item.kind==='movie'){
    if(item.year&&text.includes(String(item.year)))score+=18;
    if(/\b(?:movie|film|watch)\b/.test(text))score+=5;
    return score;
  }
  const s=Number(item.seasonNumber),e=Number(item.episodeNumber);
  const seasonEpisode=[`s${String(s).padStart(2,'0')}e${String(e).padStart(2,'0')}`,`s${s}e${e}`,`season ${s} episode ${e}`,`season ${s} ep ${e}`,`season ${s} ${e}`];
  const exact=seasonEpisode.some(value=>text.includes(norm(value)));
  if(exact)score+=70;
  if(item.episodeTitle&&titleCoverage(text,item.episodeTitle)>=.65)score+=35;
  if(episodeOnly&&!exact&&(!item.episodeTitle||titleCoverage(text,item.episodeTitle)<.65))score-=55;
  return score;
}
function dedupeLinks(links=[]){const out=new Map();for(const link of links){if(!link?.url)continue;const old=out.get(link.url);if(!old||String(link.text||'').length>String(old.text||'').length)out.set(link.url,link);}return [...out.values()];}
async function linksFor(url,dynamic=true){
  const cacheKey=`${dynamic?'d':'s'}|${url}`;const old=pageCache.get(cacheKey);if(old&&Date.now()-old.time<120000)return old.links;
  if(pageJobs.has(cacheKey))return pageJobs.get(cacheKey);
  const job=(async()=>{
    let staticLinks=[],worked=false;
    try{const response=await fetchLimited(url,{limit:2*1024*1024,partial:true});worked=true;staticLinks=directoryLinks(response.body.toString(),response.url,[],1800);}catch{}
    if(!dynamic){const links=dedupeLinks(staticLinks);pageCache.set(cacheKey,{time:Date.now(),links});return links;}
    try{
      const dynamicLinks=await withPage(async page=>{
        await visit(page,url);
        return page.locator('a[href],[data-href],[data-url],[onclick]').evaluateAll(nodes=>nodes.slice(0,2200).flatMap(node=>{
          let value=node.href||node.getAttribute('data-href')||node.getAttribute('data-url')||'';
          if(!value){const code=node.getAttribute('onclick')||'';value=code.match(/(?:location(?:\.href)?\s*=|open\s*\()\s*['\"]([^'\"]+)['\"]/i)?.[1]||'';}
          if(!value)return [];
          try{const u=new URL(value,document.baseURI);if(!/^https?:$/.test(u.protocol))return [];return [{url:u.href,text:(node.getAttribute('aria-label')||node.textContent||node.getAttribute('title')||'').replace(/\s+/g,' ').trim()}];}catch{return [];}
        }));
      });
      const links=dedupeLinks([...staticLinks,...dynamicLinks]);pageCache.set(cacheKey,{time:Date.now(),links});return links;
    }catch{const links=dedupeLinks(staticLinks);if(worked)pageCache.set(cacheKey,{time:Date.now(),links});return links;}
  })().finally(()=>pageJobs.delete(cacheKey));pageJobs.set(cacheKey,job);return job;
}
function rootsFor(site,item){
  const key=sourceKind(item);const roots=[];
  for(const value of site.categories?.[key]||[])roots.push(value);
  for(const value of site.eventListUrls||[])roots.push(value);
  for(const value of site.indexUrls||[])roots.push(value);
  if(site.sourceRoot)roots.push(site.sourceRoot);
  return [...new Set(roots.filter(Boolean))];
}
async function candidatePages(site,item){
  const shortcutKey=`${site.id}|${keyFor(item)}`;const shortcut=pageCache.get(`shortcut|${shortcutKey}`);
  const found=[];
  if(shortcut?.url)found.push({url:shortcut.url,text:item.title||item.showTitle,shortcut:true});
  const searchTemplates=site.structure?.searchTemplates||[];
  for(const template of searchTemplates.slice(0,4)){
    for(const query of itemQueries(item).slice(0,2)){
      let searchUrl;try{searchUrl=new URL(fillTemplate(template,query)).href;}catch{continue;}
      const links=await linksFor(searchUrl,true);
      const ranked=links.map(link=>({link,score:scoreLink(link,item)})).filter(x=>x.score>=35).sort((a,b)=>b.score-a.score).slice(0,4);
      for(const {link} of ranked)found.push(link);
      if(ranked.length)break;
    }
    if(found.length>1)break;
  }
  if(found.length<=1){
    for(const root of rootsFor(site,item).slice(0,5)){
      const links=await linksFor(root,true);
      const ranked=links.map(link=>({link,score:scoreLink(link,item)})).filter(x=>x.score>=38).sort((a,b)=>b.score-a.score).slice(0,4);
      for(const {link} of ranked)found.push(link);
      if(found.length>=5)break;
    }
  }
  if(item.kind==='tv'){
    const episodePages=[];
    for(const showPage of dedupeLinks(found).slice(0,4)){
      const directScore=scoreLink(showPage,item,{episodeOnly:true});
      if(directScore>=85){episodePages.push(showPage);continue;}
      const links=await linksFor(showPage.url,true);
      const ranked=links.map(link=>({link,score:scoreLink(link,item,{episodeOnly:true})})).filter(x=>x.score>=70).sort((a,b)=>b.score-a.score).slice(0,4);
      for(const {link} of ranked)episodePages.push(link);
    }
    if(episodePages.length)return dedupeLinks(episodePages).slice(0,8);
  }
  return dedupeLinks(found).slice(0,8);
}
function rank(sources){
  let recommended=false;return [...sources].sort((a,b)=>(b.score||0)-(a.score||0)||(a.startupMs||99999)-(b.startupMs||99999)).map(source=>{const next={...source,recommended:!recommended};if(!recommended)recommended=true;return next;});
}

export function tvmSourceJob(item,origin,customSites=[]){
  if(!item||!['tv','movie'].includes(item.kind)||!Number(item.tmdbId))throw new AppError('TVM_ITEM_UNAVAILABLE',400);
  const contentKey=keyFor(item),customKey=idFor(customSites.map(site=>JSON.stringify({id:site.id,support:site.support,categories:site.categories,structure:site.structure})).sort().join('|'));
  const key=`${origin}|${contentKey}|${customKey}`;const old=jobs.get(key);if(old&&(!old.done||old.expiresAt>Date.now()))return old;
  const job={sources:[],done:false,status:'CHECKING',expiresAt:0,listeners:new Set(),started:false};
  job.snapshot=()=>({type:'update',eventId:item.id||contentKey,sources:rank(job.sources),done:job.done,status:job.status});
  job.publish=()=>{for(const listener of job.listeners)listener(job.snapshot());};
  const upsert=source=>{const old=job.sources.find(x=>x.id===source.id);if(old)Object.assign(old,source);else job.sources.push(source);job.publish();};
  job.start=()=>{
    if(job.started)return;job.started=true;
    job.promise=pool.run(async()=>{
      const sites=[...customSites].filter(site=>site?.enabled&&supportState(site,item)!=='NO').sort((a,b)=>Number(supportState(b,item)==='YES')-Number(supportState(a,item)==='YES'));
      let matched=0;
      const checkSite=async site=>{
        const pages=await candidatePages(site,item).catch(()=>[]);if(!pages.length)return;matched+=pages.length;
        for(const page of pages.slice(0,5)){
          const fakeEvent={id:item.id||contentKey,league:sourceKind(item),sport:sourceKind(item),title:item.kind==='movie'?item.title:`${item.showTitle} ${item.title}`};
          let targets=[{kind:'page',url:page.url,text:'DEFAULT',parentUrl:page.url}];
          try{targets=await mirrorTargets(site,page,fakeEvent,{light:false});}catch{}
          for(const target of targets.slice(0,12)){
            try{
              const result=target.kind==='media'?{candidates:[target]}:await resolve(target.url,origin,{progress:false});
              const checks=await Promise.allSettled((result.candidates||[]).slice(0,5).map(candidate=>quickValidate(candidate)));
              for(const checked of checks){
                if(checked.status!=='fulfilled')continue;const media=checked.value;
                const id=idFor(`${site.id}|${contentKey}|${target.text||'DEFAULT'}|${media.mediaUrl}`);
                upsert({...media,id,siteId:site.id,name:site.name,displayName:domain(site),sourceRoot:site.sourceRoot||site.indexUrls?.[0]||'',sourceUrl:page.url,mirrorLabel:target.text||'',pending:false,unavailable:false,score:100-Math.min((media.startupMs||0)/1000,25)});
                pageCache.set(`shortcut|${site.id}|${contentKey}`,{time:Date.now(),url:page.url});
              }
            }catch{}
          }
          if(job.sources.some(source=>source.siteId===site.id))return;
        }
      };
      const known=sites.filter(site=>supportState(site,item)==='YES'),fallback=sites.filter(site=>supportState(site,item)!=='YES');
      await Promise.allSettled(known.slice(0,5).map(checkSite));
      if(!job.sources.length)await Promise.allSettled(fallback.slice(0,8).map(checkSite));
      job.status=job.sources.length?'READY':matched?'NO_WORKING_SOURCES':'NO_MATCHING_SOURCES';
    }).catch(()=>{job.status='SOURCES_UNAVAILABLE';}).finally(()=>{job.done=true;job.expiresAt=Date.now()+(job.sources.length?60000:30000);job.publish();});
  };
  jobs.set(key,job);return job;
}
