import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQuery,selectEvents,matchesParticipants} from '../public/events.js';
import {privateAddress,safeURL,fetchLimited,WorkPool} from '../lib/network.js';
import {parsePlaylist,validate} from '../lib/resolver.js';
import {normalizeEvent} from '../lib/schedules.js';
import {watchable,rank,eventJob,linkMatchesEvent,linkMatchesCategory,siteSupportsEvent} from '../lib/discovery.js';
test('team, abbreviation, typo and matchup queries remain distinct',()=>{
  for(const q of ['KNICKS','NYK','NEW YORK KNICKS','kniks'])assert.equal(parseQuery(q).teams[0].id,'18');
  assert.equal(parseQuery('KNICKS CELTICS').kind,'matchup');
  assert.equal(parseQuery('new orleans pelicans').teams.length,1);
  assert.equal(parseQuery('NBA').kind,'league');
  assert.equal(parseQuery('UFC 325').kind,'sport');
  assert.equal(parseQuery('NFL').league,'NFL');
  assert.equal(parseQuery('zzzz').kind,'unknown');
});
test('nonexistent matchups return no events, without confusing individual teams',()=>{
  const event={id:'1',startTime:new Date(Date.now()+3600000).toISOString(),status:'scheduled',participants:[{id:'18'},{id:'2'}]};
  assert.equal(selectEvents([event],parseQuery('knicks spurs')).length,0);
  assert.equal(selectEvents([event],parseQuery('knicks celtics')).length,1);
  assert.equal(matchesParticipants('Knicks vs Celtics',event.participants),true);
  assert.equal(matchesParticipants('Knicks vs Lakers',event.participants),false);
});


test('source adapters can recognize sport category links before searching event links',()=>{
  const site={categoryAliases:{NFL:['american football']}};
  const event={league:'NFL',sport:'football'};
  assert.equal(linkMatchesCategory({url:'https://example.com/nfl',text:'NFL'},site,event),true);
  assert.equal(linkMatchesCategory({url:'https://example.com/sports/american-football',text:''},site,event),true);
  assert.equal(linkMatchesCategory({url:'https://example.com/nba',text:'NBA'},site,event),false);
});

