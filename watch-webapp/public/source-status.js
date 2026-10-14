export function routeCount(item){return Object.values(item.categories||{}).reduce((n,urls)=>n+(urls?.length||0),0)+(item.eventLists?.length||0);}
export function inspectionLabel(item){
  const status=item.test?.status||'';
  if(['FAILED','INCOMPLETE','UNREACHABLE'].includes(status))return routeCount(item)?'ROUTES SAVED · LAST CHECK INCOMPLETE':'CHECK INCOMPLETE';
  if(status==='LEARNED')return 'ROUTES SAVED';
  if(status==='PARTIAL')return routeCount(item)?'ROUTES SAVED · CHECK PARTIAL':'CHECK PARTIAL';
  return routeCount(item)?'ROUTES SAVED':'NOT CHECKED';
}
export function inspectionFailure(error){
  const code=error?.code||error?.message;
  const reason={BROWSER_UNAVAILABLE:'SOURCE CHECKER COULD NOT START',SOURCE_ACCESS_BLOCKED:'WEBSITE BLOCKED THE SOURCE CHECKER',SOURCE_TIMEOUT:'CHECK TIMED OUT',TIMEOUT:'CHECK TIMED OUT'}[code]||'CHECK COULD NOT COMPLETE';
  return {status:'INCOMPLETE',reason,testedAt:Date.now()};
}
