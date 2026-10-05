import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import {getLiveWindow,normalizeEvent,scheduleProviders} from '../lib/schedules.js';

test('ESPN normalization supports non-NBA event-shaped sports',()=>{
  const ufc=scheduleProviders.find(item=>item.key==='UFC');
  const event=normalizeEvent({id:'999',name:'UFC 999: Example',date:'2026-10-05T23:00:00Z',status:{type:{state:'pre'}},competitions:[]},ufc);
  assert.equal(event.id,'ufc-999');
  assert.equal(event.title,'UFC 999: Example');
  assert.equal(event.league,'UFC');
});

test('live window merges multiple ESPN sports and keeps only live/next-24-hour events',async()=>{
  const oldFetch=global.fetch,oldLookup=dns.lookup;
  const now=Date.parse('2026-10-05T12:00:00Z');
  dns.lookup=async()=>[{address:'8.8.8.8'}];
  global.fetch=async value=>{
    const url=String(value);let events=[];
    if(url.includes('/football/nfl/'))events=[{id:'nfl1',date:'2026-10-05T13:00:00Z',name:'Atlanta Falcons at New Orleans Saints',competitions:[{status:{type:{state:'pre'}},competitors:[{team:{id:'1',displayName:'Atlanta Falcons'}},{team:{id:'2',displayName:'New Orleans Saints'}}]}]}];
    if(url.includes('/basketball/nba/'))events=[{id:'nba1',date:'2026-10-05T11:00:00Z',name:'Knicks at 76ers',competitions:[{status:{type:{state:'in'}},competitors:[{team:{id:'18',displayName:'New York Knicks'}},{team:{id:'20',displayName:'Philadelphia 76ers'}}]}]}];
    if(url.includes('/hockey/nhl/'))events=[{id:'old',date:'2026-10-04T01:00:00Z',name:'Old game',competitions:[{status:{type:{state:'post'}},competitors:[]}]}];
    return new Response(JSON.stringify({events}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const result=await getLiveWindow(24,now);
    assert.equal(result.events.some(event=>event.id==='nfl-nfl1'),true);
    assert.equal(result.events.some(event=>event.id==='nba-nba1'&&event.status==='live'),true);
    assert.equal(result.events.some(event=>event.id==='nhl-old'),false);
  }finally{global.fetch=oldFetch;dns.lookup=oldLookup;}
});
