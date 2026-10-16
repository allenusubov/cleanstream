import {searchSchedule,knownEvents} from './schedules.js';
import {parseQuery} from '../public/events.js';
import {catalogSearch,mergeEvents,isSportQuery} from './catalog.js';
import {gscCatalogSearch} from './gsc-feed.js';

export async function searchEvents(q) {
  const parsed=parseQuery(q);
  if(parsed.kind==='ambiguous')return {events:[],alternatives:[],query:parsed,complete:true,updatedAt:Date.now(),provider:'ESPN'};

  // ESPN is the primary sports event/schedule layer. For explicit sports and
  // NBA team/matchup queries, its schedule is authoritative.
  const explicitSport=['league','sport','team','matchup'].includes(parsed.kind)||isSportQuery(q);
  if(explicitSport){
    const [schedule,feed]=await Promise.allSettled([searchSchedule(q),gscCatalogSearch(q)]);
    if(schedule.status==='rejected'&&feed.status==='rejected')throw schedule.reason;
    const result=schedule.status==='fulfilled'?schedule.value:{events:[],complete:false,notices:['SCHEDULE_UNAVAILABLE']};
    const events=mergeEvents([...(result.events||[]),...(feed.status==='fulfilled'?feed.value:[])]);
    for(const event of events)knownEvents.set(event.id,event);
    return {...result,events,notices:[...(result.notices||[]),...(feed.status==='rejected'?['CATALOG_UNAVAILABLE']:[])],complete:result.complete!==false&&feed.status==='fulfilled'};
  }

  // Free-form live-event queries search schedules and the aggregator catalog.
  const [schedule,catalog,feed]=await Promise.allSettled([searchSchedule(q),catalogSearch(q),gscCatalogSearch(q)]);
  const notices=[];
  if(schedule.status==='rejected')notices.push('SCHEDULE_UNAVAILABLE');
  if(catalog.status==='rejected')notices.push('CATALOG_UNAVAILABLE');
  if(feed.status==='rejected'&&!notices.includes('CATALOG_UNAVAILABLE'))notices.push('CATALOG_UNAVAILABLE');
  const events=mergeEvents([
    ...(schedule.status==='fulfilled'?schedule.value.events:[]),
    ...(catalog.status==='fulfilled'?catalog.value:[]),
    ...(feed.status==='fulfilled'?feed.value:[])
  ]).slice(0,100);
  for(const event of events)knownEvents.set(event.id,event);
  return {events,alternatives:[],query:parsed,complete:notices.length===0,notices,updatedAt:Date.now()};
}
