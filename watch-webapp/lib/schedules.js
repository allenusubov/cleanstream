import {fetchLimited,AppError} from './network.js';
import {normalize,parseQuery,selectEvents} from '../public/events.js';

const cache=new Map();
const pending=new Map();
export const knownEvents=new Map();

export const scheduleProviders=[
  {key:'NBA',sport:'basketball',league:'NBA',path:'basketball/nba',aliases:['nba','basketball'],style:'matchup'},
  {key:'WNBA',sport:'basketball',league:'WNBA',path:'basketball/wnba',aliases:['wnba','women basketball'],style:'matchup'},
  {key:'NFL',sport:'football',league:'NFL',path:'football/nfl',aliases:['nfl','american football'],style:'matchup'},
  {key:'CFB',sport:'football',league:'CFB',path:'football/college-football',aliases:['cfb','college football','ncaa football'],style:'matchup'},
  {key:'NCAAB',sport:'basketball',league:'NCAAB',path:'basketball/mens-college-basketball',aliases:['ncaab','ncaa basketball','mens college basketball','college basketball'],style:'matchup'},
  {key:'WNCAAB',sport:'basketball',league:'WNCAAB',path:'basketball/womens-college-basketball',aliases:['wncaab','womens college basketball','women college basketball'],style:'matchup'},
  {key:'NHL',sport:'hockey',league:'NHL',path:'hockey/nhl',aliases:['nhl','hockey'],style:'matchup'},
  {key:'MLB',sport:'baseball',league:'MLB',path:'baseball/mlb',aliases:['mlb','baseball'],style:'matchup'},
  {key:'UFC',sport:'mma',league:'UFC',path:'mma/ufc',aliases:['ufc','mma'],style:'event'},
  {key:'BOXING',sport:'boxing',league:'BOXING',path:'boxing/boxing',aliases:['boxing','box'],style:'event'},
  {key:'F1',sport:'racing',league:'F1',path:'racing/f1',aliases:['f1','formula 1','formula one'],style:'event'},
  {key:'NASCAR',sport:'racing',league:'NASCAR',path:'racing/nascar-premier',aliases:['nascar'],style:'event'},
  {key:'INDYCAR',sport:'racing',league:'INDYCAR',path:'racing/irl',aliases:['indycar','indy car'],style:'event'},
  {key:'PGA',sport:'golf',league:'GOLF',path:'golf/pga',aliases:['golf','pga','pga tour'],style:'event'},
  {key:'LPGA',sport:'golf',league:'GOLF',path:'golf/lpga',aliases:['lpga','womens golf'],style:'event'},
  {key:'ATP',sport:'tennis',league:'TENNIS',path:'tennis/atp',aliases:['tennis','atp'],style:'matchup'},
  {key:'WTA',sport:'tennis',league:'TENNIS',path:'tennis/wta',aliases:['tennis','wta'],style:'matchup'},
  {key:'SOCCER',sport:'soccer',league:'SOCCER',path:'soccer/all',aliases:['soccer'],style:'matchup'},
  {key:'MLS',sport:'soccer',league:'MLS',path:'soccer/usa.1',aliases:['mls','major league soccer'],style:'matchup'},
  {key:'EPL',sport:'soccer',league:'EPL',path:'soccer/eng.1',aliases:['epl','premier league','english premier league'],style:'matchup'},
  {key:'UCL',sport:'soccer',league:'UCL',path:'soccer/uefa.champions',aliases:['ucl','champions league','uefa champions league'],style:'matchup'}
];

const byKey=new Map(scheduleProviders.map(item=>[item.key,item]));
const providerBase=provider=>`https://site.api.espn.com/apis/site/v2/sports/${provider.path}`;
const ymd=value=>new Date(value).toISOString().slice(0,10).replaceAll('-','');
const day=value=>new Date(value).toISOString().slice(0,10);

async function data(provider,path,ttl=60000){
  const key=`${provider.key}|${path}`;
  const old=cache.get(key);
  if(old&&Date.now()-old.time<ttl)return old.data;
  if(pending.has(key))return pending.get(key);
  const job=(async()=>{
    const response=await fetchLimited(providerBase(provider)+path,{limit:10*1024*1024});
    const json=JSON.parse(response.body.toString());
    if(!Array.isArray(json.events))throw new Error('Invalid schedule');
    cache.set(key,{time:Date.now(),data:json});
    if(cache.size>160)cache.delete(cache.keys().next().value);
    return json;
  })().finally(()=>pending.delete(key));
  pending.set(key,job);return job;
}

