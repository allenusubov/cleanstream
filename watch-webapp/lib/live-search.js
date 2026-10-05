import {getEvents,knownEvents} from './schedules.js';
import {parseQuery} from '../public/events.js';
import {catalogSearch,mergeEvents,isSportQuery} from './catalog.js';
import {youtubeSearch} from './youtube.js';
import {twitchSearch} from './twitch.js';

export async function searchEvents(q) {
  const parsed=parseQuery(q);
  // The authoritative schedule remains the gate for NBA matchups. Never look
  // for sources if these teams are not scheduled against each other.
  if(['team','matchup','league','ambiguous'].includes(parsed.kind))return getEvents(q);

  const platformSearch=!isSportQuery(q);
  const results=await Promise.allSettled([
    catalogSearch(q),
    platformSearch?youtubeSearch(q):Promise.resolve({events:[],notice:null}),
    platformSearch?twitchSearch(q):Promise.resolve({events:[],notice:null})
  ]);
  const [sports,youtube,twitch]=results;
  const notices=[];
  if(sports.status==='rejected')notices.push('CATALOG_UNAVAILABLE');
  for(const [result,prefix] of [[youtube,'YOUTUBE'],[twitch,'TWITCH']]) {
    if(result.status==='fulfilled' && result.value.notice)notices.push(result.value.notice);
    if(result.status==='rejected')notices.push(`${prefix}_UNAVAILABLE`);
  }
  const events=mergeEvents([
    ...(sports.status==='fulfilled'?sports.value:[]),
    ...(youtube.status==='fulfilled'?youtube.value.events:[]),
    ...(twitch.status==='fulfilled'?twitch.value.events:[])
  ]).slice(0,100);
  for(const event of events)knownEvents.set(event.id,event);
  if(knownEvents.size>4000)for(const [id,event] of knownEvents)if(Date.parse(event.startTime)<Date.now()-86400000)knownEvents.delete(id);
  return {events,alternatives:[],query:parsed,complete:notices.length===0,notices,updatedAt:Date.now()};
}
