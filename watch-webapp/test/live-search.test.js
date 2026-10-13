import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataCache} from '../lib/provider-cache.js';
import {livePosition} from '../public/live-position.js';
import {normalizeMatch,matchQuery,mergeEvents} from '../lib/catalog.js';
import {directoryLinks} from '../lib/directory.js';
test('LIVE remains seekable behind live, including HLS before seekable ranges appear',()=>{
  const range={length:1,start:()=>60,end:()=>120};
  assert.equal(livePosition({live:true,seekable:range,segmentDuration:6}),108);
  assert.equal(livePosition({live:true,seekable:{length:0},syncPosition:110}),110);
  assert.equal(livePosition({live:false,seekable:range,syncPosition:110}),null);
  assert.equal(livePosition({live:true,seekable:{length:0}}),null);
});
test('metadata cache shares in-flight jobs and does not cache failures',async()=>{
  const cache=new MetadataCache();let calls=0;
  const load=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return ['ok'];};
  assert.deepEqual(await Promise.all([cache.get('x',1000,load),cache.get('x',1000,load)]),[['ok'],['ok']]);assert.equal(calls,1);
  await assert.rejects(cache.get('bad',1000,()=>{throw new Error();}));
  assert.equal(await cache.get('bad',1000,()=>3),3);
});
test('catalog excludes stale entries, matches queries and merges repeated events',()=>{
  const raw={id:'test',title:'Rangers vs Devils',date:Date.now(),category:'hockey',teams:{home:{name:'Rangers'},away:{name:'Devils'}}};
  const e=normalizeMatch(raw);assert.equal(matchQuery(raw,'rangers'),true);assert.equal(matchQuery(raw,'soccer'),false);
  assert.equal(normalizeMatch({...raw,date:Date.now()-86400000}),null);
  assert.equal(mergeEvents([e,{...e,id:'duplicate',title:'Rangers v Devils'}]).length,1);
});
test('directory extraction reads titles and rejects script-generated and off-site links',()=>{
  const links=directoryLinks('<script>"<a href="/fake">fake</a>"</script><a href="/game?a=1&amp;b=2"><strong>Knicks</strong> vs Celtics</a><a href="https://other.example/ad">Other</a>','https://sports.example/',['sports.example']);
  assert.deepEqual(links,[{url:'https://sports.example/game?a=1&b=2',text:'Knicks vs Celtics'}]);
});

