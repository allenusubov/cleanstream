const logos={NBA:'nba',WNBA:'wnba',NFL:'nfl',NHL:'nhl',MLB:'mlb',UFC:'ufc',F1:'f1'};
export function eventMetadata(event,candidate={},origin=''){
  let title=event?.showTitle?event.showTitle+' · '+event.title:event?.title||candidate.title||candidate.creator||'CLEAN STREAM';
  const league=String(event?.league||event?.sport||'').toUpperCase();
  let artwork=logos[league]?'/artwork/'+logos[league]+'.png':event?.artwork||event?.logo||event?.image||candidate.artwork;
  if(typeof artwork==='object')artwork=artwork.src||artwork.url;
  if(!artwork&&logos[league])artwork='/artwork/'+logos[league]+'.png';
  if(!artwork)artwork='/artwork/clean-stream.png';
  try{artwork=new URL(artwork,origin||'https://cleanstream.cloud.run').href;}catch{artwork='';}
  return {title:String(title),artist:league||candidate.creator||'',album:'',artwork:artwork?[{src:artwork,...(/\.png(?:$|\?)/i.test(artwork)?{type:'image/png'}:{})}]:[]};
}
let lastMetadataKey='';
export function updatePlaybackMetadata(event,candidate,{active=true,paused=true}={}){
  document.title=active?eventMetadata(event,candidate,location.origin).title:'CLEAN STREAM';
  const video=document.querySelector('#video');if(video)video.setAttribute('title',document.title);
  if(!navigator.mediaSession)return;
  try{
    const metadata=active?eventMetadata(event,candidate,location.origin):null;
    const key=JSON.stringify(metadata);
    if(key!==lastMetadataKey){navigator.mediaSession.metadata=metadata&&window.MediaMetadata?new MediaMetadata(metadata):null;lastMetadataKey=key;}
    navigator.mediaSession.playbackState=active?(paused?'paused':'playing'):'none';
  }catch{}
}
