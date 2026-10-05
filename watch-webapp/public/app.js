import {initSearch} from './search.js';
import {YouTubePlayer} from './youtube-player.js';
import {TwitchPlayer} from './twitch-player.js';
import {livePosition} from './live-position.js';
import {loadCustomSources,addCustomSources,setCustomSourceEnabled,setCustomSourceProfile,mergeCustomSourceProfile,removeCustomSource,customSourceDomain,profileLines,parseProfileLines} from './custom-sources.js';
import {loadEventPreferences,setEventCategoryEnabled,setEventCategoryOrder,setEventFavorites,tickerEvents} from './event-preferences.js';
const $ = selector => document.querySelector(selector);
const homeView = $('[data-view="home"]');
const playerView = $('[data-view="player"]');
const settingsView = $('[data-view="settings"]');
const settingsList = $('#custom-source-list');
const settingsMessage = $('#settings-message');
const customSourceInput = $('#custom-source-url');
const categoryList=$('#event-category-list');
const favoritesForm=$('#favorites-form');
const favoritesInput=$('#favorites-input');
const preferencesMessage=$('#preferences-message');
const streamInput = $('#stream-url');
const homeMessage = $('#home-message');
const sourceLink = $('#source-link');
const video = $('#video');
const stage = $('.player-stage');
const playerEmpty = $('#player-empty');
const emptyCopy = $('#empty-copy');
const message = $('#player-message');
const playButton = $('#play-button');
const muteButton = $('#mute-button');
const refreshButton = $('#refresh-button');
const liveButton = $('#live-button');
const tvButton = $('#tv-button');
const tickerTrack=$('#ticker-track');
const liveTicker=$('#live-ticker');
const exploreButton=$('#explore-button');

let hls = null;
let candidate = null;
let sourceUrl = '';
let operation = null;
let busy = false;
let localLive = false;
let segmentDuration = 6;
let buffering = true;
let lastProgress = 0;
let lastTime = -1;
let generation = 0;
let castContext = null;
let remotePlayer = null;
let remoteController = null;
let castLoading = false;
let castLoadPromise = null;
let tvMode = null;
let nativeProbeAt = 0;
let nativeProbePending = false;
let alternatives = [];
let currentEvent = null;
let recovering = false;
let userPaused = true;
let recoveryAttempts = 0;
let lastRecovery = 0;
let failedSources = new Set();
let castOwned=false;
let remoteProgress=0;
let remotePosition=-1;
let recoveryCycles=0;
let liveWindowEvents=[];
let liveWindowUpdated=0;
let tickerTimer=0,tickerPauseUntil=0,tickerSetWidth=0,tickerNormalizing=false,tickerAutoScrolling=false,tickerAutoScrollAt=0,tickerHovered=false,tickerAnimating=false,tickerAnimationFrame=0,tickerEventCount=0;
let currentSettingsSection='menu';
const youtube=new YouTubePlayer($('#youtube-player'),()=>syncControls(),error=>say(readable(error)));
const twitch=new TwitchPlayer($('#twitch-player'),()=>syncControls(),error=>say(readable(error)));
const isYouTube=()=>candidate?.provider==='youtube';
const isTwitch=()=>candidate?.provider==='twitch';
const isEmbedded=()=>isYouTube()||isTwitch();
const friendly = {
  INVALID_URL:'ENTER A VALID PUBLIC LINK', ENTER_EVENT:'ENTER AN EVENT',
  SOURCE_UNAVAILABLE:"STREAM UNAVAILABLE — THIS SOURCE ISN'T WORKING RIGHT NOW",
  NO_MEDIA:"NO PLAYABLE VIDEO FOUND",
  DIRECT_BLOCKED:"PLAYBACK BLOCKED — THIS SOURCE CAN'T PLAY DIRECTLY ON YOUR DEVICE",
  SOURCE_FROZEN:'STREAM UNAVAILABLE — THIS SOURCE HAS STOPPED UPDATING',
  USAGE_LIMIT:'CHECK LIMIT REACHED — TRY AGAIN LATER', BUSY:'CHECKS ARE BUSY — TRY AGAIN SHORTLY',
  DIRECT_ONLY:'THIS STREAM NEEDS TO BE OPENED AGAIN', NOT_STARTED:'THIS EVENT HAS NOT STARTED',
  CAST_UNAVAILABLE:'THIS SOURCE IS UNAVAILABLE ON YOUR TV',
  YOUTUBE_UNAVAILABLE:'YOUTUBE PLAYBACK UNAVAILABLE — TRY THE SOURCE LINK',
  YOUTUBE_EMBED_BLOCKED:'THIS VIDEO MUST BE WATCHED ON YOUTUBE — USE SOURCE',
  TWITCH_UNAVAILABLE:'TWITCH PLAYBACK UNAVAILABLE — TRY THE SOURCE LINK'
};
const search = initSearch(async (item, items, event) => {
  currentEvent=event; alternatives=items; failedSources=new Set();recoveryAttempts=0;recoveryCycles=0;
  sourceUrl=item.sourceUrl;sourceLink.href=sourceUrl;streamInput.value=sourceUrl;
  navigate({view:'player',url:sourceUrl,q:search.query,event:event.id,live:['youtube','twitch'].includes(item.provider)?item.live:undefined});
  search.stop();
  showView('player');userPaused=false;
  const toTV=casting();
  await runOperation(async signal => {
    let choices=[item,...items.filter(x=>x.id!==item.id)];
    for(const choice of choices) {
      try {await playItem(choice,signal,toTV);return;}catch(error){if(signal.aborted)throw error;failedSources.add(choice.id);}
    }
    throw new Error('DIRECT_BLOCKED');
  });
},q=>{
  leavePlayer();showView('home');navigate({view:'search',q});
});

