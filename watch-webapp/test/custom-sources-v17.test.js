import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCustomSource,loadCustomSources,setCustomSourceProfile,mergeCustomSourceProfile,
  exportCustomSourcesPayload,importCustomSourcesPayload,encodeCustomSourcesShare,decodeCustomSourcesShare,
  parseProfileLines,recordCustomSourceSuccess,cleanupCustomSourceProfiles
} from '../public/custom-sources.js';

const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};};

test('custom profiles keep YES/NO support and learned structure',()=>{
  const s=storage();addCustomSource('example.com',s);
  setCustomSourceProfile('https://example.com/',parseProfileLines('NBA /nba\nNFL NO\nEVENTS /live','https://example.com/'),s);
  mergeCustomSourceProfile('https://example.com/',{categories:{SOCCER:['https://example.com/soccer']},support:{SOCCER:'YES'},structure:{routeStyle:'PATH',eventPrefixes:['/event/'],eventHosts:['events.example']},testedAt:123},s);
  const item=loadCustomSources(s)[0];
  assert.equal(item.support.NBA,'YES');assert.equal(item.support.NFL,'NO');assert.equal(item.support.SOCCER,'YES');
  assert.equal(item.categories.NBA[0],'https://example.com/nba');assert.equal(item.structure.eventPrefixes[0],'/event/');
});

test('successful source learns reusable event/player structure without storing a stream URL',()=>{
  const s=storage();addCustomSource('example.com',s);
  recordCustomSourceSuccess('https://example.com/',900,{eventUrl:'https://events.example/soccer/team-a-vs-team-b/123',mediaUrl:'https://cdn.example/live/master.m3u8',mirrorLabel:'SERVER 2'},s);
  const item=loadCustomSources(s)[0];
  assert.equal(item.performance.successes,1);assert.equal(item.structure.eventHosts[0],'events.example');assert.ok(item.structure.eventPrefixes.includes('/soccer/team-a-vs-team-b/'));
  assert.equal(item.structure.playerHosts[0],'cdn.example');assert.equal(item.structure.mirrorLabels[0],'SERVER 2');
  assert.equal(JSON.stringify(item).includes('master.m3u8'),false);
});

test('custom sources export/import and share token round trip',()=>{
  const a=storage();addCustomSource('example.com',a);setCustomSourceProfile('https://example.com/',parseProfileLines('NBA /nba','https://example.com/'),a);
  const payload=exportCustomSourcesPayload(a),token=encodeCustomSourcesShare(a);assert.equal(decodeCustomSourcesShare(token).sources.length,1);
  const b=storage();const result=importCustomSourcesPayload(payload,b);assert.equal(result.added,1);assert.equal(loadCustomSources(b)[0].categories.NBA[0],'https://example.com/nba');
});


test('custom source cleanup removes learned title pages and collapses pagination routes',()=>{
  const s=storage();
  s.setItem('cleanstream.customSources.v1',JSON.stringify([{
    url:'https://example.com/',enabled:true,
    categories:{
      TV:['https://example.com/shows?page=1','https://example.com/shows?page=2','https://example.com/show/207347-blue-box','https://example.com/watch/show/22980-title/1/1'],
      MOVIES:['https://example.com/movies','https://example.com/movie/9012-jackass-the-movie'],
      BOXING:['https://example.com/show/207347-blue-box']
    },
    support:{TV:'YES',MOVIES:'YES',BOXING:'YES'},
    eventLists:['https://example.com/events','https://example.com/event/nfl-network-m']
  }]));
  const result=cleanupCustomSourceProfiles('',s),item=result.items[0];
  assert.deepEqual(item.categories.TV,['https://example.com/shows']);
  assert.deepEqual(item.categories.MOVIES,['https://example.com/movies']);
  assert.equal(item.categories.BOXING,undefined);
  assert.equal(item.support.BOXING,'UNKNOWN');
  assert.deepEqual(item.eventLists,['https://example.com/events']);
  assert.ok(result.removed>=4);
  assert.ok(result.normalized>=1);
});