function competitorName(item){
  return item?.team?.displayName||item?.team?.shortDisplayName||item?.athlete?.displayName||item?.athlete?.shortName||item?.displayName||item?.name||'';
}
function competitorId(item){return item?.team?.id||item?.athlete?.id||item?.id||'';}
function competitorAbbr(item){return item?.team?.abbreviation||item?.athlete?.abbreviation||'';}
function competitorShortName(item){return item?.team?.shortDisplayName||item?.team?.name||item?.athlete?.shortName||item?.athlete?.displayName||item?.shortDisplayName||item?.name||'';}

export function normalizeEvent(raw,provider=byKey.get('NBA')){
  const competition=raw?.competitions?.[0];
  if(!raw?.id||!Number.isFinite(Date.parse(raw.date)))return null;
  const competitors=(competition?.competitors||[]).map(item=>({
    id:String(competitorId(item)||''),name:competitorName(item),shortName:competitorShortName(item),abbreviation:competitorAbbr(item)
  })).filter(item=>item.name);
  const participants=competitors;
  const state=competition?.status?.type?.state||raw?.status?.type?.state||'pre';
  const status=state==='in'?'live':state==='post'?'finished':'scheduled';
  const rawTitle=raw.name||raw.shortName||competition?.name||competition?.shortName||'';
  const title=provider.style==='matchup'&&participants.length===2?participants.map(item=>item.name).join(' VS '):rawTitle||participants.map(item=>item.name).join(' VS ');
  if(!title)return null;
  return {
    id:`${provider.key.toLowerCase()}-${raw.id}`,
    provider:'espn',
    providerEventId:String(raw.id),
    sport:provider.sport,
    league:provider.league,
    scheduleKey:provider.key,
    title,
    participants,
    startTime:raw.date,
    status
  };
}

function remember(events){
  for(const event of events)knownEvents.set(event.id,event);
  if(knownEvents.size>6000){
    const cutoff=Date.now()-2*86400000;
    for(const [id,event] of knownEvents)if(Date.parse(event.startTime)<cutoff)knownEvents.delete(id);
  }
  return events;
}

function monthsBetween(fromMs,toMs){
  const out=[];const cursor=new Date(fromMs);cursor.setUTCDate(1);cursor.setUTCHours(0,0,0,0);
  const end=new Date(toMs);end.setUTCDate(1);end.setUTCHours(0,0,0,0);
  while(cursor<=end&&out.length<3){out.push(`${cursor.getUTCFullYear()}${String(cursor.getUTCMonth()+1).padStart(2,'0')}`);cursor.setUTCMonth(cursor.getUTCMonth()+1);}
  return out;
}
async function rangeEvents(provider,fromMs,toMs,{ttl=60000}={}){
  const responses=await Promise.all(monthsBetween(fromMs,toMs).map(month=>data(provider,`/scoreboard?dates=${month}&limit=500`,ttl)));
  const unique=new Map();
  for(const json of responses)for(const raw of json.events||[]){
    const event=normalizeEvent(raw,provider);if(!event)continue;
    const start=Date.parse(event.startTime);if(start<fromMs||start>toMs)continue;
    unique.set(event.id,event);
  }
  return [...unique.values()];
}

function explicitProviders(raw){
  const q=` ${normalize(raw)} `;
  const exact=[];
  for(const provider of scheduleProviders){
    if(provider.aliases.some(alias=>q.includes(` ${normalize(alias)} `)))exact.push(provider);
  }
  // Generic "soccer" and "tennis" intentionally cover several competitions.
  if(q.includes(' soccer '))return [byKey.get('SOCCER')].filter(Boolean);
  if(q.includes(' tennis '))return scheduleProviders.filter(item=>item.sport==='tennis');
  return [...new Map(exact.map(item=>[item.key,item])).values()];
}

function meaningfulTokens(raw,providers=[]){
  let text=normalize(raw).replace(/\b(live|watch|stream|streams|today|game|games|event|events|vs|versus|v|at)\b/g,' ');
  for(const provider of providers)for(const alias of provider.aliases)text=text.replace(new RegExp(`\\b${normalize(alias).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/ /g,'\\s+')}\\b`,'g'),' ');
  return text.replace(/\s+/g,' ').trim().split(' ').filter(Boolean);
}

function textMatches(event,tokens){
  if(!tokens.length)return true;
  const hay=` ${normalize([event.title,event.league,event.sport,...(event.participants||[]).flatMap(p=>[p.name,p.abbreviation])].join(' '))} `;
  return tokens.every(token=>hay.includes(` ${token} `)||hay.includes(token));
}