function tickerLabel(event){
  if(event.status==='live')return `${event.title} · LIVE`;
  const when=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(event.startTime)).toUpperCase();
  return `${event.title} · ${when}`;
}
function tickerEventButton(event){
  const button=document.createElement('button');button.type='button';button.className='ticker-event';button.textContent=tickerLabel(event);
  button.addEventListener('click',()=>{
    leavePlayer();showView('home');navigate({view:'event',event:event.id,q:event.title});search.showEvent(event);
  });
  return button;
}
const TICKER_STEP_MS=1000;
const TICKER_SLIDE_MS=180;
function scheduleTicker(delay=TICKER_STEP_MS){
  clearTimeout(tickerTimer);
  tickerTimer=setTimeout(stepTicker,Math.max(40,delay));
}
function pauseTicker(ms=3500){
  tickerPauseUntil=Math.max(tickerPauseUntil,performance.now()+ms);
  scheduleTicker(Math.max(60,tickerPauseUntil-performance.now()));
}
function markTickerProgrammaticScroll(){
  tickerAutoScrolling=true;tickerAutoScrollAt=performance.now();
  requestAnimationFrame(()=>{tickerAutoScrolling=false;});
}
function normalizeTickerPosition(){
  if(!tickerSetWidth||tickerNormalizing)return;
  tickerNormalizing=true;
  if(liveTicker.scrollLeft<tickerSetWidth*.45){markTickerProgrammaticScroll();liveTicker.scrollLeft+=tickerSetWidth;}
  else if(liveTicker.scrollLeft>tickerSetWidth*1.55){markTickerProgrammaticScroll();liveTicker.scrollLeft-=tickerSetWidth;}
  tickerNormalizing=false;
}
function tickerSets(){return [...tickerTrack.querySelectorAll('.ticker-set')];}
function animateTickerTo(target,duration=TICKER_SLIDE_MS){
  cancelAnimationFrame(tickerAnimationFrame);
  const start=liveTicker.scrollLeft,distance=target-start;
  if(Math.abs(distance)<1){liveTicker.scrollLeft=target;return Promise.resolve();}
  tickerAnimating=true;
  return new Promise(resolve=>{
    const started=performance.now();
    const frame=now=>{
      const t=Math.min(1,(now-started)/duration);
      const eased=1-Math.pow(1-t,3);
      markTickerProgrammaticScroll();
      liveTicker.scrollLeft=start+distance*eased;
      if(t<1){tickerAnimationFrame=requestAnimationFrame(frame);return;}
      liveTicker.scrollLeft=target;tickerAnimating=false;resolve();
    };
    tickerAnimationFrame=requestAnimationFrame(frame);
  });
}
async function stepTicker(){
  const now=performance.now();
  if(!tickerSetWidth||tickerEventCount<2||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  if(tickerHovered){scheduleTicker(120);return;}
  if(tickerAnimating){scheduleTicker(60);return;}
  if(now<tickerPauseUntil){scheduleTicker(tickerPauseUntil-now);return;}
  normalizeTickerPosition();
  const sets=tickerSets(),middle=sets[1],third=sets[2];
  const middleButtons=[...(middle?.querySelectorAll('.ticker-event')||[])];
  const thirdButtons=[...(third?.querySelectorAll('.ticker-event')||[])];
  if(!middleButtons.length||!thirdButtons.length){scheduleTicker();return;}
  const left=liveTicker.scrollLeft;
  let target=middleButtons.find(button=>button.offsetLeft>left+4);
  let wrap=false;
  if(!target){target=thirdButtons[0];wrap=true;}
  await animateTickerTo(target.offsetLeft,TICKER_SLIDE_MS);
  if(wrap){
    markTickerProgrammaticScroll();
    liveTicker.scrollLeft=middleButtons[0].offsetLeft;
  }
  scheduleTicker(Math.max(40,TICKER_STEP_MS-TICKER_SLIDE_MS));
}
function startTickerMotion(){
  clearTimeout(tickerTimer);cancelAnimationFrame(tickerAnimationFrame);tickerAnimating=false;
  requestAnimationFrame(()=>{
    const sets=tickerSets(),first=sets[0],middle=sets[1];
    tickerSetWidth=first?.getBoundingClientRect().width||0;
    const firstMiddle=middle?.querySelector('.ticker-event');
    if(tickerSetWidth&&firstMiddle){markTickerProgrammaticScroll();liveTicker.scrollLeft=firstMiddle.offsetLeft;}
    if(tickerEventCount>1&&!matchMedia('(prefers-reduced-motion: reduce)').matches)scheduleTicker(TICKER_STEP_MS);
  });
}
function renderTicker(events){
  const prefs=loadEventPreferences();liveWindowEvents=Array.isArray(events)?events:[];
  clearTimeout(tickerTimer);cancelAnimationFrame(tickerAnimationFrame);tickerAnimating=false;
  const visible=tickerEvents(liveWindowEvents,prefs);tickerTrack.replaceChildren();tickerSetWidth=0;tickerEventCount=visible.length;
  if(!visible.length){const empty=document.createElement('span');empty.className='ticker-empty';empty.textContent='NO LIVE / UPCOMING EVENTS';tickerTrack.append(empty);return;}
  const makeSet=()=>{const set=document.createElement('div');set.className='ticker-set';for(const event of visible)set.append(tickerEventButton(event));return set;};
  tickerTrack.append(makeSet(),makeSet(),makeSet());startTickerMotion();
}
async function loadLiveWindow(force=false){
  const key='cleanstream.liveWindow.v1';
  if(!force){
    try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');if(saved&&Date.now()-saved.time<60000){liveWindowUpdated=saved.time;renderTicker(saved.data.events||[]);return saved.data;}}catch{}
  }
  try{
    const response=await fetch('/api/live-window?hours=24',{cache:'no-store'});if(!response.ok)throw new Error();
    const data=await response.json();liveWindowUpdated=Date.now();renderTicker(data.events||[]);
    try{sessionStorage.setItem(key,JSON.stringify({time:liveWindowUpdated,data}));}catch{}
    return data;
  }catch{
    if(!liveWindowEvents.length){tickerTrack.replaceChildren();const empty=document.createElement('span');empty.className='ticker-empty';empty.textContent='LIVE SCHEDULE UNAVAILABLE';tickerTrack.append(empty);}
    return {events:liveWindowEvents};
  }
}
liveTicker.addEventListener('mouseenter',()=>{tickerHovered=true;pauseTicker(1200);});
liveTicker.addEventListener('mouseleave',()=>{tickerHovered=false;pauseTicker(600);});
liveTicker.addEventListener('pointerdown',()=>pauseTicker(4500));
liveTicker.addEventListener('touchstart',()=>pauseTicker(4500),{passive:true});
liveTicker.addEventListener('scroll',()=>{const manual=!tickerAnimating&&!tickerAutoScrolling&&performance.now()-tickerAutoScrollAt>120;if(manual){pauseTicker(2200);normalizeTickerPosition();}},{passive:true});
liveTicker.addEventListener('wheel',event=>{
  if(Math.abs(event.deltaY)>Math.abs(event.deltaX)){event.preventDefault();liveTicker.scrollLeft+=event.deltaY;}
  pauseTicker(3500);normalizeTickerPosition();
},{passive:false});
let tickerDrag=null;
liveTicker.addEventListener('pointerdown',event=>{
  if(event.pointerType==='touch')return;
  tickerDrag={id:event.pointerId,x:event.clientX,left:liveTicker.scrollLeft};liveTicker.setPointerCapture?.(event.pointerId);
});
liveTicker.addEventListener('pointermove',event=>{
  if(!tickerDrag||tickerDrag.id!==event.pointerId)return;liveTicker.scrollLeft=tickerDrag.left-(event.clientX-tickerDrag.x);pauseTicker(3500);
});
liveTicker.addEventListener('pointerup',event=>{if(tickerDrag?.id===event.pointerId)tickerDrag=null;});
liveTicker.addEventListener('pointercancel',()=>{tickerDrag=null;});
addEventListener('cleanstream:event-preferences-changed',()=>renderTicker(liveWindowEvents));
exploreButton.addEventListener('click',async()=>{
  if(!liveWindowEvents.length||Date.now()-liveWindowUpdated>60000)await loadLiveWindow(true);
  leavePlayer();showView('home');navigate({view:'explore'});search.explore(liveWindowEvents);
});
async function playItem(item,signal,toTV=false) {
  sourceUrl=item.sourceUrl||sourceUrl;sourceLink.href=sourceUrl;
  if(['youtube','twitch'].includes(item.provider)) {
    // A video playing on a receiver must not overlap a new embedded player.
    if(casting())castContext.endCurrentSession(true);
    await attachLocal(item,signal);userPaused=false;return;
  }
  if(item.expiresAt && item.expiresAt<Date.now()) {
    const data=await apiResolve(signal,true);
    item={...item,...data[0]};
  }
  if(toTV){await loadOnTV(item,signal);candidate=item;}
  else await attachLocal(item,signal);
  const route=new URL(location.href);
  if(route.searchParams.has('watch') && route.searchParams.get('watch')!==sourceUrl) {
    route.searchParams.set('watch',sourceUrl);history.replaceState(history.state,'',route);
  }
  userPaused=false;
}
function readable(error) {
  if(friendly[error?.message])return friendly[error.message];
  if(error?.name==='AbortError')return 'CONNECTION INTERRUPTED — TRY AGAIN';
  return 'STREAM UNAVAILABLE — TRY REFRESH OR ANOTHER SOURCE';
}
async function recoverStream() {
  if(recovering || busy || userPaused || !candidate || Date.now()-lastRecovery<15000)return;
  if(++recoveryCycles>4){userPaused=true;say("NO WORKING SOURCES — PRESS REFRESH TO TRY AGAIN");return;}
  recovering=true;lastRecovery=Date.now();
  const toTV=Boolean(castOwned && castSession());
  await runOperation(async signal=>{
    say('STREAM INTERRUPTED — RECONNECTING');
    try {
      if(recoveryAttempts++<1) {await playItem(candidate,signal,toTV);return;}
    }catch(error){if(signal.aborted)throw error;}
    failedSources.add(candidate.id);
    const available=[...alternatives,...(currentEvent?search.getSources(currentEvent.id):[])];
    const attempted=new Set();
    for(const next of available) {
      if(failedSources.has(next.id)||attempted.has(next.id))continue;
      attempted.add(next.id);say('STREAM INTERRUPTED — SWITCHING SOURCE');
      try{await playItem(next,signal,toTV);return;}catch(error){if(signal.aborted)throw error;failedSources.add(next.id);}
    }
    // Refresh the durable source page only after cached alternatives are exhausted.
    say('CHECKING FOR A FRESH SOURCE');
    try{await resolveAndPlay(signal,toTV,true);return;}catch(error){if(signal.aborted)throw error;}
    if(currentEvent) {
      const fresh=await search.refreshSources(currentEvent.id,null,signal);
      for(const next of fresh) {
        if(next.expiresAt<Date.now()||failedSources.has(next.id))continue;
        try{await playItem(next,signal,toTV);alternatives=fresh;return;}catch(error){if(signal.aborted)throw error;}
      }
    }
    userPaused=true;throw new Error('SOURCE_UNAVAILABLE');
  });
  recovering=false;
}

function showView(name) {
  homeView.classList.toggle('is-active', name === 'home');
  playerView.classList.toggle('is-active', name === 'player');
  settingsView.classList.toggle('is-active', name === 'settings');
  homeView.setAttribute('aria-hidden', String(name !== 'home'));
  playerView.setAttribute('aria-hidden', String(name !== 'player'));
  settingsView.setAttribute('aria-hidden', String(name !== 'settings'));
}
function showSettingsPage(section='menu') {
  const allowed=new Set(['menu','sources','preferences']);currentSettingsSection=allowed.has(section)?section:'menu';
  document.querySelectorAll('[data-settings-page]').forEach(page=>{
    const active=page.dataset.settingsPage===currentSettingsSection;page.hidden=!active;page.classList.toggle('is-active',active);
  });
  settingsMessage.textContent='';preferencesMessage.textContent='';
  if(currentSettingsSection==='sources'){customSourceInput.value='';renderSettingsSources();}
  if(currentSettingsSection==='preferences')renderEventPreferences();
}
function openSettingsPage(section='menu',push=true){
  showView('settings');showSettingsPage(section);if(push)navigate({view:'settings',section});
}
function renderEventPreferences(){
  const prefs=loadEventPreferences();categoryList.replaceChildren();favoritesInput.value=prefs.favorites.join('\n');
  for(const item of prefs.categories){
    const row=document.createElement('div');row.className=`preference-row${item.enabled?'':' is-off'}`;row.dataset.key=item.key;
    const handle=document.createElement('button');handle.type='button';handle.className='preference-drag';handle.setAttribute('aria-label',`Reorder ${item.key}`);handle.textContent='≡';
    const name=document.createElement('span');name.className='preference-name';name.textContent=item.key;
    const toggle=document.createElement('button');toggle.type='button';toggle.className='text-action preference-toggle';toggle.textContent=item.enabled?'ON':'OFF';
    toggle.addEventListener('click',()=>{setEventCategoryEnabled(item.key,!item.enabled);renderEventPreferences();});
    let drag=null;
    handle.addEventListener('pointerdown',event=>{
      event.preventDefault();drag={id:event.pointerId};row.classList.add('is-dragging');handle.setPointerCapture?.(event.pointerId);pauseTicker(5000);
    });
    handle.addEventListener('pointermove',event=>{
      if(!drag||drag.id!==event.pointerId)return;
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.preference-row');
      if(!target||target===row||target.parentElement!==categoryList)return;
      const rect=target.getBoundingClientRect();categoryList.insertBefore(row,event.clientY<rect.top+rect.height/2?target:target.nextSibling);
    });
    const finish=event=>{
      if(!drag||event&&drag.id!==event.pointerId)return;drag=null;row.classList.remove('is-dragging');
      setEventCategoryOrder([...categoryList.children].map(node=>node.dataset.key));renderEventPreferences();
    };
    handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);
    row.append(handle,name,toggle);categoryList.append(row);
  }
}
function renderSourceProfile(copy,item) {
  const profile=document.createElement('div');profile.className='custom-source-profile';
  const entries=[];
  for(const [key,urls] of Object.entries(item.categories||{}))for(const url of urls)entries.push([key,url]);
  for(const url of item.eventLists||[])entries.push(['EVENTS',url]);
  for(const [label,url] of entries){
    const line=document.createElement('div');line.className='custom-source-profile-line';
    const tag=document.createElement('span');tag.className='custom-source-profile-label';tag.textContent=label;
    const link=document.createElement('a');link.className='custom-source-profile-link';link.href=url;link.target='_blank';link.rel='noopener noreferrer';
    try{const u=new URL(url);const tail=`${u.pathname}${u.search}${u.hash}`;link.textContent=`${u.hostname.replace(/^www\./i,'')}${tail==='/'?'':tail}`;}catch{link.textContent=url;}
    line.append(tag,link);profile.append(line);
  }
  if(entries.length)copy.append(profile);
}
function profileEditor(row,item) {
  const old=row.querySelector('.custom-source-editor');if(old){old.remove();return;}
  const editor=document.createElement('form');editor.className='custom-source-editor';
  const textarea=document.createElement('textarea');textarea.rows=4;textarea.spellcheck=false;textarea.value=profileLines(item);
  textarea.placeholder='NFL /nfl\nNBA /#nba\nEVENTS /#live';
  const buttons=document.createElement('div');buttons.className='custom-source-editor-actions';
  const save=document.createElement('button');save.type='submit';save.className='text-action';save.textContent='SAVE';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='text-action';cancel.textContent='CANCEL';cancel.addEventListener('click',()=>editor.remove());
  const note=document.createElement('div');note.className='custom-source-editor-note';note.textContent='ONE MAPPING PER LINE · LABEL + URL, /PATH, ?QUERY OR #HASH';
  buttons.append(save,cancel);editor.append(textarea,note,buttons);
  editor.addEventListener('submit',event=>{event.preventDefault();const parsed=parseProfileLines(textarea.value,item.url);setCustomSourceProfile(item.url,parsed);renderSettingsSources();if(parsed.invalid)settingsMessage.textContent=`${parsed.invalid} INVALID MAPPING${parsed.invalid===1?'':'S'} IGNORED`;});
  row.append(editor);textarea.focus();
}
function renderSettingsSources() {
  const items=loadCustomSources();settingsList.replaceChildren();
  if(!items.length){const empty=document.createElement('div');empty.className='custom-source-empty';empty.textContent='NO CUSTOM SOURCES ADDED';settingsList.append(empty);return;}
  for(const item of items){
    const row=document.createElement('div');row.className=`custom-source-row${item.enabled?'':' is-off'}`;
    const copy=document.createElement('div');copy.className='custom-source-copy';
    const domain=document.createElement('a');domain.className='custom-source-domain';domain.textContent=customSourceDomain(item.url);domain.href=item.url;domain.target='_blank';domain.rel='noopener noreferrer';
    const status=document.createElement('div');status.className='custom-source-status';status.textContent=item.enabled?'ENABLED':'DISABLED';copy.append(domain,status);renderSourceProfile(copy,item);
    const actions=document.createElement('div');actions.className='custom-source-actions';
    const toggle=document.createElement('button');toggle.type='button';toggle.className='text-action';toggle.textContent=item.enabled?'ON':'OFF';toggle.addEventListener('click',()=>{setCustomSourceEnabled(item.url,!item.enabled);renderSettingsSources();});
    const test=document.createElement('button');test.type='button';test.className='text-action';test.textContent='TEST';
    test.addEventListener('click',async()=>{
      test.disabled=true;status.textContent='SCANNING';
      try{
        const response=await fetch('/api/source-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:item.url})});if(!response.ok)throw new Error();
        const data=await response.json();mergeCustomSourceProfile(item.url,{categories:data.categories||{},eventLists:data.eventLists||[]});
        const count=Object.values(data.categories||{}).flat().length+(data.eventLists||[]).length;settingsMessage.textContent=count?`${count} DISCOVERY LINK${count===1?'':'S'} SAVED`:'REACHABLE · NO CATEGORY LINKS FOUND';renderSettingsSources();
      }catch{status.textContent='UNAVAILABLE';}finally{test.disabled=false;}
    });
    const edit=document.createElement('button');edit.type='button';edit.className='text-action';edit.textContent='EDIT';edit.addEventListener('click',()=>profileEditor(row,item));
    const remove=document.createElement('button');remove.type='button';remove.className='text-action';remove.textContent='REMOVE';remove.addEventListener('click',()=>{removeCustomSource(item.url);renderSettingsSources();});
    actions.append(toggle,test,edit,remove);row.append(copy,actions);settingsList.append(row);
  }
}
function openSettings() {openSettingsPage('menu');}

function say(text = '') { message.textContent = text; }
function placeholder(text) {
  emptyCopy.textContent = text;
  playerEmpty.classList.remove('is-hidden');
}
function castSession() { return castContext?.getCurrentSession() || null; }
function casting() {
  return Boolean(castSession() && remotePlayer?.isMediaLoaded &&
    remotePlayer.mediaInfo?.customData?.cleanStreamOrigin === location.origin);
}
function setBusy(value) {
  busy = value;
  refreshButton.disabled = value || !sourceUrl;
  refreshButton.textContent = value ? 'LOADING' : 'REFRESH';
  playButton.disabled = value || !candidate;
  syncControls();
}
function destroyLocal() {
  generation++;
  youtube.destroy();
  twitch.destroy();
  hls?.destroy();
  hls = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.classList.remove('is-visible');
  localLive = false;
  buffering = true;
  lastProgress = 0;
  lastTime = -1;
}
function latestLocalPosition() {
  if(isYouTube())return youtube.target;
  if(isTwitch())return null;
  return livePosition({live:localLive||video.duration===Infinity,seekable:video.seekable,syncPosition:hls?.liveSyncPosition,segmentDuration});
}
function knownLive() {
  if(isYouTube())return youtube.live||candidate?.live===true;
  if(isTwitch())return candidate?.live===true;
  return localLive||candidate?.live===true||video.duration===Infinity||Boolean(casting()&&remotePlayer?.liveSeekableRange&&!remotePlayer.liveSeekableRange.isLiveDone);
}
async function waitForLocalLiveTarget(timeout=2500) {
  const started=Date.now();
  while(Date.now()-started<timeout){
    const target=latestLocalPosition();if(target!==null)return target;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return latestLocalPosition();
}
function remoteLivePosition() {
  const range = remotePlayer?.liveSeekableRange;
  if (!range || range.isLiveDone || !Number.isFinite(range.end)) return null;
  return Math.max(range.start, range.end - Math.max(2, segmentDuration));
}
function syncControls() {
  const onTV = casting();
  const paused = onTV ? remotePlayer.isPaused : isYouTube()?youtube.paused:isTwitch()?twitch.paused:video.paused;
  playButton.textContent = paused ? 'PLAY' : 'PAUSE';
  muteButton.textContent = (onTV ? remotePlayer.isMuted : isYouTube()?youtube.muted:isTwitch()?twitch.muted:video.muted) ? 'UNMUTE' : 'MUTE';
  const target = onTV ? remoteLivePosition() : latestLocalPosition();
  const position = onTV ? remotePlayer.currentTime : isYouTube()?youtube.time:video.currentTime;
  const progressing = onTV
    ? remotePlayer.playerState === 'PLAYING'
    : isYouTube()?!youtube.paused&&!youtube.buffering:isTwitch()?!twitch.paused:!buffering && !video.ended && Date.now() - lastProgress < 5000;
  const live=knownLive();
  const atLive = isTwitch()?live&&!paused:target !== null && !paused && progressing && !busy && !castLoading &&
    position >= target - Math.max(2, segmentDuration / 2);
  liveButton.disabled = busy || !live;
  liveButton.classList.toggle('is-live', atLive);
  liveButton.setAttribute('aria-label', atLive ? 'Playing live' : 'Go to live');
  liveButton.title = live ? (atLive ? 'At the latest available video' : 'Jump to live') : 'Live position unavailable';
  stage.classList.toggle('is-casting', onTV);
  if (onTV && !busy) placeholder('PLAYING ON TV');
  updateTVButton();
}

async function apiResolve(signal, refresh = false) {
  const response = await fetch('/api/resolve', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({url: sourceUrl, refresh}), signal
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('SOURCE_UNAVAILABLE'); }
  if (!response.ok) throw new Error(data.code || 'SOURCE_UNAVAILABLE');
  if (!data.candidates?.length) throw new Error('NO PLAYABLE MEDIA FOUND');
  return data.candidates;
}
async function probeManifest(item, signal, url = item.mediaUrl, depth = 0) {
  if (!item.isHls || depth > 3) return null;
  const response = await fetch(url, {signal, cache: 'no-store'});
  if (!response.ok) throw new Error('SOURCE_UNAVAILABLE');
  const text = await response.text();
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('INVALID STREAM PLAYLIST');
  if (text.includes('#EXT-X-STREAM-INF:')) {
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex(line => line.startsWith('#EXT-X-STREAM-INF:'));
    const next = lines.slice(index + 1).find(line => line.trim() && !line.startsWith('#'));
    return next ? probeManifest(item, signal, new URL(next.trim(), response.url || new URL(url, location.href)).href, depth + 1) : null;
  }
  return {
    live: !text.includes('#EXT-X-ENDLIST') && !text.includes('#EXT-X-PLAYLIST-TYPE:VOD'),
    duration: Number(text.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]) || 6
  };
}
function waitForMedia(signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', cancelled);
      error ? reject(error) : resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error('VIDEO COULD NOT LOAD'));
    const cancelled = () => finish(new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) return cancelled();
    video.addEventListener('canplay', ready);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', cancelled, {once: true});
    timer = setTimeout(() => finish(new Error('STREAM TIMED OUT')), 14000);
  });
}
async function attachLocal(item, signal) {
  destroyLocal();
  const thisGeneration = generation;
  candidate = item;
  if(item.provider==='youtube') {
    placeholder('LOADING');await youtube.load(item,signal);
    playerEmpty.classList.add('is-hidden');say();syncControls();return;
  }
  if(item.provider==='twitch') {
    placeholder('LOADING');await twitch.load(item,signal);
    localLive=true;playerEmpty.classList.add('is-hidden');say();syncControls();return;
  }
  localLive=item.live===true;
  segmentDuration=item.segmentDuration||6;
  stage.classList.remove('is-casting');
  placeholder('LOADING');
  const ready = waitForMedia(signal);
  // Attach rejection handling immediately, even if setup throws synchronously.
  ready.catch(() => {});
  video.classList.add('is-visible');
  if (item.isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
    if (!window.Hls?.isSupported()) throw new Error('HLS IS NOT SUPPORTED IN THIS BROWSER');
    hls = new Hls({enableWorker: true, lowLatencyMode: true, liveSyncDurationCount: 3});
    hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
      if (generation !== thisGeneration) return;
      localLive = Boolean(data.details.live);
      segmentDuration = data.details.targetduration || 6;
      syncControls();
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (generation !== thisGeneration || !data.fatal) return;
      buffering = true;
      say('STREAM INTERRUPTED — PRESS REFRESH');
      syncControls();
      // Trigger readiness failure so refresh can re-extract the source.
      video.dispatchEvent(new Event('error'));
      if(!busy) recoverStream();
    });
    hls.loadSource(item.mediaUrl);
    hls.attachMedia(video);
  } else {
    video.src = item.mediaUrl;
    video.load();
    if (item.isHls) {
      probeManifest(item, signal).then(info => {
        if (info && generation === thisGeneration) {
          localLive = info.live; segmentDuration = info.duration; syncControls();
        }
      }).catch(() => {});
    }
  }
  await ready;
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  segmentDuration=item.segmentDuration||segmentDuration;
  playerEmpty.classList.add('is-hidden');
  try { await video.play(); say(); }
  catch { say('READY — PRESS PLAY'); }
  syncControls();
}
async function resolveAndPlay(signal, toTV = false, refresh = false) {
  const items = await apiResolve(signal, refresh);
  if(!currentEvent) alternatives=items;
  let lastError;
  for (const item of items.slice(0, 3)) {
    try {
      await playItem(item,signal,toTV && Boolean(castSession()));
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('NO PLAYABLE MEDIA FOUND');
}
async function runOperation(task) {
  operation?.abort();
  const controller = new AbortController();
  operation = controller;
  setBusy(true);
  say();
  try { await task(controller.signal); }
  catch (error) {
    if (!controller.signal.aborted) {
      userPaused=true;
      placeholder('TRY REFRESH');
      console.warn('Playback failed', error.name, error.message);
      say(readable(error));
    }
  } finally {
    if (operation === controller) { operation = null; setBusy(false); }
  }
}
async function openStream(push=true,restoreLive=null) {
  search.stop(); currentEvent=null;alternatives=[];failedSources=new Set();recoveryAttempts=0;recoveryCycles=0;userPaused=false;
  let url;
  try {
    const raw = streamInput.value.trim();
    if (!raw) throw new Error();
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch { homeMessage.textContent = 'ENTER A VALID URL'; streamInput.focus(); return; }
  homeMessage.textContent = '';
  sourceUrl = url.href;
  sourceLink.href = sourceUrl;
  showView('player');
  if(push)navigate({view:'player',url:sourceUrl});
  const toTV = casting();
  await runOperation(async signal => {
    if(restoreLive!==null) {
      const items=await apiResolve(signal);if(items[0]?.provider==='youtube' && items[0].live===null)items[0].live=restoreLive;
      return playItem(items[0],signal,toTV);
    }
    return resolveAndPlay(signal,toTV);
  });
}
async function refreshStream() {
  if (busy || !sourceUrl) return;
  const toTV = casting();
  userPaused=false;recoveryAttempts=0;recoveryCycles=0;failedSources.clear();
  await runOperation(async signal => {
    if (candidate) {
      try {
        await playItem(candidate,signal,toTV);
        return;
      } catch (error) { if (signal.aborted) throw error; }
    }
    say('RECONNECTING TO SOURCE');
    await resolveAndPlay(signal, toTV, true);
  });
}

function updateTVButton() {
  const airplay = typeof video.webkitShowPlaybackTargetPicker === 'function';
  const castReady = Boolean(castContext);
  const chromium=/Chrome|Chromium|Edg\//.test(navigator.userAgent);
  tvMode = isEmbedded()?null:chromium?(castReady?'cast':null):airplay?'airplay':castReady?'cast':null;
  tvButton.hidden = !tvMode;
  tvButton.textContent = tvMode === 'airplay' ? 'AIRPLAY' : 'CAST';
  tvButton.classList.toggle('is-connected', casting() || Boolean(video.webkitCurrentPlaybackTargetIsWireless));
  tvButton.disabled = busy || castLoading || !candidate || (tvMode === 'cast' && candidate.castEligible === false);
  tvButton.title = tvMode === 'cast' ? 'Choose a Google Cast device' : 'Choose an AirPlay device';
}
function mediaMime(item) {
  if (item.isHls) return 'application/vnd.apple.mpegurl';
  const type = item.contentType?.split(';')[0];
  if (type?.startsWith('video/')) return type;
  const url = item.mediaUrl || '';
  return /\.webm(?:$|\?)/i.test(url) ? 'video/webm' : 'video/mp4';
}
async function loadOnTV(item, signal) {
  const session = castSession();
  if (!session) throw new Error('NO CAST DEVICE CONNECTED');
  castLoading = true;
  updateTVButton();
  try {
    if(['youtube','twitch'].includes(item.provider)||item.castEligible === false) throw new Error('CAST_UNAVAILABLE');
    const live=Boolean(item.live);
    segmentDuration=item.segmentDuration || segmentDuration;
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const media = new chrome.cast.media.MediaInfo(new URL(item.mediaUrl, location.href).href, mediaMime(item));
    media.streamType = live ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED;
    media.metadata = new chrome.cast.media.GenericMediaMetadata();
    media.metadata.title = currentEvent?.title || 'CLEAN STREAM';
    media.customData = {cleanStreamOrigin:location.origin, sourceUrl, isHls:item.isHls, segmentDuration, live, id:item.id, castEligible:item.castEligible, expiresAt:item.expiresAt};
    const request = new chrome.cast.media.LoadRequest(media);
    request.autoplay = true;
    if (!live && video.currentTime > 0) request.currentTime = video.currentTime;
    await session.loadMedia(request);
    castOwned=true;remoteProgress=Date.now();remotePosition=-1;userPaused=false;
    // Only stop the local download after the receiver accepts the media.
    destroyLocal();
    placeholder('PLAYING ON TV');
    say();
  } catch (error) {
    console.warn('Cast load failed',error.code); throw new Error('CAST_UNAVAILABLE');
  } finally { castLoading = false; syncControls(); }
}
function adoptCastMedia() {
  const media = castSession()?.getMediaSession()?.media;
  if (!media) return;
  try {
    const url = new URL(media.contentId);
    if (media.customData?.cleanStreamOrigin !== location.origin || url.protocol !== 'https:') return;
    candidate = {...media.customData, mediaUrl:url.href, isHls:Boolean(media.customData?.isHls), contentType:media.contentType};
    castOwned=true;remoteProgress=Date.now();userPaused=Boolean(remotePlayer?.isPaused);
    sourceUrl = media.customData?.sourceUrl || sourceUrl;
    sourceLink.href = sourceUrl;
    streamInput.value = sourceUrl;
    segmentDuration = media.customData?.segmentDuration || 6;
    showView('player');
    navigate({view:'player',url:sourceUrl},true);
    destroyLocal();
    setBusy(false);
  } catch { /* A different receiver session must not replace our current source. */ }
}
window.__onGCastApiAvailable = available => {
  if (!available || !window.cast?.framework || castContext) return;
  castContext = cast.framework.CastContext.getInstance();
  castContext.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED
  });
  remotePlayer = new cast.framework.RemotePlayer();
  remoteController = new cast.framework.RemotePlayerController(remotePlayer);
  remoteController.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, syncControls);
  castContext.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, updateTVButton);
  castContext.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, event => {
    if (event.sessionState === cast.framework.SessionState.SESSION_RESUMED) adoptCastMedia();
    if (event.sessionState === cast.framework.SessionState.SESSION_ENDED) {
      castOwned=false;
      stage.classList.remove('is-casting');
      if (candidate && playerView.classList.contains('is-active') && !busy) {
        refreshStream();
      }
    }
    syncControls();
  });
  updateTVButton();
};

