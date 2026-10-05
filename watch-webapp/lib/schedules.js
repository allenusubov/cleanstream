import {fetchLimited, AppError} from './network.js';
import {parseQuery,selectEvents} from '../public/events.js';
const base='https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const cache=new Map();
const pending=new Map();
export const knownEvents=new Map();
async function data(path, ttl) {
  const old=cache.get(path);
  if(old && Date.now()-old.time<ttl) return old.data;
  if(pending.has(path)) return pending.get(path);
  const job=(async()=>{
    const response=await fetchLimited(base+path,{limit:8*1024*1024});
    const json=JSON.parse(response.body.toString());
    if(!Array.isArray(json.events)) throw new Error('Invalid schedule');
    cache.set(path,{time:Date.now(),data:json});
    if(cache.size>80) cache.delete(cache.keys().next().value);
    return json;
  })().finally(()=>pending.delete(path));
  pending.set(path,job); return job;
}
export function normalizeEvent(raw) {
  const c=raw.competitions?.[0];
  if(!c || !raw.id || !Number.isFinite(Date.parse(raw.date))) return null;
  const participants=(c.competitors||[]).filter(p=>p.team).map(p=>({id:String(p.team.id),name:p.team.displayName||p.team.name,abbreviation:p.team.abbreviation}));
  if(participants.length!==2) return null;
  const state=c.status?.type?.state || raw.status?.type?.state;
  return {id:`nba-${raw.id}`,sport:'basketball',league:'NBA',title:participants.map(p=>p.name).join(' VS '),participants,
    startTime:raw.date,status:state==='in'?'live':state==='post'?'finished':'scheduled'};
}
export async function getEvents(rawQuery) {
  const query=parseQuery(rawQuery);
  if(!['team','matchup','league'].includes(query.kind)) return {events:[],alternatives:[],query,complete:true};
  const now=new Date(); const season=now.getUTCFullYear()+(now.getUTCMonth()>=8?1:0);
  let requests;
  if(query.teams.length) {
    // One team's complete published season is enough to establish whether a matchup exists.
    requests=[1,2,3].map(type=>data(`/teams/${query.teams[0].id}/schedule?season=${season}&seasontype=${type}`,30*60000));
  } else {
    // Include the previous UTC date so late-evening games in North America do not
    // disappear after UTC midnight. Filter/sort after normalization instead of
    // trusting Cloud Run's calendar date as the viewer's local day.
    requests=Array.from({length:8},(_,index)=>{
      const offset=index-1;
      const date=new Date(now.getTime()+offset*86400000).toISOString().slice(0,10).replaceAll('-','');
      return data(`/scoreboard?dates=${date}`,Math.abs(offset)<=1?60000:30*60000);
    });
  }
  const responses=await Promise.allSettled(requests);
  const good=responses.filter(x=>x.status==='fulfilled');
  if(!good.length) throw new AppError('SCHEDULE_UNAVAILABLE',503);
  const all=new Map();
  for(const response of good) for(const raw of response.value.events) {
    const event=normalizeEvent(raw); if(event) all.set(event.id,event);
  }
  for(const [id,event] of all) knownEvents.set(id,event);
  if(knownEvents.size>4000) for(const [id,event] of knownEvents) if(Date.parse(event.startTime)<Date.now()-86400000) knownEvents.delete(id);
  const events=selectEvents([...all.values()],query);
  const alternatives=query.kind==='matchup' && !events.length ? selectEvents([...all.values()],{teams:[query.teams[0]]}).slice(0,3) : [];
  return {events,alternatives,query,complete:good.length===responses.length,updatedAt:Date.now(),provider:'ESPN',coverage:query.teams.length?'PUBLISHED SEASON':'LIVE WINDOW + NEXT 6 DAYS'};
}
