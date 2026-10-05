import test from 'node:test';
import assert from 'node:assert/strict';
import {MetadataCache} from '../lib/provider-cache.js';
import {normalizeYouTube,youtubeSearch} from '../lib/youtube.js';
import {normalizeTwitch,twitchSearch} from '../lib/twitch.js';
import {twitchChannel} from '../public/twitch-url.js';
import {youtubeId} from '../public/youtube-url.js';
import {livePosition} from '../public/live-position.js';
import {normalizeMatch,matchQuery,mergeEvents} from '../lib/catalog.js';
import dns from 'node:dns/promises';
import {directoryLinks} from '../lib/directory.js';
test('YouTube links accept supported formats and reject unrelated hosts',()=>{
  for(const url of ['https://youtu.be/abcdefghijk','https://www.youtube.com/watch?v=abcdefghijk','https://youtube.com/live/abcdefghijk'])assert.equal(youtubeId(url),'abcdefghijk');
  for(const url of ['https://youtube.com.evil.test/watch?v=abcdefghijk','https://youtube.com/@shinya','https://youtube.com/watch?v=bad','file://youtube.com/watch?v=abcdefghijk'])assert.equal(youtubeId(url),null);
});
test('live YouTube results exclude ended, private and non-embeddable videos',()=>{
  const video={id:'abcdefghijk',snippet:{title:'Streaming',channelTitle:'ShinyaTheNinja',channelId:'channel'},status:{embeddable:true,privacyStatus:'public'},liveStreamingDetails:{actualStartTime:new Date().toISOString()}};
  assert.equal(normalizeYouTube(video).sources[0].provider,'youtube');
  assert.equal(normalizeYouTube({...video,liveStreamingDetails:{...video.liveStreamingDetails,actualEndTime:new Date().toISOString()}}),null);
  assert.equal(normalizeYouTube({...video,status:{embeddable:false,privacyStatus:'public'}}),null);
  assert.equal(normalizeYouTube({...video,status:{embeddable:true,privacyStatus:'private'}}),null);
});
test('missing YouTube key is an explicit unavailable provider, not empty success',async()=>{
  const previous=process.env.YOUTUBE_API_KEY;delete process.env.YOUTUBE_API_KEY;
  try{assert.equal((await youtubeSearch('shinya')).notice,'YOUTUBE_NOT_CONFIGURED');}
  finally{if(previous)process.env.YOUTUBE_API_KEY=previous;}
});
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
test('shinya resolves by channel, verifies live metadata, and reuses search quota',async()=>{
  const oldFetch=global.fetch,oldLookup=dns.lookup,oldKey=process.env.YOUTUBE_API_KEY;
  const calls=[];process.env.YOUTUBE_API_KEY='test-only';dns.lookup=async()=>[{address:'8.8.8.8'}];
  global.fetch=async value=>{
    const url=new URL(value);calls.push(url);
    const items=url.pathname.endsWith('/search')?[{id:{videoId:'shinyalive1'}}]:[{id:'shinyalive1',snippet:{title:'A TITLE WITHOUT THE CREATOR NAME',channelTitle:'ShinyaTheNinja',channelId:'UCnVjKfzAqo7mzKJUShCfJkg'},status:{embeddable:true,privacyStatus:'public'},liveStreamingDetails:{actualStartTime:new Date().toISOString()}}];
    return new Response(JSON.stringify({items}));
  };
  try {
    const result=await youtubeSearch('shinya');assert.equal(result.events.length,1);assert.equal(result.events[0].creator,'ShinyaTheNinja');
    assert.equal(calls[0].searchParams.get('channelId'),'UCnVjKfzAqo7mzKJUShCfJkg');assert.equal(calls[0].searchParams.get('eventType'),'live');
    await youtubeSearch('shinya');assert.equal(calls.filter(c=>c.pathname.endsWith('/search')).length,1);
  }finally{global.fetch=oldFetch;dns.lookup=oldLookup;if(oldKey)process.env.YOUTUBE_API_KEY=oldKey;else delete process.env.YOUTUBE_API_KEY;}
});
test('directory extraction reads titles and rejects script-generated and off-site links',()=>{
  const links=directoryLinks('<script>"<a href="/fake">fake</a>"</script><a href="/game?a=1&amp;b=2"><strong>Knicks</strong> vs Celtics</a><a href="https://other.example/ad">Other</a>','https://sports.example/',['sports.example']);
  assert.deepEqual(links,[{url:'https://sports.example/game?a=1&b=2',text:'Knicks vs Celtics'}]);
});

test('Twitch links and live search results normalize to official twitch.tv sources',()=>{
  assert.equal(twitchChannel('https://www.twitch.tv/kaicenat'),'kaicenat');
  assert.equal(twitchChannel('https://twitch.tv/directory'),null);
  assert.equal(twitchChannel('https://twitch.tv.evil.test/kaicenat'),null);
  const event=normalizeTwitch({id:'1',is_live:true,broadcaster_login:'kaicenat',display_name:'KaiCenat',title:'LIVE',game_name:'Just Chatting',started_at:new Date().toISOString()});
  assert.equal(event.provider,'twitch');assert.equal(event.sources[0].displayName,'TWITCH.TV');
});
test('missing Twitch credentials are explicit instead of pretending there are no results',async()=>{
  const oldId=process.env.TWITCH_CLIENT_ID,oldSecret=process.env.TWITCH_CLIENT_SECRET;
  delete process.env.TWITCH_CLIENT_ID;delete process.env.TWITCH_CLIENT_SECRET;
  try{assert.equal((await twitchSearch('kai cenat')).notice,'TWITCH_NOT_CONFIGURED');}
  finally{if(oldId)process.env.TWITCH_CLIENT_ID=oldId;if(oldSecret)process.env.TWITCH_CLIENT_SECRET=oldSecret;}
});