tvButton.addEventListener('click', async () => {
  if (!candidate || busy) return;
  if (tvMode === 'airplay') {
    video.webkitShowPlaybackTargetPicker();
    return;
  }
  if (tvMode !== 'cast') return;
  try {
    // Called directly from the click, preserving the browser's user gesture.
    await castContext.requestSession();
    if (castSession() && !casting() && !castLoadPromise) {
      castLoadPromise = loadOnTV(candidate);
      await castLoadPromise;
    }
  } catch (error) {
    if (error !== 'cancel' && error?.code !== 'cancel') {
      say('CAST UNAVAILABLE — CHECK YOUR TV AND LOCAL NETWORK PERMISSION');
    }
  } finally { castLoadPromise = null; updateTVButton(); }
});
$('#link-form').addEventListener('submit', event => {event.preventDefault();openStream();});
$('#settings-button').addEventListener('click', openSettings);
document.querySelectorAll('[data-open-settings]').forEach(button=>button.addEventListener('click',()=>openSettingsPage(button.dataset.openSettings)));
favoritesForm.addEventListener('submit',event=>{event.preventDefault();const prefs=setEventFavorites(favoritesInput.value);favoritesInput.value=prefs.favorites.join('\n');preferencesMessage.textContent='FAVORITES SAVED';});
$('#custom-source-form').addEventListener('submit',event=>{
  event.preventDefault();settingsMessage.textContent='';
  try{
    const result=addCustomSources(customSourceInput.value);
    customSourceInput.value='';renderSettingsSources();
    const parts=[];
    if(result.added)parts.push(`${result.added} ${result.added===1?'SOURCE':'SOURCES'} ADDED`);
    if(result.existing)parts.push(`${result.existing} ALREADY SAVED`);
    if(result.invalid)parts.push(`${result.invalid} INVALID`);
    if(result.limit)parts.push(`${result.limit} OVER LIMIT`);
    settingsMessage.textContent=parts.join(' · ')||'SOURCES SAVED';
  }catch(error){settingsMessage.textContent=error.message||'ENTER VALID SOURCE URLS';customSourceInput.focus();}
});
$('#settings-back').addEventListener('click',()=>{
  if(currentSettingsSection!=='menu'){showSettingsPage('menu');navigate({view:'settings',section:'menu'},true);return;}
  if(history.state?.cleanStream&&history.state.depth>0)history.back();
  else {navigate({view:'home'},true);restoreRoute();}
});
refreshButton.addEventListener('click', refreshStream);
$('#back-button').addEventListener('click', () => {
  if(history.state?.cleanStream && history.state.depth>0)history.back();
  else {const q=new URL(location.href).searchParams.get('q');navigate(q?{view:'search',q}:{view:'home'},true);restoreRoute();}
});
playButton.addEventListener('click', async () => {
  if (casting()) { userPaused=!remotePlayer.isPaused;remoteController.playOrPause(); return; }
  if (!candidate || busy) return;
  if(isYouTube()){userPaused=!youtube.paused;youtube.paused?youtube.play():youtube.pause();syncControls();return;}
  if(isTwitch()){userPaused=!twitch.paused;twitch.paused?twitch.play():twitch.pause();syncControls();return;}
  if (!video.paused) {userPaused=true;video.pause();}
  else {
    try { userPaused=false;await video.play(); say(); }
    catch { say('PLAYBACK COULD NOT START — PRESS REFRESH'); }
  }
});
muteButton.addEventListener('click', () => {
  if (casting()) remoteController.muteOrUnmute();
  else if(isYouTube())youtube.mute();
  else if(isTwitch())twitch.mute();
  else video.muted = !video.muted;
  syncControls();
});
liveButton.addEventListener('click', async () => {
  if(isYouTube()){userPaused=false;youtube.jump();syncControls();return;}
  if(isTwitch()){userPaused=false;twitch.jump();syncControls();return;}
  if (casting()) {
    const target = remoteLivePosition();
    if (target === null) {say('LIVE POSITION IS STILL LOADING');return;}
    const media = castSession()?.getMediaSession();
    const request = new chrome.cast.media.SeekRequest();
    userPaused=false;request.currentTime = target;
    request.resumeState = chrome.cast.media.ResumeState.PLAYBACK_START;
    media?.seek(request, () => say(), () => say('COULD NOT JUMP TO LIVE — PRESS REFRESH'));
    return;
  }
  const target = await waitForLocalLiveTarget();
  if (target === null) {say('LIVE POSITION IS STILL LOADING');return;}
  userPaused=false;video.currentTime = target;
  try { await video.play(); say(); }
  catch { say('PRESS PLAY TO RESUME'); }
});
$('#fullscreen-button').addEventListener('click', async () => {
  if (casting()) { say('VIDEO IS PLAYING ON YOUR TV'); return; }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (!isEmbedded() && video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else await stage.requestFullscreen?.();
  } catch { say('FULLSCREEN IS UNAVAILABLE'); }
});
for (const name of ['play', 'pause', 'volumechange', 'durationchange', 'progress', 'seeked', 'webkitcurrentplaybacktargetiswirelesschanged']) {
  video.addEventListener(name, syncControls);
}
video.addEventListener('playing', () => { userPaused=false;buffering = false; lastProgress = Date.now(); syncControls(); });
video.addEventListener('waiting', () => { buffering = true; syncControls(); });
video.addEventListener('ended', () => { buffering = true; syncControls(); });
video.addEventListener('error', () => {
  buffering = true;
  if (!busy && candidate && !casting() && !isEmbedded()) recoverStream();
  syncControls();
});
video.addEventListener('timeupdate', () => {
  if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastProgress = Date.now(); }
  syncControls();
});
video.addEventListener('pause', () => {if(!busy && !recovering && !castLoading && !casting() && !video.ended && !video.error)userPaused=true;});
setInterval(() => {
  if (!playerView.classList.contains('is-active')) return;
  syncControls();
  if(!isEmbedded() && !userPaused && !busy && !recovering && !casting() && lastProgress && Date.now()-lastProgress>18000)recoverStream();
  if(!busy && !recovering && lastProgress && Date.now()-lastRecovery>60000 && !buffering){recoveryAttempts=0;recoveryCycles=0;}
  if(castOwned && castSession() && !busy && !castLoading && !recovering){
    if(remotePlayer?.isMediaLoaded && remotePlayer.isPaused)userPaused=true;
    if(remotePlayer?.playerState==='PLAYING'){userPaused=false;if(remotePosition!==remotePlayer.currentTime){remotePosition=remotePlayer.currentTime;remoteProgress=Date.now();}}
    if(!userPaused && remoteProgress && Date.now()-remoteProgress>18000)recoverStream();
  }
  // Native Safari doesn't expose HLS playlist state. Read the same small playlist
  // periodically to distinguish live from VOD/ended streams without re-extracting.
  if (candidate?.isHls && !hls && !isEmbedded() && !casting() && !busy && !nativeProbePending && Date.now() - nativeProbeAt > 15000) {
    nativeProbeAt = Date.now(); nativeProbePending = true;
    const thisGeneration = generation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    probeManifest(candidate, controller.signal).then(info => {
      if (info && thisGeneration === generation) { localLive = info.live; segmentDuration = info.duration; }
    }).catch(() => {}).finally(() => { clearTimeout(timer); nativeProbePending = false; });
  }
}, 1000);
updateTVButton();
syncControls();

