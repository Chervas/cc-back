'use strict';
const https=require('node:https'),{createHmac}=require('node:crypto');
const {BrokerError,fail}=require('./errors'),{tokenText}=require('./whatsapp-secrets');
const A=require('./meta-marketing-ads-contract'),M=require('./meta-marketing-contract'),D=require('./meta-marketing-discovery-contract'),C=require('./meta-marketing-oauth-contract'),E=require('./meta-marketing-enrollment-contract');
function usage(headers){
  let max=0;
  const scan=(v,depth=0)=>{if(depth>6)return;if(Array.isArray(v)){for(const item of v)scan(item,depth+1);return;}if(!v||typeof v!=='object')return;
    for(const [key,value]of Object.entries(v)){if(['call_count','total_cputime','total_time','acc_id_util_pct','usage'].includes(key)&&Number.isFinite(Number(value)))max=Math.max(max,Math.min(100,Math.max(0,Number(value))));else if(value&&typeof value==='object')scan(value,depth+1);}};
  for(const key of ['x-app-usage','x-ad-account-usage','x-business-use-case-usage']){const raw=headers?.[key];if(typeof raw==='string'&&raw.length<=16384)try{scan(JSON.parse(raw));}catch{}}
  return max;
}
function createMetaMarketingAdsHttp({request=https.request,pacer,cursor,timeoutMs=8000,now=Date.now}={}){
  if(typeof pacer?.run!=='function'||typeof pacer?.observe!=='function'||typeof cursor?.open!=='function'||typeof cursor?.seal!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)fail('invalid_request');
  async function read(input){
    const {binding,metadata,token,appSecret,asset,operation,payload,signal,authorize,context}=input,name=A.validate(operation,payload);
    if(Object.keys(input).some(k=>!['binding','metadata','token','appSecret','asset','operation','payload','signal','authorize','context'].includes(k))
      ||asset?.kind!=='ad_account'||!M.graphId(asset.id)||asset.assetRef!==`meta-ad_account:${asset.id}`||typeof authorize!=='function'||!(signal instanceof AbortSignal)
      ||!Buffer.isBuffer(token)||!tokenText(token.toString('utf8'))||!Buffer.isBuffer(appSecret)||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii')))fail('invalid_request');
    E.assets([asset]);C.metadata(metadata,binding);M.assertAssetCredential(metadata,asset);
    const codecScope={principalId:context?.principalId,tenantRef:context?.tenantRef,binding,assetRef:asset.assetRef,operation,policyVersion:context?.policyVersion};
    if(typeof codecScope.principalId!=='string'||!codecScope.principalId||typeof codecScope.tenantRef!=='string'||!codecScope.tenantRef||typeof codecScope.policyVersion!=='string'||!codecScope.policyVersion)fail('invalid_request');
    let after=null,pages=0;
    if(payload.pageToken!==null){let v;try{v=JSON.parse(cursor.open(payload.pageToken,codecScope));}catch{fail('invalid_request');}
      if(!v||Object.keys(v).sort().join(',')!=='after,endDate,pages,startDate'||typeof v.after!=='string'||!/^[\x21-\x7e]{1,1024}$/.test(v.after)
        ||v.startDate!==(payload.startDate??null)||v.endDate!==(payload.endDate??null)||!Number.isInteger(v.pages)||v.pages<1||v.pages>=2000)fail('invalid_request');after=v.after;pages=v.pages;}
    const ownToken=Buffer.from(token),ownApp=Buffer.from(appSecret),appToken=Buffer.concat([Buffer.from(metadata.appId+'|'),ownApp]);
    const wipe=()=>{ownToken.fill(0);ownApp.fill(0);appToken.fill(0);};signal.addEventListener('abort',wipe,{once:true});
    const scope='meta-ads-app:'+metadata.appId,deadline=now()+25000;let observed=0;
    const check=()=>{if(signal.aborted||now()>=deadline)fail('provider_timeout');authorize();};
    const pacedRequest=(work)=>pacer.run(scope,{signal,deadline},async()=>{check();const result=await work();check();return result;});
    const transport=(settings,callback)=>request(settings,res=>{const pct=usage(res.headers);observed=Math.max(observed,pct);pacer.observe(scope,pct);callback(res);});
    const path=`/${M.GRAPH_VERSION}/act_${asset.id}/${['insights','actions'].includes(name)?'insights':name}`;
    const fetchGraph=(targetPath,bearer)=>pacedRequest(()=>new Promise((resolve,reject)=>{
        let req,res,timer,settled=false,bytes=0;const chunks=[];
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);for(const b of chunks)b.fill(0);chunks.length=0;error?reject(error):resolve(value);};
        const abort=()=>{finish(new BrokerError('provider_timeout'));res?.destroy();req?.destroy();};
        timer=setTimeout(abort,Math.min(timeoutMs,Math.max(1,deadline-now())));timer.unref?.();
        try{req=transport({protocol:'https:',hostname:'graph.facebook.com',port:443,method:'GET',path:targetPath,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:{authorization:'Bearer '+bearer.toString('utf8'),accept:'application/json','accept-encoding':'identity'}},response=>{
          res=response;if(settled){res.destroy();return;}
          if(res.statusCode===429){finish(new BrokerError('rate_limited'));res.destroy();req?.destroy();return;}
          if(String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'||!['','identity'].includes(String(res.headers['content-encoding']||'').toLowerCase())||res.statusCode>=300&&res.statusCode<400){finish(new BrokerError('provider_failed'));res.destroy();req?.destroy();return;}
          res.on('data',chunk=>{bytes+=chunk.length;if(bytes>131072){chunk.fill(0);finish(new BrokerError('provider_failed'));res.destroy();req?.destroy();}else if(!settled)chunks.push(chunk);});
          res.on('aborted',()=>finish(new BrokerError('provider_failed')));res.on('error',()=>finish(new BrokerError('provider_failed')));
          res.on('end',()=>{if(settled)return;let buffer;try{buffer=Buffer.concat(chunks);const value=JSON.parse(buffer.toString('utf8'));
            if(res.statusCode===429||[4,17,32,613].includes(value?.error?.code))fail('rate_limited');
            if([190,102].includes(value?.error?.code))fail('credential_revoked');if([401,403].includes(res.statusCode)||[10,200].includes(value?.error?.code))fail('provider_unauthorized');
            if(res.statusCode!==200||!value||value.error||typeof value!=='object'||Array.isArray(value))fail('provider_failed');finish(null,value);
          }catch(e){finish(e instanceof BrokerError?e:new BrokerError('provider_failed'));}finally{buffer?.fill(0);}});
        });req.on('error',()=>finish(new BrokerError('provider_failed')));signal.addEventListener('abort',abort,{once:true});if(signal.aborted||settled)abort();else req.end();
        }catch{finish(new BrokerError('provider_failed'));req?.destroy();}
      }));
    try{
      const verify=async()=>{const raw=await fetchGraph(`/${M.GRAPH_VERSION}/debug_token?${new URLSearchParams({input_token:ownToken.toString('utf8')})}`,appToken);
        const fresh=D.fresh(raw,binding,metadata,now());M.assertAssetCredential(fresh,asset);return fresh;};
      await verify();const proof=createHmac('sha256',ownApp).update(ownToken).digest('hex');
      const query=new URLSearchParams({fields:A.FIELDS[name],limit:'50',appsecret_proof:proof});
      if(after)query.set('after',after);
      if(['insights','actions'].includes(name)){query.set('level','ad');query.set('time_increment','1');query.set('time_range',JSON.stringify({since:payload.startDate,until:payload.endDate}));query.set('breakdowns','publisher_platform,platform_position');}
      const raw=await fetchGraph(path+'?'+query,ownToken);
      const results=A.projectPage(name,raw,payload);let nextPageToken=null;
      if(raw.paging?.next){let next;try{next=new URL(raw.paging.next);}catch{fail('provider_failed');}
        const cursorAfter=raw.paging?.cursors?.after;
        if(next.protocol!=='https:'||next.hostname!=='graph.facebook.com'||next.port||next.username||next.password||next.hash||next.pathname!==path
          ||typeof cursorAfter!=='string'||!/^[\x21-\x7e]{1,1024}$/.test(cursorAfter)||next.searchParams.get('after')!==cursorAfter||cursorAfter===after||!results.length||pages>=1999
          ||cursorAfter.includes(ownToken.toString('utf8'))||cursorAfter.includes(ownApp.toString('ascii')))fail('provider_failed');
        nextPageToken=cursor.seal(JSON.stringify({after:cursorAfter,startDate:payload.startDate??null,endDate:payload.endDate??null,pages:pages+1}),codecScope);
      }
      let serialized=JSON.stringify(results);
      // Also reject URL-encoded reflections in an otherwise permitted label or
      // canonical permalink path. Query/fragment secrets were already removed.
      for(let round=0;round<3;round++){
        if(serialized.includes(ownToken.toString('utf8'))||serialized.includes(ownApp.toString('ascii')))fail('provider_failed');
        let decoded;try{decoded=decodeURIComponent(serialized);}catch{break;}if(decoded===serialized)break;serialized=decoded;
      }
      await verify();check();return A.validatePage(operation,{results,nextPageToken,usage:pacer.usage(scope,observed)},payload);
    }catch(e){if(e instanceof BrokerError)throw e;throw new BrokerError('provider_failed');}
    finally{signal.removeEventListener('abort',wipe);wipe();}
  }
  return {read};
}
module.exports={createMetaMarketingAdsHttp,usage};
