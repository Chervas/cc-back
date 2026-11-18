'use strict';
const K=require('./meta-marketing-credential-shape'),R=require('./meta-marketing-read-diagnostics');
const https=require('node:https'),{createHmac}=require('node:crypto');
const {BrokerError,fail}=require('./errors'),{tokenText}=require('./whatsapp-secrets');
const A=require('./meta-marketing-ads-contract'),M=require('./meta-marketing-contract'),D=require('./meta-marketing-discovery-contract'),C=require('./meta-marketing-oauth-contract'),E=require('./meta-marketing-enrollment-contract');
const creative=require('./meta-marketing-ads-creative');
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
    E.assets([asset]);K.metadata(metadata,binding);M.assertAssetCredential(metadata,asset);
    const codecScope={principalId:context?.principalId,tenantRef:context?.tenantRef,binding,assetRef:asset.assetRef,operation,policyVersion:context?.policyVersion};
    if(typeof codecScope.principalId!=='string'||!codecScope.principalId||typeof codecScope.tenantRef!=='string'||!codecScope.tenantRef||typeof codecScope.policyVersion!=='string'||!codecScope.policyVersion)fail('invalid_request');
    const diagnostic=R.create({operation,assetRef:asset.assetRef});
    const withCreative=name==='ads'&&[1,2].includes(payload.creativeVersion);
    let after=null,pages=0;
    if(payload.pageToken!==null){let v;try{v=JSON.parse(cursor.open(payload.pageToken,codecScope));}catch{fail('invalid_request');}
      if(!v||Object.keys(v).sort().join(',')!==(withCreative?'after,creativeVersion,endDate,pages,startDate':'after,endDate,pages,startDate')||withCreative&&v.creativeVersion!==payload.creativeVersion||typeof v.after!=='string'||!/^[\x21-\x7e]{1,1024}$/.test(v.after)
        ||v.startDate!==(payload.startDate??null)||v.endDate!==(payload.endDate??null)||!Number.isInteger(v.pages)||v.pages<1||v.pages>=2000)fail('invalid_request');after=v.after;pages=v.pages;}
    const ownToken=Buffer.from(token),ownApp=Buffer.from(appSecret),appToken=Buffer.concat([Buffer.from(metadata.appId+'|'),ownApp]);
    const wipe=()=>{ownToken.fill(0);ownApp.fill(0);appToken.fill(0);};signal.addEventListener('abort',wipe,{once:true});
    const scope='meta-ads-app:'+metadata.appId,deadline=now()+25000;let observed=0;
    const check=()=>{if(signal.aborted||now()>=deadline)fail('provider_timeout');authorize();};
    const pacedRequest=(work)=>pacer.run(scope,{signal,deadline},async()=>{check();const result=await work();check();return result;});
    const transport=(settings,callback)=>request(settings,res=>{diagnostic.status(res.statusCode);const pct=usage(res.headers);observed=Math.max(observed,pct);pacer.observe(scope,pct);callback(res);});
    const graphVersion=metadata.graphVersion||M.GRAPH_VERSION,edge=['insights','actions'].includes(name)?'insights':name;
    const path=`/${graphVersion}/act_${asset.id}/${edge}`;
    const fetchGraph=(targetPath,bearer)=>{diagnostic.begin();diagnostic.credential(bearer===appToken?'application':'primary');return pacedRequest(()=>new Promise((resolve,reject)=>{
        diagnostic.stage('request');
        let req,res,timer,settled=false,bytes=0;const chunks=[];
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);for(const b of chunks)b.fill(0);chunks.length=0;error?reject(error):resolve(value);};
        const abort=()=>{diagnostic.stage('timeout');finish(new BrokerError('provider_timeout'));res?.destroy();req?.destroy();};
        timer=setTimeout(abort,Math.min(timeoutMs,Math.max(1,deadline-now())));timer.unref?.();
        try{req=transport({protocol:'https:',hostname:'graph.facebook.com',port:443,method:'GET',path:targetPath,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:{authorization:'Bearer '+bearer.toString('utf8'),accept:'application/json','accept-encoding':'identity'}},response=>{
          res=response;if(settled){res.destroy();return;}
          if(res.statusCode===429){finish(new BrokerError('rate_limited'));res.destroy();req?.destroy();return;}
          if(String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'||!['','identity'].includes(String(res.headers['content-encoding']||'').toLowerCase())||res.statusCode>=300&&res.statusCode<400){finish(new BrokerError('provider_failed'));res.destroy();req?.destroy();return;}
          res.on('data',chunk=>{diagnostic.stage('body');bytes+=chunk.length;if(bytes>131072){chunk.fill(0);finish(new BrokerError('provider_failed'));res.destroy();req?.destroy();}else if(!settled)chunks.push(chunk);});
          res.on('aborted',()=>{diagnostic.stage('aborted');finish(new BrokerError('provider_failed'));});res.on('error',()=>{diagnostic.stage('transport');finish(new BrokerError('provider_failed'));});
          res.on('end',()=>{if(settled)return;let buffer;try{buffer=Buffer.concat(chunks);diagnostic.stage('json');const value=JSON.parse(buffer.toString('utf8'));diagnostic.meta(value?.error);diagnostic.stage('http');
            if(res.statusCode===429||[4,17,32,613,80004].includes(value?.error?.code))fail('rate_limited');
            // debug_token authenticates the application separately from the
            // inspected credential. Its HTTP rejection cannot revoke the latter.
            if([190,102].includes(value?.error?.code))fail(bearer===appToken?'secret_unavailable':'credential_revoked');if([401,403].includes(res.statusCode)||[10,200].includes(value?.error?.code))fail('provider_unauthorized');
            if(res.statusCode!==200||!value||value.error||typeof value!=='object'||Array.isArray(value))fail('provider_failed');diagnostic.stage('complete');finish(null,value);
          }catch(e){finish(e instanceof BrokerError?e:new BrokerError('provider_failed'));}finally{buffer?.fill(0);}});
        });req.on('error',()=>{diagnostic.stage('transport');finish(new BrokerError('provider_failed'));});signal.addEventListener('abort',abort,{once:true});if(signal.aborted||settled)abort();else req.end();
        }catch{diagnostic.stage('transport');finish(new BrokerError('provider_failed'));req?.destroy();}
      }));};
    try{
      const verify=async(afterRead=false)=>{diagnostic.phase(afterRead?'after_credential_http':'before_credential_http');const raw=await fetchGraph(`/${metadata.graphVersion||M.GRAPH_VERSION}/debug_token?${new URLSearchParams({input_token:ownToken.toString('utf8')})}`,appToken);
        diagnostic.scopes(raw?.data?.scopes);diagnostic.phase(afterRead?'after_credential_validation':'before_credential_validation');diagnostic.credential('primary');const fresh=D.fresh(raw,binding,metadata,now());M.assertAssetCredential(fresh,asset);return fresh;};
      await verify();const proof=createHmac('sha256',ownApp).update(ownToken).digest('hex');
      const query=new URLSearchParams({fields:withCreative?A.CREATIVE_FIELDS:A.FIELDS[name],limit:withCreative?'10':'50',appsecret_proof:proof});
      if(after)query.set('after',after);
      if(['insights','actions'].includes(name)){query.set('level','ad');query.set('time_increment','1');query.set('time_range',JSON.stringify({since:payload.startDate,until:payload.endDate}));query.set('breakdowns','publisher_platform,platform_position');}
      diagnostic.phase('data_http');const raw=await fetchGraph(path+'?'+query,ownToken);
      diagnostic.phase('data_projection');let results;try{
        if(withCreative&&(!Array.isArray(raw.data)||raw.data.some(ad=>ad.account_id!==asset.id)))fail('provider_failed');
        results=A.projectPage(name,raw,payload);
      }catch(error){diagnostic.adsProjection(name,raw,payload);throw error;}let nextPageToken=null;
      if(withCreative){
        // Sources are read only for video IDs observed in this exact authorized
        // account page. Callers cannot supply a video ID, URL or field list.
        const projections=results.map(ad=>ad.creative?.sharing).filter(Boolean);
        const ids=[...new Set(projections.flatMap(value=>creative.videoIds(value)))];
        const hashes=[...new Set(projections.flatMap(value=>creative.imageHashes(value)))];
        // At most ten admissible choices per each of ten ads. Keep the original
        // ten-reference batch cap and the same overall deadline/pacing policy.
        if(ids.length>100||hashes.length>100)fail('provider_failed');
        const sources={},images={};
        for(let offset=0;offset<ids.length;offset+=10){
          const batch=ids.slice(offset,offset+10);
          const sourceQuery=new URLSearchParams({ids:batch.join(','),fields:'id,source',appsecret_proof:proof});
          let response;
          try{response=await fetchGraph(`/${graphVersion}/?${sourceQuery}`,ownToken);}
          catch(error){if(!['provider_failed','provider_unauthorized'].includes(error.code))throw error;
            response=error.code==='provider_unauthorized'?Object.fromEntries(batch.map(id=>[id,{error:{code:200}}])):{};}
          if(!response||typeof response!=='object'||Array.isArray(response)||Object.keys(response).some(id=>!batch.includes(id)))fail('provider_failed');
          for(const [id,value]of Object.entries(response)){
            if([190,102].includes(value?.error?.code))fail('credential_revoked');
            if([4,17,32,613,80004].includes(value?.error?.code)){
              pacer.observe(scope,100);const error=new BrokerError('rate_limited');
              error.retryAfterMs=Math.max(1,pacer.usage(scope,100).pauseUntil-now());throw error;
            }
            sources[id]=value;
          }
        }
        for(let offset=0;offset<hashes.length;offset+=10){
          const batch=hashes.slice(offset,offset+10);
          const imageQuery=new URLSearchParams({hashes:JSON.stringify(batch),fields:'hash,url',limit:'10',appsecret_proof:proof});
          let response;
          try{response=await fetchGraph(`/${graphVersion}/act_${asset.id}/adimages?${imageQuery}`,ownToken);}
          catch(error){if(!['provider_failed','provider_unauthorized'].includes(error.code))throw error;
            if(error.code==='provider_unauthorized')for(const hash of batch)images[hash]={error:{code:200}};
            continue;}
          if(!Array.isArray(response.data)||response.data.length>10||response.paging?.next)fail('provider_failed');
          const seen=new Set();
          for(const image of response.data){
            if(!image||typeof image!=='object'||Array.isArray(image)||!batch.includes(image.hash)||seen.has(image.hash))fail('provider_failed');
            seen.add(image.hash);images[image.hash]={hash:image.hash,url:image.url};
          }
        }
        for(const ad of results)if(ad.creative?.sharing){
          ad.creative.sharing=creative.videoSources(ad.creative.sharing,sources);
          ad.creative.sharing=creative.imageSources(ad.creative.sharing,images);
        }
      }
      diagnostic.phase('pagination');
      if(raw.paging?.next){let next;try{next=new URL(raw.paging.next);}catch{diagnostic.pagination({urlInvalid:true});diagnostic.paginationPathVariant('other');fail('provider_failed');}
        // Classify only exact, closed equivalents for diagnosis. This is not an
        // authorization decision: the original strict path check below remains.
        diagnostic.paginationPathVariant(next.pathname===path?'exact':next.pathname===`/${graphVersion}/${asset.id}/${edge}`?'numeric_account'
          :[`/act_${asset.id}/${edge}`,`/${asset.id}/${edge}`].includes(next.pathname)?'versionless_same_account':'other');
        const pathParts=next.pathname.split('/').slice(1),version=/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(pathParts[0])?pathParts[0]:null;
        const accountPart=pathParts[version?1:0],edgePart=pathParts[version?2:1];
        diagnostic.paginationPathShape({segmentCount:pathParts.filter(Boolean).length,emptySegments:pathParts.slice(0,next.pathname.endsWith('/')?-1:undefined).some(v=>v===''),
          trailingSlash:next.pathname.endsWith('/'),percentEncoding:next.pathname.includes('%'),version,
          versionRelation:version?(version===graphVersion?'current':'other'):/^(?:act_)?[1-9][0-9]{0,29}$/.test(pathParts[0])?'versionless':'invalid',
          account:accountPart===`act_${asset.id}`?'same_act':accountPart===asset.id?'same_numeric':!accountPart?'missing':/^(?:act_)?[1-9][0-9]{0,29}$/.test(accountPart)?'other_numeric':'other',
          edge:['ads','adsets','campaigns','insights'].includes(edgePart)?edgePart:null,edgeMatches:edgePart===edge,
          canonicalPattern:/^\/(?:v[0-9]{1,3}\.[0-9]{1,2}\/)?(?:act_)?[1-9][0-9]{0,29}\/(?:ads|adsets|campaigns|insights)\/?$/.test(next.pathname)});
        // Meta's observed v24 request response supplies a canonical v25 paging
        // path. Admit only that exact version pair and the same account/edge.
        // Next is never fetched: requests keep their fixed path and only the
        // validated cursor is sealed for the next typed read.
        const observedVersionAlias=graphVersion==='v24.0'&&next.pathname===`/v25.0/act_${asset.id}/${edge}`;
        const cursorAfter=raw.paging?.cursors?.after;
        const pagination={urlInvalid:false,protocolRejected:next.protocol!=='https:',hostRejected:next.hostname!=='graph.facebook.com',
          authorityRejected:Boolean(next.port||next.username||next.password),fragmentRejected:Boolean(next.hash),pathMismatch:next.pathname!==path&&!observedVersionAlias,
          cursorMissing:typeof cursorAfter!=='string',cursorMalformed:typeof cursorAfter==='string'&&!/^[\x21-\x7e]{1,1024}$/.test(cursorAfter),
          cursorUrlMismatch:next.searchParams.get('after')!==cursorAfter,cursorRepeated:cursorAfter===after,emptyPage:!results.length,pageLimitReached:pages>=1999,
          credentialReflection:typeof cursorAfter==='string'&&(cursorAfter.includes(ownToken.toString('utf8'))||cursorAfter.includes(ownApp.toString('ascii')))};
        diagnostic.pagination(pagination);if(Object.values(pagination).some(Boolean))fail('provider_failed');
        nextPageToken=cursor.seal(JSON.stringify({after:cursorAfter,startDate:payload.startDate??null,endDate:payload.endDate??null,pages:pages+1,...(withCreative?{creativeVersion:payload.creativeVersion}:{})}),codecScope);
      }
      diagnostic.phase('reflection');let serialized=JSON.stringify(results);
      // Also reject URL-encoded reflections in an otherwise permitted label or
      // canonical permalink path. Query/fragment secrets were already removed.
      for(let round=0;round<3;round++){
        if(serialized.includes(ownToken.toString('utf8'))||serialized.includes(ownApp.toString('ascii')))fail('provider_failed');
        let decoded;try{decoded=decodeURIComponent(serialized);}catch{break;}if(decoded===serialized)break;serialized=decoded;
      }
      await verify(true);diagnostic.phase('authorization');check();diagnostic.phase('response_validation');return A.validatePage(operation,{results,nextPageToken,usage:pacer.usage(scope,observed)},payload);
    }catch(e){const error=e instanceof BrokerError?e:new BrokerError('provider_failed');diagnostic.fail(error);throw error;}
    finally{signal.removeEventListener('abort',wipe);wipe();}
  }
  return {read};
}
module.exports={createMetaMarketingAdsHttp,usage};
