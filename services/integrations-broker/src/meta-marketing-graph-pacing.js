'use strict';
const {fail,BrokerError}=require('./errors'),M=require('./meta-marketing-contract'),{usage}=require('./meta-marketing-ads-http');
function scoped({pacer,request,now=Date.now},appId){
  if(pacer===undefined)return {request,run:async(signal,work)=>work()};
  if(!M.graphId(appId)||typeof pacer.run!=='function'||typeof pacer.observe!=='function'||typeof request!=='function')fail('invalid_request');
  const key='meta-ads-app:'+appId;
  return {
    request:(options,callback)=>request(options,response=>{pacer.observe(key,usage(response.headers));callback(response);}),
    run:(signal,work,authorize=()=>{})=>pacer.run(key,{signal,deadline:now()+25000},async()=>{if(signal?.aborted)fail('provider_timeout');authorize();const value=await work();if(signal?.aborted)fail('provider_timeout');authorize();return value;}),
  };
}
function safeError(error,fallback='provider_failed'){
  const out=new BrokerError(error instanceof BrokerError?error.code:fallback);
  if(out.code==='rate_limited'&&Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>0&&error.retryAfterMs<=86400000)out.retryAfterMs=error.retryAfterMs;
  return out;
}
module.exports={scoped,safeError};