export async function getLiveWindow(hours=24,now=Date.now()){
  const from=now-6*3600000;
  const to=now+Math.max(1,Math.min(Number(hours)||24,168))*3600000;
  const results=await Promise.allSettled(scheduleProviders.map(provider=>rangeEvents(provider,from,to,{ttl:60000})));
  const events=[];const unavailable=[];
  for(let i=0;i<results.length;i++){
    const result=results[i];
    if(result.status==='fulfilled')events.push(...result.value);
    else unavailable.push(scheduleProviders[i].key);
  }
  const unique=new Map();
  for(const event of events){
    const start=Date.parse(event.startTime);
    const inWindow=event.status==='live'||(event.status!=='finished'&&start>=now-6*3600000&&start<=to);
    if(!inWindow)continue;
    const signature=`${normalize(event.title)}|${Math.round(start/60000)}`;
    if(!unique.has(signature))unique.set(signature,event);
  }
  const ordered=[...unique.values()].sort((a,b)=>(a.status==='live'?-1:0)-(b.status==='live'?-1:0)||Date.parse(a.startTime)-Date.parse(b.startTime));
  remember(ordered);
  return {events:ordered,complete:unavailable.length===0,unavailable,updatedAt:Date.now(),provider:'ESPN',windowHours:hours};
}

async function nbaTeamSchedule(query){
  const provider=byKey.get('NBA');
  const now=new Date();const season=now.getUTCFullYear()+(now.getUTCMonth()>=8?1:0);
  const requests=[1,2,3].map(type=>data(provider,`/teams/${query.teams[0].id}/schedule?season=${season}&seasontype=${type}`,30*60000));
  const responses=await Promise.allSettled(requests);const good=responses.filter(item=>item.status==='fulfilled');
  if(!good.length)throw new AppError('SCHEDULE_UNAVAILABLE',503);
  const all=new Map();
  for(const response of good)for(const raw of response.value.events||[]){const event=normalizeEvent(raw,provider);if(event)all.set(event.id,event);}
  remember([...all.values()]);
  const events=selectEvents([...all.values()],query);
  const alternatives=query.kind==='matchup'&&!events.length?selectEvents([...all.values()],{teams:[query.teams[0]]}).slice(0,3):[];
  return {events,alternatives,query,complete:good.length===responses.length,updatedAt:Date.now(),provider:'ESPN',coverage:'PUBLISHED NBA SEASON'};
}

export async function searchSchedule(rawQuery,{days=7}={}){
  const raw=String(rawQuery||'').trim();
  const parsed=parseQuery(raw);
  if(['team','matchup','ambiguous'].includes(parsed.kind))return nbaTeamSchedule(parsed);
  const explicit=explicitProviders(raw);
  const providers=explicit.length?explicit:scheduleProviders;
  const now=Date.now(),to=now+Math.max(1,Math.min(days,30))*86400000;
  const results=await Promise.allSettled(providers.map(provider=>rangeEvents(provider,now-6*3600000,to,{ttl:explicit.length?60000:90000})));
  const good=results.filter(item=>item.status==='fulfilled');
  if(!good.length)throw new AppError('SCHEDULE_UNAVAILABLE',503);
  const tokens=meaningfulTokens(raw,explicit);
  const events=[];
  for(const result of good)for(const event of result.value){
    if(event.status==='finished'||Date.parse(event.startTime)<now-6*3600000)continue;
    if(textMatches(event,tokens))events.push(event);
  }
  const unique=new Map();
  for(const event of events){const key=`${normalize(event.title)}|${Math.round(Date.parse(event.startTime)/60000)}`;if(!unique.has(key))unique.set(key,event);}
  const ordered=[...unique.values()].sort((a,b)=>(a.status==='live'?-1:0)-(b.status==='live'?-1:0)||Date.parse(a.startTime)-Date.parse(b.startTime));
  remember(ordered);
  return {events:ordered,alternatives:[],query:{...parsed,providers:providers.map(item=>item.key)},complete:good.length===results.length,updatedAt:Date.now(),provider:'ESPN',coverage:explicit.length?`${providers.map(item=>item.key).join(' + ')} · NEXT ${days} DAYS`:`MULTI-SPORT · NEXT ${days} DAYS`};
}

// Backward-compatible name used by the rest of the app.
export const getEvents=searchSchedule;

export function getKnownEvent(id){return knownEvents.get(id)||null;}
export function providerForEventId(id){
  const prefix=String(id||'').split('-')[0].toUpperCase();
  return byKey.get(prefix)||null;
}
