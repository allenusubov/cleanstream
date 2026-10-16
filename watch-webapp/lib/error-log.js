// Keep the useful exception and trace while omitting source tokens/query strings.
function safeText(value){
  return String(value||'').replace(/https?:\/\/[^\s"'<>]+/gi,value=>{
    try{const url=new URL(value);return url.origin+url.pathname;}catch{return '[URL]';}
  }).replace(/\b(authorization|cookie|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[REDACTED]').slice(0,8000);
}
export function requestErrorLog(error,req={}){
  const cause=error?.cause;
  const record={severity:'ERROR',message:'Request failed',method:req.method||'',path:String(req.path||'').slice(0,200),
    code:error?.code||'SOURCE_UNAVAILABLE',name:error?.name||'Error',errorMessage:safeText(error?.message),stack:safeText(error?.stack)};
  if(cause)record.cause={name:cause.name||'Error',message:safeText(cause.message||cause),stack:safeText(cause.stack)};
  if(error?.routeFailures)record.routeFailures=error.routeFailures.slice(0,5).map(value=>({code:value.code,message:safeText(value.cause?.message),stack:safeText(value.cause?.stack)}));
  const project=process.env.GOOGLE_CLOUD_PROJECT||process.env.GCLOUD_PROJECT;
  const trace=String(req.get?.('x-cloud-trace-context')||'').split('/')[0];
  if(project&&/^[a-f0-9]{32}$/i.test(trace))record['logging.googleapis.com/trace']=`projects/${project}/traces/${trace}`;
  return record;
}
