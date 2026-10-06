import {directoryLinks} from './directory.js';
import {fetchLimited,safeURL} from './network.js';
import {withPage,visit} from './resolver.js';

export const CATEGORY_ALIASES={
  NBA:['nba','basketball'], WNBA:['wnba','women basketball','basketball'], NFL:['nfl','american football','football'],
  CFB:['cfb','college football','ncaa football'], NCAAB:['ncaab','ncaa basketball','college basketball'], WNCAAB:['wncaab','womens college basketball'],
  UFC:['ufc','mma','fight'], MMA:['mma','ufc','fight'], BOXING:['boxing','box'], NHL:['nhl','hockey'], MLB:['mlb','baseball'], SOCCER:['soccer','football'],
  F1:['f1','formula 1','formula one','motorsport'], NASCAR:['nascar'], INDYCAR:['indycar','indy car'], GOLF:['golf','pga','lpga'],
  TENNIS:['tennis'], RUGBY:['rugby'], CRICKET:['cricket']
};

const EVENT_WORDS=['events','live','schedule','upcoming','matches','games','fixtures','calendar'];
const HUB_WORDS=['sports','sport','watch','live','events','schedule'];
const normalize=value=>String(value||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const cleanCandidate=(value,base)=>{
  try {
    const url=new URL(value,base);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
    return url.href;
  } catch{return null;}
};
const linkText=link=>{
  try {
    const url=new URL(link.url);
    return normalize(`${link.text||''} ${decodeURIComponent(url.pathname)} ${decodeURIComponent(url.search)} ${decodeURIComponent(url.hash)}`);
  }catch{return normalize(link.text||'');}
};
function wordHit(text,term){
  const needle=normalize(term);if(!needle)return false;
  return (` ${text} `).includes(` ${needle} `);
}
export function likelyEventPage(link){
  try{
    const url=new URL(link.url);
    const path=decodeURIComponent(url.pathname||'').toLowerCase();
    const visible=normalize(link.text||'');
    const slug=(path.split('/').filter(Boolean).at(-1)||'').replace(/[-_+]+/g,' ');
    if(/\/(?:news|blog|article|story|post)(?:\/|$)/i.test(path))return true;
    if(/(?:^|[-_/])vs(?:[-_/]|$)/i.test(path)||wordHit(visible,'vs'))return true;
    if(/\bversus\b/i.test(`${visible} ${slug}`))return true;
    if(/(?:^|[-_/])at(?:[-_/]|$)/i.test(path) && slug.split(/\s+/).filter(Boolean).length>=4)return true;
    if(/\/\d{3,}\/?$/i.test(path) && slug.split(/\s+/).filter(Boolean).length>=3)return true;
    return false;
  }catch{return true;}
}
function routeDepth(link){
  try{return new URL(link.url).pathname.split('/').filter(Boolean).length;}catch{return 99;}
}
function categoryScore(link,key,aliases){
  if(likelyEventPage(link))return -1000;
  const text=linkText(link),visible=normalize(link.text||'');
  const exact=normalize(key);
  let score=Math.max(0,8-routeDepth(link)*2);
  if(wordHit(visible,exact))score+=30;
  if(wordHit(text,exact))score+=20;
  for(const alias of aliases){
    if(wordHit(visible,alias))score+=14;
    else if(wordHit(text,alias))score+=7;
  }
  // "football" is ambiguous. Prefer explicit NFL/CFB/SOCCER wording when it exists.
  if(['NFL','CFB','SOCCER'].includes(key) && !wordHit(text,key) && wordHit(text,'football'))score-=4;
  if(key==='SOCCER' && /\b(?:nfl|cfb|college football|ncaa football)\b/.test(text))score-=40;
  if(key==='NFL' && /\b(?:cfb|college football|ncaa football)\b/.test(text))score-=40;
  if(key==='CFB' && /\bnfl\b/.test(text))score-=40;
  return score;
}
function eventScore(link){
  if(likelyEventPage(link))return -1000;
  const text=linkText(link),visible=normalize(link.text||'');let score=0;
  for(const word of EVENT_WORDS){
    if(wordHit(visible,word))score+=12;
    else if(wordHit(text,word))score+=5;
  }
  if(/\/events?\/?(?:$|\?)/i.test(link.url))score+=10;
  if(/\/schedule\/?(?:$|\?)/i.test(link.url))score+=10;
  return score;
}
function structureFromLinks(links){
  const eventLinks=(links||[]).filter(likelyEventPage);
  const eventPrefixes=[],eventHosts=[];
  for(const link of eventLinks){
    try{
      const u=new URL(link.url);eventHosts.push(u.hostname.replace(/^www\./i,''));
      const parts=u.pathname.split('/').filter(Boolean);
      if(parts.length>1)eventPrefixes.push('/'+parts.slice(0,-1).join('/')+'/');
      else if(parts.length===1)eventPrefixes.push('/');
    }catch{}
  }
  const styles=new Set();
  for(const link of links||[]){try{const u=new URL(link.url);if(u.hash)styles.add('HASH');if(u.search)styles.add('QUERY');if(u.pathname&&u.pathname!=='/')styles.add('PATH');}catch{}}
  const routeStyle=styles.size===1?[...styles][0]:styles.size>1?'MIXED':'UNKNOWN';
  return {routeStyle,eventPrefixes:[...new Set(eventPrefixes)].slice(0,12),eventHosts:[...new Set(eventHosts)].slice(0,8)};
}

function dedupeLinks(links,base){
  const map=new Map();
  for(const link of links||[]){
    const url=cleanCandidate(link.url,base);if(!url)continue;
    const text=String(link.text||'').replace(/\s+/g,' ').trim();
    const old=map.get(url);
    if(!old || text.length>(old.text||'').length)map.set(url,{url,text});
  }
  return [...map.values()];
}
export function profileFromLinks(links,base){
  const clean=dedupeLinks(links,base),categories={};
  for(const [key,aliases] of Object.entries(CATEGORY_ALIASES)){
    const ranked=clean.map(link=>({link,score:categoryScore(link,key,aliases)})).filter(x=>x.score>=10).sort((a,b)=>b.score-a.score||routeDepth(a.link)-routeDepth(b.link));
    if(ranked.length)categories[key]=[...new Set(ranked.map(x=>x.link.url))].slice(0,6);
  }
  const eventLists=[...new Set(clean.map(link=>({link,score:eventScore(link)})).filter(x=>x.score>=10).sort((a,b)=>b.score-a.score).map(x=>x.link.url))];
  const hubs=clean.filter(link=>{
    const text=linkText(link);return HUB_WORDS.some(word=>wordHit(text,word));
  }).slice(0,6).map(link=>link.url);
  const support={};for(const key of Object.keys(CATEGORY_ALIASES))support[key]=(categories[key]||[]).length?'YES':'UNKNOWN';
  return {categories,eventLists,hubs,links:clean,support,structure:structureFromLinks(clean)};
}
async function pageLinks(url,{dynamic=true}={}){
  let finalUrl=url,staticLinks=[],staticError=null,staticWorked=false;
  try{
    // Large homepages are common. Keep the first 2 MB instead of treating an
    // oversized HTML document as an unavailable source.
    const response=await fetchLimited(url,{limit:2*1024*1024,partial:true});
    staticWorked=true;finalUrl=response.url;
    staticLinks=directoryLinks(response.body.toString(),response.url,[],1500);
  }catch(error){staticError=error;}
  const first=profileFromLinks(staticLinks,finalUrl);
  const useful=Object.keys(first.categories).length+first.eventLists.length;
  if(!dynamic || useful>=6)return {url:finalUrl,links:staticLinks,reachable:staticWorked,method:staticWorked?'STATIC':'NONE'};
  try{
    const dynamicLinks=await withPage(async page=>{
      await visit(page,url);
      finalUrl=page.url()||finalUrl;
      return page.locator('a[href],[data-href],[data-url],[onclick]').evaluateAll(nodes=>nodes.slice(0,2200).flatMap(node=>{
        let value=node.href||node.getAttribute('data-href')||node.getAttribute('data-url')||'';
        if(!value){
          const code=node.getAttribute('onclick')||'';
          value=code.match(/(?:location(?:\.href)?\s*=|open\s*\()\s*['\"]([^'\"]+)['\"]/i)?.[1]||'';
        }
        if(!value)return [];
        try{
          const u=new URL(value,document.baseURI);
          if(!/^https?:$/.test(u.protocol))return [];
          return [{url:u.href,text:(node.getAttribute('aria-label')||node.textContent||node.getAttribute('title')||'').replace(/\s+/g,' ').trim()}];
        }catch{return [];}
      }));
    });
    return {url:finalUrl,links:dedupeLinks([...staticLinks,...dynamicLinks],finalUrl),reachable:true,method:staticWorked?'STATIC+DYNAMIC':'DYNAMIC'};
  }catch(error){
    if(staticWorked)return {url:finalUrl,links:staticLinks,reachable:true,method:'STATIC'};
    return {url:finalUrl,links:[],reachable:false,method:'NONE',error:staticError||error};
  }
}
function mergeProfiles(profiles){
  const categories={};const eventLists=[],eventPrefixes=[],eventHosts=[];const styles=new Set();
  for(const profile of profiles){
    for(const [key,urls] of Object.entries(profile.categories||{})){
      categories[key]??=[];
      for(const url of urls||[])if(!categories[key].includes(url))categories[key].push(url);
    }
    for(const url of profile.eventLists||[])if(!eventLists.includes(url))eventLists.push(url);
    for(const value of profile.structure?.eventPrefixes||[])if(!eventPrefixes.includes(value))eventPrefixes.push(value);
    for(const value of profile.structure?.eventHosts||[])if(!eventHosts.includes(value))eventHosts.push(value);
    if(profile.structure?.routeStyle&&profile.structure.routeStyle!=='UNKNOWN')styles.add(profile.structure.routeStyle);
  }
  const support={};for(const key of Object.keys(CATEGORY_ALIASES))support[key]=(categories[key]||[]).length?'YES':'UNKNOWN';
  const routeStyle=styles.size===1?[...styles][0]:styles.size>1?'MIXED':'UNKNOWN';
  return {categories,eventLists,support,structure:{routeStyle,eventPrefixes:eventPrefixes.slice(0,12),eventHosts:eventHosts.slice(0,8)}};
}
export async function scanSourceProfile(input,hints={}){
  const root=await safeURL(input);
  const seeds=[root.href];
  const addSeed=async value=>{
    if(seeds.length>=8||!value)return;
    try{const url=(await safeURL(String(value))).href;if(!seeds.includes(url))seeds.push(url);}catch{}
  };
  // Re-test routes we already know. A homepage may be blocked or empty while a
  // category/events route still works and can teach us more about the site.
  for(const value of (Array.isArray(hints?.eventLists)?hints.eventLists:[]))await addSeed(value);
  for(const urls of Object.values(hints?.categories&&typeof hints.categories==='object'?hints.categories:{})){
    for(const value of (Array.isArray(urls)?urls:[urls])){await addSeed(value);if(seeds.length>=8)break;}
    if(seeds.length>=8)break;
  }

  const profiles=[];const hubs=[];let reachablePages=0,pagesChecked=0,finalUrl=root.href;
  for(const seed of seeds){
    const page=await pageLinks(seed,{dynamic:true});pagesChecked++;
    if(!page.reachable)continue;
    reachablePages++;if(seed===root.href)finalUrl=page.url||finalUrl;
    const profile=profileFromLinks(page.links,page.url||seed);profiles.push(profile);
    for(const hub of profile.hubs||[])if(!hubs.includes(hub))hubs.push(hub);
  }

  // Crawl a few discovered navigation hubs with cheap static requests. This is
  // bounded so TEST ALL can learn structure without turning into a site crawl.
  for(const hub of hubs.slice(0,4)){
    if(pagesChecked>=12)break;
    try{
      const page=await pageLinks(hub,{dynamic:false});pagesChecked++;
      if(!page.reachable)continue;reachablePages++;profiles.push(profileFromLinks(page.links,page.url||hub));
    }catch{}
  }

  const merged=mergeProfiles(profiles);
  const learned=Object.values(merged.categories||{}).reduce((n,urls)=>n+(urls?.length||0),0)+(merged.eventLists?.length||0);
  const status=reachablePages===0?'UNREACHABLE':learned?'LEARNED':'PARTIAL';
  return {url:finalUrl,categories:merged.categories,eventLists:merged.eventLists,support:merged.support,structure:merged.structure,
    status,reachable:reachablePages>0,pagesChecked,reachablePages,testedAt:Date.now()};
}
