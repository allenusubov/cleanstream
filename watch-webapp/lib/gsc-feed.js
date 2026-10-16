import crypto from 'node:crypto';
import {AppError,publicURL,fetchLimited} from './network.js';
import {MetadataCache} from './provider-cache.js';
import {abortable,withSignal} from './discovery-control.js';
import {matchesParticipants,normalize,parseQuery} from '../public/events.js';
import {excludedPlatform} from '../public/live-only.js';
import {inspectEmbedPolicy,clearEmbedPolicies} from './embed-policy.js';

export const GSC_ENDPOINT='https://cdn.strm-api.org/api/v1/gsc/matches';
// The public player's k1 wire format. These constants are published in its
// client script, not account credentials. No remote JavaScript runs on Node.
const initialCodec={key:'vqW3n/yB1R+GwSPc4kJs2dCkV7kRmXaNy3lQ/3XkHJI=',plain:'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',mixed:'MiljRIn9PX1o63wGBYTtFsKmEkSur-pC_U02cvzAdy5e8ZqLDgJ4OhVN7QbHxfWa'};
let codec=initialCodec;
const cache=new MetadataCache(4);
// Observed provider requirements concern their embedded players only. Direct
// media extraction is still attempted and is not blacklisted by this table.
const originalSiteReasons={'sportycos.com':'PROVIDER_CONTEXT_REQUIRED','streame.center':'POPUP_PROTECTION_UNSUPPORTED','gsports.lat':'EMBEDDING_BLOCKED','gooz.aapmains.net':'EMBEDDING_BLOCKED'};
export function knownGscSite(value){try{return ['sportycos.com','www.sportycos.com'].includes(new URL(value).hostname);}catch{return false;}}
export function gscFeedInPage(html){return String(html).replace(/\\\//g,'/').includes(GSC_ENDPOINT);}
export function validGscCodec(value){return Boolean(value&&typeof value.key==='string'&&/^[A-Za-z0-9+/=]{40,48}$/.test(value.key)&&Buffer.from(value.key,'base64').length===32&&[value.plain,value.mixed].every(text=>typeof text==='string'&&text.length===64&&new Set(text).size===64&&/^[A-Za-z0-9_-]+$/.test(text)));}
export function decodeGscFeed(body,settings=codec){
  const wire=String(body).trim();let json;
  try{
    if(wire.startsWith('k1')){
      if(!validGscCodec(settings)||wire.length>4*1024*1024)throw new Error('Invalid envelope');
      const mapped=Array.from(wire.slice(2)).reverse().map(char=>{const i=settings.mixed.indexOf(char);if(i<0)throw new Error('Invalid alphabet');return settings.plain[i];}).join('');
      const packed=Buffer.from(mapped,'base64url');if(packed.length<29)throw new Error('Truncated envelope');
      const decipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(settings.key,'base64'),packed.subarray(0,12));
      decipher.setAuthTag(packed.subarray(-16));
      json=JSON.parse(Buffer.concat([decipher.update(packed.subarray(12,-16)),decipher.final()]).toString('utf8'));
    }else json=JSON.parse(wire);
    if(!json||!Array.isArray(json.matches)||json.matches.length>5000)throw new Error('Invalid match list');
    return json;
  }catch(cause){const error=new AppError('FEED_FORMAT_CHANGED',502);error.cause=cause;throw error;}
}
export function clearGscFeed(){cache.values.clear();clearEmbedPolicies();}
export async function gscData({pageUrl='https://sportycos.com/us/us.html',readCodec}={}){
  return abortable(cache.get(GSC_ENDPOINT,30000,()=>withSignal(AbortSignal.timeout(15000),async()=>{
    const response=await fetchLimited(GSC_ENDPOINT,{limit:3*1024*1024,headers:{Accept:'application/json, text/plain, */*'}});
    try{return decodeGscFeed(response.body.toString());}
    catch(error){
      if(!readCodec)throw error;
      const learned=await readCodec(pageUrl);if(!validGscCodec(learned))throw error;
      const data=decodeGscFeed(response.body.toString(),learned);codec=learned;return data;
    }
  }))).catch(cause=>{if(cause.code==='FEED_FORMAT_CHANGED'||cause.name==='AbortError')throw cause;const error=new AppError('FEED_UNAVAILABLE',502);error.cause=cause;throw error;});
}
function cleanTarget(value){try{const url=publicURL(value);if(excludedPlatform(url.href))return null;url.hash='';return url.href;}catch{return null;}}
export function gscPlayerUrl(root,matchId){
  const url=publicURL(root);
  if(!/\/us\/us\.html$/i.test(url.pathname))url.pathname='/us/us.html';
  for(const key of [...url.searchParams.keys()])if(!['p','d','v','ref'].includes(key))url.searchParams.delete(key);
  url.searchParams.set('id',String(matchId));url.hash='';return url.href;
}
export function gscOptions(match,root,{selected=0}={}){
  const streams=Array.isArray(match?.streams)?match.streams.slice(0,40):[],unique=new Map();
  const ordered=selected>0&&selected<streams.length?[streams[selected],...streams.filter((_,i)=>i!==selected)]:streams;
  for(const stream of ordered){
    const label=[stream.name||`SERVER ${stream.no||streams.indexOf(stream)+1}`,stream.language,stream.hd?'HD':''].filter(Boolean).join(' · ').toUpperCase();
    const real=cleanTarget(stream.real_url),embed=cleanTarget(stream.embed_url),web=cleanTarget(stream.web_url);
    // The published embed is authoritative. Its wrapper can select a different
    // server than the historical real_url field; preserve that routing.
    for(const target of [...new Set([embed||real,real,web].filter(Boolean))]){
      if(!unique.has(target))unique.set(target,{url:target,text:match.title,mirrorLabel:label,label,kind:'frame',noReferer:true,parentUrl:gscPlayerUrl(root,match.id),categoryUrl:new URL('/us/us.html',root).href});
    }
  }
  return [...unique.values()];
}
export function gscProviderPlayers(match,root,{selected=0}={}){
  const streams=Array.isArray(match?.streams)?match.streams.slice(0,40):[],unique=new Map();
  const ordered=selected>0&&selected<streams.length?[streams[selected],...streams.filter((_,i)=>i!==selected)]:streams;
  for(const stream of ordered){
    const embedUrl=cleanTarget(stream.embed_url)||cleanTarget(stream.real_url);if(!embedUrl||unique.has(embedUrl))continue;
    unique.set(embedUrl,{embedUrl,requiresProviderPlayer:true,sourceUrl:gscPlayerUrl(root,match.id),mirrorLabel:[stream.name||`SERVER ${stream.no||streams.indexOf(stream)+1}`,stream.language,stream.hd?'HD':''].filter(Boolean).join(' · ').toUpperCase()});
  }
  // Direct embeds avoid an extra wrapper/ancestor policy. Keep wrapper choices
  // available, but prefer published external embeds when the feed supplies both.
  return [...unique.values()].sort((a,b)=>Number(knownGscSite(a.embedUrl))-Number(knownGscSite(b.embedUrl)));
}
export async function gscPagePlayers(url,options={}){
  const input=publicURL(url);if(!/\/us\/us\.html$/i.test(input.pathname)||!input.searchParams.has('id'))return [];
  const data=await gscData({pageUrl:url,...options}),match=data.matches.find(value=>String(value.id)===input.searchParams.get('id'));
  if(!match)throw new AppError('EVENT_UNAVAILABLE',404);
  const players=gscProviderPlayers(match,url,{selected:Number(input.searchParams.get('s'))||0});
  if(!options.origin)return players;
  const inspected=await Promise.all(players.map(async player=>{
    const reason=originalSiteReasons[new URL(player.embedUrl).hostname];
    const allowed=reason?false:await inspectEmbedPolicy(player.embedUrl,options.origin);
    if(allowed===false){const {embedUrl,...rest}=player;return {...rest,requiresProviderPlayer:false,externalUrl:embedUrl,requiresOriginalSite:true,accessReason:reason||'EMBEDDING_BLOCKED'};}
    return {...player,embeddingAllowed:allowed};
  }));
  return inspected.sort((a,b)=>Number(b.embeddingAllowed===true)-Number(a.embeddingAllowed===true));
}
export function matchGscEvent(matches,event){
  const start=Date.parse(event.startTime),id=String(event.providerEventId||event.id?.replace(/^nba-/,'')||'');
  return matches.filter(match=>{
    if(match.finished===true)return false;
    const time=Number(match.timestamp)||Date.parse(match.starts_at);
    if(!Number.isFinite(time)||!Number.isFinite(start)||Math.abs(time-start)>6*3600000)return false;
    const text=[match.title,match.home?.name,match.away?.name].filter(Boolean).join(' ');
    const exact=Boolean(id&&String(match.api_id||'').endsWith('-'+id));
    if(exact)return true;
    if(Math.abs(time-start)>90*60000)return false;
    if(event.participants?.length>=2){const participants=event.league==='NBA'?event.participants:event.participants.map(value=>({name:value.name}));return matchesParticipants(text,participants)&&(!/^event-espn-/.test(String(match.api_id||''))||!event.providerEventId);}
    const title=normalize(event.title),name=normalize(match.title);return exact||Boolean(title&&title===name);
  });
}
export function normalizeGscMatch(match,now=Date.now()){
  const time=Number(match.timestamp)||Date.parse(match.starts_at);if(!match.id||!match.title||match.finished||!Number.isFinite(time)||time<now-6*3600000||time>now+30*86400000)return null;
  const api=String(match.api_id||'');
  const league=['WNBA','NBA','NHL','NFL','MLB','UFC','BOXING','F1'].find(key=>new RegExp(`(?:-|\\b)${key.toLowerCase()}(?:-|\\b)`).test(api+' '+match.title))||(/college-football/.test(api)?'CFB':({boxing:'BOXING',mma:'MMA',motorsport:'RACING'}[match.sport]||String(match.sport||'OTHER').toUpperCase()));
  return {id:`gsc-${match.id}`,provider:'gsc',providerEventId:/^event-espn-/.test(api)?api.match(/-(\d{6,})$/)?.[1]||'':'',catalogId:String(match.id),sport:match.sport,league,title:match.title,
    startTime:new Date(time).toISOString(),status:match.live?'live':'scheduled',participants:[match.home?.name,match.away?.name].filter(Boolean).map(name=>({name})),sourcePage:gscPlayerUrl('https://sportycos.com/',match.id)};
}
export async function gscCatalogSearch(q){
  const parsed=parseQuery(q),query=normalize(q).replace(/\b(live|watch|stream|streams|today|vs|versus)\b/g,' ').trim();
  const data=await gscData();
  return data.matches.map(value=>normalizeGscMatch(value)).filter(Boolean).filter(event=>{
    const text=[event.title,event.league,event.sport,...event.participants.map(value=>value.name)].join(' ');
    if(parsed.teams.length)return parsed.teams.every(team=>matchesParticipants(text,[team,team]));
    if(['league','sport'].includes(parsed.kind))return event.league===parsed.league;
    return query.split(/\s+/).filter(Boolean).every(word=>` ${normalize(text)} `.includes(` ${word} `));
  });
}
export async function gscEventPages(event,root,options={}){
  const data=await gscData({pageUrl:root,...options});
  return matchGscEvent(data.matches,event).flatMap(match=>{
    const routes=gscOptions(match,root);return routes.length?routes:[{url:gscPlayerUrl(root,match.id),text:match.title,streamsPending:true}];
  });
}
export async function gscPageRoutes(url,options={}){
  const input=publicURL(url);
  if(input.pathname==='/frame.html'&&input.searchParams.has('url')){
    const target=cleanTarget(input.searchParams.get('url'));return target?[{url:target,kind:'frame',noReferer:true,label:'PLAYER'}]:[];
  }
  if(!/\/us\/us\.html$/i.test(input.pathname))return [];
  const data=await gscData({pageUrl:url,...options});
  if(/\/us\/us\.html$/i.test(input.pathname)&&input.searchParams.has('id')){
    const match=data.matches.find(value=>String(value.id)===input.searchParams.get('id'));
    // Never silently substitute the feed's first event for a missing/old ID.
    if(!match)throw new AppError('EVENT_UNAVAILABLE',404);
    const routes=gscOptions(match,url,{selected:Number(input.searchParams.get('s'))||0});
    if(!routes.length)throw new AppError('STREAMS_NOT_POSTED',422);return routes;
  }
  // Wrapper pages are inspected normally; never replace their own routing
  // logic with the feed's optional/historical upstream URL.
  return [];
}
