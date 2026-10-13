import {searchSchedule,knownEvents} from './schedules.js';
import {parseQuery} from '../public/events.js';
import {catalogSearch,mergeEvents,isSportQuery} from './catalog.js';

export async function searchEvents(q) {
  const parsed=parseQuery(q);
  if(parsed.kind==='ambiguous')return {events:[],alternatives:[],query:parsed,complete:true,updatedAt:Date.now(),provider:'ESPN'};

  // ESPN is the primary sports event/schedule layer. For explicit sports and
  // NBA team/matchup queries, its schedule is authoritative.
  const explicitSport=['league','sport','team','matchup'].includes(parsed.kind)||isSportQuery(q);
  if(explicitSport)return searchSchedule(q);

  // Free-form live-event queries search schedules and the aggregator catalog.
  const [schedule,catalog]=await Promise.allSettled([searchSchedule(q),catalogSearch(q)]);
  const notices=[];
  if(schedule.status==='rejected')notices.push('SCHEDULE_UNAVAILABLE');
  if(catalog.status==='rejected')notices.push('CATALOG_UNAVAILABLE');
  const events=mergeEvents([
    ...(schedule.status==='fulfilled'?schedule.value.events:[]),
    ...(catalog.status==='fulfilled'?catalog.value:[])
  ]).slice(0,100);
  for(const event of events)knownEvents.set(event.id,event);
  return {events,alternatives:[],query:parsed,complete:notices.length===0,notices,updatedAt:Date.now()};
}
