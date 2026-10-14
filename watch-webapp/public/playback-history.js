export const PLAYBACK_HISTORY_KEY='cleanstream.playbackHistory.v1';
const count=value=>Math.max(0,Math.min(10000,Number(value)||0));
const time=value=>Math.max(0,Number(value)||0);
export function hostOf(value){try{return new URL(value.includes('://')?value:'https://'+value).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}}
export function playbackContext(agent=globalThis.navigator?.userAgent||'',mode='local'){
  const browser=/Chrome|Chromium|Edg\//.test(agent)?'chrome':/Safari/.test(agent)&&!/(CriOS|FxiOS)/.test(agent)?'safari':/Firefox/.test(agent)?'firefox':'other';
  return `${browser}:${['local','cast','airplay'].includes(mode)?mode:'local'}`;
}
export function feedKey(item){try{const u=new URL(item.mediaUrl);return u.origin+u.pathname;}catch{return '';}}
export function cleanPlaybackHistory(values=[]){
  if(!Array.isArray(values))return [];
  return values.slice(0,1000).flatMap(raw=>{
    const host=hostOf(String(raw?.host||''));if(!host)return [];
    let categoryUrl='';try{const u=new URL(raw.categoryUrl);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.href.length<=2048)categoryUrl=u.href;}catch{}
    return [{host,feedKey:String(raw.feedKey||'').slice(0,2048),eventId:String(raw.eventId||'').slice(0,128),mediaHost:hostOf(String(raw.mediaHost||'')),sport:String(raw.sport||'OTHER').toUpperCase().slice(0,32),context:String(raw.context||'').slice(0,32),
      successes:count(raw.successes),failures:count(raw.failures),lastSuccessAt:time(raw.lastSuccessAt),lastFailureAt:time(raw.lastFailureAt),
      consecutiveFailures:count(raw.consecutiveFailures),avgStartupMs:Math.min(120000,time(raw.avgStartupMs)),reason:String(raw.reason||'').slice(0,48),categoryUrl}];
  });
}
export function loadPlaybackHistory(storage=globalThis.localStorage){try{return cleanPlaybackHistory(JSON.parse(storage?.getItem(PLAYBACK_HISTORY_KEY)||'[]'));}catch{return [];}}
export function historyFor(item,event={},context=playbackContext(),values=loadPlaybackHistory()){
  const host=hostOf(item?.providerHost||item?.sourceRoot||item?.sourceUrl||'');
  const mediaHost=hostOf(item?.mediaUrl||'');const sport=String(event.league||event.sport||'OTHER').toUpperCase();
  const matches=values.filter(value=>value.host===host&&value.context===context);
  return matches.find(value=>value.sport===sport&&value.mediaHost===mediaHost&&value.feedKey===feedKey(item)&&value.eventId===String(event.id||''))||null;
}
export function historyPriority(record,now=Date.now()){
  if(!record)return 0;
  const lastSuccessAt=time(record.lastSuccessAt),lastFailureAt=time(record.lastFailureAt);
  const recentSuccess=lastSuccessAt>0?Math.max(0,Math.min(1,1-(now-lastSuccessAt)/(14*86400000))):0;
  const recentFailure=lastFailureAt>lastSuccessAt?Math.max(0,Math.min(1,1-(now-lastFailureAt)/(6*3600000))):0;
  const weak=['TIMEOUT','TOKEN_EXPIRED','NETWORK_ERROR','PLAYBACK_FAILED'].includes(record.reason);
  const penalty=Math.min(record.consecutiveFailures||0,5)*(weak?7:22)*recentFailure;
  return Math.min(record.successes||0,10)*3+recentSuccess*90-Math.min(record.avgStartupMs||0,15000)/1000-penalty;
}
export function playbackLabel(item,event,context=playbackContext(),values=loadPlaybackHistory()){
  const record=historyFor(item,event,context,values);
  if(record?.lastFailureAt>record?.lastSuccessAt)return 'FAILED ON THIS DEVICE — TRY AGAIN';
  if(record?.lastSuccessAt)return 'PLAYED ON THIS DEVICE';
  const host=hostOf(item?.providerHost||item?.sourceRoot||item?.sourceUrl||'');
  const provider=values.filter(value=>value.host===host&&value.context===context);
  if(provider.some(value=>value.lastSuccessAt))return 'PROVIDER PLAYED ON THIS DEVICE';
  if(provider.some(value=>value.lastFailureAt))return 'PAST PLAYBACK FAILURES — TRY SOURCE';
  return 'FOUND — UNTESTED';
}
export function recordPlayback(item,event,context,outcome,{reason='',startupMs=0,now=Date.now()}={},storage=globalThis.localStorage){
  const host=hostOf(item?.providerHost||item?.sourceRoot||item?.sourceUrl||'');if(!host)return null;
  const mediaHost=hostOf(item?.mediaUrl||''),key=feedKey(item),eventId=String(event?.id||''),sport=String(event?.league||event?.sport||'OTHER').toUpperCase();
  const values=loadPlaybackHistory(storage),index=values.findIndex(value=>value.host===host&&value.mediaHost===mediaHost&&value.sport===sport&&value.context===context&&value.feedKey===key&&value.eventId===eventId);
  const old=index>=0?values[index]:{host,mediaHost,feedKey:key,eventId,sport,context,successes:0,failures:0,consecutiveFailures:0};
  const next={...old};
  if(outcome==='success')Object.assign(next,{successes:old.successes+1,lastSuccessAt:now,consecutiveFailures:0,categoryUrl:item.categoryUrl||old.categoryUrl||'',avgStartupMs:old.avgStartupMs?Math.round(old.avgStartupMs*.75+startupMs*.25):startupMs});
  else Object.assign(next,{failures:old.failures+1,lastFailureAt:now,consecutiveFailures:(old.consecutiveFailures||0)+1,reason});
  if(index>=0)values.splice(index,1);values.unshift(next);
  try{storage?.setItem(PLAYBACK_HISTORY_KEY,JSON.stringify(cleanPlaybackHistory(values)));}catch{}
  return next;
}
// A seek or a single canplay event is not sustained playback.
export class PlaybackEvidence {
  constructor(onSuccess){this.onSuccess=onSuccess;this.last=null;this.progress=0;this.finished=false;}
  sample(position,playing,now=Date.now()){
    if(this.finished)return;
    if(playing&&this.last?.playing){const elapsed=now-this.last.now,advance=position-this.last.position;
      if(elapsed>0&&elapsed<=2500&&advance>0&&advance<=elapsed/1000*2+.3)this.progress+=Math.min(elapsed,advance*1000);
    }
    this.last={position,playing,now};
    if(this.progress>=3000){this.finished=true;this.onSuccess();}
  }
}
