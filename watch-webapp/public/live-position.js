export function livePosition({live,seekable,syncPosition,segmentDuration=6}) {
  if(!live)return null;
  if(seekable?.length) {
    const i=seekable.length-1,start=seekable.start(i),end=seekable.end(i);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;
    const target=Number.isFinite(syncPosition)?syncPosition:end-Math.max(2,segmentDuration*2);
    return Math.max(start,Math.min(end-0.1,target));
  }
  return Number.isFinite(syncPosition)&&syncPosition>=0?syncPosition:null;
}
