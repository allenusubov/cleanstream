import {directoryLinks} from './directory.js';
import {fetchLimited,safeURL} from './network.js';
import {withPage,visit} from './resolver.js';

export const CATEGORY_ALIASES={
  // Treat common navigation labels as the same family. TEST should learn a site's
  // structure, not require one exact word such as "TV".
  TV:['tv','television','tv shows','television shows','shows','tv series','television series','series','episodes','tv episodes','watch tv','watch shows','watch series'],
  MOVIES:['movies','movie','films','film','cinema','feature films','watch movies','watch films'],
  NBA:['nba','basketball'], WNBA:['wnba','women basketball','womens basketball'], NFL:['nfl','american football'],
  CFB:['cfb','college football','ncaa football'], NCAAB:['ncaab','ncaa basketball','college basketball'], WNCAAB:['wncaab','womens college basketball'],
  UFC:['ufc','ultimate fighting championship'], MMA:['mma','mixed martial arts'], BOXING:['boxing','boxing streams','boxing events'], NHL:['nhl','hockey'], MLB:['mlb','baseball'], SOCCER:['soccer','football'],
  F1:['f1','formula 1','formula one','motorsport'], NASCAR:['nascar'], INDYCAR:['indycar','indy car'], GOLF:['golf','pga','lpga'],
  TENNIS:['tennis'], RUGBY:['rugby'], CRICKET:['cricket']
};

