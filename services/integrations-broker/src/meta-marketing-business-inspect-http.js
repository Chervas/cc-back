'use strict';
const {BrokerError,fail}=require('./errors'),{tokenText}=require('./whatsapp-secrets');
// A fixed Meta-only debug path. The legacy/WhatsApp inspector is untouched.
function inspect({input,request,timeoutMs,graphVersion}){
 if(input.action!=='inspect'||!Buffer.isBuffer(input.token)||!Buffer.isBuffer(input.candidate)
  ||!tokenText(input.token.toString('utf8'))||!tokenText(input.candidate.toString('utf8'))||!/^v(?:24|25|26|27)\.0$/.test(graphVersion))fail('invalid_request');
 const signal=input.signal;if(signal?.aborted)fail('provider_timeout');
 return new Promise((resolve,reject)=>{let req,res,timer,done=false,size=0;const chunks=[];
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);chunks.length=0;error?reject(error):resolve(value);};
  const abort=()=>{finish(new BrokerError('provider_timeout'));res?.destroy();req?.destroy();};
  timer=setTimeout(abort,timeoutMs);timer.unref?.();
  try{
   req=request({protocol:'https:',hostname:'graph.facebook.com',port:443,method:'GET',path:`/${graphVersion}/debug_token?`+new URLSearchParams({input_token:input.candidate.toString('utf8')}),agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:{authorization:'Bearer '+input.token.toString('utf8'),accept:'application/json','accept-encoding':'identity'}},response=>{
    res=response;if(done){res.destroy();return;}
    if(String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'||!['','identity'].includes(String(res.headers['content-encoding']||'').toLowerCase())||res.statusCode>=300&&res.statusCode<400){finish(new BrokerError('provider_failed'));res.destroy();req?.destroy();return;}
    res.on('data',chunk=>{size+=chunk.length;if(done){chunk.fill(0);return;}if(size>524288){finish(new BrokerError('provider_failed'));chunk.fill(0);res.destroy();req?.destroy();}else chunks.push(chunk);});
    res.on('aborted',()=>finish(new BrokerError('provider_failed')));res.on('error',()=>finish(new BrokerError('provider_failed')));
    res.on('end',()=>{let body;try{if(done)return;body=Buffer.concat(chunks);const value=JSON.parse(body.toString('utf8'));
     if(res.statusCode===429||[4,17,32,613].includes(value?.error?.code))fail('rate_limited');
     if([190,102].includes(value?.error?.code))fail('credential_revoked');
     if(res.statusCode!==200||!value||Object.getPrototypeOf(value)!==Object.prototype||value.error)fail('provider_failed');
     finish(null,value);
    }catch(error){finish(require('./meta-marketing-graph-pacing').safeError(error));}finally{body?.fill(0);}});
   });
   req.on('error',()=>finish(new BrokerError('provider_failed')));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted||done)abort();else req.end();
  }catch{finish(new BrokerError('provider_failed'));req?.destroy();}
 });
}
module.exports={inspect};
