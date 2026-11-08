'use strict';
const K=require('./meta-marketing-credential-shape'),R=require('./meta-marketing-read-diagnostics');
const https=require('node:https'),{createHmac}=require('node:crypto'),{BrokerError,fail}=require('./errors'),{tokenText}=require('./whatsapp-secrets');
const L=require('./meta-marketing-leads-contract'),M=require('./meta-marketing-contract'),C=require('./meta-marketing-oauth-contract'),D=require('./meta-marketing-discovery-contract'),{usage}=require('./meta-marketing-ads-http');
const AD_FIELDS='id,account_id,campaign_id,adset_id,effective_status,creative{id,call_to_action,object_story_spec}';
function createMetaMarketingLeadsHttp({request=https.request,pacer,cursor,now=Date.now,timeoutMs=8000}={}){
  if(typeof pacer?.run!=='function'||typeof pacer?.observe!=='function'||typeof cursor?.open!=='function'||typeof cursor?.seal!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)fail('invalid_request');
  async function read(input){
    const {binding,metadata,token,appSecret,asset,account,operation,payload,signal,authorize,context,receipt,recipientClinicId}=input,name=L.validate(operation,payload);
    if(['receiptAccept','challenge'].includes(name)||Object.keys(input).some(k=>!['binding','metadata','token','appSecret','asset','account','operation','payload','signal','authorize','context','receipt','recipientClinicId'].includes(k))
      ||asset?.kind!=='facebook_page'||asset.assetRef!==`meta-facebook_page:${asset.id}`||!M.graphId(asset.id)||account?.kind!=='ad_account'||account.assetRef!==payload.adAccountAssetRef||account.assetRef!==`meta-ad_account:${account.id}`||!M.graphId(account.id)
      ||typeof authorize!=='function'||!(signal instanceof AbortSignal)||!Buffer.isBuffer(token)||!tokenText(token.toString('utf8'))||!Buffer.isBuffer(appSecret)||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii')))fail('invalid_request');
    K.metadata(metadata,binding);for(const a of [asset,account])M.assertAssetCredential(metadata,a);
    for(const scope of L.REQUIRED_SCOPES){if(!metadata.scopes.includes(scope))fail('scope_denied');const granular=metadata.granularScopes.find(r=>r.scope===scope);if(granular&&!granular.targetIds.includes(scope==='ads_read'?account.id:asset.id))fail('scope_denied');}
    const codecScope={principalId:context?.principalId,tenantRef:context?.tenantRef,binding,assetRef:asset.assetRef,operation,policyVersion:context?.policyVersion};
    if(['principalId','tenantRef','policyVersion'].some(k=>typeof codecScope[k]!=='string'||!codecScope[k]))fail('invalid_request');
    let after=null,pages=0;if(name==='destinations'&&payload.cursor!==null){let v;try{v=JSON.parse(cursor.open(payload.cursor,codecScope));}catch{fail('invalid_request');}
      if(!C.exact(v,'after,pages,campaignId,adAccountAssetRef')||typeof v.after!=='string'||!/^[\x21-\x7e]{1,1024}$/.test(v.after)||v.campaignId!==payload.campaignId||v.adAccountAssetRef!==account.assetRef||!Number.isInteger(v.pages)||v.pages<1||v.pages>=2000)fail('invalid_request');after=v.after;pages=v.pages;}
    if(name==='receiptRead'&&(!receipt||L.event(receipt).page_id!==asset.id))fail('scope_denied');
    const diagnostic=R.create({operation,assetRef:asset.assetRef});
    const ownToken=Buffer.from(token),ownApp=Buffer.from(appSecret),appToken=Buffer.concat([Buffer.from(metadata.appId+'|'),ownApp]);let pageToken;
    const rejectReflections=value=>{let encoded=value;for(let i=0;i<3;i++){if([ownToken,ownApp,appToken,pageToken].filter(Boolean).some(b=>encoded.includes(b.toString('utf8'))))fail('provider_failed');let decoded;try{decoded=decodeURIComponent(encoded);}catch{break;}if(decoded===encoded)break;encoded=decoded;}};
    const wipe=()=>{ownToken.fill(0);ownApp.fill(0);appToken.fill(0);pageToken?.fill(0);};signal.addEventListener('abort',wipe,{once:true});
    const scope='meta-ads-app:'+metadata.appId,deadline=now()+25000;let observed=0;
    const check=()=>{if(signal.aborted||now()>=deadline)fail('provider_timeout');authorize();};
    const proof=bearer=>createHmac('sha256',ownApp).update(bearer).digest('hex');
    // Targets and fields are built only below. Neither a provider next URL nor
    // a caller URL/field list can ever reach this transport.
    const fetchGraph=(path,bearer,method='GET',body)=>{diagnostic.begin();return pacer.run(scope,{signal,deadline},async()=>{
      diagnostic.stage('request');check();const result=await new Promise((resolve,reject)=>{let req,res,timer,settled=false,bytes=0;const chunks=[];
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);for(const b of chunks)b.fill(0);error?reject(error):resolve(value);};
        const abort=()=>{diagnostic.stage('timeout');finish(new BrokerError('provider_timeout'));res?.destroy();req?.destroy();};timer=setTimeout(abort,Math.min(timeoutMs,Math.max(1,deadline-now())));timer.unref?.();
        try{const headers={authorization:'Bearer '+bearer.toString('utf8'),accept:'application/json','accept-encoding':'identity'};if(body){headers['content-type']='application/x-www-form-urlencoded';headers['content-length']=String(Buffer.byteLength(body));}
          req=request({protocol:'https:',hostname:'graph.facebook.com',port:443,method,path,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',headers},response=>{
            res=response;if(settled){res.destroy();return;}diagnostic.status(res.statusCode);const pct=usage(res.headers);observed=Math.max(observed,pct);pacer.observe(scope,pct);
            if(res.statusCode===429){finish(new BrokerError('rate_limited'));res.destroy();req?.destroy();return;}
            if(String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'||!['','identity'].includes(String(res.headers['content-encoding']||'').toLowerCase())||res.statusCode>=300&&res.statusCode<400){finish(new BrokerError('provider_failed'));res.destroy();req?.destroy();return;}
            res.on('data',chunk=>{diagnostic.stage('body');bytes+=chunk.length;if(bytes>131072){chunk.fill(0);finish(new BrokerError('provider_failed'));res.destroy();req?.destroy();}else if(!settled)chunks.push(chunk);});
            res.on('aborted',()=>{diagnostic.stage('aborted');finish(new BrokerError('provider_failed'));});res.on('error',()=>{diagnostic.stage('transport');finish(new BrokerError('provider_failed'));});
            res.on('end',()=>{let buf;try{if(settled)return;buf=Buffer.concat(chunks);diagnostic.stage('json');const v=JSON.parse(buf.toString('utf8'));diagnostic.meta(v?.error);diagnostic.stage('http');if([4,17,32,613].includes(v?.error?.code))fail('rate_limited');if([190,102].includes(v?.error?.code))fail('credential_revoked');if([401,403].includes(res.statusCode)||[10,200].includes(v?.error?.code))fail('provider_unauthorized');if(res.statusCode!==200||!v||v.error||typeof v!=='object'||Array.isArray(v))fail('provider_failed');diagnostic.stage('complete');finish(null,v);}catch(e){finish(e instanceof BrokerError?e:new BrokerError('provider_failed'));}finally{buf?.fill(0);}});
          });req.on('error',()=>{diagnostic.stage('transport');finish(new BrokerError('provider_failed'));});signal.addEventListener('abort',abort,{once:true});if(signal.aborted||settled)abort();else req.end(body);
        }catch{diagnostic.stage('transport');finish(new BrokerError('provider_failed'));req?.destroy();}
      });check();return result;
    });};
    const get=(node,fields,bearer=ownToken,extra={})=>fetchGraph(`/${metadata.graphVersion||M.GRAPH_VERSION}/${node}?`+new URLSearchParams({fields,appsecret_proof:proof(bearer),...extra}),bearer);
    const verifyUser=async(afterRead=false)=>{diagnostic.phase(afterRead?'after_credential_http':'before_credential_http');const raw=await fetchGraph(`/${metadata.graphVersion||M.GRAPH_VERSION}/debug_token?`+new URLSearchParams({input_token:ownToken.toString('utf8')}),appToken);diagnostic.scopes(raw?.data?.scopes);diagnostic.phase(afterRead?'after_credential_validation':'before_credential_validation');const fresh=D.fresh(raw,binding,metadata,now());for(const a of [asset,account])M.assertAssetCredential(fresh,a);};
    const derivePage=async()=>{diagnostic.phase('page_token_http');const raw=await get(asset.id,'id,access_token');diagnostic.phase('page_token_validation');if(raw.id!==asset.id||!tokenText(raw.access_token))fail('scope_denied');pageToken=Buffer.from(raw.access_token);delete raw.access_token;
      diagnostic.phase('page_token_debug_http');const debug=await fetchGraph(`/${metadata.graphVersion||M.GRAPH_VERSION}/debug_token?`+new URLSearchParams({input_token:pageToken.toString('utf8')}),appToken),d=debug.data;diagnostic.phase('page_token_debug_validation');
      if(!d||d.is_valid!==true||d.app_id!==metadata.appId||d.type!=='PAGE'||d.profile_id!=null&&d.profile_id!==asset.id||!Array.isArray(d.scopes)||!d.scopes.includes('leads_retrieval'))fail('scope_denied');
      if([d.expires_at,d.data_access_expires_at].some(v=>!Number.isSafeInteger(v)||v<0||v!==0&&v*1000<=now()))fail('credential_revoked');
      diagnostic.phase('page_identity_http');const me=await get('me','id',pageToken);diagnostic.phase('page_identity_validation');if(me.id!==asset.id)fail('scope_denied');};
    const form=async id=>{const f=await get(id,'id,name,page_id,status',pageToken);if(f.id!==id||f.page_id!==asset.id)fail('scope_denied');return {id:f.id,name:f.name,page_id:f.page_id,status:f.status};};
    const reception=async()=>{
      // HasLeadAccess is not available for this app. Read one owned Form and
      // one lead identifier through the supported APIs, never contact fields.
      diagnostic.phase('page_access_http');const forms=await get(asset.id+'/leadgen_forms','id,page_id',pageToken,{limit:'1'});
      diagnostic.phase('page_access_projection');if(!Array.isArray(forms.data)||forms.data.length>1||forms.data.some(f=>!C.exact(f,'id,page_id')||!M.graphId(f.id)||f.page_id!==asset.id))fail('scope_denied');
      let access=false;
      if(forms.data.length){diagnostic.phase('data_http');const probe=await get(forms.data[0].id+'/leads','id',pageToken,{limit:'1'});diagnostic.phase('data_projection');
        if(!Array.isArray(probe.data)||probe.data.length>1||probe.data.some(v=>!C.exact(v,'id')||!M.graphId(v.id)))fail('provider_failed');access=true;}
      diagnostic.phase('page_subscriptions_http');const raw=await get(asset.id+'/subscribed_apps','id,subscribed_fields',pageToken,{limit:'100'});diagnostic.phase('page_subscriptions_projection');if(!Array.isArray(raw.data)||raw.data.length>100||raw.paging?.next)fail('provider_failed');
      const mine=raw.data.filter(r=>r?.id===metadata.appId);if(mine.length>1)fail('provider_failed');const fields=mine.length?mine[0].subscribed_fields:[];
      if(!Array.isArray(fields)||fields.length>100||new Set(fields).size!==fields.length||fields.some(v=>typeof v!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(v)))fail('provider_failed');fields.sort();
      return {page:{id:asset.id,has_lead_access:access},subscription:{subscribed:mine.length===1,fields,revision:L.subscription(metadata.appId,asset.id,account.id,fields)}};};
    try{
      diagnostic.phase('authorization');check();await verifyUser();let result;
      if(name==='destinations'){
        const path=`/${metadata.graphVersion||M.GRAPH_VERSION}/act_${account.id}/ads`,q=new URLSearchParams({fields:AD_FIELDS,limit:'50',appsecret_proof:proof(ownToken),filtering:JSON.stringify([{field:'campaign.id',operator:'EQUAL',value:payload.campaignId}])});if(after)q.set('after',after);
        const raw=await fetchGraph(path+'?'+q,ownToken);if(!Array.isArray(raw.data)||raw.data.length>50)fail('provider_failed');const results=raw.data.map(L.projectAd);let nextCursor=null;
        if(raw.paging?.next){let u;try{u=new URL(raw.paging.next);}catch{fail('provider_failed');}const next=raw.paging?.cursors?.after;if(u.protocol!=='https:'||u.hostname!=='graph.facebook.com'||u.port||u.username||u.password||u.hash||u.pathname!==path||typeof next!=='string'||!/^[\x21-\x7e]{1,1024}$/.test(next)||u.searchParams.get('after')!==next||next===after||!results.length||pages>=1999)fail('provider_failed');rejectReflections(next);nextCursor=cursor.seal(JSON.stringify({after:next,pages:pages+1,campaignId:payload.campaignId,adAccountAssetRef:account.assetRef}),codecScope);}
        result={results,nextCursor};
      }else{
        await derivePage();
        if(name==='form')result={form:await form(payload.formId)};
        else if(['pageStatus','pageEnable'].includes(name)){
          result=await reception();
          if(name==='pageEnable'){
            if(!result.page.has_lead_access)fail('scope_denied');if(result.subscription.revision!==payload.expectedSubscriptionRevision)fail('idempotency_conflict');
            if(!result.subscription.fields.includes('leadgen')){const old=result.subscription.fields,fields=[...old,'leadgen'].sort();
              const body=new URLSearchParams({subscribed_fields:fields.join(','),appsecret_proof:proof(pageToken)}).toString();
              // An uncertain POST is never retried. The next readiness GET is
              // the reconciliation mechanism; this operation only sends once.
              const ack=await fetchGraph(`/${metadata.graphVersion||M.GRAPH_VERSION}/${asset.id}/subscribed_apps`,pageToken,'POST',body);if(ack.success!==true)fail('provider_failed');result=await reception();if(!result.subscription.subscribed||fields.some(f=>!result.subscription.fields.includes(f)))fail('provider_failed');
            }
          }
        }else if(name==='receiptRead'){
          await form(receipt.form_id);
          // Identity comes before contact fields. HMAC proves the application;
          // it does not prove an Ad belongs to this reviewed account.
          const metadataLead=await get(receipt.lead_id,'id,form_id,ad_id,campaign_id,created_time,is_organic',pageToken);
          if(metadataLead.id!==receipt.lead_id||metadataLead.form_id!==receipt.form_id||receipt.ad_id!==null&&metadataLead.ad_id!==receipt.ad_id||typeof metadataLead.is_organic!=='boolean')fail('scope_denied');
          let identity=null;
          if(metadataLead.ad_id!=null){if(!M.graphId(metadataLead.ad_id))fail('scope_denied');const ad=await get(metadataLead.ad_id,'id,account_id,campaign_id,adset_id');if(ad.id!==metadataLead.ad_id||ad.account_id!==account.id||ad.campaign_id!==metadataLead.campaign_id||metadataLead.is_organic)fail('scope_denied');identity={account_id:ad.account_id,campaign_id:ad.campaign_id,ad_id:ad.id,adset_id:ad.adset_id};}
          else if(!metadataLead.is_organic||metadataLead.campaign_id!=null)fail('scope_denied');
          check();const lead=await get(receipt.lead_id,'id,form_id,ad_id,campaign_id,created_time,is_organic,field_data',pageToken);
          for(const k of ['id','form_id','ad_id','campaign_id','created_time','is_organic'])if((lead[k]??null)!==(metadataLead[k]??null))fail('scope_denied');
          if(!Array.isArray(lead.field_data)||lead.field_data.length>100)fail('provider_failed');
          result={event:receipt,recipientClinicId,lead:{id:lead.id,form_id:lead.form_id,ad_id:lead.ad_id??null,campaign_id:lead.campaign_id??null,created_time:lead.created_time,is_organic:lead.is_organic,field_data:lead.field_data.filter(f=>['full_name','email','phone_number'].includes(f?.name)).map(f=>({name:f.name,values:f.values}))},identity};
        }else fail('operation_denied');
      }
      await verifyUser(true);diagnostic.phase('authorization');check();result.usage=pacer.usage(scope,observed);diagnostic.phase('response_validation');const safe=L.validateResponse(operation,result,payload);diagnostic.phase('reflection');rejectReflections(JSON.stringify(safe));
      return safe;
    }catch(e){const error=e instanceof BrokerError?e:new BrokerError('provider_failed');diagnostic.fail(error);throw error;}finally{signal.removeEventListener('abort',wipe);wipe();}
  }
  return {read};
}
module.exports={createMetaMarketingLeadsHttp,AD_FIELDS};