test('source discovery can match an event from a clean URL slug even when anchor text is empty',()=>{
  const event={participants:[{id:'26',name:'Utah Jazz'},{id:'7',name:'Denver Nuggets'}]};
  assert.equal(linkMatchesEvent({url:'https://streamseast.eu/nba/401914127/jazz-vs-nuggets',text:''},event),true);
  assert.equal(linkMatchesEvent({url:'https://streamseast.eu/nba/401914127/lakers-vs-suns',text:''},event),false);
});
test('private and mapped network destinations are rejected',async()=>{
  for(const ip of ['127.0.0.2','10.1.1.1','169.254.169.254','100.64.1.1','192.168.1.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','fc00::1'])assert.equal(privateAddress(ip),true,ip);
  assert.equal(privateAddress('8.8.8.8'),false);
  for(const url of ['http://127.0.0.2','http://[::ffff:127.0.0.1]','https://a:b@example.com','file:///etc/passwd'])await assert.rejects(safeURL(url));
});
test('redirects cannot fetch private addresses and byte samples stay bounded',async()=>{
  const old=global.fetch;let calls=0;
  try{
    global.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1'}});};
    await assert.rejects(fetchLimited('https://8.8.8.8'));assert.equal(calls,1);
    global.fetch=async()=>new Response(new Uint8Array(100000));
    assert.equal((await fetchLimited('https://8.8.8.8',{limit:64,partial:true})).body.length,64);
    await assert.rejects(fetchLimited('https://8.8.8.8',{limit:64}));
  }finally{global.fetch=old;}
});
test('work pool limits concurrency and refuses excessive work',async()=>{
  const pool=new WorkPool(2,3,5);let active=0,peak=0;
  await Promise.all(Array.from({length:5},()=>pool.run(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;})));
  assert.equal(peak,2);assert.equal(pool.active,0);await assert.rejects(pool.run(async()=>{}),/USAGE_LIMIT/);
});
test('HLS validation checks direct segment access, not just manifest HTTP status',async()=>{
  const old=global.fetch;let segmentCORS=false;
  const manifest='#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST';
  global.fetch=async url=>url.endsWith('.m3u8')?new Response(manifest,{headers:{'access-control-allow-origin':'*'}}):new Response(new Uint8Array(188),{headers:{'content-type':'video/mp2t',...(segmentCORS?{'access-control-allow-origin':'*'}:{})}});
  try{
    await assert.rejects(validate({url:'https://8.8.8.8/live.m3u8',isHls:true},'https://cleanstream.cloud.run'),/DIRECT_BLOCKED/);
    segmentCORS=true;const item=await validate({url:'https://8.8.8.8/live.m3u8',isHls:true},'https://cleanstream.cloud.run');
    assert.equal(item.mediaUrl,'https://8.8.8.8/live.m3u8');assert.equal(item.castEligible,true);assert.equal(item.live,false);assert.ok(!JSON.stringify(item).includes('/api/media/'));
  }finally{global.fetch=old;}
});
test('playlist state and event timing do not confuse VOD with live events',()=>{
  const p=parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:23\n#EXTINF:8,\na.ts','https://example.com/live/index.m3u8');
  assert.equal(p.duration,8);assert.equal(p.sequence,23);assert.equal(p.live,true);assert.equal(p.segments[0],'https://example.com/live/a.ts');
  const future={id:'nba-future',status:'scheduled',startTime:new Date(Date.now()+86400000).toISOString()};
  assert.equal(watchable(future),false);assert.throws(()=>eventJob(future,'https://example.com'),/NOT_STARTED/);
  const ranked=rank([{score:5},{score:10}]);assert.equal(ranked[0].recommended,true);assert.equal(ranked[1].recommended,false);
});
test('normalized schedules carry participants and real status',()=>{
  const event=normalizeEvent({id:'123',date:'2026-10-04T23:00Z',competitions:[{status:{type:{state:'in'}},competitors:[{team:{id:'18',displayName:'New York Knicks',shortDisplayName:'Knicks'}},{team:{id:'2',displayName:'Boston Celtics',shortDisplayName:'Celtics'}}]}]});
  assert.equal(event.id,'nba-123');assert.equal(event.status,'live');assert.equal(event.participants.length,2);assert.equal(event.participants[0].shortName,'Knicks');
  assert.equal(normalizeEvent({id:'bad',date:'invalid'}),null);
});
test('simultaneous viewers share one validation job per event',()=>{
  const event={id:'nba-shared',league:'NBA',status:'live',startTime:new Date().toISOString()};
  assert.equal(eventJob(event,'https://example.com'),eventJob(event,'https://example.com'));
});
test('frozen HLS is rejected instead of called healthy',async()=>{
  const old=global.fetch;
  global.fetch=async url=>new Response(url.endsWith('.m3u8')?'#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,\na.ts':new Uint8Array(188),{headers:{'access-control-allow-origin':'*'}});
  try{await assert.rejects(validate({url:'https://8.8.8.8/frozen.m3u8',isHls:true},'https://example.com',{progress:true}),/SOURCE_FROZEN/);}
  finally{global.fetch=old;}
});

import {customRegistry} from '../lib/custom-sources.js';
import {normalizeCustomSourceUrl,loadCustomSources,addCustomSource,addCustomSources,setCustomSourceEnabled,removeCustomSource} from '../public/custom-sources.js';

test('custom source settings normalize, persist, toggle and remove browser registry rows',()=>{
  const data=new Map();
  const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};
  assert.equal(normalizeCustomSourceUrl('example.com'),'https://example.com/');
  addCustomSource('example.com',storage);
  assert.deepEqual(loadCustomSources(storage),[{url:'https://example.com/',enabled:true,categories:{},eventLists:[]}]);
  setCustomSourceEnabled('https://example.com/',false,storage);
  assert.equal(loadCustomSources(storage)[0].enabled,false);
  removeCustomSource('https://example.com/',storage);
  assert.equal(loadCustomSources(storage).length,0);
});

test('custom source settings accept multiple newline-separated URLs in one add',()=>{
  const data=new Map();
  const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};
  const result=addCustomSources('example.com\nhttps://second.test/path\n\nexample.com',storage);
  assert.equal(result.added,2);
  assert.equal(result.existing,1);
  assert.deepEqual(loadCustomSources(storage),[
    {url:'https://example.com/',enabled:true,categories:{},eventLists:[]},
    {url:'https://second.test/path',enabled:true,categories:{},eventLists:[]}
  ]);
});

test('custom source URLs become bounded wildcard discovery adapters',async()=>{
  const sites=await customRegistry(['https://8.8.8.8/sports','https://8.8.8.8/sports']);
  assert.equal(sites.length,1);
  assert.equal(sites[0].custom,true);
  assert.deepEqual(sites[0].leagues,['*']);
  assert.equal(sites[0].dynamic,true);
  assert.equal(sites[0].indexUrls[0],'https://8.8.8.8/sports');
});

