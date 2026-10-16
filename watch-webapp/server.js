import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolve,clearResolved} from './lib/resolver.js';
import {knownEvents,getLiveWindow,getKnownEvent} from './lib/schedules.js';
import {searchEvents} from './lib/live-search.js';
import {eventJob} from './lib/discovery.js';
import {AppError,safeURL,publicURL} from './lib/network.js';
import {customRegistry} from './lib/custom-sources.js';
import {scanSourceProfile} from './lib/source-profile.js';
import {requestErrorLog} from './lib/error-log.js';
import {cleanPlaybackHistory} from './public/playback-history.js';
import {excludedPlatform} from './public/live-only.js';
import {extractionError} from './lib/event-streams.js';
import {withSignal} from './lib/discovery-control.js';
export const app=express();
const root=path.dirname(fileURLToPath(import.meta.url));
app.set('trust proxy',1);
app.use(express.json({limit:'2mb'}));
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
  const live=await searchEvents(query);
  res.json({live,notices:live.notices||[]});
});
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
  if(req.body?.refresh) clearResolved(url,origin(req));
  res.setHeader('Cache-Control','no-store');
  const controller=new AbortController();
  res.on('close',()=>controller.abort(new DOMException('Client disconnected','AbortError')));
  if(!req.body?.stream){
    try{return res.json(await withSignal(controller.signal,()=>resolve(url,origin(req))));}
    catch(cause){throw extractionError(cause);}
  }
  res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store, no-transform');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
  const write=value=>{if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify(value)+'\n');};
  const heartbeat=setInterval(()=>write({type:'ping'}),10000);
  try{
    const result=await withSignal(controller.signal,()=>resolve(url,origin(req),{scanAll:true,signal:controller.signal,playbackHistory:cleanPlaybackHistory(req.body.playbackHistory),
      onCandidate:candidate=>write({type:'candidate',candidate}),onProgress:progress=>write({type:'progress',...progress})}));
    write({type:'done',partial:result.partial,checkedRoutes:result.checkedRoutes,totalRoutes:result.totalRoutes});
  }catch(cause){
    if(!controller.signal.aborted){const error=extractionError(cause);console.error(JSON.stringify(requestErrorLog(error,req)));write({type:'error',code:error.code});}
  }finally{clearInterval(heartbeat);if(!res.destroyed)res.end();}
});
async function streamEventSources(req,res){
  const event=knownEvents.get(req.params.id);
  if(!event) throw new AppError('EVENT_UNAVAILABLE',404);
  const customSites=await customRegistry(req.body?.customSources||[]);
  const mode=req.body?.mode==='deep'?'deep':'light';
  const job=eventJob(event,origin(req),customSites,{mode,resume:Boolean(req.body?.resume),recheck:Boolean(req.body?.recheck),checkedProviderIds:req.body?.checkedProviderIds,playbackHistory:cleanPlaybackHistory(req.body?.playbackHistory)});
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
  res.on('close',()=>{clearInterval(heartbeat);job.listeners.delete(write);setTimeout(()=>{if(!job.listeners.size&&!job.done)job.cancel?.();},250).unref();});
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
    job.listeners.add(write);detach.push(()=>{job.listeners.delete(write);setTimeout(()=>{if(!job.listeners.size&&!job.done)job.cancel?.();},250).unref();});write(job.snapshot());job.start();
  }
  const heartbeat=setInterval(()=>{if(!closed&&!res.destroyed&&!res.writableEnded)res.write('{"type":"ping"}\n');},10000);
  detach.push(()=>clearInterval(heartbeat));
  res.on('close',()=>{closed=true;for(const fn of detach)fn();});
});

app.post('/api/source-test',async(req,res)=>{
  const raw=String(req.body?.url||'').trim();
  const input=raw.includes('://')?raw:`https://${raw}`;
  if(excludedPlatform(input))throw new AppError('LIVE_AGGREGATORS_ONLY',422);
  const url=publicURL(input);
  const profile=await scanSourceProfile(url.href,req.body?.profile||{});
  let finalUrl=url;try{finalUrl=publicURL(profile.url||url.href);}catch{}
  res.setHeader('Cache-Control','no-store');
  res.json({ok:Boolean(profile.reachable),status:profile.status||'PARTIAL',reachable:Boolean(profile.reachable),
    pagesChecked:Number(profile.pagesChecked)||0,reachablePages:Number(profile.reachablePages)||0,
    url:finalUrl.href,host:finalUrl.hostname.replace(/^www\./i,'').toUpperCase(),
    categories:profile.categories||{},eventLists:profile.eventLists||[],support:profile.support||{},structure:profile.structure||{},reason:profile.reason||'',testedAt:profile.testedAt||Date.now()});
});
// Deliberately disabled: this app never relays video bytes to viewers or TVs.
app.use('/api/media',(_req,res)=>res.status(410).json({code:'DIRECT_ONLY'}));
app.use('/api/tvm',(_req,res)=>res.status(410).json({code:'LIVE_AGGREGATORS_ONLY'}));
// Uploading replacement files in GitHub does not delete old files. Never serve
// obsolete player modules even if they remain in an existing checkout.
app.use(['/youtube-player.js','/twitch-player.js','/youtube-url.js','/twitch-url.js'],(_req,res)=>res.sendStatus(404));
app.use(express.static(path.join(root,'public'),{maxAge:0}));
app.use((error,req,res,_next)=>{
  console.error(JSON.stringify(requestErrorLog(error,req)));
  if(res.headersSent) return res.end();
  res.status(error.status||500).json({code:error.type==='entity.too.large'?'SOURCE_LIST_TOO_LARGE':error.code||'SOURCE_UNAVAILABLE'});
});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))app.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('CLEAN STREAM ready'));
