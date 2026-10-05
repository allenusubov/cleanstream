import {fetchLimited} from './network.js';
import {MetadataCache} from './provider-cache.js';
import {normalize,matchesParticipants} from '../public/events.js';
const cache=new MetadataCache();
const base='https://streamed.pk/api';
export async function streamedData(path) {
  return cache.get(path,90000,async()=>{
    const response=await fetchLimited(base+path,{limit:3*1024*1024});
    const json=JSON.parse(response.body.toString());
    if(!Array.isArray(json))throw new Error('Invalid catalog');
    return json;
  });
}
const sports={nba:'basketball',wnba:'basketball',basketball:'basketball',nfl:'american-football',cfb:'american-football',football:'american-football',soccer:'football',ufc:'fight',mma:'fight',boxing:'fight',nhl:'hockey',hockey:'hockey',mlb:'baseball',baseball:'baseball',f1:'motor-sports',racing:'motor-sports',tennis:'tennis',cricket:'cricket',rugby:'rugby',wwe:'wrestling'};
export const isSportQuery=q=>normalize(q).split(' ').some(word=>Object.hasOwn(sports,word));
export function matchQuery(match,q) {
  const query=normalize(q).replace(/\b(live|watch|stream|streams|today|vs|versus)\b/g,' ').trim();
  if(sports[query]) {
    if(match.category!==sports[query])return false;
    // A basketball feed isn't proof that an event belongs to the NBA/WNBA.
    const metadata=normalize([match.title,match.id,match.league,...(match.sources||[]).map(s=>s.id)].join(' '));
    if(query==='f1')return /\bf1\b|\bformula 1\b/.test(metadata);
    if(query==='ufc')return /\bufc\b|dana white.*contender/.test(metadata);
    if(['nba','wnba','cfb','nfl','boxing','wwe'].includes(query))return new RegExp(`\\b${query}\\b`,'i').test(metadata);
    return true;
  }
  const text=` ${normalize(`${match.title} ${match.category} ${match.league||''}`)} `;
  const words=query.split(/\s+/).filter(Boolean);
  return words.length>0 && words.every(word=>text.includes(` ${word} `));
}
export function normalizeMatch(match,now=Date.now()) {
  const date=Number(match.date);
  if(!match.id || !match.title || !Number.isFinite(date) || date<now-6*3600000 || date>now+30*86400000)return null;
  const names=[match.teams?.home?.name,match.teams?.away?.name].filter(Boolean);
  return {id:`streamed-${match.id}`,provider:'streamed',sport:match.category,league:match.category.toUpperCase(),title:match.title,
    startTime:new Date(date).toISOString(),status:'scheduled',participants:names.map(name=>({name})),catalogId:match.id};
}
export async function catalogSearch(q) {
  const raw=await streamedData('/matches/all');
  return raw.filter(m=>matchQuery(m,q)).map(m=>normalizeMatch(m)).filter(Boolean);
}
export async function streamedPages(event) {
  const raw=await streamedData('/matches/all');
  const matches=raw.filter(m=>{
    if(event.catalogId)return m.id===event.catalogId;
    const text=[m.title,m.teams?.home?.name,m.teams?.away?.name,m.league,m.category].filter(Boolean).join(' ');
    return Math.abs(Number(m.date)-Date.parse(event.startTime))<6*3600000 && matchesParticipants(text,event.participants);
  });
  const refs=matches.flatMap(m=>m.sources||[]).slice(0,4);
  const results=await Promise.allSettled(refs.map(s=>streamedData(`/stream/${encodeURIComponent(s.source)}/${encodeURIComponent(s.id)}`)));
  return results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value).filter(s=>{
    try{return new URL(s.embedUrl).protocol==='https:';}catch{return false;}
  }).sort((a,b)=>Number(b.language==='English')-Number(a.language==='English')).map(s=>({url:s.embedUrl,text:event.title})).slice(0,3);
}
export function mergeEvents(events) {
  const unique=new Map();
  for(const event of events) {
    const title=event.participants?.length===2?event.participants.map(p=>normalize(p.name)).sort().join('|'):normalize(event.title).replace(/\b(vs|v|versus)\b/g,' ').replace(/\s+/g,' ').trim();
    const key=event.provider==='youtube'?event.id:`${title}|${Math.round(Date.parse(event.startTime)/1800000)}`;
    if(!unique.has(key))unique.set(key,event);
  }
  return [...unique.values()].sort((a,b)=>(a.status==='live'?-1:0)-(b.status==='live'?-1:0)||Date.parse(a.startTime)-Date.parse(b.startTime));
}
