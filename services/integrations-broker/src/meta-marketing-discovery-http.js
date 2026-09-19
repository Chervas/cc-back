'use strict';
const https=require('node:https'),{createHmac}=require('node:crypto'),{BrokerError,fail}=require('./errors');
const C=require('./meta-marketing-oauth-contract'),D=require('./meta-marketing-discovery-contract'),M=require('./meta-marketing-contract'),{tokenText}=require('./whatsapp-secrets');
function createMetaMarketingDiscoveryHttp({request=https.request,timeoutMs=8000,now=()=>Date.now()}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)fail('invalid_request');
  const inspect=require('./meta-marketing-http').createMetaMarketingHttp({request,timeoutMs});
  async function page({subjectId,edge,fields,after,token,proof,signal,budget}){
    if(signal.aborted)fail('provider_timeout');
    if(++budget.pages>D.MAX_PAGES)fail('provider_failed');
    const params=new URLSearchParams({fields,limit:'100',appsecret_proof:proof});if(after)params.set('after',after);
    return new Promise((resolve,reject)=>{
      let req,res,timer,settled=false,bytes=0;const chunks=[];
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);for(const c of chunks)c.fill(0);chunks.length=0;error?reject(error):resolve(value);};
      const abort=()=>{finish(new BrokerError('provider_timeout'));res?.destroy();req?.destroy();};
      timer=setTimeout(abort,timeoutMs);timer.unref?.();
      try{
        req=request({protocol:'https:',hostname:'graph.facebook.com',port:443,method:'GET',path:`/${M.GRAPH_VERSION}/${subjectId}/${edge}?${params}`,
          agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:{authorization:'Bearer '+token.toString('utf8'),accept:'application/json','accept-encoding':'identity'}},response=>{
          res=response;if(settled){res.destroy();return;}
          if(String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'||!['','identity'].includes(String(res.headers['content-encoding']||'').toLowerCase())
            ||res.statusCode>=300&&res.statusCode<400){finish(new BrokerError('provider_failed'));res.destroy();req?.destroy();return;}
          res.on('data',chunk=>{bytes+=chunk.length;budget.bytes+=chunk.length;
            if(settled){chunk.fill(0);return;}
            if(bytes>131072||budget.bytes>D.MAX_BYTES){finish(new BrokerError('provider_failed'));chunk.fill(0);res.destroy();req?.destroy();}else chunks.push(chunk);
          });
          res.on('aborted',()=>finish(new BrokerError('provider_failed')));res.on('error',()=>finish(new BrokerError('provider_failed')));
          res.on('end',()=>{if(settled)return;let body;
            try{
              body=Buffer.concat(chunks);const v=JSON.parse(body.toString('utf8'));
              if([190,102].includes(v?.error?.code))fail('credential_revoked');
              if([401,403].includes(res.statusCode)||[10,200].includes(v?.error?.code))fail('provider_unauthorized');
              if(res.statusCode===429||[4,17,32,613].includes(v?.error?.code))fail('rate_limited');
              if(res.statusCode!==200||v?.error||!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).some(k=>!['data','paging'].includes(k))
                ||!Array.isArray(v.data)||v.data.length>100)fail('provider_failed');
              let next=null;
              if(v.paging!==undefined){
                const p=v.paging;if(!p||Object.getPrototypeOf(p)!==Object.prototype||Object.keys(p).some(k=>!['cursors','next','previous'].includes(k)))fail('provider_failed');
                if(p.next!==undefined){
                  if(typeof p.next!=='string'||!p.next||!p.cursors||typeof p.cursors.after!=='string'||!/^[A-Za-z0-9_+/=-]{1,2048}$/.test(p.cursors.after))fail('provider_failed');
                  next=p.cursors.after; // Only the cursor is used; never follow a provider-supplied URL.
                }
              }
              finish(null,{rows:v.data,next});
            }catch(e){finish(new BrokerError(e instanceof BrokerError?e.code:'provider_failed'));}finally{body?.fill(0);}
          });
        });
        req.on('error',()=>finish(new BrokerError('provider_failed')));signal.addEventListener('abort',abort,{once:true});if(signal.aborted||settled)abort();else req.end();
      }catch{finish(new BrokerError('provider_failed'));req?.destroy();}
    });
  }
  return async({binding,metadata,token,appSecret,signal,authorize})=>{
    if(!Buffer.isBuffer(token)||!tokenText(token.toString('utf8'))||!Buffer.isBuffer(appSecret)||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii'))||!(signal instanceof AbortSignal))fail('invalid_request');
    if(typeof authorize!=='function')fail('invalid_request');
    C.metadata(metadata,binding);const ownToken=Buffer.from(token),ownApp=Buffer.from(appSecret),appToken=Buffer.concat([Buffer.from(metadata.appId+'|'),ownApp]);
    const wipe=()=>{ownToken.fill(0);ownApp.fill(0);appToken.fill(0);};signal.addEventListener('abort',wipe,{once:true});
    try{
      const verify=async()=>{authorize();if(signal.aborted)fail('provider_timeout');const raw=await inspect({action:'inspect',id:metadata.appId,token:appToken,candidate:ownToken,signal});authorize();if(signal.aborted)fail('provider_timeout');D.fresh(raw,binding,metadata,now());};
      await verify();const available=D.kinds(metadata),assets=[],seen=new Set(),budget={pages:0,bytes:0};
      const proof=createHmac('sha256',ownApp).update(ownToken).digest('hex');
      const push=a=>{M.assertAssetCredential(metadata,a);if(seen.has(a.assetRef)||assets.length>=D.MAX_ASSETS)fail('provider_failed');seen.add(a.assetRef);assets.push(a);};
      const edges=[];
      if(available.includes('ad_account'))edges.push(['adaccounts','id,account_id,name,account_status,currency,timezone_name']);
      if(available.includes('facebook_page'))edges.push(['accounts','id,name'+(available.includes('instagram_business')?',instagram_business_account{id,name,username}':'')]);
      if(!edges.length)fail('scope_denied');
      for(const [edge,fields]of edges){
        let after=null;const cursors=new Set();
        do{
          authorize();
          const r=await page({subjectId:metadata.subjectId,edge,fields,after,token:ownToken,proof,signal,budget});if(signal.aborted)fail('provider_timeout');
          authorize();
          for(const raw of r.rows){
            if(edge==='adaccounts'){
              if(!C.exact(raw,'id,account_id,name,account_status,currency,timezone_name'))fail('provider_failed');push(D.project(raw,'ad_account'));
            }else{
              if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Object.keys(raw).some(k=>!['id','name',...(available.includes('instagram_business')?['instagram_business_account']:[])].includes(k)))fail('provider_failed');
              push(D.project(raw,'facebook_page'));
              if(raw.instagram_business_account!=null){const ig=raw.instagram_business_account;if(!C.exact(ig,'id,name,username'))fail('provider_failed');push(D.project(ig,'instagram_business',raw.id));}
            }
          }
          after=r.next;if(after){if(cursors.has(after))fail('provider_failed');cursors.add(after);}
        }while(after);
      }
      await verify();return assets;
    }catch(e){throw new BrokerError(e instanceof BrokerError?e.code:'provider_failed');}
    finally{signal.removeEventListener('abort',wipe);wipe();}
  };
}
module.exports={createMetaMarketingDiscoveryHttp};