if(window.__castReady || window.cast?.framework) window.__onGCastApiAvailable(true);

function leavePlayer() {
  operation?.abort();operation=null;userPaused=true;recovering=false;
  destroyLocal();candidate=null;currentEvent=null;alternatives=[];sourceUrl='';setBusy(false);say();
}
function navigate(state,replace=false) {
  const url=new URL('/',location.origin);
  if(state.q)url.searchParams.set('q',state.q);
  if(state.view==='settings')url.searchParams.set('settings',state.section||'menu');
  if(state.view==='explore')url.searchParams.set('explore','1');
  if(state.view==='event'&&state.event)url.searchParams.set('event',state.event);
  if(state.view==='player') {
    url.searchParams.set('watch',state.url);
    if(state.event)url.searchParams.set('event',state.event);
    if(state.live!==undefined && state.live!==null)url.searchParams.set('live',state.live?'1':'0');
  }
  const same=url.href===location.href;
  const depth=(history.state?.cleanStream?history.state.depth:0)+(replace||same?0:1);
  history[replace||same?'replaceState':'pushState']({cleanStream:true,depth},'',url);
}
let routeGeneration=0;
async function restoreRoute() {
  const token=++routeGeneration;
  const params=new URL(location.href).searchParams;
  search.stop();leavePlayer();
  const q=params.get('q'),url=params.get('watch');
  if(params.has('settings')){
    const section=params.get('settings');showView('settings');showSettingsPage(section==='1'?'menu':section||'menu');return;
  }
  if(url) {
    streamInput.value=url;
    await openStream(false,params.has('live')?params.get('live')==='1':null);
    if(token!==routeGeneration)return;
    if(q && params.get('event')) {
      try {
        const response=await fetch(`/api/events?q=${encodeURIComponent(q)}`);
        const data=await response.json();
        if(token===routeGeneration)currentEvent=data.events?.find(e=>e.id===params.get('event'))||null;
      }catch{}
    }
  } else if(params.get('explore')==='1') {
    showView('home');
    const data=await loadLiveWindow(false);if(token!==routeGeneration)return;
    search.explore(data.events||[]);
  } else if(params.get('event')) {
    showView('home');
    let event=null;
    try{const response=await fetch(`/api/event/${encodeURIComponent(params.get('event'))}`);if(response.ok)event=(await response.json()).event;}catch{}
    if(!event&&q){
      try{const response=await fetch(`/api/events?q=${encodeURIComponent(q)}`);if(response.ok)event=(await response.json()).events?.find(item=>item.id===params.get('event'))||null;}catch{}
    }
    if(token!==routeGeneration)return;
    if(event)search.showEvent(event);else if(q)await search.search(q,false);else search.reset();
  } else {
    showView('home');
    if(q)await search.search(q,false);
    else {search.reset();$('#event-query').value='';streamInput.value='';homeMessage.textContent='';}
  }
}
document.querySelectorAll('.home-link').forEach(link=>link.addEventListener('click',event=>{
  event.preventDefault();navigate({view:'home'});restoreRoute();
}));
addEventListener('popstate',restoreRoute);
if(!history.state?.cleanStream)history.replaceState({cleanStream:true,depth:0},'');
restoreRoute();
loadLiveWindow(false);
setInterval(()=>{if(homeView.classList.contains('is-active')&&!homeView.classList.contains('has-results'))loadLiveWindow(true);},60000);

function fitMasthead() {
  const title=$('.masthead');
  if(!homeView.classList.contains('is-active'))return;
  title.style.fontSize='';
  const available=$('.site-header').clientWidth;
  const range=document.createRange();range.selectNodeContents(title);
  const width=range.getBoundingClientRect().width;
  if(width>available)title.style.fontSize=`${parseFloat(getComputedStyle(title).fontSize)*available/width}px`;
}
new ResizeObserver(()=>requestAnimationFrame(fitMasthead)).observe($('.site-header'));
new MutationObserver(()=>requestAnimationFrame(fitMasthead)).observe(homeView,{attributes:true,attributeFilter:['class']});
document.fonts.ready.then(fitMasthead);
