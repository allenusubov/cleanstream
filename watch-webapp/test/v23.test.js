import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import {GSC_ENDPOINT,decodeGscFeed,gscData,gscOptions,gscProviderPlayers,gscEventPages,gscPageRoutes,matchGscEvent,gscCatalogSearch,normalizeGscMatch,clearGscFeed} from '../lib/gsc-feed.js';
import {orderedSources,playSourceChoices,sourceCountLabel} from '../public/playback-selection.js';
import {configuredPlayerSources} from '../lib/player-sources.js';
import {allowsEmbedding} from '../lib/embed-policy.js';
import {playResolvedCandidates} from '../public/resolution-session.js';
process.env.SOURCE_REGISTRY_JSON='[]';
const codec={key:'vqW3n/yB1R+GwSPc4kJs2dCkV7kRmXaNy3lQ/3XkHJI=',plain:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',mixed:'MiljRIn9PX1o63wGBYTtFsKmEkSur-pC_U02cvzAdy5e8ZqLDgJ4OhVN7QbHxfWa'};
function encode(value){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(codec.key,'base64'),iv);
  const packed=Buffer.concat([iv,cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]).toString('base64url');
  return 'k1'+[...packed].map(c=>codec.mixed[codec.plain.indexOf(c)]).reverse().join('');
}
const now=Date.now(),start=new Date(now-100000).toISOString();
const match=(id,title,home,away,sport='basketball',league='nba')=>({id,api_id:`event-espn-league-${sport}-${league}-${400000000+id}`,title,home:{name:home},away:{name:away},sport,starts_at:start,timestamp:Date.parse(start),live:true,finished:false,streams:[
  {no:1,name:'Server 1',language:'English',embed_url:`https://sportycos.com/streameast.html?id=${id}`,real_url:`https://8.8.8.8/feed-${id}.m3u8`},
  {no:2,language:'Spanish',embed_url:`https://8.8.4.4/embed/${id}`}
]});
const knicks=match(701,'Toronto Raptors at New York Knicks','New York Knicks','Toronto Raptors');
const hockey=match(702,'Vancouver Canucks at Florida Panthers','Florida Panthers','Vancouver Canucks','hockey','nhl');
const warriors=match(703,'Los Angeles Lakers at Golden State Warriors','Golden State Warriors','Los Angeles Lakers');
const pending={...match(704,'Daniel Dubois vs Fabio Wardley','Daniel Dubois','Fabio Wardley','boxing','boxing'),streams:[]};
const fixture={matches:[knicks,hockey,warriors,pending]};
const event=m=>({id:'event-'+m.id,providerEventId:String(400000000+m.id),title:m.title,league:m.sport==='hockey'?'NHL':'NBA',startTime:start,participants:[{id:'18',name:m.home.name},{id:'28',name:m.away.name}]});
async function mockFeed(task){
  const originalFetch=global.fetch,originalLookup=dns.lookup;let calls=0;
  clearGscFeed();dns.lookup=async()=>[{address:'8.8.8.8',family:4}];
  global.fetch=async url=>{if(String(url)===GSC_ENDPOINT){calls++;return new Response(encode(fixture),{headers:{'content-type':'text/plain'}});}const parsed=new URL(url);if(parsed.hostname==='sportycos.com'&&parsed.pathname==='/streameast.html')return new Response(`<video src="https://8.8.8.8/feed-${parsed.searchParams.get('id')}.m3u8"></video>`,{headers:{'content-type':'text/html'}});return new Response('<html>Player</html>',{headers:{'content-type':'text/html'}});};
  try{return await task(()=>calls);}finally{global.fetch=originalFetch;dns.lookup=originalLookup;clearGscFeed();}
}
test('k1 feed reader authenticates and decodes the public player wire format',()=>{
  assert.deepEqual(decodeGscFeed(encode(fixture)),fixture);assert.deepEqual(decodeGscFeed(JSON.stringify(fixture)),fixture);
  const wire=encode(fixture),corrupt=wire.slice(0,-2)+(wire.at(-2)==='A'?'B':'A')+wire.at(-1);
  assert.throws(()=>decodeGscFeed(corrupt),error=>error.code==='FEED_FORMAT_CHANGED');assert.throws(()=>decodeGscFeed('k1bad'),error=>error.code==='FEED_FORMAT_CHANGED');
});
test('event matching covers multiple sports and rejects old or different event IDs',()=>{
  for(const m of fixture.matches)assert.equal(matchGscEvent(fixture.matches,event(m))[0].id,m.id);
  const repeat={...knicks,id:799,api_id:'event-espn-league-basketball-nba-499999999'};
  assert.deepEqual(matchGscEvent([repeat],event(knicks)),[]);
  assert.deepEqual(matchGscEvent([{...knicks,timestamp:now-48*3600000}],event(knicks)),[]);
  assert.equal(matchGscEvent([hockey],{...event(hockey),providerEventId:'',id:'other',participants:[{id:'18',name:'Florida Panthers'},{id:'28',name:'Vancouver Canucks'}]})[0].id,hockey.id);
});
test('feed options preserve signed targets, remove duplicates/private URLs and preserve published wrappers',()=>{
  const value={...knicks,streams:[...knicks.streams,{embed_url:knicks.streams[0].real_url},{embed_url:'http://127.0.0.1/private'},{embed_url:'https://www.youtube.com/watch?v=removed'},{embed_url:'https://cdn.example/video.m3u8?token=kept&x=1'}]};
  const options=gscOptions(value,'https://sportycos.com/us/us.html?id=old&ref=origin.example');
  assert.equal(options[0].url,knicks.streams[0].embed_url);assert.equal(options.filter(x=>x.url===knicks.streams[0].real_url).length,1);
  assert.ok(options.some(x=>x.url==='https://cdn.example/video.m3u8?token=kept&x=1'));
  assert.ok(options.every(x=>!x.url.includes('127.0.0.1')&&!x.url.includes('youtube.com')));assert.equal(new URL(options[0].parentUrl).searchParams.get('id'),'701');
});
test('saved old player URL discovers new event IDs, while a pasted missing ID never plays another event',async()=>mockFeed(async()=>{
  const pages=await gscEventPages(event(hockey),'https://sportycos.com/us/us.html?id=701&ref=origin.example');
  assert.ok(pages.length);assert.ok(pages.every(page=>new URL(page.parentUrl).searchParams.get('id')==='702'));
  await assert.rejects(gscPageRoutes('https://sportycos.com/us/us.html?id=999999'),error=>error.code==='EVENT_UNAVAILABLE');
  const wrapper=await gscPageRoutes('https://sportycos.com/streameast.html?id=701');assert.deepEqual(wrapper,[]);
}));
test('scheduled events without posted streams remain discoverable and get an accurate waiting status',async()=>mockFeed(async()=>{
  const pages=await gscEventPages(event(pending),'https://sportycos.com/');assert.equal(pages[0].streamsPending,true);
  await assert.rejects(gscPageRoutes('https://sportycos.com/us/us.html?id=704'),error=>error.code==='STREAMS_NOT_POSTED');
  const {eventJob}=await import('../lib/discovery.js'),e=event(pending);e.id='v23-pending-event';
  const job=eventJob(e,'https://pending.example',[{id:'v23-waiting-site',enabled:true,type:'gsc',indexUrls:['https://sportycos.com/'],displayHost:'sportycos.com'}]);job.start();await job.promise;
  assert.equal(job.snapshot().providerChecks[0].status,'WAITING_FOR_STREAMS');assert.equal(job.sources.length,0);
}));
test('concurrent events share one metadata fetch, with no player or video requests',async()=>mockFeed(async calls=>{
  const results=await Promise.all(fixture.matches.map(m=>gscEventPages(event(m),'https://sportycos.com/')));
  assert.equal(calls(),1);assert.ok(results.every(pages=>pages.length>0));
}));
test('manual catalog searches include NBA, NHL and team matches from the feed',async()=>mockFeed(async()=>{
  assert.equal((await gscCatalogSearch('NBA')).length,2);assert.equal((await gscCatalogSearch('NHL'))[0].title,hockey.title);
  assert.equal((await gscCatalogSearch('Knicks'))[0].title,knicks.title);assert.equal((await gscCatalogSearch('Knicks Warriors')).length,0);
  assert.equal(normalizeGscMatch({...knicks,finished:true}),null);
}));
test('known player URLs resolve through the feed without requesting the provider HTML page',async()=>mockFeed(async calls=>{
  const {resolve}=await import('../lib/resolver.js');
  const result=await resolve('https://sportycos.com/us/us.html?id=701','https://feed-resolve.example');
  assert.ok(result.candidates.some(item=>(item.embedUrl||item.externalUrl)===knicks.streams[0].embed_url));assert.equal(calls(),1);
  assert.ok(result.candidates.every(item=>item.provisional&&!item.castEligible));
}));
test('event discovery publishes feed stream options before deeper extraction and reports checked providers',async()=>mockFeed(async()=>{
  const {eventJob}=await import('../lib/discovery.js');const e=event(knicks);e.id='v23-feed-discovery';
  const site={id:'v23-feed-site',enabled:true,custom:true,indexUrls:['https://sportycos.com/us/us.html?id=old'],displayHost:'sportycos.com'};
  const job=eventJob(e,'https://discovery-feed.example',[site]);let early=false;
  job.listeners.add(state=>{if(state.sources.some(source=>source.hasStreamOptions||source.embedUrl))early=true;});job.start();await job.promise;
  assert.equal(early,true);assert.ok(job.sources.some(source=>source.mediaUrl));assert.equal(job.snapshot().providerChecks[0].status,'LINKS_FOUND');
  assert.ok(job.sources.every(source=>source.sourceUrl.includes('id=701')));
}));
test('WATCH prefers an untried stream page over a feed that just failed on this device',()=>{
  const bad={id:'bad',sourceUrl:'https://bad.example/game',mediaUrl:'https://cdn.example/live.mp4'},page={id:'page',sourceUrl:'https://good.example/event',hasStreamOptions:true};
  const history=[{host:'bad.example',mediaHost:'cdn.example',feedKey:'https://cdn.example/live.mp4',eventId:'game',sport:'NBA',context:'chrome:local',lastFailureAt:now,lastSuccessAt:0,consecutiveFailures:2,reason:'ACCESS_DENIED'}];
  assert.equal(orderedSources([bad,page],{id:'game',league:'NBA'},'chrome:local',history)[0],page);
  assert.equal(sourceCountLabel([bad,page]),'1 VIDEO LINK · 1 STREAM PAGE');
});
test('failed direct video falls through to another provider page before retrying its own page',async()=>{
  const bad={id:'bad',mediaUrl:'https://cdn.example/bad.mp4',sourceUrl:'https://bad.example/game'},page={id:'page',sourceUrl:'https://good.example/game',hasStreamOptions:true},calls=[];
  const result=await playSourceChoices({items:[bad,page],selected:bad,event:{},history:[],context:'chrome:local',signal:new AbortController().signal,
    tryMedia:async()=>{calls.push('bad-video');throw new Error('DECODE_ERROR');},tryPage:async item=>{calls.push(item.sourceUrl);}});
  assert.equal(result,page);assert.deepEqual(calls,['bad-video','https://good.example/game']);
});
test('cancellation prevents further provider retries within WATCH',async()=>{
  const controller=new AbortController();
  await assert.rejects(playSourceChoices({items:[{mediaUrl:'https://a.example/a.mp4',sourceUrl:'https://a.example/'},{hasStreamOptions:true,sourceUrl:'https://b.example/'}],event:{},context:'chrome:local',signal:controller.signal,
    tryMedia:async()=>{controller.abort();throw new DOMException('Cancelled','AbortError');},tryPage:async()=>assert.fail('must not inspect another provider')}),{name:'AbortError'});
});
test('literal encoded and extensionless HLS player sources are discovered without executing JavaScript',()=>{
  const target='https://cdn.example/playlist/123/load-playlist?token=kept&x=1',b64=Buffer.from(target).toString('base64');
  const result=configuredPlayerSources(`<script>new Hls(); const source="${target}"; source:window.atob('${b64}');const file="https://127.0.0.1/private";</script>`,'https://player.example/');
  assert.equal(result.length,1);assert.equal(result[0].url,target);assert.equal(result[0].kind,'player-media');
});
test('provider players stay separate from direct media and are deduplicated by player URL',()=>{
  const players=gscProviderPlayers({...knicks,streams:[...knicks.streams,knicks.streams[0]]},'https://sportycos.com/');
  assert.equal(players.length,2);assert.ok(players.some(player=>player.embedUrl===knicks.streams[0].embed_url));assert.equal(players[0].mediaUrl,undefined);assert.equal(players[0].requiresProviderPlayer,true);
  assert.equal(orderedSources(players,event(knicks),'chrome:local',[]).length,2);assert.equal(sourceCountLabel(players),'2 PLAYER OPTIONS');
});
test('explicit embedding restrictions are respected instead of offering a blocked player',()=>{
  const parent='https://cleanstream.cloud.run',url='https://player.example/embed';
  assert.equal(allowsEmbedding(new Headers({'content-security-policy':"frame-ancestors 'self' allowed.example"}),parent,url),false);
  assert.equal(allowsEmbedding(new Headers({'content-security-policy':"default-src 'none'; frame-ancestors https://cleanstream.cloud.run"}),parent,url),true);
  assert.equal(allowsEmbedding(new Headers({'x-frame-options':'SAMEORIGIN'}),parent,url),false);
  assert.equal(allowsEmbedding(new Headers({'content-security-policy':'frame-ancestors https://*.cloud.run'}),parent,url),true);
  assert.equal(allowsEmbedding(new Headers({'content-security-policy':"frame-ancestors 'none'"}),parent,url),false);
});
test('original-site links are surfaced without autoplay, popup permissions, or false device playback',async()=>{
  const response=new Response(JSON.stringify({type:'candidate',candidate:{externalUrl:'https://sportycos.com/streameast.html?id=1'}})+'\n'+JSON.stringify({type:'done'})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  let shown=0;
  await assert.rejects(playResolvedCandidates({signal:new AbortController().signal,open:async()=>response,onCandidate:()=>shown++,play:async()=>assert.fail('must not autoplay/open original site')}),/ORIGINAL_SITE_REQUIRED/);
  assert.equal(shown,1);
});
test('non-ESPN feed IDs can match scheduled events by participants and time',()=>{
  const providerMatch={...hockey,api_id:'se-554433221'};
  assert.equal(matchGscEvent([providerMatch],event(hockey))[0].id,hockey.id);
  assert.deepEqual(matchGscEvent([{...providerMatch,timestamp:Date.parse(start)+2*3600000}],event(hockey)),[]);
});
