import test from 'node:test';
import assert from 'node:assert/strict';
import {eventStreamRoutes,walkEventStreams,extractionError} from '../lib/event-streams.js';
import {playResolvedCandidates} from '../public/resolution-session.js';
import {AppError} from '../lib/network.js';

test('event source rows and nested players survive parsing; navigation, private URLs and chat do not',()=>{
  const base='https://sports.example/Toronto-Raptors-vs-New-York-Knicks/74862';
  const routes=eventStreamRoutes(`<a href="/nba-streams">NBA</a><a href="/">Home</a>
    <iframe src="https://player.example/event/123"></iframe><iframe src="https://www.youtube.com/live_chat?v=x"></iframe>
    <a class="nocolor w-100" href="https://mirror.example/player?id=1&amp;token=kept">Mirror 1</a>
    <a class="nocolor w-100" href="https://mirror.example/player?id=1&amp;token=kept#player">Mirror 1</a>
    <a class="nocolor" href="http://127.0.0.1/private">bad</a><a class="nocolor" href="javascript:alert(1)">bad</a>
    <a href="https://second.example/knicks-vs-raptors">Watch game</a><a class="nocolor" href="/lakers-vs-warriors">Other event</a><a href="/unrelated">Watch</a>`,base);
  assert.equal(routes.length,3);assert.equal(routes[0].kind,'frame');assert.equal(routes[1].url,'https://mirror.example/player?id=1&token=kept');
  assert.equal(routes[2].url,'https://second.example/knicks-vs-raptors');
});
test('one failing embedded player cannot hide a working sibling; feeds are deduplicated and published early',async()=>{
  const root='https://sports.example/game',published=[],calls=[];let slowFinished=false;
  const result=await walkEventStreams(root,{scanAll:true,inspectStatic:async(url,route)=>{
    calls.push(url);
    if(url===root)return {media:[],routes:[{url:'https://bad.example/'},{url:'https://good.example/'},{url:'https://slow.example/'}]};
    if(url.includes('bad.'))throw new Error('net::ERR_CONNECTION_RESET');
    if(url.includes('slow.')){await new Promise(r=>setTimeout(r,30));slowFinished=true;return {media:[{url:'https://cdn.example/live.m3u8'}],routes:[]};}
    assert.equal(route.parentUrl,root);return {media:[{url:'https://cdn.example/live.m3u8'}],routes:[]};
  },inspectBrowser:async()=>{throw new Error('broken browser route');},onCandidate:item=>{assert.equal(slowFinished,false);published.push(item);}});
  assert.equal(result.candidates.length,1);assert.equal(published.length,1);assert.equal(published[0].routeUrl,'https://good.example/');assert.ok(result.failures.length);assert.equal(calls.length,4);
});
test('walker reaches nested iframe players, orders known providers first, and enforces crawl bounds',async()=>{
  const calls=[];const result=await walkEventStreams('https://root.example/event',{
    maxRoutes:7,maxDepth:2,priority:url=>url.includes('known')?100:0,inspectStatic:async url=>{
      calls.push(url);if(url.includes('root.'))return {media:[],routes:Array.from({length:40},(_,i)=>({url:`https://${i===5?'known':'r'+i}.example/`,kind:'link'}))};
      return {media:[],routes:[{url:url+'nested'}]};
    },inspectBrowser:async()=>({media:[],routes:[]})});
  assert.equal(calls[1],'https://known.example/');assert.equal(result.totalRoutes,7);assert.equal(result.partial,true);
});
test('browser-discovered event links enter the same bounded queue',async()=>{
  const result=await walkEventStreams('https://root.example/',{inspectStatic:async url=>url.includes('child')?{media:[{url:'https://cdn.example/stream.m3u8'}],routes:[]}:{media:[],routes:[]},
    inspectBrowser:async()=>({media:[],routes:[{url:'https://child.example/'}]})});
  assert.equal(result.candidates[0].url,'https://cdn.example/stream.m3u8');
});
test('cancellation stops pending routes and reaches active inspection work',async()=>{
  const controller=new AbortController(),calls=[];
  await assert.rejects(walkEventStreams('https://root.example/',{signal:controller.signal,inspectStatic:async url=>{
    calls.push(url);controller.abort(new DOMException('User left player','AbortError'));return {media:[],routes:[{url:'https://never.example/'}]};
  },inspectBrowser:async()=>{assert.fail('browser should not start');}}),{name:'AbortError'});
  assert.deepEqual(calls,['https://root.example/']);
});
test('extraction errors preserve useful distinctions instead of blaming source playback',()=>{
  assert.equal(extractionError(new Error('page.goto: net::ERR_CONNECTION_RESET')).code,'SOURCE_NETWORK_ERROR');
  assert.equal(extractionError(new Error('unexpected runtime failure')).code,'EXTRACTION_FAILED');
  assert.equal(extractionError(new Error('Timeout 6000ms exceeded')).code,'SOURCE_TIMEOUT');
  const unavailable=new AppError('BROWSER_UNAVAILABLE',503);assert.equal(extractionError(unavailable),unavailable);
});
test('progressive playback tries a later feed after failure and cancels remaining inspection on success',async()=>{
  const tried=[],found=[];let networkSignal,cancelled=false;
  const result=await playResolvedCandidates({signal:new AbortController().signal,
    open:async signal=>{networkSignal=signal;return new Response(new ReadableStream({start(controller){
      const send=data=>controller.enqueue(new TextEncoder().encode(JSON.stringify(data)+'\n'));
      send({type:'candidate',candidate:{mediaUrl:'https://cdn.example/bad.mp4'}});
      send({type:'candidate',candidate:{mediaUrl:'https://cdn.example/bad.mp4'}});
      send({type:'candidate',candidate:{mediaUrl:'https://cdn.example/good.mp4'}});
    },cancel(){cancelled=true;}}),{headers:{'content-type':'application/x-ndjson'}});},
    onCandidate:item=>found.push(item.mediaUrl),play:async item=>{tried.push(item.mediaUrl);if(item.mediaUrl.includes('bad'))throw new Error('DECODE_ERROR');}});
  assert.ok(result.mediaUrl.includes('good'));assert.equal(tried.length,2);assert.equal(found.length,2);assert.equal(networkSignal.aborted,true);assert.equal(cancelled,true);
});
test('an inspection error after a candidate does not discard that playable candidate',async()=>{
  const response=new Response(JSON.stringify({type:'candidate',candidate:{mediaUrl:'https://cdn.example/live.mp4'}})+'\n'+JSON.stringify({type:'error',code:'EXTRACTION_FAILED'})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  const item=await playResolvedCandidates({signal:new AbortController().signal,open:async()=>response,play:async()=>{}});assert.ok(item.mediaUrl.includes('live'));
});
test('empty and invalid resolver responses report extraction or server errors accurately',async()=>{
  const run=response=>playResolvedCandidates({signal:new AbortController().signal,open:async()=>response,play:async()=>assert.fail()});
  await assert.rejects(run(new Response('{"type":"error","code":"EXTRACTION_FAILED"}\n',{headers:{'content-type':'application/x-ndjson'}})),/EXTRACTION_FAILED/);
  await assert.rejects(run(new Response('unavailable',{status:502})),/RESOLVER_UNAVAILABLE/);
});
test('transport cleanup cannot keep a successfully playing video busy',async()=>{
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"type":"candidate","candidate":{"mediaUrl":"https://cdn.example/live.mp4"}}\n'));},cancel(){return new Promise(()=>{});}}),{headers:{'content-type':'application/x-ndjson'}});
  let timer;
  try{
    const result=await Promise.race([playResolvedCandidates({signal:new AbortController().signal,open:async()=>response,play:async()=>{}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cleanup blocked playback')),100);})]);
    assert.ok(result.mediaUrl.includes('live.mp4'));
  }finally{clearTimeout(timer);}
});
test('failed device playback is distinguished from failed inspection',async()=>{
  const response=new Response('{"candidates":[{"mediaUrl":"https://cdn.example/bad.mp4"}]}',{headers:{'content-type':'application/json'}});
  await assert.rejects(playResolvedCandidates({signal:new AbortController().signal,open:async()=>response,play:async()=>{throw new Error('DECODE_ERROR');}}),error=>error.message==='NO_DEVICE_PLAYBACK'&&error.cause.message==='DECODE_ERROR');
});
test('HTTP resolver streams candidates and completion without relaying video',async()=>{
  const original=global.fetch;
  global.fetch=async()=>new Response('<video src="https://8.8.8.8/real-stream.m3u8"></video>',{headers:{'content-type':'text/html'}});
  const {app}=await import('../server.js');const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
    const response=await original(`http://127.0.0.1:${server.address().port}/api/resolve`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://8.8.8.8/v22-event',stream:true})});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/ndjson/);
    const events=(await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.find(event=>event.type==='candidate').candidate.mediaUrl,'https://8.8.8.8/real-stream.m3u8');assert.equal(events.at(-1).type,'done');
    const invalid=await original(`http://127.0.0.1:${server.address().port}/api/resolve`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'http://127.0.0.1/private',stream:true})});
    assert.match(await invalid.text(),/INVALID_URL/);
  }finally{global.fetch=original;server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('event discovery preserves a current event directory when deeper extraction has not produced media',async()=>{
  const original=global.fetch;
  global.fetch=async()=>new Response('<a class="nocolor" href="https://8.8.4.4/embed/game">Provider stream option</a>',{headers:{'content-type':'text/html'}});
  try{
    const {eventJob}=await import('../lib/discovery.js');
    const event={id:'nba-v22-options',league:'NBA',status:'live',participants:[{name:'Knicks'},{name:'Raptors'}]};
    const site={id:'v22-options-site',enabled:true,custom:true,displayHost:'8.8.8.8',events:{[event.id]:'https://8.8.8.8/v22-options'}};
    const job=eventJob(event,'https://options.example',[site]);let announced=false;
    const observed=new Promise(resolve=>job.listeners.add(state=>{if(state.sources.some(value=>value.hasStreamOptions)){announced=true;job.cancel();resolve();}}));
    job.start();await observed;await job.promise;
    assert.equal(announced,true);assert.ok(job.sources.some(value=>value.sourceUrl==='https://8.8.8.8/v22-options'&&value.hasStreamOptions&&!value.mediaUrl));
  }finally{global.fetch=original;}
});
