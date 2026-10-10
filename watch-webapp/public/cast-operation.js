export async function boundedCastLoad(session,request,{signal,timeout=15000,onLateResolution}={}){
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  let timer,cancel,wasInterrupted=false;
  try{
    const interrupted=new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('CAST_TIMED_OUT')),timeout);
      cancel=()=>reject(new DOMException('Cancelled','AbortError'));
      signal?.addEventListener('abort',cancel,{once:true});
    });
    const loading=session.loadMedia(request);
    loading.then(()=>{if(wasInterrupted)onLateResolution?.();},()=>{});
    await Promise.race([loading,interrupted]);
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  }catch(error){wasInterrupted=true;throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
