'use strict';
const { randomInt } = require('node:crypto');
const { GetSecretValueCommand, PutSecretValueCommand, DescribeSecretCommand } = require('@aws-sdk/client-secrets-manager');
const E = require('./whatsapp-onboarding-contract');
const { fail } = require('./errors');
// A separate immutable version in the existing candidate vault slot. Never
// replace AWSCURRENT/AWSPENDING, return a PIN, or put it in the clinical DB.
function createRegistrationPins({ client, kmsKeyArn }) {
  return async function withPin({ binding, flowId, phoneId, versionId, signal }, work) {
    if (!E.uuid(flowId) || !E.uuid(versionId) || !E.id(phoneId)) fail('invalid_request');
    const b=E.bindingFor(binding);
    const info=await client.send(new DescribeSecretCommand({SecretId:binding.secretArn}),{abortSignal:signal});
    if(info.ARN!==binding.secretArn || info.KmsKeyId!==kmsKeyArn || info.DeletedDate)fail('secret_unavailable');
    let raw;
    try { raw=await client.send(new GetSecretValueCommand({SecretId:binding.secretArn,VersionId:versionId}),{abortSignal:signal}); }
    catch(error) {
      if(error?.name!=='ResourceNotFoundException')fail('secret_unavailable');
      let body=JSON.stringify({version:1,provider:'meta-whatsapp-registration-pin',flowId,phoneId,appId:b.appId,
        scopeKey:b.scopeKey,pin:String(randomInt(1000000)).padStart(6,'0')});
      try {
        await client.send(new PutSecretValueCommand({SecretId:binding.secretArn,ClientRequestToken:versionId,
          SecretString:body,VersionStages:['CC_REGISTRATION_PIN']}),{abortSignal:signal});
      } finally { body=null; }
      raw=await client.send(new GetSecretValueCommand({SecretId:binding.secretArn,VersionId:versionId}),{abortSignal:signal});
    }
    let value;
    try {
      if(raw.ARN!==binding.secretArn || raw.VersionId!==versionId || typeof raw.SecretString!=='string'
        || raw.SecretString.length>2048 || raw.VersionStages?.some(v=>['AWSCURRENT','AWSPENDING','AWSPREVIOUS'].includes(v)))fail('secret_unavailable');
      value=JSON.parse(raw.SecretString);delete raw.SecretString;
      if(!E.exact(value,['version','provider','flowId','phoneId','appId','scopeKey','pin']) || value.version!==1
        || value.provider!=='meta-whatsapp-registration-pin' || value.flowId!==flowId || value.phoneId!==phoneId
        || value.appId!==b.appId || value.scopeKey!==b.scopeKey || !/^\d{6}$/.test(value.pin))fail('secret_unavailable');
      return await work(value.pin);
    } finally { if(value)delete value.pin;if(raw)delete raw.SecretString; }
  };
}
module.exports={createRegistrationPins};
