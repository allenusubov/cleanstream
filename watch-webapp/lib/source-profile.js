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
  return {categories,eventLists,hubs,links:clean};
}
async function pageLinks(url,{dynamic=true}={}){
  let finalUrl=url,staticLinks=[],staticError=null;
  try{
    const response=await fetchLimited(url,{limit:2*1024*1024});
    finalUrl=response.url;
    staticLinks=directoryLinks(response.body.toString(),response.url,[],1500);
  }catch(error){staticError=error;}
  const first=profileFromLinks(staticLinks,finalUrl);
  const useful=Object.keys(first.categories).length+first.eventLists.length;
  if(!dynamic || useful>=3)return {url:finalUrl,links:staticLinks};
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
    return {url:finalUrl,links:dedupeLinks([...staticLinks,...dynamicLinks],finalUrl)};
  }catch(error){
    if(staticLinks.length)return {url:finalUrl,links:staticLinks};
    throw staticError||error;
  }
}
function mergeProfiles(profiles){
  const categories={};const eventLists=[];
  for(const profile of profiles){
    for(const [key,urls] of Object.entries(profile.categories||{})){
      categories[key]??=[];
      for(const url of urls||[])if(!categories[key].includes(url))categories[key].push(url);
    }
    for(const url of profile.eventLists||[])if(!eventLists.includes(url))eventLists.push(url);
  }
  return {categories,eventLists};
}
export async function scanSourceProfile(input){
  const root=await safeURL(input);
  const firstPage=await pageLinks(root.href,{dynamic:true});
  const first=profileFromLinks(firstPage.links,firstPage.url);
  const profiles=[first];
  // TEST may inspect a few obvious navigation hubs once. Search then reuses what
  // was learned instead of rediscovering these paths for every live event.
  if(Object.keys(first.categories).length<2){
    for(const hub of first.hubs.slice(0,3)){
      try{
        await safeURL(hub);
        const page=await pageLinks(hub,{dynamic:false});
        profiles.push(profileFromLinks(page.links,page.url));
      }catch{}
    }
  }
  const merged=mergeProfiles(profiles);
  return {url:firstPage.url,categories:merged.categories,eventLists:merged.eventLists};
}
