import {searchSchedule,knownEvents} from './schedules.js';
import {parseQuery} from '../public/events.js';
import {catalogSearch,mergeEvents,isSportQuery} from './catalog.js';
import {youtubeSearch} from './youtube.js';
import {twitchSearch} from './twitch.js';

export async function searchEvents(q) {
  const parsed=parseQuery(q);
  if(parsed.kind==='ambiguous')return {events:[],alternatives:[],query:parsed,complete:true,updatedAt:Date.now(),provider:'ESPN'};

  // ESPN is the primary sports event/schedule layer. For explicit sports and
  // NBA team/matchup queries, its schedule is authoritative.
  const explicitSport=['league','sport','team','matchup'].includes(parsed.kind)||isSportQuery(q);
  if(explicitSport)return searchSchedule(q);

  // Unknown/free-form queries may be a team name, a creator, or a general live
  // event. Search the multi-sport schedule and public live platforms together.
  const results=await Promise.allSettled([
    searchSchedule(q),
    catalogSearch(q),
    youtubeSearch(q),
    twitchSearch(q)
  ]);
  const [schedule,catalog,youtube,twitch]=results;
  const notices=[];
  if(schedule.status==='rejected')notices.push('SCHEDULE_UNAVAILABLE');
  if(catalog.status==='rejected')notices.push('CATALOG_UNAVAILABLE');
  for(const [result,prefix] of [[youtube,'YOUTUBE'],[twitch,'TWITCH']]) {
    if(result.status==='fulfilled'&&result.value.notice)notices.push(result.value.notice);
    if(result.status==='rejected')notices.push(`${prefix}_UNAVAILABLE`);
  }
  const events=mergeEvents([
    ...(schedule.status==='fulfilled'?schedule.value.events:[]),
    ...(catalog.status==='fulfilled'?catalog.value:[]),
    ...(youtube.status==='fulfilled'?youtube.value.events:[]),
    ...(twitch.status==='fulfilled'?twitch.value.events:[])
  ]).slice(0,100);
  for(const event of events)knownEvents.set(event.id,event);
  return {events,alternatives:[],query:parsed,complete:notices.length===0,notices,updatedAt:Date.now()};
}
