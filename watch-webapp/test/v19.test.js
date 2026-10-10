import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import {customRegistry} from '../lib/custom-sources.js';
import {mergeProviders} from '../lib/provider-registry.js';
import {WorkPool,publicURL} from '../lib/network.js';
import {eachConcurrent,withSignal} from '../lib/discovery-control.js';
import {compactSources,eligibleEvent,discoveryMessage} from '../public/source-request.js';
import {eventMetadata} from '../public/playback-metadata.js';
import {boundedCastLoad} from '../public/cast-operation.js';

test('1,400 profiles are compact and do not perform DNS before discovery',async()=>{
  const original=dns.lookup;let lookups=0;dns.lookup=async()=>{lookups++;throw Error('No DNS should happen here');};
  try{
    const saved=Array.from({length:1400},(_,i)=>({url:'https://source'+i+'.example/',enabled:true,categories:{NBA:['https://source'+i+'.example/nba'],TV:['https://source'+i+'.example/tv']},test:{reason:'x'.repeat(1000)},performance:{successes:20},support:{NBA:'NO'}}));
    const compact=compactSources(saved,{league:'NBA'});assert.ok(JSON.stringify(compact).length>65536);assert.ok(JSON.stringify(compact).length<2*1024*1024);
    assert.ok(!JSON.stringify(compact).includes('"test"'));assert.ok(!JSON.stringify(compact).includes('"TV"'));
    const sites=await customRegistry(compact);assert.equal(sites.length,1400);assert.equal(lookups,0);
    await assert.rejects(customRegistry(Array.from({length:3001},()=>({url:'https://example.com'}))),/SOURCE_LIST_TOO_LARGE/);
    for(const url of ['http://127.0.0.1','https://localhost','http://169.254.169.254','http://[::1]','https://user:password@example.com'])assert.throws(()=>publicURL(url));
  }finally{dns.lookup=original;}
});

test('custom routes merge without replacing built-in adapters or dropping other roots',()=>{
  const sites=mergeProviders([{id:'streamed',type:'streamed',displayHost:'streamed.pk',enabled:true,restrictLeagues:true,leagues:['NBA']}],[
    {id:'custom',custom:true,enabled:true,displayHost:'streamed.pk',indexUrls:['https://streamed.pk/nba'],categories:{NBA:['https://streamed.pk/basketball']}},
    {id:'a',custom:true,enabled:true,displayHost:'example.com',indexUrls:['https://example.com/live']},
    {id:'b',custom:true,enabled:true,displayHost:'example.com',indexUrls:['https://example.com/nba']}
  ]);
  assert.equal(sites.length,2);assert.equal(sites[0].type,'streamed');assert.equal(sites[0].restrictLeagues,true);assert.deepEqual(sites[1].indexUrls,['https://example.com/live','https://example.com/nba']);
});

test('cancellation removes queued browser work and stops scheduled providers',async()=>{
  const pool=new WorkPool(1),controller=new AbortController();let release;
  const first=pool.run(()=>new Promise(resolve=>release=resolve));
  const next=pool.run(()=>assert.fail('Cancelled work must not start'),controller.signal);controller.abort();await assert.rejects(next);assert.equal(pool.queue.length,0);release();await first;assert.equal(pool.active,0);
  const abort=new AbortController();let calls=0;
  await withSignal(abort.signal,()=>eachConcurrent(Array.from({length:1400}),2,async()=>{calls++;abort.abort();}));
  assert.ok(calls<=2);
});

test('all providers beyond twelve can be scheduled with bounded concurrency',async()=>{
  let active=0,peak=0,calls=0;
  const cursor=await eachConcurrent(Array.from({length:25}),3,async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));calls++;active--;});
  assert.equal(calls,25);assert.equal(cursor,25);assert.equal(peak,3);
});

