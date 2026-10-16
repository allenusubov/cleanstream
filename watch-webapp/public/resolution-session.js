// Consume results while the server is still inspecting sibling player links.
// Playback failure advances this queue within the same explicit user action.
export async function playResolvedCandidates({open,play,onCandidate=()=>{},onProgress=()=>{},signal}){
  const network=new AbortController(),combined=AbortSignal.any([signal,network.signal]);
  const queue=[],seen=new Set();let ended=false,wake=()=>{},failure=null,reader;
  const accept=data=>{
    if(combined.aborted)return;
    if(data.type==='candidate'&&data.candidate?.mediaUrl&&!seen.has(data.candidate.mediaUrl)){
      seen.add(data.candidate.mediaUrl);queue.push(data.candidate);onCandidate(data.candidate);wake();
    }else if(data.type==='progress')onProgress(data);
    else if(data.type==='error'){failure=new Error(data.code||'EXTRACTION_FAILED');}
  };
  const cancelled=()=>wake();signal.addEventListener('abort',cancelled,{once:true});
  try{
    const response=await open(combined);
    if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(data?.code||'RESOLVER_UNAVAILABLE');}
    const read=async()=>{
      try{
        if(!response.headers.get('content-type')?.includes('ndjson')){
          const data=await response.json();for(const candidate of data.candidates||[])accept({type:'candidate',candidate});return;
        }
        reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
        while(!combined.aborted){
          const next=await reader.read();buffer+=decoder.decode(next.value||new Uint8Array(),{stream:!next.done});
          if(combined.aborted)break;
          let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim())accept(JSON.parse(line));}
          if(next.done){if(buffer.trim())accept(JSON.parse(buffer));break;}
        }
      }catch(error){if(!combined.aborted)failure=error;}
      finally{ended=true;wake();}
    };
    void read();let playbackError;
    while(true){
      if(signal.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');
      if(queue.length){
        const item=queue.shift();
        try{await play(item);return item;}catch(error){if(signal.aborted)throw error;playbackError=error;}
      }else if(ended){
        if(playbackError){const error=new Error('NO_DEVICE_PLAYBACK');error.cause=playbackError;throw error;}
        throw failure||new Error('NO_MEDIA');
      }
      else await new Promise(resolve=>{wake=resolve;});
    }
  }finally{
    network.abort();signal.removeEventListener('abort',cancelled);
    // Cancellation of a streamed body can wait on the transport (or a tee).
    // Release player controls immediately; cleanup must not hold playback busy.
    void reader?.cancel().catch(()=>{});
  }
}