const EVENT_WORDS=['events','live','schedule','upcoming','matches','games','fixtures','calendar'];
const HUB_WORDS=['sports','sport','watch','live','events','schedule','tv','television','shows','series','movies','films','cinema'];
const HUB_PHRASES=[...new Set([...HUB_WORDS,...Object.values(CATEGORY_ALIASES).flat()].map(value=>String(value).toLowerCase()))];
const PAGINATION_PARAMS=new Set(['page','p','pg','offset','start','from']);
const TRACKING_PARAMS=new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid']);
const normalize=value=>String(value||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const cleanCandidate=(value,base)=>{
  try {
    const url=new URL(value,base);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
    return url.href;
  } catch{return null;}
};
const linkText=link=>{
  try {
    const url=new URL(link.url);
    return normalize(`${link.text||''} ${decodeURIComponent(url.pathname)} ${decodeURIComponent(url.search)} ${decodeURIComponent(url.hash)}`);
  }catch{return normalize(link.text||'');}
};
function wordHit(text,term){
  const needle=normalize(term);if(!needle)return false;
  return (` ${text} `).includes(` ${needle} `);
}
function routePieces(link){
  try{
    const url=new URL(link.url),parts=url.pathname.split('/').filter(Boolean).map(value=>normalize(decodeURIComponent(value)));
    const hash=normalize(decodeURIComponent(url.hash||''));
    const query=[...url.searchParams.values()].map(value=>normalize(value)).filter(Boolean);
    return {url,parts,hash,query,visible:normalize(link.text||'')};
  }catch{return {url:null,parts:[],hash:'',query:[],visible:normalize(link.text||'')}}
}
function compactLabelHit(value,phrase){
  const text=normalize(value),needle=normalize(phrase);if(!text||!needle)return false;
  if(text===needle)return true;
  const words=text.split(' ');if(words.length>6)return false;
  return text===`watch ${needle}`||text===`${needle} streams`||text===`${needle} stream`||text===`live ${needle}`||text===`${needle} live`||text===`watch ${needle} online`;
}
function canonicalNavigationLink(link){
  try{
    const url=new URL(link.url);
    for(const key of [...url.searchParams.keys()]){
      const lower=key.toLowerCase();if(TRACKING_PARAMS.has(lower)||PAGINATION_PARAMS.has(lower))url.searchParams.delete(key);
    }
    return {...link,url:url.href};
  }catch{return link;}
}
export function likelyContentDetailPage(link){
  try{
    const {url,parts,visible}=routePieces(link);if(!url)return true;
    const path='/'+parts.join('/');
    // Search result pages and broad navigation pages are reusable; individual
    // title/episode/watch pages are not.
    if(parts.some(part=>['genre','genres','category','categories','tag','tags'].includes(part)))return true;
    if(/\b(?:season|episode)\s*\d+\b/.test(path)||/(?:^|\/)s\d{1,2}e\d{1,3}(?:\/|$)/i.test(path))return true;
    if(/\/(?:watch|play|embed)\/(?:movie|movies|show|shows|series|tv)\//i.test(url.pathname))return true;
    if(/\/(?:movie|movies|film|films|show|shows|series|tv)\/(?:view|watch|play)\//i.test(url.pathname))return true;
    const contentIndex=parts.findIndex(part=>['movie','movies','film','films','show','shows','series','tv'].includes(part));
    if(contentIndex>=0&&contentIndex<parts.length-1){
      const rest=parts.slice(contentIndex+1);const first=rest[0]||'';
      if(/^(?:view|watch|play)$/.test(first)&&rest.length>1)return true;
      if(/^\d{2,}(?:\b| )/.test(first)||/^\d{2,}[-_]/.test(decodeURIComponent(url.pathname.split('/').filter(Boolean)[contentIndex+1]||'')))return true;
      if(rest.length>=2&&rest.slice(-2).every(value=>/^\d+$/.test(value)))return true;
      if(first.split(' ').length>=3&&!['popular','latest','new','trending','top','all'].includes(first))return true;
    }
    // A deep slug with a long human title is usually an item page, even when the
    // title happens to contain a category word (e.g. "Blue Box").
    const last=parts.at(-1)||'';
    if(parts.length>=2&&last.split(' ').length>=4&&visible&&visible.split(' ').length>=2)return true;
    return false;
  }catch{return true;}
}
export function likelyEventPage(link){
  try{
    const url=new URL(link.url);
    const path=decodeURIComponent(url.pathname||'').toLowerCase();
    const visible=normalize(link.text||'');
    const slug=(path.split('/').filter(Boolean).at(-1)||'').replace(/[-_+]+/g,' ');
    if(/\/(?:news|blog|article|story|post)(?:\/|$)/i.test(path))return true;
    if(/(?:^|[-_/])vs(?:[-_/]|$)/i.test(path)||wordHit(visible,'vs'))return true;
    if(/\bversus\b/i.test(`${visible} ${slug}`))return true;
    if(/(?:^|[-_/])at(?:[-_/]|$)/i.test(path) && slug.split(/\s+/).filter(Boolean).length>=4)return true;
    if(/\/\d{3,}\/?$/i.test(path) && slug.split(/\s+/).filter(Boolean).length>=3)return true;
    return false;
  }catch{return true;}
}
function routeDepth(link){
  try{return new URL(link.url).pathname.split('/').filter(Boolean).length;}catch{return 99;}
}
function categoryScore(link,key,aliases){
  if(likelyEventPage(link)||likelyContentDetailPage(link))return -1000;
  const text=linkText(link),{parts,hash,query,visible}=routePieces(link);
  const phrases=[key,...aliases].map(normalize).filter(Boolean);let score=Math.max(0,8-routeDepth(link)*2),strong=false;
  for(const phrase of phrases){
    if(compactLabelHit(visible,phrase)){score+=phrase===normalize(key)?44:34;strong=true;}
    if(parts.some(part=>part===phrase)){score+=phrase===normalize(key)?34:26;strong=true;}
    if(hash===phrase){score+=28;strong=true;}
    if(query.some(value=>value===phrase)){score+=24;strong=true;}
  }
  // Only use loose word matches after a real navigation signal. This prevents a
  // title such as "Blue Box" from teaching BOXING and movie names containing
  // "football" from teaching a sports category.
  if(strong){
    const exact=normalize(key);if(wordHit(text,exact))score+=8;
    for(const alias of aliases)if(wordHit(text,alias))score+=3;
  }
  if(!strong)return -1000;
  // "football" is ambiguous. Prefer explicit NFL/CFB/SOCCER wording when it exists.
  if(['NFL','CFB','SOCCER'].includes(key) && !wordHit(text,key) && wordHit(text,'football'))score-=4;
  if(key==='SOCCER' && /\b(?:nfl|cfb|college football|ncaa football)\b/.test(text))score-=40;
  if(key==='NFL' && /\b(?:cfb|college football|ncaa football)\b/.test(text))score-=40;
  if(key==='CFB' && /\bnfl\b/.test(text))score-=40;
  return score;
}
function eventScore(link){
  if(likelyEventPage(link)||likelyContentDetailPage(link))return -1000;
  const text=linkText(link),visible=normalize(link.text||'');let score=0;
  for(const word of EVENT_WORDS){
    if(wordHit(visible,word))score+=12;
    else if(wordHit(text,word))score+=5;
  }
  if(/\/events?\/?(?:$|\?)/i.test(link.url))score+=10;
  if(/\/schedule\/?(?:$|\?)/i.test(link.url))score+=10;
  return score;
}
function structureFromLinks(links){
  const eventLinks=(links||[]).filter(likelyEventPage);
  const eventPrefixes=[],eventHosts=[];
  for(const link of eventLinks){
    try{
      const u=new URL(link.url);eventHosts.push(u.hostname.replace(/^www\./i,''));
      const parts=u.pathname.split('/').filter(Boolean);
      if(parts.length>1)eventPrefixes.push('/'+parts.slice(0,-1).join('/')+'/');
      else if(parts.length===1)eventPrefixes.push('/');
    }catch{}
  }
  const styles=new Set();
  for(const link of links||[]){try{const u=new URL(link.url);if(u.hash)styles.add('HASH');if(u.search)styles.add('QUERY');if(u.pathname&&u.pathname!=='/')styles.add('PATH');}catch{}}
  const routeStyle=styles.size===1?[...styles][0]:styles.size>1?'MIXED':'UNKNOWN';
  return {routeStyle,eventPrefixes:[...new Set(eventPrefixes)].slice(0,12),eventHosts:[...new Set(eventHosts)].slice(0,8)};
}

function searchTemplatesFromHtml(html,base){
  const out=[];const clean=String(html||'').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'');
  for(const match of clean.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)){
    const attrs=match[1]||'',body=match[2]||'';
    const method=(attrs.match(/\bmethod\s*=\s*(["'])(.*?)\1/i)?.[2]||'GET').toUpperCase();if(method!=='GET')continue;
    const action=attrs.match(/\baction\s*=\s*(["'])(.*?)\1/i)?.[2]||base;
    const inputs=[...body.matchAll(/<input\b([^>]*)>/gi)];let name='';
    for(const input of inputs){
      const a=input[1]||'',type=(a.match(/\btype\s*=\s*(["'])(.*?)\1/i)?.[2]||'text').toLowerCase();
      const n=a.match(/\bname\s*=\s*(["'])(.*?)\1/i)?.[2]||'';
      if(!n)continue;if(type==='search'||/^(q|s|query|search|keyword|term)$/i.test(n)){name=n;break;}
    }
    if(!name)continue;
    try{const url=new URL(action,base);url.searchParams.set(name,'__CLEANSTREAM_QUERY__');out.push(url.href.replace('__CLEANSTREAM_QUERY__','{query}'));}catch{}
  }
  return [...new Set(out)].slice(0,8);
}
function dedupeLinks(links,base){
  const map=new Map();
  for(const link of links||[]){
    const url=cleanCandidate(link.url,base);if(!url)continue;
    const text=String(link.text||'').replace(/\s+/g,' ').trim();
    const candidate=canonicalNavigationLink({url,text});const old=map.get(candidate.url);
    if(!old || text.length>(old.text||'').length)map.set(candidate.url,candidate);
  }
  return [...map.values()];
}
export function profileFromLinks(links,base,searchTemplates=[],browserSearch=false){
  const clean=dedupeLinks(links,base),categories={};
  for(const [key,aliases] of Object.entries(CATEGORY_ALIASES)){
    const ranked=clean.map(link=>({link,score:categoryScore(link,key,aliases)})).filter(x=>x.score>=10).sort((a,b)=>b.score-a.score||routeDepth(a.link)-routeDepth(b.link));
    if(ranked.length)categories[key]=[...new Set(ranked.map(x=>x.link.url))].slice(0,6);
  }
  const eventLists=[...new Set(clean.map(link=>({link,score:eventScore(link)})).filter(x=>x.score>=10).sort((a,b)=>b.score-a.score).map(x=>x.link.url))];
  const hubs=clean.filter(link=>{
    if(likelyContentDetailPage(link)||likelyEventPage(link))return false;
    const {parts,hash,visible}=routePieces(link);
    return HUB_PHRASES.some(word=>compactLabelHit(visible,word)||parts.some(part=>part===normalize(word))||hash===normalize(word));
  }).slice(0,6).map(link=>link.url);
  const support={};for(const key of Object.keys(CATEGORY_ALIASES))support[key]=(categories[key]||[]).length?'YES':'UNKNOWN';
  const structure=structureFromLinks(clean);structure.searchTemplates=[...new Set(searchTemplates)].slice(0,8);structure.browserSearch=Boolean(browserSearch);
  return {categories,eventLists,hubs,links:clean,support,structure};
}
async function pageLinks(url,{dynamic=true}={}){
  let finalUrl=url,staticLinks=[],staticSearch=[],staticBrowserSearch=false,staticError=null,staticWorked=false;
  try{
    // Large homepages are common. Keep the first 2 MB instead of treating an
    // oversized HTML document as an unavailable source.
    const response=await fetchLimited(url,{limit:2*1024*1024,partial:true});
    staticWorked=true;finalUrl=response.url;
    const html=response.body.toString();staticLinks=directoryLinks(html,response.url,[],1500);staticSearch=searchTemplatesFromHtml(html,response.url);staticBrowserSearch=/<input\b[^>]*(?:type\s*=\s*[\"']search[\"']|name\s*=\s*[\"'](?:q|s|query|search|keyword|term)[\"']|placeholder\s*=\s*[\"'][^\"']*search)/i.test(html);
  }catch(error){staticError=error;}
  const first=profileFromLinks(staticLinks,finalUrl,staticSearch,staticBrowserSearch);
  const useful=Object.keys(first.categories).length+first.eventLists.length;
  if(!dynamic || useful>=6)return {url:finalUrl,links:staticLinks,searchTemplates:staticSearch,browserSearch:staticBrowserSearch,reachable:staticWorked,method:staticWorked?'STATIC':'NONE'};
  try{
    const dynamicData=await withPage(async page=>{
      await visit(page,url);
      finalUrl=page.url()||finalUrl;
      const links=await page.locator('a[href],[data-href],[data-url],[onclick]').evaluateAll(nodes=>nodes.slice(0,2200).flatMap(node=>{
        let value=node.href||node.getAttribute('data-href')||node.getAttribute('data-url')||'';
        if(!value){
          const code=node.getAttribute('onclick')||'';
          value=code.match(/(?:location(?:\.href)?\s*=|open\s*\()\s*['"]([^'"]+)['"]/i)?.[1]||'';
        }
        if(!value)return [];
        try{
          const u=new URL(value,document.baseURI);
          if(!/^https?:$/.test(u.protocol))return [];
          return [{url:u.href,text:(node.getAttribute('aria-label')||node.textContent||node.getAttribute('title')||'').replace(/\s+/g,' ').trim()}];
        }catch{return [];}
      }));
      const searches=await page.locator('form').evaluateAll(forms=>forms.slice(0,40).flatMap(form=>{
        if(String(form.method||'get').toUpperCase()!=='GET')return [];
        const input=[...form.querySelectorAll('input')].find(node=>node.type==='search'||/^(q|s|query|search|keyword|term)$/i.test(node.name||''));
        if(!input?.name)return [];
        try{const u=new URL(form.action||document.baseURI,document.baseURI);u.searchParams.set(input.name,'__CLEANSTREAM_QUERY__');return [u.href.replace('__CLEANSTREAM_QUERY__','{query}')];}catch{return [];}
      }));
      const browserSearch=Boolean(document.querySelector('input[type=\"search\"],input[name=\"q\"],input[name=\"s\"],input[name=\"query\"],input[name=\"search\"],input[name=\"keyword\"],input[name=\"term\"],input[placeholder*=\"search\" i]'));
      return {links,searches,browserSearch};
    });
    return {url:finalUrl,links:dedupeLinks([...staticLinks,...dynamicData.links],finalUrl),searchTemplates:[...new Set([...staticSearch,...dynamicData.searches])].slice(0,8),browserSearch:Boolean(staticBrowserSearch||dynamicData.browserSearch),reachable:true,method:staticWorked?'STATIC+DYNAMIC':'DYNAMIC'};
  }catch(error){
    if(staticWorked)return {url:finalUrl,links:staticLinks,searchTemplates:staticSearch,browserSearch:staticBrowserSearch,reachable:true,method:'STATIC'};
    return {url:finalUrl,links:[],searchTemplates:[],browserSearch:false,reachable:false,method:'NONE',error:staticError||error};
  }
}
function mergeProfiles(profiles){
  const categories={};const eventLists=[],eventPrefixes=[],eventHosts=[],searchTemplates=[];const styles=new Set();let browserSearch=false;
  for(const profile of profiles){
    for(const [key,urls] of Object.entries(profile.categories||{})){
      categories[key]??=[];
      for(const url of urls||[])if(!categories[key].includes(url))categories[key].push(url);
    }
    for(const url of profile.eventLists||[])if(!eventLists.includes(url))eventLists.push(url);
    for(const value of profile.structure?.eventPrefixes||[])if(!eventPrefixes.includes(value))eventPrefixes.push(value);
    for(const value of profile.structure?.eventHosts||[])if(!eventHosts.includes(value))eventHosts.push(value);
    for(const value of profile.structure?.searchTemplates||[])if(!searchTemplates.includes(value))searchTemplates.push(value);
    if(profile.structure?.browserSearch)browserSearch=true;
    if(profile.structure?.routeStyle&&profile.structure.routeStyle!=='UNKNOWN')styles.add(profile.structure.routeStyle);
  }
  const support={};for(const key of Object.keys(CATEGORY_ALIASES))support[key]=(categories[key]||[]).length?'YES':'UNKNOWN';
  const routeStyle=styles.size===1?[...styles][0]:styles.size>1?'MIXED':'UNKNOWN';
  return {categories,eventLists,support,structure:{routeStyle,eventPrefixes:eventPrefixes.slice(0,12),eventHosts:eventHosts.slice(0,8),searchTemplates:searchTemplates.slice(0,8),browserSearch}};
}
export async function scanSourceProfile(input,hints={}){
  const root=await safeURL(input);
  const seeds=[root.href];
  const addSeed=async value=>{
    if(seeds.length>=8||!value)return;
    try{const url=(await safeURL(String(value))).href;if(!seeds.includes(url))seeds.push(url);}catch{}
  };
  // Re-test routes we already know. A homepage may be blocked or empty while a
  // category/events route still works and can teach us more about the site.
  for(const value of (Array.isArray(hints?.eventLists)?hints.eventLists:[]))await addSeed(value);
  for(const urls of Object.values(hints?.categories&&typeof hints.categories==='object'?hints.categories:{})){
    for(const value of (Array.isArray(urls)?urls:[urls])){await addSeed(value);if(seeds.length>=8)break;}
    if(seeds.length>=8)break;
  }

  const profiles=[];const hubs=[];let reachablePages=0,pagesChecked=0,finalUrl=root.href;
  for(const seed of seeds){
    const page=await pageLinks(seed,{dynamic:true});pagesChecked++;
    if(!page.reachable)continue;
    reachablePages++;if(seed===root.href)finalUrl=page.url||finalUrl;
    const profile=profileFromLinks(page.links,page.url||seed,page.searchTemplates||[],page.browserSearch);profiles.push(profile);
    for(const hub of profile.hubs||[])if(!hubs.includes(hub))hubs.push(hub);
  }

  // Crawl a few discovered navigation hubs with cheap static requests. This is
  // bounded so TEST ALL can learn structure without turning into a site crawl.
  for(const hub of hubs.slice(0,4)){
    if(pagesChecked>=12)break;
    try{
      const page=await pageLinks(hub,{dynamic:false});pagesChecked++;
      if(!page.reachable)continue;reachablePages++;profiles.push(profileFromLinks(page.links,page.url||hub,page.searchTemplates||[],page.browserSearch));
    }catch{}
  }

  const merged=mergeProfiles(profiles);
  const learned=Object.values(merged.categories||{}).reduce((n,urls)=>n+(urls?.length||0),0)+(merged.eventLists?.length||0)+(merged.structure?.searchTemplates?.length||0)+(merged.structure?.browserSearch?1:0);
  const status=reachablePages===0?'UNREACHABLE':learned?'LEARNED':'PARTIAL';
  const reason=status==='UNREACHABLE'?'NO REACHABLE PAGES':status==='LEARNED'?`${learned} REUSABLE ROUTE${learned===1?'':'S'} FOUND`:'REACHABLE · NO REUSABLE ROUTES FOUND';
  return {url:finalUrl,categories:merged.categories,eventLists:merged.eventLists,support:merged.support,structure:merged.structure,
    status,reason,reachable:reachablePages>0,pagesChecked,reachablePages,testedAt:Date.now()};
}
