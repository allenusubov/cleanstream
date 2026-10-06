import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolve,clearResolved} from './lib/resolver.js';
import {knownEvents,getLiveWindow,getKnownEvent} from './lib/schedules.js';
import {searchEvents} from './lib/live-search.js';
import {youtubeId} from './public/youtube-url.js';
import {resolveYouTube} from './lib/youtube.js';
import {twitchChannel,twitchCandidate} from './public/twitch-url.js';
import {eventJob} from './lib/discovery.js';
import {AppError,safeURL} from './lib/network.js';
import {customRegistry} from './lib/custom-sources.js';
import {scanSourceProfile} from './lib/source-profile.js';
import {searchTvm,tvDetails,tvSeason,movieDetails,episodeContext,tmdbConfigured} from './lib/tmdb.js';
import {tvmSourceJob} from './lib/tvm-sources.js';
const app=express();
const root=path.dirname(fileURLToPath(import.meta.url));
app.set('trust proxy',1);
app.use(express.json({limit:'64kb'}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  next();
});
function origin(req) {
  const configured=process.env.PUBLIC_ORIGIN;
  if(configured) return new URL(configured).origin;
  return `${req.protocol}://${req.get('host')}`;
}
app.get('/health',(_req,res)=>res.send('ok'));
app.get('/api/events',async(req,res)=>{
  const query=String(req.query.q||'').trim().slice(0,100);
  if(!query) throw new AppError('ENTER_EVENT');
  res.setHeader('Cache-Control','no-store');
  res.json(await searchEvents(query));
});

app.get('/api/search',async(req,res)=>{
  const query=String(req.query.q||'').trim().slice(0,100);
  if(!query)throw new AppError('ENTER_EVENT');
  res.setHeader('Cache-Control','no-store');
  const [liveResult,tvmResult]=await Promise.allSettled([searchEvents(query),searchTvm(query)]);
  const live=liveResult.status==='fulfilled'?liveResult.value:{events:[],alternatives:[],complete:false,notices:['SCHEDULE_UNAVAILABLE']};
  const tvm=tvmResult.status==='fulfilled'?tvmResult.value:{tv:[],movies:[]};
  const notices=[...(live.notices||[])];
  if(tvmResult.status==='rejected')notices.push(tmdbConfigured()?'TMDB_UNAVAILABLE':'TMDB_NOT_CONFIGURED');
  res.json({live,tv:tvm.tv||[],movies:tvm.movies||[],notices:[...new Set(notices)]});
});
app.get('/api/tvm/tv/:id',async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await tvDetails(req.params.id));});
app.get('/api/tvm/tv/:id/season/:season',async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await tvSeason(req.params.id,req.params.season));});
app.get('/api/tvm/tv/:id/episode/:season/:episode',async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await episodeContext(req.params.id,req.params.season,req.params.episode));});
app.get('/api/tvm/movie/:id',async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await movieDetails(req.params.id));});
app.get('/api/live-window',async(req,res)=>{
  const hours=Math.max(1,Math.min(Number(req.query.hours)||24,168));
  res.setHeader('Cache-Control','no-store');
  res.json(await getLiveWindow(hours));
});
app.get('/api/event/:id',async(req,res)=>{
  const event=getKnownEvent(req.params.id);
  if(!event)throw new AppError('EVENT_UNAVAILABLE',404);
  res.setHeader('Cache-Control','no-store');
  res.json({event});
});
app.post('/api/resolve',async(req,res)=>{
  const url=String(req.body?.url||'').trim();
  const youtube=youtubeId(url);
  if(youtube)return res.json({sourceUrl:url,candidates:[await resolveYouTube(youtube)]});
  const twitch=twitchChannel(url);
  if(twitch)return res.json({sourceUrl:url,candidates:[twitchCandidate(twitch)]});
  if(req.body?.refresh) clearResolved(url,origin(req));
  res.setHeader('Cache-Control','no-store');
  res.json(await resolve(url,origin(req)));
});
async function streamEventSources(req,res){
  const event=knownEvents.get(req.params.id);
  if(!event) throw new AppError('EVENT_UNAVAILABLE',404);
  const customSites=await customRegistry(req.body?.customSources||[]);
  const mode=req.body?.mode==='light'?'light':'deep';
  const job=eventJob(event,origin(req),customSites,{mode});
  res.setHeader('Content-Type','application/x-ndjson');
  res.setHeader('Cache-Control','no-store, no-transform');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  const write=state=>{
    if(res.destroyed || res.writableEnded) return;
    res.write(JSON.stringify(state)+'\n');
    if(state.done) res.end();
  };
  job.listeners.add(write);
  const heartbeat=setInterval(()=>{if(!res.destroyed && !res.writableEnded) res.write('{"type":"ping"}\n');},10000);
  res.on('close',()=>{clearInterval(heartbeat);job.listeners.delete(write);});
  write(job.snapshot());job.start();
}
app.get('/api/events/:id/sources',streamEventSources);
app.post('/api/events/:id/sources',streamEventSources);
app.post('/api/explore-sources',async(req,res)=>{
  const ids=[...new Set(Array.isArray(req.body?.eventIds)?req.body.eventIds.map(value=>String(value)):[])];
  const events=ids.map(id=>knownEvents.get(id)).filter(Boolean);
  const customSites=await customRegistry(req.body?.customSources||[]);
  res.setHeader('Content-Type','application/x-ndjson');
  res.setHeader('Cache-Control','no-store, no-transform');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  if(!events.length){res.write('{"type":"done"}\n');return res.end();}
  let completed=0,closed=false;
  const detach=[];
  const maybeEnd=()=>{if(!closed&&completed>=events.length){closed=true;for(const fn of detach)fn();res.end();}};
  for(const event of events){
    const job=eventJob(event,origin(req),customSites,{mode:'light'});let counted=false;
    const write=state=>{
      if(closed||res.destroyed||res.writableEnded)return;
      res.write(JSON.stringify(state)+'\n');
      if(state.done&&!counted){counted=true;completed++;maybeEnd();}
    };
    job.listeners.add(write);detach.push(()=>job.listeners.delete(write));write(job.snapshot());job.start();
  }
  const heartbeat=setInterval(()=>{if(!closed&&!res.destroyed&&!res.writableEnded)res.write('{"type":"ping"}\n');},10000);
  detach.push(()=>clearInterval(heartbeat));
  res.on('close',()=>{closed=true;for(const fn of detach)fn();});
});

