// Shared with the server: conservative team matching prevents invented matchups.
export const teams = [
  ['1','Atlanta Hawks','ATL','hawks'],['2','Boston Celtics','BOS','celtics'],
  ['17','Brooklyn Nets','BKN','nets'],['30','Charlotte Hornets','CHA','hornets'],
  ['4','Chicago Bulls','CHI','bulls'],['5','Cleveland Cavaliers','CLE','cavaliers cavs'],
  ['6','Dallas Mavericks','DAL','mavericks mavs'],['7','Denver Nuggets','DEN','nuggets'],
  ['8','Detroit Pistons','DET','pistons'],['9','Golden State Warriors','GSW','warriors golden state'],
  ['10','Houston Rockets','HOU','rockets'],['11','Indiana Pacers','IND','pacers'],
  ['12','Los Angeles Clippers','LAC','clippers la clippers'],['13','Los Angeles Lakers','LAL','lakers la lakers'],
  ['29','Memphis Grizzlies','MEM','grizzlies'],['14','Miami Heat','MIA','heat'],
  ['15','Milwaukee Bucks','MIL','bucks'],['16','Minnesota Timberwolves','MIN','timberwolves wolves'],
  ['3','New Orleans Pelicans','NOP','pelicans'],['18','New York Knicks','NYK','knicks new york'],
  ['25','Oklahoma City Thunder','OKC','thunder okc'],['19','Orlando Magic','ORL','magic'],
  ['20','Philadelphia 76ers','PHI','76ers sixers'],['21','Phoenix Suns','PHX','suns'],
  ['22','Portland Trail Blazers','POR','blazers trail blazers'],['23','Sacramento Kings','SAC','kings'],
  ['24','San Antonio Spurs','SAS','spurs san antonio'],['28','Toronto Raptors','TOR','raptors'],
  ['26','Utah Jazz','UTA','jazz'],['27','Washington Wizards','WAS','wizards']
].map(([id,name,abbreviation,extra]) => ({id,name,abbreviation,aliases:[name,abbreviation,...extra.split(' ').filter(x=>!['new','york','golden','state','la','trail','san','antonio'].includes(x)),...({'18':['new york'],'9':['golden state'],'24':['san antonio'],'3':['new orleans']}[id]||[])]}));
export const normalize = value => String(value).toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
function distance(a,b) {
  let row = Array.from({length:b.length+1},(_,i)=>i);
  for (let i=1;i<=a.length;i++) { const next=[i]; for(let j=1;j<=b.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]!==b[j-1])); row=next; }
  return row[b.length];
}
export function parseQuery(raw) {
  const query = normalize(raw).replace(/\b(vs|versus|v|at|nba|basketball|live|today|game|games|watch|streams|stream)\b/g,' ').replace(/\s+/g,' ').trim();
  if (!query) return {kind:'league',teams:[]};
  if (/\b(nfl|ufc|nhl|mlb|soccer|boxing|football|f1)\b/.test(query)) return {kind:'unsupported',teams:[]};
  const words=query.split(' ');
  const matched=teams.filter(team=>team.aliases.some(alias=>{
    const a=normalize(alias);
    if (a.includes(' ')) return ` ${query} `.includes(` ${a} `);
    return words.some(w=>w===a || (a.length>=5 && w.length>=5 && distance(a,w)<=1));
  }));
  return {kind:matched.length===2?'matchup':matched.length===1?'team':matched.length?'ambiguous':'unknown',teams:matched};
}
export function matchesParticipants(text, participants) {
  const query=normalize(text);
  return participants.length >= 2 && participants.every(p => {
    const team=p.id?teams.find(t=>t.id===p.id):null;
    const aliases=team?.aliases || [p.name];
    return aliases.some(a=>a.length>=3 && ` ${query} `.includes(` ${normalize(a)} `));
  });
}
export function selectEvents(events, query, now=Date.now()) {
  return events.filter(e=>e.status!=='finished' && Date.parse(e.startTime)>now-6*3600000 &&
    query.teams.every(t=>e.participants.some(p=>p.id===t.id)))
    .sort((a,b)=>(a.status==='live'?-1:0)-(b.status==='live'?-1:0)||Date.parse(a.startTime)-Date.parse(b.startTime));
}
