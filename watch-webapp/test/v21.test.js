import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import {PlaybackEvidence,recordPlayback,loadPlaybackHistory,playbackLabel,playbackContext,historyPriority} from '../public/playback-history.js';
import {inspectionLabel,inspectionFailure} from '../public/source-status.js';
import {loadCustomSources,CUSTOM_SOURCE_KEY,recordCustomSourceSuccess} from '../public/custom-sources.js';
import {directoryLinks} from '../lib/directory.js';
import {adapterRoutes,structuredEventLinks} from '../lib/provider-adapters.js';
process.env.SOURCE_REGISTRY_JSON='[]';
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};};

test('playback evidence rejects canplay, frozen time and seek jumps and records sustained progress once',()=>{
  let successes=0;const proof=new PlaybackEvidence(()=>successes++);
  proof.sample(0,true,0);proof.sample(0,true,1000);proof.sample(100,true,2000);assert.equal(successes,0);
  proof.sample(101,true,3000);proof.sample(102,true,4000);proof.sample(103,true,5000);assert.equal(successes,1);
  proof.sample(104,true,6000);assert.equal(successes,1);
});
test('playback outcomes are isolated by browser, receiver, event and feed',()=>{
  const saved=storage(),item={providerHost:'sports.example',mediaUrl:'https://cdn.example/feed.m3u8?token=secret',categoryUrl:'https://sports.example/nba'};
  const event={id:'nba-one',league:'NBA'};
  recordPlayback(item,event,'chrome:local','success',{now:10000,startupMs:800},saved);
  recordPlayback(item,event,'chrome:cast','failure',{now:20000,reason:'FORMAT_UNSUPPORTED'},saved);
  const rows=loadPlaybackHistory(saved);assert.equal(rows.length,2);assert.ok(!JSON.stringify(rows).includes('secret'));
  assert.equal(playbackLabel(item,event,'chrome:local',rows),'PLAYED ON THIS DEVICE');
  assert.equal(playbackLabel(item,event,'chrome:cast',rows),'FAILED ON THIS DEVICE — TRY AGAIN');
  assert.equal(playbackLabel(item,event,'safari:local',rows),'FOUND — UNTESTED');
  assert.equal(playbackLabel({...item,mediaUrl:'https://cdn.example/other.m3u8'},event,'chrome:cast',rows),'PAST PLAYBACK FAILURES — TRY SOURCE');
  assert.equal(playbackLabel(item,{...event,id:'nba-new'},'chrome:local',rows),'PROVIDER PLAYED ON THIS DEVICE');
  assert.equal(playbackContext('Chrome/154 Safari/537.36','cast'),'chrome:cast');
});
test('repeated direct failures lower priority temporarily and successful retry restores it',()=>{
  const saved=storage(),item={providerHost:'a.example',mediaUrl:'https://cdn.example/a.m3u8'},event={id:'one',league:'NBA'},now=Date.now();
  for(let i=0;i<3;i++)recordPlayback(item,event,'chrome:local','failure',{reason:'ACCESS_DENIED',now:now+i},saved);
  const failed=loadPlaybackHistory(saved)[0];assert.ok(historyPriority(failed,now+3)<0);
  assert.equal(historyPriority(failed,now+7*3600000),0);
  recordPlayback(item,event,'chrome:local','success',{now:now+100,startupMs:400},saved);
  assert.ok(historyPriority(loadPlaybackHistory(saved)[0],now+101)>0);
});
test('legacy FAILED inspection retains routes and never means direct playback failed',()=>{
  const saved=storage();saved.setItem(CUSTOM_SOURCE_KEY,JSON.stringify([{url:'https://sports.example/',categories:{NBA:['https://sports.example/nba#','https://sports.example/nba']},test:{status:'FAILED',reason:'TEST REQUEST FAILED'}}]));
  const item=loadCustomSources(saved)[0];assert.deepEqual(item.categories.NBA,['https://sports.example/nba']);
  assert.equal(inspectionLabel(item),'ROUTES SAVED · LAST CHECK INCOMPLETE');
  assert.equal(inspectionFailure({code:'SOURCE_TIMEOUT'}).status,'INCOMPLETE');assert.deepEqual(loadPlaybackHistory(saved),[]);
  recordCustomSourceSuccess(item.url,200,{categoryUrl:'https://sports.example/current-nba',sport:'NBA'},saved);
  assert.equal(loadCustomSources(saved)[0].categories.NBA[0],'https://sports.example/current-nba');
});
test('event directory preserves empty/title links and contextual Watch links',()=>{
  const links=directoryLinks('<article><h2>Toronto Raptors vs Boston Celtics</h2><a href="/game/123">WATCH</a></article><a href="/jazz-vs-nuggets"></a><a href="/other" title="Knicks vs Nets"></a>','https://sports.example/');
  assert.match(links[0].text,/Toronto Raptors/);assert.equal(links[1].url,'https://sports.example/jazz-vs-nuggets');assert.equal(links[2].text,'Knicks vs Nets');
});
test('structured event feeds preserve new IDs and signed media URLs',()=>{
  const url='https://cdn.example/hls?id=456&token=valid';
  const links=structuredEventLinks(JSON.stringify({events:[{title:'Knicks vs Nets',watchUrl:url}]}),'https://sports.example/');
  assert.deepEqual(links,[{url,text:'Knicks vs Nets'}]);
  assert.equal(structuredEventLinks('<script id="__NEXT_DATA__">{"events":[{"name":"Knicks vs Nets","href":"/event/new"}]}</script>','https://sports.example/')[0].url,'https://sports.example/event/new');
  assert.deepEqual(adapterRoutes({indexUrls:['https://streameaste.is/']},{league:'NBA'}),['https://streameaste.is/nba-streams']);
});
test('saved category lists find a new game without visiting the homepage or the old event page',async()=>{
  const oldFetch=global.fetch;const calls=[];
  global.fetch=async url=>{calls.push(String(url));return new Response('<a href="/new-game">Toronto Raptors vs Boston Celtics</a>',{headers:{'content-type':'text/html'}});};
  try{
    const {genericPages}=await import('../lib/discovery.js');
    const event={id:'nba-new-category',league:'NBA',participants:[{name:'Toronto Raptors'},{name:'Boston Celtics'}]};
    const pages=await genericPages({id:'category-test',custom:true,dynamic:false,indexUrls:['https://8.8.8.8/'],categories:{NBA:['https://8.8.8.8/nba-streams']}},event,{light:true});
    assert.equal(pages[0].url,'https://8.8.8.8/new-game');assert.equal(pages[0].categoryUrl,'https://8.8.8.8/nba-streams');assert.deepEqual(calls,['https://8.8.8.8/nba-streams']);
  }finally{global.fetch=oldFetch;}
});
test('provider queue checks four at a time, uses playback priority, resumes and deduplicates matching feeds',async()=>{
  const {eventJob,providerPriority}=await import('../lib/discovery.js');
  const event={id:'nba-batch-test',league:'NBA',title:'Knicks vs Nets',status:'live',participants:[{name:'Knicks'},{name:'Nets'}]};
  const sites=Array.from({length:8},(_,i)=>({id:'batch-'+i,enabled:true,custom:true,displayHost:'s'+i+'.example',indexUrls:['https://8.8.8.8/provider-'+i],events:{[event.id]:'https://8.8.8.8/batch-'+(i===6?7:i)+'.m3u8'}}));
  const playbackHistory=[{host:'s7.example',sport:'NBA',context:'chrome:local',successes:3,lastSuccessAt:Date.now(),avgStartupMs:400},
    {host:'s0.example',sport:'NBA',context:'chrome:local',failures:4,consecutiveFailures:4,lastFailureAt:Date.now(),reason:'ACCESS_DENIED'}];
  assert.ok(providerPriority(sites[7],event,playbackHistory)>providerPriority(sites[1],event,playbackHistory));
  assert.ok(providerPriority(sites[0],event,playbackHistory)<providerPriority(sites[1],event,playbackHistory));
  const first=eventJob(event,'https://batch.example',sites,{mode:'light',playbackHistory});first.start();await first.promise;
  assert.equal(first.cursor,4);assert.equal(first.continuation,true);assert.ok(first.sources.some(source=>source.siteId==='batch-7'));assert.ok(!first.sources.some(source=>source.siteId==='batch-0'));
  assert.ok(first.sources.every(source=>source.provisional&&!source.castEligible));
  const second=eventJob(event,'https://batch.example',sites,{mode:'light',playbackHistory,resume:true});second.start();await second.promise;
  // The next click checks exactly the four remaining providers.
  assert.equal(second.cursor,8);assert.equal(new Set(second.sources.map(source=>source.mediaUrl)).size,second.sources.length);
  const changed=[...playbackHistory,{host:'s6.example',sport:'NBA',context:'chrome:local',successes:1,lastSuccessAt:Date.now()}];
  const resumed=eventJob(event,'https://batch.example',sites,{mode:'light',playbackHistory:changed,resume:true,checkedProviderIds:first.snapshot().checkedProviderIds});resumed.start();await resumed.promise;
  assert.equal(resumed.completedSiteIds.size,8);assert.equal(resumed.continuation,false);
  assert.ok(!resumed.sources.some(source=>first.snapshot().checkedProviderIds.includes(source.siteId)));
  const retry=eventJob(event,'https://batch.example',sites,{mode:'light',playbackHistory,recheck:true});assert.notEqual(retry,second);assert.equal(retry.cursor,0);
});


