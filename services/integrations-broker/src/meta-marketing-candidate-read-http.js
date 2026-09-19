'use strict';
const https=require('node:https'),{createHmac}=require('node:crypto'),{BrokerError,fail}=require('./errors');
const C=require('./meta-marketing-oauth-contract'),D=require('./meta-marketing-discovery-contract'),M=require('./meta-marketing-contract'),E=require('./meta-marketing-enrollment-contract');
const {tokenText}=require('./whatsapp-secrets');
function createMetaMarketingCandidateReadHttp({request=https.request,timeoutMs=8000,now=()=>Date.now()}={}){
  const http=require('./meta-marketing-http').createMetaMarketingHttp({request,timeoutMs});
  return async({binding,metadata,token,appSecret,asset,operation,signal,authorize})=>{
    if(!M.OPERATIONS.includes(operation)||typeof authorize!=='function'||!(signal instanceof AbortSignal)
      ||!Buffer.isBuffer(token)||!tokenText(token.toString('utf8'))||!Buffer.isBuffer(appSecret)||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii')))fail('invalid_request');
    E.assets([asset]);C.metadata(metadata,binding);M.assertAssetCredential(metadata,asset);
    const ownToken=Buffer.from(token),ownApp=Buffer.from(appSecret),appToken=Buffer.concat([Buffer.from(metadata.appId+'|'),ownApp]);
    const wipe=()=>{ownToken.fill(0);ownApp.fill(0);appToken.fill(0);};signal.addEventListener('abort',wipe,{once:true});
    const check=()=>{if(signal.aborted)fail('provider_timeout');authorize();};
    try{
      const verify=async()=>{check();const raw=await http({action:'inspect',id:metadata.appId,token:appToken,candidate:ownToken,signal});check();
        const fresh=D.fresh(raw,binding,metadata,now());M.assertAssetCredential(fresh,asset);return fresh;};
      await verify();const proof=createHmac('sha256',ownApp).update(ownToken).digest('hex');let result;
      if(operation===M.ASSET){
        if(asset.kind==='instagram_business'){
          const parent=await http({action:'instagram_parent',id:asset.parentPageId,token:ownToken,proof,signal});check();
          if(parent.id!==asset.parentPageId||parent.instagram_business_account?.id!==asset.id)fail('scope_denied');
        }
        const raw=await http({action:asset.kind,id:asset.id,token:ownToken,proof,signal});check();result=M.projectAsset(raw,asset);
      }
      const fresh=await verify();
      if(operation===M.STATUS){const {appId,subjectId,tokenType,expiresAt,dataAccessExpiresAt}=fresh;
        result={credentialValid:true,appId,subjectId,tokenType,expiresAt,dataAccessExpiresAt,verifiedAt:now(),requiredScopes:M.requiredScopes(asset.kind),assetAccessVerified:false};}
      return result;
    }catch(e){throw new BrokerError(e instanceof BrokerError?e.code:'provider_failed');}
    finally{signal.removeEventListener('abort',wipe);wipe();}
  };
}
module.exports={createMetaMarketingCandidateReadHttp};
