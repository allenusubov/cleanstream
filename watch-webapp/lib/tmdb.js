import {AppError} from './network.js';

const API='https://api.themoviedb.org/3';
const cache=new Map();
const CACHE_MS=10*60*1000;
const token=()=>String(process.env.TMDB_BEARER_TOKEN||process.env.TMDB_API_READ_TOKEN||'').trim();

function cleanQuery(value=''){
  return String(value||'')
    .replace(/\bs(?:eason)?\s*\d+\b/ig,' ')
    .replace(/\bs\d{1,2}e\d{1,3}\b/ig,' ')
    .replace(/\bepisode\s*\d+\b/ig,' ')
    .replace(/\s+/g,' ').trim();
}
function year(value=''){const match=String(value||'').match(/^(\d{4})/);return match?Number(match[1]):null;}
function cacheGet(key){const old=cache.get(key);if(old&&Date.now()-old.time<CACHE_MS)return old.value;return null;}
function cacheSet(key,value){cache.set(key,{time:Date.now(),value});if(cache.size>300)cache.delete(cache.keys().next().value);return value;}
async function request(path,params={}){
  const auth=token();if(!auth)throw new AppError('TMDB_NOT_CONFIGURED',503);
  const url=new URL(`${API}${path}`);for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,String(value));
  const key=url.href,old=cacheGet(key);if(old)return old;
  const response=await fetch(url,{headers:{Authorization:`Bearer ${auth}`,Accept:'application/json'},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new AppError(response.status===401?'TMDB_NOT_CONFIGURED':'TMDB_UNAVAILABLE',502);
  return cacheSet(key,await response.json());
}

export function tmdbConfigured(){return Boolean(token());}
export function tmdbSearchQuery(value){return cleanQuery(value);}
export function normalizeMovie(item={}){
  return {contentType:'tvm',kind:'movie',id:`tvm-movie-${item.id}`,tmdbId:Number(item.id),title:String(item.title||item.original_title||'MOVIE'),year:year(item.release_date),releaseDate:item.release_date||'',overview:item.overview||''};
}
export function normalizeTv(item={},details={}){
  return {contentType:'tvm',kind:'tv',id:`tvm-tv-${item.id}`,tmdbId:Number(item.id),title:String(item.name||item.original_name||details.name||'TV SHOW'),year:year(item.first_air_date||details.first_air_date),firstAirDate:item.first_air_date||details.first_air_date||'',seasonCount:Number(details.number_of_seasons)||0,overview:item.overview||details.overview||''};
}
export function normalizeEpisode(show,seasonNumber,episode={}){
  return {contentType:'tvm',kind:'tv',id:`tvm-tv-${show.tmdbId||show.id}-s${Number(seasonNumber)}e${Number(episode.episode_number)}`,tmdbId:Number(show.tmdbId||show.id),showTitle:String(show.title||show.name||'TV SHOW'),title:`EPISODE ${Number(episode.episode_number)} · ${String(episode.name||`EPISODE ${episode.episode_number}`).toUpperCase()}`,episodeTitle:String(episode.name||''),seasonNumber:Number(seasonNumber),episodeNumber:Number(episode.episode_number),airDate:episode.air_date||'',year:year(episode.air_date),overview:episode.overview||''};
}

export async function searchTvm(query){
  const q=cleanQuery(query);if(!q)return {tv:[],movies:[]};
  const data=await request('/search/multi',{query:q,include_adult:'false',language:'en-US',page:1});
  const raw=Array.isArray(data.results)?data.results:[];
  const tvRaw=raw.filter(item=>item.media_type==='tv').slice(0,6);
  const movieRaw=raw.filter(item=>item.media_type==='movie').slice(0,8);
  const tv=await Promise.all(tvRaw.map(async item=>{try{return normalizeTv(item,await request(`/tv/${item.id}`,{language:'en-US'}));}catch{return normalizeTv(item);}}));
  return {tv,movies:movieRaw.map(normalizeMovie)};
}

export async function tvDetails(id){
  const data=await request(`/tv/${Number(id)}`,{language:'en-US'});
  const show=normalizeTv(data,data);
  const seasons=(Array.isArray(data.seasons)?data.seasons:[]).filter(season=>Number(season.season_number)>0).map(season=>({seasonNumber:Number(season.season_number),name:String(season.name||`SEASON ${season.season_number}`),year:year(season.air_date),airDate:season.air_date||'',episodeCount:Number(season.episode_count)||0}));
  return {...show,seasons,seasonCount:seasons.length||show.seasonCount};
}
export async function tvSeason(id,seasonNumber){
  const show=await tvDetails(id);const number=Number(seasonNumber);
  const data=await request(`/tv/${Number(id)}/season/${number}`,{language:'en-US'});
  const episodes=(Array.isArray(data.episodes)?data.episodes:[]).map(episode=>normalizeEpisode(show,number,episode));
  return {show,season:{seasonNumber:number,name:String(data.name||`SEASON ${number}`),year:year(data.air_date),airDate:data.air_date||'',episodes}};
}
export async function movieDetails(id){return normalizeMovie(await request(`/movie/${Number(id)}`,{language:'en-US'}));}

export async function episodeContext(id,seasonNumber,episodeNumber){
  const show=await tvDetails(id);const season=await tvSeason(id,seasonNumber);const episodes=season.season.episodes;
  const index=episodes.findIndex(item=>item.episodeNumber===Number(episodeNumber));
  if(index<0)throw new AppError('TVM_ITEM_UNAVAILABLE',404);
  const current=episodes[index];let previous=index>0?episodes[index-1]:null,next=index<episodes.length-1?episodes[index+1]:null;
  if(!previous){
    const previousSeason=show.seasons.filter(item=>item.seasonNumber<Number(seasonNumber)).at(-1);
    if(previousSeason){try{previous=(await tvSeason(id,previousSeason.seasonNumber)).season.episodes.at(-1)||null;}catch{}}
  }
  if(!next){
    const nextSeason=show.seasons.find(item=>item.seasonNumber>Number(seasonNumber));
    if(nextSeason){try{next=(await tvSeason(id,nextSeason.seasonNumber)).season.episodes[0]||null;}catch{}}
  }
  return {show,current,previous,next};
}
