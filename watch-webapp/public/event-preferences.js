export const EVENT_PREFERENCES_KEY='cleanstream.eventPreferences.v1';
export const EVENT_CATEGORIES=['NBA','WNBA','NFL','CFB','NCAAB','WNCAAB','NHL','MLB','UFC','MMA','BOXING','SOCCER','TENNIS','F1','NASCAR','INDYCAR','GOLF'];

const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

export function eventCategory(event={}){
  const sport=String(event.sport||'').toLowerCase();
  const league=String(event.league||event.scheduleKey||'').toUpperCase();
  if(sport==='soccer'||['SOCCER','MLS','EPL','UCL'].includes(league))return 'SOCCER';
  if(sport==='tennis'||['ATP','WTA','TENNIS'].includes(league))return 'TENNIS';
  if(['NBA','WNBA','NFL','CFB','NCAAB','WNCAAB','NHL','MLB','UFC','MMA','BOXING','F1','NASCAR','INDYCAR','GOLF'].includes(league))return league;
  if(sport==='mma')return league==='UFC'?'UFC':'MMA';
  if(sport==='boxing')return 'BOXING';
  if(sport==='golf')return 'GOLF';
  if(sport==='racing'){if(league.includes('NASCAR'))return 'NASCAR';if(league.includes('INDY'))return 'INDYCAR';return 'F1';}
  return league&&EVENT_CATEGORIES.includes(league)?league:null;
}

function cleanFavorites(values=[]){
  const seen=new Set(),out=[];
  for(const value of values){const text=String(value||'').trim();const key=normalize(text);if(!key||seen.has(key))continue;seen.add(key);out.push(text);if(out.length>=50)break;}
  return out;
}

export function defaultEventPreferences(){
  return {categories:EVENT_CATEGORIES.map(key=>({key,enabled:true})),favorites:[]};
}

export function loadEventPreferences(storage=globalThis.localStorage){
  let raw={};try{raw=JSON.parse(storage?.getItem(EVENT_PREFERENCES_KEY)||'{}')||{};}catch{}
  const saved=Array.isArray(raw.categories)?raw.categories:[];
  const byKey=new Map(saved.map(item=>[String(item?.key||'').toUpperCase(),item]));
  const ordered=[];
  for(const item of saved){const key=String(item?.key||'').toUpperCase();if(EVENT_CATEGORIES.includes(key)&&!ordered.includes(key))ordered.push(key);}
  for(const key of EVENT_CATEGORIES)if(!ordered.includes(key))ordered.push(key);
  return {
    categories:ordered.map(key=>({key,enabled:byKey.get(key)?.enabled!==false})),
    favorites:cleanFavorites(Array.isArray(raw.favorites)?raw.favorites:[])
  };
}

export function saveEventPreferences(prefs,storage=globalThis.localStorage){
  const current=loadEventPreferences({getItem:()=>JSON.stringify(prefs||{})});
  storage?.setItem(EVENT_PREFERENCES_KEY,JSON.stringify(current));
  if(typeof globalThis.dispatchEvent==='function'&&typeof CustomEvent!=='undefined')globalThis.dispatchEvent(new CustomEvent('cleanstream:event-preferences-changed',{detail:current}));
  return current;
}

export function setEventCategoryEnabled(key,enabled,storage=globalThis.localStorage){
  const prefs=loadEventPreferences(storage);const target=prefs.categories.find(item=>item.key===String(key).toUpperCase());if(target)target.enabled=Boolean(enabled);return saveEventPreferences(prefs,storage);
}

export function setEventCategoryOrder(keys,storage=globalThis.localStorage){
  const prefs=loadEventPreferences(storage),enabled=new Map(prefs.categories.map(item=>[item.key,item.enabled]));
  const ordered=[];for(const raw of keys){const key=String(raw).toUpperCase();if(EVENT_CATEGORIES.includes(key)&&!ordered.includes(key))ordered.push(key);}
  for(const item of prefs.categories)if(!ordered.includes(item.key))ordered.push(item.key);
  prefs.categories=ordered.map(key=>({key,enabled:enabled.get(key)!==false}));return saveEventPreferences(prefs,storage);
}

export function setEventFavorites(values,storage=globalThis.localStorage){
  const prefs=loadEventPreferences(storage);prefs.favorites=cleanFavorites(Array.isArray(values)?values:String(values||'').split(/\r?\n/));return saveEventPreferences(prefs,storage);
}

export function isFavoriteEvent(event,prefs=loadEventPreferences()){
  const hay=normalize([event.title,...(event.participants||[]).flatMap(item=>[item.name,item.abbreviation])].join(' '));
  return prefs.favorites.some(value=>{const needle=normalize(value);return needle&&hay.includes(needle);});
}


export function compactEventTitle(event={}){
  const participants=Array.isArray(event.participants)?event.participants.filter(Boolean):[];
  if(participants.length===2){
    const names=participants.map(item=>String(item.shortName||item.name||item.abbreviation||'').trim()).filter(Boolean);
    if(names.length===2)return names.join(' VS ');
  }
  return String(event.title||'').trim();
}

export function tickerEvents(events,prefs=loadEventPreferences()){
  const enabled=new Set(prefs.categories.filter(item=>item.enabled).map(item=>item.key));
  const rank=new Map(prefs.categories.map((item,index)=>[item.key,index]));
  return [...(Array.isArray(events)?events:[])].filter(event=>{const category=eventCategory(event);return !category||enabled.has(category);}).sort((a,b)=>{
    const alive=a.status==='live',blive=b.status==='live';if(alive!==blive)return alive?-1:1;
    const af=isFavoriteEvent(a,prefs),bf=isFavoriteEvent(b,prefs);
    const ar=rank.get(eventCategory(a))??999,br=rank.get(eventCategory(b))??999;
    const at=Date.parse(a.startTime)||0,bt=Date.parse(b.startTime)||0;
    if(alive&&blive){if(af!==bf)return af?-1:1;if(ar!==br)return ar-br;return at-bt;}
    // Upcoming events stay chronological. Favorites/category priority only break equal showtimes.
    const amin=Math.floor(at/60000),bmin=Math.floor(bt/60000);if(amin!==bmin)return amin-bmin;
    if(af!==bf)return af?-1:1;if(ar!==br)return ar-br;
    return String(a.title||'').localeCompare(String(b.title||''));
  });
}