app.post('/api/tvm/sources',async(req,res)=>{
  const item=req.body?.item;
  const customSites=await customRegistry(req.body?.customSources||[]);
  const job=tvmSourceJob(item,origin(req),customSites,{mode:req.body?.mode||'deep'});
  res.setHeader('Content-Type','application/x-ndjson');
  res.setHeader('Cache-Control','no-store, no-transform');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  const write=state=>{if(res.destroyed||res.writableEnded)return;res.write(JSON.stringify(state)+'\n');if(state.done)res.end();};
  job.listeners.add(write);
  const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write('{"type":"ping"}\n');},10000);
  res.on('close',()=>{clearInterval(heartbeat);job.listeners.delete(write);});
  write(job.snapshot());job.start();
});
app.post('/api/source-test',async(req,res)=>{
  const raw=String(req.body?.url||'').trim();
  const url=await safeURL(raw.includes('://')?raw:`https://${raw}`);
  const profile=await scanSourceProfile(url.href,req.body?.profile||{});
  let finalUrl=url;try{finalUrl=await safeURL(profile.url||url.href);}catch{}
  res.setHeader('Cache-Control','no-store');
  res.json({ok:profile.status!=='UNREACHABLE',status:profile.status||'PARTIAL',reachable:Boolean(profile.reachable),
    pagesChecked:Number(profile.pagesChecked)||0,reachablePages:Number(profile.reachablePages)||0,
    url:finalUrl.href,host:finalUrl.hostname.replace(/^www\./i,'').toUpperCase(),
    categories:profile.categories||{},eventLists:profile.eventLists||[],support:profile.support||{},structure:profile.structure||{},reason:profile.reason||'',testedAt:profile.testedAt||Date.now()});
});
// Deliberately disabled: this app never relays video bytes to viewers or TVs.
app.use('/api/media',(_req,res)=>res.status(410).json({code:'DIRECT_ONLY'}));
app.use(express.static(path.join(root,'public'),{maxAge:0}));
app.use((error,_req,res,_next)=>{
  console.error('Request failed',error.code||error.name);
  if(res.headersSent) return res.end();
  res.status(error.status||500).json({code:error.code||'SOURCE_UNAVAILABLE'});
});
app.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('CLEAN STREAM ready'));
