import {AppError,fetchLimited} from './network.js';
import {MetadataCache} from './provider-cache.js';
import {youtubeCandidate} from '../public/youtube-url.js';
const cache=new MetadataCache();
const creators=new Map([['shinya','UCnVjKfzAqo7mzKJUShCfJkg'],['shinyatheninja','UCnVjKfzAqo7mzKJUShCfJkg']]);
let day='',used=0;
function searchBudget() {
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles'}).format(new Date());
  if(day!==today){day=today;used=0;}
  const configured=Number(process.env.YOUTUBE_SEARCH_DAILY_LIMIT??80);
  const limit=Number.isFinite(configured)?Math.max(0,Math.min(100,configured)):80;
  if(used>=limit)throw new AppError('YOUTUBE_LIMIT',429);
  used++;
}
async function api(resource,params) {
  const key=process.env.YOUTUBE_API_KEY;
  if(!key)throw new AppError('YOUTUBE_NOT_CONFIGURED',503);
  return cache.get(`${resource}:${JSON.stringify(params)}`,resource==='channels'?86400000:60000,async()=>{
    if(resource==='search')searchBudget();
    const url=new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    for(const [k,v] of Object.entries({...params,key}))url.searchParams.set(k,v);
    try {
      const response=await fetchLimited(url.href,{limit:1024*1024});
      const json=JSON.parse(response.body.toString());
      if(!Array.isArray(json.items))throw new Error();
      return json.items;
    }catch{throw new AppError('YOUTUBE_UNAVAILABLE',503);}
  });
}
export function normalizeYouTube(video) {
  const live=video.liveStreamingDetails;
  if(!/^[\w-]{11}$/.test(video.id||'') || !live || live.actualEndTime || !video.status?.embeddable || video.status?.privacyStatus!=='public')return null;
  const startTime=live.actualStartTime||live.scheduledStartTime;
  if(!Number.isFinite(Date.parse(startTime)))return null;
  const isLive=Boolean(live.actualStartTime);
  return {id:`youtube-${video.id}`,provider:'youtube',sport:'creator',league:'YOUTUBE',title:video.snippet.title,
    creator:video.snippet.channelTitle,channelId:video.snippet.channelId,startTime,status:isLive?'live':'scheduled',
    participants:[],sources:isLive?[youtubeCandidate(video.id,true)]:[]};
}
export async function resolveYouTube(id) {
  const item=youtubeCandidate(id,null);
  if(!process.env.YOUTUBE_API_KEY)return item;
  try {
    const [video]=await api('videos',{part:'snippet,status,liveStreamingDetails',id});
    if(video?.status?.embeddable===false)throw new AppError('YOUTUBE_EMBED_BLOCKED',422);
    if(video)item.live=Boolean(video.liveStreamingDetails?.actualStartTime&&!video.liveStreamingDetails.actualEndTime);
  }catch(error){if(error.code==='YOUTUBE_EMBED_BLOCKED')throw error;}
  return item;
}
export async function youtubeSearch(query) {
  if(!process.env.YOUTUBE_API_KEY)return {events:[],notice:'YOUTUBE_NOT_CONFIGURED'};
  const q=query.trim().toLowerCase();
  try {
    return await cache.get(`result:${q}`,60000,async()=>{
      let channel=creators.get(q.replace(/^@/,''));
      if(!channel) {
        // Search channels as well as titles. Once resolved, repeat lookups avoid this call.
        const channels=q.startsWith('@')?await api('channels',{part:'id,snippet',forHandle:q}):
          await api('search',{part:'snippet',type:'channel',q,maxResults:3});
        const clean=n=>n?.toLowerCase().replace(/[^a-z0-9]/g,'')||'';
        const exact=channels.find(c=>[c.snippet?.title,c.snippet?.customUrl].some(n=>clean(n)===clean(q)));
        const prefixes=channels.filter(c=>clean(c.snippet?.title).startsWith(clean(q)));
        const matched=exact||(q.length>=4 && prefixes.length===1?prefixes[0]:null);
        channel=matched?.id?.channelId||matched?.id;
        if(typeof channel==='string'){
          if(creators.size>=200)creators.delete(creators.keys().next().value);
          creators.set(q,channel);
        }
      }
      const results=await api('search',{part:'snippet',type:'video',eventType:'live',videoEmbeddable:'true',maxResults:12,...(channel?{channelId:channel}:{q})});
      const ids=results.map(v=>v.id?.videoId).filter(Boolean);
      if(!ids.length)return {events:[],notice:null};
      const videos=await api('videos',{part:'snippet,status,liveStreamingDetails',id:ids.join(',')});
      return {events:videos.map(normalizeYouTube).filter(Boolean),notice:null};
    });
  }catch(error){return {events:[],notice:['YOUTUBE_LIMIT','YOUTUBE_NOT_CONFIGURED'].includes(error.code)?error.code:'YOUTUBE_UNAVAILABLE'};}
}
