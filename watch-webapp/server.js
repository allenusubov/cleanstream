import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolve,clearResolved} from './lib/resolver.js';
import {knownEvents} from './lib/schedules.js';
import {searchEvents} from './lib/live-search.js';
import {youtubeId} from './public/youtube-url.js';
import {resolveYouTube} from './lib/youtube.js';
import {twitchChannel,twitchCandidate} from './public/twitch-url.js';
import {eventJob} from './lib/discovery.js';
import {AppError,safeURL} from './lib/network.js';
import {customRegistry} from './lib/custom-sources.js';
import {scanSourceProfile} from './lib/source-profile.js';
const app=express();
const root=path.dirname(fileURLToPath(import.meta.url));
app.set('trust proxy',1);
app.use(express.json({limit:'16kb'}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  next();
});
const buckets=new Map();
function limit(max) {
  return (req,res,next)=>{
    const key=`${max}|${req.ip}`;
    const now=Date.now();const old=(buckets.get(key)||[]).filter(t=>now-t<60000);
    if(old.length>=max) return res.status(429).json({code:'USAGE_LIMIT'});
    old.push(now);buckets.set(key,old);
    if(buckets.size>2000) for(const [k,v] of buckets) if(v.at(-1)<now-60000) buckets.delete(k);
    next();
  };
}
function origin(req) {
  const configured=process.env.PUBLIC_ORIGIN;
  if(configured) return new URL(configured).origin;
  return `${req.protocol}://${req.get('host')}`;
}
app.get('/health',(_req,res)=>res.send('ok'));
app.get('/api/events',limit(30),async(req,res)=>{
  const query=String(req.query.q||'').trim().slice(0,100);
  if(!query) throw new AppError('ENTER_EVENT');
  res.setHeader('Cache-Control','no-store');
  res.json(await searchEvents(query));
});
app.post('/api/resolve',limit(8),async(req,res)=>{
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
  const job=eventJob(event,origin(req),customSites);
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
app.get('/api/events/:id/sources',limit(30),streamEventSources);
app.post('/api/events/:id/sources',limit(30),streamEventSources);
app.post('/api/source-test',limit(12),async(req,res)=>{
  const raw=String(req.body?.url||'').trim();
  const url=await safeURL(raw.includes('://')?raw:`https://${raw}`);
  const profile=await scanSourceProfile(url.href);
  const finalUrl=await safeURL(profile.url);
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,url:finalUrl.href,host:finalUrl.hostname.replace(/^www\./i,'').toUpperCase(),
    categories:profile.categories||{},eventLists:profile.eventLists||[]});
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
