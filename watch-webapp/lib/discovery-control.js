import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage();
export const currentSignal=()=>scope.getStore();
export const withSignal=(signal,task)=>scope.run(signal,task);
export function aborted(signal=currentSignal()){if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');}
export function abortable(promise,signal=currentSignal()){
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const cancel=()=>{cleanup();reject(signal.reason||new DOMException('Cancelled','AbortError'));};
    const cleanup=()=>signal.removeEventListener('abort',cancel);
    if(signal.aborted)return cancel();
    signal.addEventListener('abort',cancel,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
export async function eachConcurrent(items,limit,task,{signal=currentSignal(),start=0,onComplete=()=>{}}={}){
  let next=start;
  const complete=new Set();
  let cursor=start;
  const worker=async()=>{
    while(next<items.length&&!signal?.aborted){
      const index=next++;
      try{await task(items[index],index);}catch(error){if(signal?.aborted)break;}
      if(signal?.aborted)break;
      complete.add(index);while(complete.has(cursor))cursor++;
      onComplete(cursor);
    }
  };
  await Promise.all(Array.from({length:Math.min(limit,items.length-start)},worker));
  return cursor;
}
