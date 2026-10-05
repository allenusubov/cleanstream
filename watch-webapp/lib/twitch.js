import {AppError} from './network.js';
import {MetadataCache} from './provider-cache.js';
import {twitchCandidate} from '../public/twitch-url.js';

const cache=new MetadataCache();
let tokenState={token:'',expiresAt:0};

async function appToken() {
  const clientId=process.env.TWITCH_CLIENT_ID;
  const clientSecret=process.env.TWITCH_CLIENT_SECRET;
  if(!clientId||!clientSecret)throw new AppError('TWITCH_NOT_CONFIGURED',503);
  if(tokenState.token && tokenState.expiresAt>Date.now()+60000)return tokenState.token;
  const body=new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'client_credentials'});
  let response;
  try{
    response=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(10000)});
  }catch{throw new AppError('TWITCH_UNAVAILABLE',503);}
  if(!response.ok)throw new AppError('TWITCH_UNAVAILABLE',503);
  const json=await response.json().catch(()=>null);
  if(!json?.access_token)throw new AppError('TWITCH_UNAVAILABLE',503);
  tokenState={token:json.access_token,expiresAt:Date.now()+Math.max(60000,(Number(json.expires_in)||3600)*1000)};
  return tokenState.token;
}

async function helix(path,params) {
  const clientId=process.env.TWITCH_CLIENT_ID;
  const token=await appToken();
  const url=new URL(`https://api.twitch.tv/helix/${path}`);
  for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null)url.searchParams.set(key,String(value));
  let response;
  try{
    response=await fetch(url,{headers:{'Client-Id':clientId,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
  }catch{throw new AppError('TWITCH_UNAVAILABLE',503);}
  if(response.status===401){tokenState={token:'',expiresAt:0};throw new AppError('TWITCH_UNAVAILABLE',503);}
  if(!response.ok)throw new AppError('TWITCH_UNAVAILABLE',503);
  const json=await response.json().catch(()=>null);
  if(!Array.isArray(json?.data))throw new AppError('TWITCH_UNAVAILABLE',503);
  return json.data;
}

export function normalizeTwitch(channel) {
  if(!channel?.is_live || !channel?.broadcaster_login || !channel?.id)return null;
  const started=channel.started_at && Number.isFinite(Date.parse(channel.started_at))?channel.started_at:new Date().toISOString();
  const source=twitchCandidate(channel.broadcaster_login);
  return {
    id:`twitch-${channel.id}`,
    provider:'twitch',
    sport:'creator',
    league:'TWITCH',
    title:channel.display_name||channel.broadcaster_login,
    creator:channel.display_name||channel.broadcaster_login,
    subtitle:channel.title||'',
    category:channel.game_name||'',
    startTime:started,
    status:'live',
    participants:[],
    sources:[source]
  };
}

export async function twitchSearch(query) {
  if(!process.env.TWITCH_CLIENT_ID||!process.env.TWITCH_CLIENT_SECRET)return {events:[],notice:'TWITCH_NOT_CONFIGURED'};
  const q=String(query||'').trim();
  if(!q)return {events:[],notice:null};
  try{
    return await cache.get(`search:${q.toLowerCase()}`,60000,async()=>{
      const channels=await helix('search/channels',{query:q,first:12,live_only:'true'});
      return {events:channels.map(normalizeTwitch).filter(Boolean),notice:null};
    });
  }catch(error){return {events:[],notice:error.code==='TWITCH_NOT_CONFIGURED'?error.code:'TWITCH_UNAVAILABLE'};}
}