test('only live and soon events auto-check; partial checks never claim exhaustive absence',()=>{
  const now=Date.now();
  assert.equal(eligibleEvent({status:'live'},now),true);
  assert.equal(eligibleEvent({status:'scheduled',startTime:new Date(now+30*60000)},now),true);
  assert.equal(eligibleEvent({status:'scheduled',startTime:new Date(now+90*60000)},now),false);
  assert.equal(eligibleEvent({status:'live',provider:'youtube'},now),false);
  assert.match(discoveryMessage({partial:true}),/INCOMPLETE/);
});

test('event titles and transparent league artwork replace generic playback branding',()=>{
  const meta=eventMetadata({title:'KNICKS VS CELTICS',league:'NBA'},{},'https://app.example');
  assert.equal(meta.title,'KNICKS VS CELTICS');assert.equal(meta.artwork[0].src,'https://app.example/artwork/nba.png');
  assert.equal(eventMetadata({showTitle:'SHOW',title:'EPISODE 2'}).title,'SHOW · EPISODE 2');
});

test('Cast load has a timeout and responds to cancellation',async()=>{
  await assert.rejects(boundedCastLoad({loadMedia:()=>new Promise(()=>{})},{},{timeout:10}),/CAST_TIMED_OUT/);
  const controller=new AbortController();const pending=boundedCastLoad({loadMedia:()=>new Promise(()=>{})},{},{signal:controller.signal});controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');
});

test('HTTP discovery accepts a large list and publishes a built-in before slow custom work',async()=>{
  const originalFetch=global.fetch,originalDNS=dns.lookup;
  process.env.SOURCE_REGISTRY_JSON=JSON.stringify([{id:'builtin',enabled:true,displayHost:'8.8.8.8',events:{'nba-v19':'https://8.8.8.8/live.m3u8'}}]);
  dns.lookup=async()=>[{address:'8.8.8.8',family:4}];
  global.fetch=async(url,options={})=>{
    if(String(url).includes('8.8.8.8'))return new Response(String(url).endsWith('.m3u8')?'#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts':new Uint8Array(188));
    return new Promise((resolve,reject)=>{const fail=()=>reject(options.signal.reason);if(options.signal?.aborted)fail();else options.signal?.addEventListener('abort',fail,{once:true});});
  };
  let server,job;
  try{
    const {app}=await import('../server.js');
    const {knownEvents}=await import('../lib/schedules.js');
    const {eventJob}=await import('../lib/discovery.js');
    const event={id:'nba-v19',league:'NBA',title:'KNICKS VS CELTICS',status:'live',participants:[{name:'New York Knicks'},{name:'Boston Celtics'}]};knownEvents.set(event.id,event);
    const customSources=Array.from({length:1400},(_,i)=>({url:'https://source'+i+'.example/',categories:{NBA:['https://source'+i+'.example/nba']}}));
    const body=JSON.stringify({customSources,mode:'light'});
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    const start=Date.now();
    await new Promise((resolve,reject)=>{
      const request=http.request(origin+'/api/events/'+event.id+'/sources',{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},response=>{
        assert.equal(response.statusCode,200);let buffer='';
        response.on('data',data=>{buffer+=data;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line)continue;const update=JSON.parse(line);if(update.sources?.some(s=>s.mediaUrl)){assert.ok(Date.now()-start<2000);request.destroy();resolve();}}});
      });request.once('error',reject);request.end(body);
    });
    const sites=await customRegistry(customSources);job=eventJob(event,origin,sites,{mode:'light'});
    await new Promise(resolve=>setTimeout(resolve,400));assert.equal(job.controller.signal.aborted,true);
    await job.promise;assert.equal(job.done,true);assert.equal(job.partial,true);assert.ok(job.firstSourceMs<2000);
    const other={...event,id:'nba-no-profile'};
    const check=eventJob(other,origin,[{id:'no-profile',name:'CUSTOM',custom:true,enabled:true,support:{NBA:'NO'},events:{[other.id]:'https://8.8.8.8/live.m3u8'},mirrors:false}],{mode:'deep'});
    check.start();await check.promise;assert.ok(check.sources.some(source=>source.siteId==='no-profile'&&source.mediaUrl));
  }finally{job?.cancel();server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());global.fetch=originalFetch;dns.lookup=originalDNS;}
});