import {profileFromLinks} from '../lib/source-profile.js';
import {setCustomSourceProfile,mergeCustomSourceProfile,enabledCustomSources,parseProfileLines} from '../public/custom-sources.js';

test('source TEST profile recognizes category and general event-list links across hosts',()=>{
  const profile=profileFromLinks([
    {url:'https://sports.example/nfl',text:'NFL'},
    {url:'https://catalog.example/basketball',text:'NBA'},
    {url:'https://events.example/live',text:'Live Events'}
  ],'https://sports.example/');
  assert.equal(profile.categories.NFL[0],'https://sports.example/nfl');
  assert.equal(profile.categories.NBA[0],'https://catalog.example/basketball');
  assert.equal(profile.eventLists[0],'https://events.example/live');
});

test('custom source profiles persist learned and manually supplied routes',()=>{
  const data=new Map();const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};
  addCustomSource('example.com',storage);
  setCustomSourceProfile('https://example.com/',{categories:{NFL:['https://catalog.example/nfl']},eventLists:['https://catalog.example/events']},storage);
  const item=enabledCustomSources(storage)[0];
  assert.equal(item.categories.NFL[0],'https://catalog.example/nfl');assert.equal(item.eventLists[0],'https://catalog.example/events');
  const parsed=parseProfileLines('NBA https://other.example/nba\nEVENTS https://other.example/live');
  assert.equal(parsed.categories.NBA[0],'https://other.example/nba');assert.equal(parsed.eventLists[0],'https://other.example/live');
});


test('source adapters are general by default and only sport-gated when explicitly restricted',()=>{
  const nfl={league:'NFL',sport:'football'};
  assert.equal(siteSupportsEvent({leagues:['NBA']},nfl),true);
  assert.equal(siteSupportsEvent({leagues:['NBA'],restrictLeagues:true},nfl),false);
  assert.equal(siteSupportsEvent({leagues:['*'],restrictLeagues:true},nfl),true);
});

test('custom profile editor accepts root-relative category paths',()=>{
  const parsed=parseProfileLines(`NFL /nfl\nNBA /nba\nEVENTS /live`,'https://sports.example/');
  assert.equal(parsed.categories.NFL[0],'https://sports.example/nfl');
  assert.equal(parsed.categories.NBA[0],'https://sports.example/nba');
  assert.equal(parsed.eventLists[0],'https://sports.example/live');
  assert.equal(parsed.invalid,0);
});

test('source TEST merges learned routes without overwriting manual routes',()=>{
  const data=new Map();const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};
  addCustomSource('example.com',storage);
  setCustomSourceProfile('https://example.com/',{categories:{NFL:['https://example.com/nfl']},eventLists:['https://example.com/events']},storage);
  mergeCustomSourceProfile('https://example.com/',{categories:{NFL:['https://catalog.example/nfl'],NBA:['https://example.com/nba']},eventLists:['https://catalog.example/live']},storage);
  const item=enabledCustomSources(storage)[0];
  assert.deepEqual(item.categories.NFL,['https://example.com/nfl','https://catalog.example/nfl']);
  assert.equal(item.categories.NBA[0],'https://example.com/nba');
  assert.deepEqual(item.eventLists,['https://example.com/events','https://catalog.example/live']);
});


test('manual custom routes preserve query strings and hash fragments exactly',()=>{
  const parsed=parseProfileLines('NFL /#nfl\nNBA /?sport=nba#live\nEVENTS #events','https://sports.example/');
  assert.equal(parsed.categories.NFL[0],'https://sports.example/#nfl');
  assert.equal(parsed.categories.NBA[0],'https://sports.example/?sport=nba#live');
  assert.equal(parsed.eventLists[0],'https://sports.example/#events');
  const data=new Map();const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};
  addCustomSource('sports.example',storage);
  setCustomSourceProfile('https://sports.example/',parsed,storage);
  assert.equal(enabledCustomSources(storage)[0].categories.NFL[0],'https://sports.example/#nfl');
});

test('source TEST discovery keeps same-page hash category routes',()=>{
  const profile=profileFromLinks([{url:'https://sports.example/#nfl',text:'NFL'},{url:'https://sports.example/#nba',text:'NBA'}],'https://sports.example/');
  assert.equal(profile.categories.NFL[0],'https://sports.example/#nfl');
  assert.equal(profile.categories.NBA[0],'https://sports.example/#nba');
});