test('resolver preserves escaped signed URLs and recognizes extensionless HLS responses',async()=>{
  const original=global.fetch;
  try{
    const {resolve}=await import('../lib/resolver.js');
    global.fetch=async()=>new Response(String.raw`{"url":"https:\/\/8.8.8.8\/live.m3u8?id=555\u0026token=kept"}`,{headers:{'content-type':'application/json'}});
    const signed=await resolve('https://8.8.8.8/escaped-stream.json','https://app.example');
    assert.equal(signed.candidates[0].mediaUrl,'https://8.8.8.8/live.m3u8?id=555&token=kept');
    global.fetch=async()=>new Response('#EXTM3U\n#EXTINF:6,\na.ts',{headers:{'content-type':'application/octet-stream'}});
    const noExtension=await resolve('https://8.8.8.8/manifest-endpoint?id=555','https://app.example');assert.equal(noExtension.candidates[0].isHls,true);
  }finally{global.fetch=original;}
});


test('explicit RECHECK bypasses cached candidates and re-extracts the current event page',async()=>{
  const original=global.fetch;let current='old',calls=0;
  global.fetch=async()=>{calls++;return new Response('<video src="https://8.8.8.8/'+current+'.m3u8"></video>',{headers:{'content-type':'text/html'}});};
  try{
    const {eventJob}=await import('../lib/discovery.js');const event={id:'nba-explicit-recheck',league:'NBA',status:'live',participants:[{name:'Knicks'},{name:'Nets'}]};
    const site={id:'recheck-cache',enabled:true,custom:false,displayHost:'8.8.8.8',events:{[event.id]:'https://8.8.8.8/rotating-player.html'}};
    const first=eventJob(event,'https://recheck.example',[site]);first.start();await first.promise;assert.equal(first.sources[0].mediaUrl,'https://8.8.8.8/old.m3u8');
    current='new';const second=eventJob(event,'https://recheck.example',[site],{recheck:true});second.start();await second.promise;
    assert.equal(second.sources[0].mediaUrl,'https://8.8.8.8/new.m3u8');assert.equal(calls,2);
  }finally{global.fetch=original;}
});
