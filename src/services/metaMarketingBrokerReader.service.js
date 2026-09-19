'use strict';
const { randomUUID } = require('node:crypto');
const C = require('../../services/integrations-broker/src/meta-marketing-contract');
const { createMetaMarketingBrokerScope, createMetaMarketingScopeRepository } = require('./metaMarketingBrokerScope.service');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const SAFE = new Set(['meta_broker_binding_invalid','meta_broker_scope_changed','meta_broker_not_active','broker_cohort_disabled',
  'meta_broker_scope_forbidden','meta_broker_session_required','broker_response_invalid','broker_configuration_invalid',
  'broker_timeout','broker_unavailable','connection_blocked','asset_revoked','scope_denied','operation_denied','invalid_request',
  'secret_unavailable','credential_revoked','provider_failed','provider_timeout','provider_unauthorized','rate_limited','audit_unavailable']);
const fail = code => { throw Object.assign(Error(code),{code}); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
function projection(data, operation, expected, now) {
  if (operation === C.ASSET) {
    const keys=['assetRef','kind','id','name',...(expected.kind === 'ad_account' ? ['accountStatus','currency','timezone'] : expected.kind === 'instagram_business' ? ['username'] : [])];
    if (!exact(data,keys) || data.assetRef !== expected.assetRef || data.kind !== expected.kind) fail('broker_response_invalid');
    try { return C.projectAsset({id:data.id,name:data.name,account_id:expected.id,account_status:data.accountStatus,
      currency:data.currency,timezone_name:data.timezone,username:data.username},expected); } catch { fail('broker_response_invalid'); }
  }
  const keys=['credentialValid','appId','subjectId','tokenType','expiresAt','dataAccessExpiresAt','verifiedAt','requiredScopes','assetAccessVerified'];
  if (!exact(data,keys) || data.credentialValid !== true || data.assetAccessVerified !== false || data.appId !== expected.appId || data.subjectId !== expected.subjectId
    || !['USER','SYSTEM_USER'].includes(data.tokenType) || !Number.isSafeInteger(data.verifiedAt) || Math.abs(data.verifiedAt-now)>60000
    || !Array.isArray(data.requiredScopes) || data.requiredScopes.slice().sort().join(',') !== C.requiredScopes(expected.kind).slice().sort().join(',')) fail('broker_response_invalid');
  for (const field of ['expiresAt','dataAccessExpiresAt']) if (data[field] !== null && (!Number.isSafeInteger(data[field]) || data[field] <= now)) fail('broker_response_invalid');
  return structuredClone(data);
}
function createMetaMarketingBrokerReader({ client, assertContext, now=Date.now }) {
  if (typeof client?.execute !== 'function' || typeof assertContext !== 'function') fail('broker_configuration_invalid');
  return { async read(context,operation,{authorize,timeoutMs=30000,requestId=randomUUID()}={}) {
    try {
      if (!C.OPERATIONS.includes(operation) || typeof authorize !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30000 || typeof requestId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) fail('invalid_request');
      const deadline=now()+timeoutMs;
      const before=await assertContext(context);await authorize(structuredClone(before));
      if(now()>=deadline)fail('broker_timeout');
      const response=await client.execute({requestId,operation,connectionRef:before.connectionRef,assetRef:before.assetRef,tenantRef:before.tenantRef,payload:{}},{timeoutMs:deadline-now()});
      const after=await assertContext(context);await authorize(structuredClone(after));
      if(now()>=deadline)fail('broker_timeout');
      if(response?.requestId!==requestId)fail('broker_response_invalid');
      return projection(response.data,operation,after,now());
    } catch(error) {fail(SAFE.has(error?.code)?error.code:'meta_broker_binding_invalid');}
  } };
}
function createConfiguredMetaMarketingClient({env=process.env,createClient=createIntegrationsBrokerClient}={}) {
  let client,configuration;
  function privateFile(filename) {
    const fs=require('node:fs'),path=require('node:path');let fd;
    try {
      if(typeof filename!=='string'||!path.isAbsolute(filename)||fs.realpathSync(filename)!==filename)fail('broker_configuration_invalid');
      fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.mode&0o077||stat.uid!==process.geteuid()||stat.size<1||stat.size>65536)fail('broker_configuration_invalid');
      return fs.readFileSync(fd);
    } catch {fail('broker_configuration_invalid');} finally {if(fd!==undefined)fs.closeSync(fd);}
  }
  return {execute(command,budget) {
    const current={origin:env.META_MARKETING_BROKER_ORIGIN,audience:env.META_MARKETING_BROKER_AUDIENCE,keyId:env.META_MARKETING_BROKER_KEY_ID,
      keyFile:env.META_MARKETING_BROKER_KEY_FILE,caFile:env.META_MARKETING_BROKER_CA_FILE};
    if(configuration&&JSON.stringify(configuration)!==JSON.stringify(current))fail('broker_configuration_invalid');
    if(!client){const key=privateFile(current.keyFile);try{client=createClient({origin:current.origin,audience:current.audience,keyId:current.keyId,
      privateKey:key,ca:privateFile(current.caFile),timeoutMs:30000});configuration=current;}finally{key.fill(0);}}
    return client.execute(command,budget);
  }};
}
function createMetaMarketingBroker(options) {
  const scope=createMetaMarketingBrokerScope(options);
  return {...scope,...createMetaMarketingBrokerReader({client:options.client,assertContext:scope.assertContext,...(options.now?{now:options.now}:{})})};
}
const client=createConfiguredMetaMarketingClient();
const modelServices=new WeakMap();
function forModels(models) {
  if(!models||typeof models!=='object')fail('broker_configuration_invalid');
  if(!modelServices.has(models))modelServices.set(models,createMetaMarketingBroker({client,...createMetaMarketingScopeRepository(()=>models)}));
  return modelServices.get(models);
}
module.exports={createMetaMarketingBrokerReader,createMetaMarketingBroker,createConfiguredMetaMarketingClient,forModels,projection};
