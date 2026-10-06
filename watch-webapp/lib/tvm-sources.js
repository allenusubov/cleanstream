import crypto from 'node:crypto';
import {directoryLinks} from './directory.js';
import {fetchLimited,WorkPool,AppError} from './network.js';
import {withPage,visit,resolve,quickValidate} from './resolver.js';
import {mirrorTargets} from './discovery.js';

const jobs=new Map(),pageCache=new Map(),pageJobs=new Map(),browserSearchJobs=new Map();
const pool=new WorkPool(Math.max(1,Math.min(4,Number(process.env.TVM_JOB_CONCURRENCY)||2)));
const idFor=value=>crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const norm=value=>String(value||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const slug=value=>norm(value).replace(/\s+/g,'-');
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
  return [...new Set([`${item.showTitle} S${s}E${e}`,`${item.showTitle} season ${item.seasonNumber} episode ${item.episodeNumber}`,`${item.showTitle} ${item.episodeTitle||''}`.trim(),item.showTitle].filter(Boolean))];
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
function dedupeStrings(values=[],max=8){return [...new Set(values.filter(Boolean).map(String))].slice(0,max);}
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
function fillContentTemplate(template,item){
  let value=String(template||'');
  value=value.replaceAll('{title}',slug(item.kind==='movie'?item.title:item.showTitle));
  value=value.replaceAll('{season}',String(Number(item.seasonNumber)||''));
  value=value.replaceAll('{episode}',String(Number(item.episodeNumber)||''));
  value=value.replaceAll('{season2}',String(Number(item.seasonNumber)||0).padStart(2,'0'));
  value=value.replaceAll('{episode2}',String(Number(item.episodeNumber)||0).padStart(2,'0'));
  value=value.replaceAll('{year}',String(item.year||''));
  try{return new URL(value).href;}catch{return null;}
}
function directLearnedPages(site,item){
  const templates=item.kind==='tv'?(site.structure?.episodeTemplates||[]):(site.structure?.titleTemplates||[]);
  return templates.map(template=>fillContentTemplate(template,item)).filter(Boolean).map(url=>({url,text:item.title||item.showTitle,learned:true}));
}
function searchTemplateFromResult(url,query){
  try{
    const u=new URL(url);let changed=false;
    for(const [key,value] of [...u.searchParams]){
      if(norm(value)===norm(query)||norm(value).includes(norm(query))){u.searchParams.set(key,'__CLEANSTREAM_QUERY__');changed=true;break;}
    }
    if(!changed)return null;
    return u.href.replace('__CLEANSTREAM_QUERY__','{query}');
  }catch{return null;}
}
function deriveContentTemplate(url,item){
  try{
    const u=new URL(url);let path=decodeURIComponent(u.pathname),changedTitle=false,changedEpisode=false;
    const titleSlug=slug(item.kind==='movie'?item.title:item.showTitle);
    if(titleSlug){
      const variants=[titleSlug,titleSlug.replace(/-/g,'_'),titleSlug.replace(/-/g,' ')];
      for(const value of variants){if(path.toLowerCase().includes(value.toLowerCase())){path=path.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'),'{title}');changedTitle=true;break;}}
    }
    if(item.kind==='tv'){
      const s=Number(item.seasonNumber),e=Number(item.episodeNumber),s2=String(s).padStart(2,'0'),e2=String(e).padStart(2,'0');
      const before=path;
      path=path.replace(new RegExp(`s${s2}e${e2}`,'i'),'s{season2}e{episode2}');
      path=path.replace(new RegExp(`s${s}e${e}`,'i'),'s{season}e{episode}');
      path=path.replace(new RegExp(`(season[-_/ ]*)${s}(?=\\D|$)`,'i'),'$1{season}');
      path=path.replace(new RegExp(`(episode[-_/ ]*)${e}(?=\\D|$)`,'i'),'$1{episode}');
      changedEpisode=path!==before;
      if(!changedTitle||!changedEpisode)return null;
    } else if(!changedTitle)return null;
    u.pathname=path;
    let href=decodeURIComponent(u.href);
    href=href.replace(/%7B/gi,'{').replace(/%7D/gi,'}');
    return href;
  }catch{return null;}
}
async function browserSearch(site,item){
  const query=itemQueries(item)[0];if(!query)return {links:[],structure:{}};
  const cacheKey=`browser-search|${site.id}|${sourceKind(item)}|${norm(query)}`;
  const old=pageCache.get(cacheKey);if(old&&Date.now()-old.time<120000)return old.value;
  if(browserSearchJobs.has(cacheKey))return browserSearchJobs.get(cacheKey);
  const job=(async()=>{
    const learned={browserSearch:true,searchTemplates:[]},found=[];
    for(const root of rootsFor(site,item).slice(0,3)){
      try{
        const result=await withPage(async page=>{
          await visit(page,root);
          const searchButtons=page.locator('button[aria-label*="search" i],[role="button"][aria-label*="search" i],a[title*="search" i],button[title*="search" i]');
          const inputSelector='input[type="search"],input[name="q"],input[name="s"],input[name="query"],input[name="search"],input[name="keyword"],input[name="term"],input[placeholder*="search" i]';
          let input=page.locator(inputSelector).first();
          if(!(await input.count())||!(await input.isVisible().catch(()=>false))){
            for(let i=0;i<Math.min(await searchButtons.count(),6);i++){
              const button=searchButtons.nth(i);if(!(await button.isVisible().catch(()=>false)))continue;
              await button.click({timeout:900,force:true}).catch(()=>{});input=page.locator(inputSelector).first();if((await input.count())&&(await input.isVisible().catch(()=>false)))break;
            }
          }
          if(!(await input.count())||!(await input.isVisible().catch(()=>false)))return null;
          await input.fill(query,{timeout:1200});
          await input.press('Enter',{timeout:1200}).catch(()=>{});
          await page.waitForLoadState('domcontentloaded',{timeout:2200}).catch(()=>{});
          await page.waitForTimeout(500);
          const links=await page.locator('a[href],[data-href],[data-url],[onclick]').evaluateAll(nodes=>nodes.slice(0,2200).flatMap(node=>{
            let value=node.href||node.getAttribute('data-href')||node.getAttribute('data-url')||'';
            if(!value){const code=node.getAttribute('onclick')||'';value=code.match(/(?:location(?:\.href)?\s*=|open\s*\()\s*['\"]([^'\"]+)['\"]/i)?.[1]||'';}
            if(!value)return [];
            try{const u=new URL(value,document.baseURI);if(!/^https?:$/.test(u.protocol))return [];return [{url:u.href,text:(node.getAttribute('aria-label')||node.textContent||node.getAttribute('title')||'').replace(/\s+/g,' ').trim()}];}catch{return [];}
          }));
          return {url:page.url(),title:await page.title().catch(()=>''),links};
        });
        if(!result)continue;
        const template=searchTemplateFromResult(result.url,query);if(template)learned.searchTemplates.push(template);
        if(scoreLink({url:result.url,text:result.title},item)>=35)found.push({url:result.url,text:result.title});
        const ranked=dedupeLinks(result.links).map(link=>({link,score:scoreLink(link,item)})).filter(x=>x.score>=35).sort((a,b)=>b.score-a.score).slice(0,6);
        for(const {link} of ranked)found.push(link);
        if(found.length)break;
      }catch{}
    }
    const value={links:dedupeLinks(found).slice(0,8),structure:{browserSearch:true,searchTemplates:dedupeStrings(learned.searchTemplates,8)}};
    pageCache.set(cacheKey,{time:Date.now(),value});return value;
  })().finally(()=>browserSearchJobs.delete(cacheKey));
  browserSearchJobs.set(cacheKey,job);return job;
}
async function candidatePages(site,item){
  const shortcutKey=`${site.id}|${keyFor(item)}`;const shortcut=pageCache.get(`shortcut|${shortcutKey}`);
  const found=[...directLearnedPages(site,item)],learned={browserSearch:Boolean(site.structure?.browserSearch),searchTemplates:[],episodeTemplates:[],titleTemplates:[]};
  if(shortcut?.url)found.unshift({url:shortcut.url,text:item.title||item.showTitle,shortcut:true});
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
  if(found.length<=1||site.structure?.browserSearch){
    const searched=await browserSearch(site,item).catch(()=>({links:[],structure:{}}));
    for(const link of searched.links||[])found.push(link);
    learned.browserSearch=Boolean(learned.browserSearch||searched.structure?.browserSearch);
    learned.searchTemplates.push(...(searched.structure?.searchTemplates||[]));
  }
  if(item.kind==='tv'){
    const episodePages=[];
    for(const showPage of dedupeLinks(found).slice(0,6)){
      const directScore=scoreLink(showPage,item,{episodeOnly:true});
      if(directScore>=85){episodePages.push(showPage);continue;}
      const links=await linksFor(showPage.url,true);
      const ranked=links.map(link=>({link,score:scoreLink(link,item,{episodeOnly:true})})).filter(x=>x.score>=70).sort((a,b)=>b.score-a.score).slice(0,6);
      for(const {link} of ranked)episodePages.push(link);
    }
    const pages=dedupeLinks(episodePages).slice(0,10);
    for(const page of pages){const template=deriveContentTemplate(page.url,item);if(template)learned.episodeTemplates.push(template);}
    if(pages.length)return {pages,learned:{...learned,searchTemplates:dedupeStrings(learned.searchTemplates),episodeTemplates:dedupeStrings(learned.episodeTemplates)}};
  }
  const pages=dedupeLinks(found).slice(0,10);
  if(item.kind==='movie')for(const page of pages){const template=deriveContentTemplate(page.url,item);if(template)learned.titleTemplates.push(template);}
  return {pages,learned:{...learned,searchTemplates:dedupeStrings(learned.searchTemplates),titleTemplates:dedupeStrings(learned.titleTemplates)}};
}
function rank(sources){
  let recommended=false;return [...sources].sort((a,b)=>(b.score||0)-(a.score||0)||(a.startupMs||99999)-(b.startupMs||99999)).map(source=>{const next={...source,recommended:!recommended};if(!recommended)recommended=true;return next;});
}

export function tvmSourceJob(item,origin,customSites=[],{mode='deep'}={}){
  if(!item||!['tv','movie'].includes(item.kind)||!Number(item.tmdbId))throw new AppError('TVM_ITEM_UNAVAILABLE',400);
  const contentKey=keyFor(item),customKey=idFor(customSites.map(site=>JSON.stringify({id:site.id,support:site.support,categories:site.categories,structure:site.structure})).sort().join('|'));
  const key=`${origin}|${contentKey}|${customKey}|${mode}`;const old=jobs.get(key);if(old&&(!old.done||old.expiresAt>Date.now()))return old;
  const job={sources:[],done:false,status:'CHECKING',expiresAt:0,listeners:new Set(),started:false};
  job.snapshot=()=>({type:'update',eventId:item.id||contentKey,sources:rank(job.sources),done:job.done,status:job.status});
  job.publish=()=>{for(const listener of job.listeners)listener(job.snapshot());};
  const upsert=source=>{const old=job.sources.find(x=>x.id===source.id);if(old)Object.assign(old,source);else job.sources.push(source);job.publish();};
  job.start=()=>{
    if(job.started)return;job.started=true;
    job.promise=pool.run(async()=>{
      // A manual/deep check must actually try every enabled source. A saved NO can
      // be stale or incorrectly learned, so use it only to prune non-deep checks.
      const sites=[...customSites].filter(site=>site?.enabled&&(mode==='deep'||supportState(site,item)!=='NO')).sort((a,b)=>Number(supportState(b,item)==='YES')-Number(supportState(a,item)==='YES'));
      let matched=0;
      const checkSite=async site=>{
        const discovery=await candidatePages(site,item).catch(()=>({pages:[],learned:{}}));const pages=discovery.pages||[];if(!pages.length)return;matched+=pages.length;
        for(const page of pages.slice(0,6)){
          const fakeEvent={id:item.id||contentKey,league:sourceKind(item),sport:sourceKind(item),title:item.kind==='movie'?item.title:`${item.showTitle} ${item.title}`};
          let targets=[{kind:'page',url:page.url,text:'DEFAULT',parentUrl:page.url}];
          try{targets=await mirrorTargets(site,page,fakeEvent,{light:false});}catch{}
          for(const target of targets.slice(0,20)){
            try{
              const result=target.kind==='media'?{candidates:[target]}:await resolve(target.url,origin,{progress:false});
              const checks=await Promise.allSettled((result.candidates||[]).slice(0,6).map(candidate=>quickValidate(candidate)));
              for(const checked of checks){
                if(checked.status!=='fulfilled')continue;const media=checked.value;
                const id=idFor(`${site.id}|${contentKey}|${target.text||'DEFAULT'}|${media.mediaUrl}`);
                const learnedStructure={...discovery.learned};
                const template=deriveContentTemplate(page.url,item);if(template){if(item.kind==='tv')learnedStructure.episodeTemplates=dedupeStrings([...(learnedStructure.episodeTemplates||[]),template]);else learnedStructure.titleTemplates=dedupeStrings([...(learnedStructure.titleTemplates||[]),template]);}
                upsert({...media,id,siteId:site.id,name:site.name,displayName:domain(site),sourceRoot:site.sourceRoot||site.indexUrls?.[0]||'',sourceUrl:page.url,mirrorLabel:target.text||'',learnedStructure,pending:false,unavailable:false,score:100-Math.min((media.startupMs||0)/1000,25)});
                pageCache.set(`shortcut|${site.id}|${contentKey}`,{time:Date.now(),url:page.url});
              }
            }catch{}
          }
          if(job.sources.some(source=>source.siteId===site.id))return;
        }
      };
      // Check every applicable custom TV/movie source. Results stream to the UI
      // as each site succeeds instead of stopping after the first known source.
      await Promise.allSettled(sites.slice(0,12).map(checkSite));
      job.status=job.sources.length?'READY':matched?'NO_WORKING_SOURCES':'NO_MATCHING_SOURCES';
    }).catch(()=>{job.status='SOURCES_UNAVAILABLE';}).finally(()=>{job.done=true;job.expiresAt=Date.now()+(job.sources.length?60000:30000);job.publish();});
  };
  jobs.set(key,job);return job;
}
