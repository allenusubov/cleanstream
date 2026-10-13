import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import dns from 'node:dns/promises';
import {ReusableBrowser} from '../lib/browser-lifecycle.js';
import {requestErrorLog} from '../lib/error-log.js';
import {excludedPlatform,aggregatorEvent} from '../public/live-only.js';
import {addCustomSources,loadCustomSources,removeCustomSources,parseProfileLines,CUSTOM_SOURCE_KEY} from '../public/custom-sources.js';
import {profileFromLinks} from '../lib/source-profile.js';
import {customRegistry} from '../lib/custom-sources.js';
import {resolve} from '../lib/resolver.js';

function browser(){
  const value=new EventEmitter();value.connected=true;value.isConnected=()=>value.connected;
  value.newContext=async()=>({close:async()=>{}});
  value.disconnect=()=>{value.connected=false;value.emit('disconnected');};return value;
}
test('failed browser startup is not cached and concurrent retries share one launch',async()=>{
  let calls=0;const live=browser();
  const manager=new ReusableBrowser(async()=>{if(++calls===1)throw new Error('Executable missing');return live;});
  await assert.rejects(manager.get(),error=>error.code==='BROWSER_UNAVAILABLE'&&error.cause.message==='Executable missing');
  const recovered=await Promise.all(Array.from({length:8},()=>manager.get()));
  assert.ok(recovered.every(item=>item===live));assert.equal(calls,2);
});
test('disconnected cached browser is replaced without reusing a dead process',async()=>{
  const first=browser(),second=browser();let calls=0;
  const manager=new ReusableBrowser(async()=>++calls===1?first:second);
  assert.equal(await manager.get(),first);first.disconnect();
  assert.equal(await manager.get(),second);assert.equal(calls,2);
});
test('disconnect racing context creation retries once on a fresh browser',async()=>{
  const first=browser(),second=browser();let calls=0;
  first.newContext=async()=>{first.disconnect();throw new Error('Target closed');};
  const expected={close:async()=>{}};second.newContext=async()=>expected;
  const manager=new ReusableBrowser(async()=>++calls===1?first:second);
  assert.equal(await manager.context({}),expected);assert.equal(calls,2);
});
test('a cancelled caller leaves shared browser startup available to another caller',async()=>{
  let finish,calls=0;const live=browser();const controller=new AbortController();
  const manager=new ReusableBrowser(()=>{calls++;return new Promise(resolve=>finish=resolve);});
  const cancelled=manager.get(controller.signal);const shared=manager.get();
  await Promise.resolve();controller.abort();await assert.rejects(cancelled,error=>error.name==='AbortError');
  finish(live);assert.equal(await shared,live);assert.equal(calls,1);
});
test('cancellation racing context creation closes the created context',async()=>{
  const live=browser(),controller=new AbortController();let closed=0;
  live.newContext=async()=>{controller.abort();return {close:async()=>closed++};};
  await assert.rejects(new ReusableBrowser(async()=>live).context({},controller.signal),error=>error.name==='AbortError');
  assert.equal(closed,1);assert.equal(live.isConnected(),true);
});
test('a healthy-browser context error does not cause repeated browser launches',async()=>{
  const live=browser();let calls=0;live.newContext=async()=>{throw new Error('Invalid options');};
  const manager=new ReusableBrowser(async()=>{calls++;return live;});
  await assert.rejects(manager.context({}),/Invalid options/);assert.equal(calls,1);assert.equal(await manager.get(),live);
});
test('error logs retain actual exception and cause without signed URLs or credentials',()=>{
  const error=new Error('Target closed https://source.example/player?token=secret authorization=secret');
  error.code='BROWSER_UNAVAILABLE';error.cause=new Error('Executable missing /ms-playwright/chromium');
  const record=requestErrorLog(error,{method:'POST',path:'/api/resolve'});
  assert.equal(record.severity,'ERROR');assert.match(record.errorMessage,/Target closed/);assert.match(record.stack,/Target closed/);
  assert.match(record.cause.message,/Executable missing/);assert.equal(record.path,'/api/resolve');
  assert.ok(!JSON.stringify(record).includes('secret'));
});
test('bulk removal preserves unselected enabled state and profiles in one storage write',()=>{
  const data=new Map();let writes=0;
  const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>{writes++;data.set(key,value);}};
  data.set(CUSTOM_SOURCE_KEY,JSON.stringify([
    {url:'https://a.example/',enabled:false,categories:{NBA:['https://a.example/nba']}},
    {url:'https://b.example/',enabled:true},{url:'https://c.example/',enabled:true}
  ]));
  removeCustomSources(new Set(['https://b.example/','https://c.example/']),storage);
  assert.equal(writes,1);const saved=loadCustomSources(storage);assert.equal(saved.length,1);
  assert.equal(saved[0].enabled,false);assert.deepEqual(saved[0].categories.NBA,['https://a.example/nba']);
  removeCustomSources([saved[0].url],storage);assert.deepEqual(loadCustomSources(storage),[]);
});
test('legacy profiles keep live routes and stop carrying movie/episode discovery data',()=>{
  const data=JSON.stringify([{url:'https://sports.example/',categories:{TV:['https://sports.example/tv'],MOVIES:['https://sports.example/movies'],NBA:['https://sports.example/nba']},
    support:{TV:'YES',NBA:'YES'},structure:{episodeTemplates:['https://sports.example/episode/{episode}'],titleTemplates:['https://sports.example/show/{title}'],searchTemplates:['https://sports.example/search?q={query}']}}]);
  const saved=loadCustomSources({getItem:()=>data})[0];
  assert.deepEqual(Object.keys(saved.categories),['NBA']);assert.equal(saved.support.TV,undefined);
  assert.equal(saved.structure.episodeTemplates,undefined);assert.equal(saved.structure.titleTemplates,undefined);
  assert.equal(saved.structure.searchTemplates.length,1);
  const manual=parseProfileLines('NBA /nba\nTV /tv\nMOVIES /movies\nEPISODE /episode/{episode}','https://sports.example/');
  assert.equal(manual.invalid,3);assert.equal(manual.categories.NBA[0],'https://sports.example/nba');
});
test('source learning finds live navigation and ignores movie/show navigation',()=>{
  const profile=profileFromLinks([{url:'https://sports.example/nba',text:'NBA'},
    {url:'https://sports.example/tv',text:'TV Shows'},{url:'https://sports.example/movies',text:'Movies'},
    {url:'https://sports.example/live',text:'Live Events'}],'https://sports.example/');
  assert.equal(profile.categories.NBA[0],'https://sports.example/nba');assert.equal(profile.categories.TV,undefined);
  assert.equal(profile.categories.MOVIES,undefined);assert.ok(!profile.hubs.some(url=>/\/(tv|movies)$/.test(url)));
});
test('removed platforms are rejected without blocking lookalike aggregator domains',async()=>{
  for(const url of ['https://youtube.com/live/test','https://youtu.be/test','https://www.twitch.tv/test']){
    assert.equal(excludedPlatform(url),true);await assert.rejects(resolve(url,'https://app.example'),/LIVE_AGGREGATORS_ONLY/);
  }
  assert.equal(excludedPlatform('https://youtube.com.sports.example/live'),false);
  const storage={getItem:()=>null,setItem:()=>{}};
  assert.equal(addCustomSources('https://youtube.com\nhttps://sports.example',storage).invalid,1);
  const registry=await customRegistry(['https://twitch.tv/',{url:'https://sports.example/',categories:{TV:['https://sports.example/tv'],NBA:['https://sports.example/nba']}}]);
  assert.equal(registry.length,1);assert.deepEqual(Object.keys(registry[0].categories),['NBA']);
  assert.equal(aggregatorEvent({provider:'youtube',status:'live'}),false);assert.equal(aggregatorEvent({contentType:'tvm',kind:'tv'}),false);
  assert.equal(aggregatorEvent({provider:'streamed',status:'live'}),true);
});
test('HTTP search returns live events only and removed playback routes stay disabled',async()=>{
  const originalFetch=global.fetch,originalDNS=dns.lookup;let server;const calls=[];
  dns.lookup=async()=>[{address:'8.8.8.8',family:4}];
  global.fetch=async value=>{
    const url=new URL(value);calls.push(url.hostname);
    const data=url.hostname==='streamed.pk'?[{id:'opening-night',title:'Opening Night',date:Date.now(),category:'other'}]:{events:[]};
    return new Response(JSON.stringify(data));
  };
  function request(path,body){return new Promise((resolve,reject)=>{
    const encoded=body?JSON.stringify(body):null;
    const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{}},response=>{
      let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(text)}));
    });req.on('error',reject);req.end(encoded);
  });}
  try{
    const {app}=await import('../server.js');server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const search=await request('/api/search?q=opening%20night');assert.equal(search.status,200);
    assert.equal(search.data.tv,undefined);assert.equal(search.data.movies,undefined);assert.ok(search.data.live.events.some(event=>event.catalogId==='opening-night'));
    assert.ok(calls.every(host=>host==='streamed.pk'||host.endsWith('espn.com')));
    assert.equal((await request('/api/tvm/tv/1396')).status,410);
    const youtube=await request('/api/resolve',{url:'https://youtube.com/live/test'});assert.equal(youtube.status,422);assert.equal(youtube.data.code,'LIVE_AGGREGATORS_ONLY');
    assert.equal((await request('/api/media/test')).status,410);
  }finally{server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());global.fetch=originalFetch;dns.lookup=originalDNS;}
});
