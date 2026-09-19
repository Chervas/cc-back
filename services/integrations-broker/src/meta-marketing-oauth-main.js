'use strict';
const path=require('node:path'),net=require('node:net'),{createPublicKey}=require('node:crypto');
const {fail}=require('./errors'),{validatePolicy}=require('./policy');
const {privateFile,connectAws,ACCOUNT,SECRET_KEY}=require('./google-main');
const {BrokerStore}=require('./store'),{Broker}=require('./broker'),{createServer}=require('./server');
const {drainAudit}=require('./audit'),tlsReload=require('./tls-reload');
const C=require('./meta-marketing-oauth-contract');
const D=require('./meta-marketing-discovery-contract');
const E=require('./meta-marketing-enrollment-contract');
const {createMetaMarketingEnrollment}=require('./meta-marketing-enrollment');
const {createMetaMarketingOAuthSecrets}=require('./meta-marketing-oauth-secrets');
const {createMetaMarketingOAuthHttp}=require('./meta-marketing-oauth-http');
const {createMetaMarketingOAuth,createMetaMarketingOAuthOperations}=require('./meta-marketing-oauth');
const prefix=environment=>`/clinicaclick/integrations/prod/meta-marketing/${environment}/`;
function validateConfig(config) {
  const fields=['cohort','enabled','environment','listenAddress','policy','port','stateFile','tlsCertFile','tlsKeyFile'];
  if (config && Object.hasOwn(config,'standby')) { fields.push('standby'); if(typeof config.standby!=='boolean')fail('invalid_request'); }
  if (config && Object.hasOwn(config,'assetDiscovery')) { fields.push('assetDiscovery'); if(typeof config.assetDiscovery!=='boolean')fail('invalid_request'); }
  if (config && Object.hasOwn(config,'assetEnrollment')) { fields.push('assetEnrollment'); if(typeof config.assetEnrollment!=='boolean'||config.assetEnrollment&&!config.assetDiscovery)fail('invalid_request'); }
  if (config?.tlsRenewal) { fields.push('tlsRenewal');tlsReload.validateSettings(config.tlsRenewal); }
  if (!config || Object.keys(config).sort().join(',')!==fields.sort().join(',') || config.enabled!==true || config.cohort!==C.COHORT
    || !['dev','staging'].includes(config.environment) || !net.isIP(config.listenAddress) || !Number.isInteger(config.port)
    || config.port<1024 || config.port>65535 || typeof config.stateFile!=='string' || !path.isAbsolute(config.stateFile)) fail('invalid_request');
  const policy=validatePolicy(config.policy),gateway=`gateway:${config.environment}:meta-marketing-oauth`,control=`control:${config.environment}:meta-marketing-oauth`;
  if (config.standby) {
    if (policy.principals.length || policy.connections.length || policy.grants.length) fail('invalid_request');
    return config;
  }
  const expected=config.assetEnrollment?Object.values(E.roles(config.environment)):[gateway,control];
  if (!policy.connections.length || policy.connections.length>64 || policy.principals.length!==expected.length
    || !expected.every(id=>policy.principals.some(p=>p.id===id)) || policy.principals.some(p=>p.maxPerMinute>20)) fail('invalid_request');
  const keys=policy.principals.map(p=>createPublicKey(p.publicKey).export({type:'spki',format:'der'}).toString('base64'));
  if (new Set(keys).size!==keys.length) fail('invalid_request');
  const slots=new Set(),apps=new Set(),scopes=new Set();
  for (const binding of policy.connections) {
    if (Object.keys(binding).sort().join(',')!=='clientSecretArn,connectionRef,expiresAt,initialState,metaMarketingOAuth,provider,secretArn') fail('invalid_request');
    const b=C.bindingFor(binding);
    if (slots.has(binding.secretArn) || scopes.has(b.scopeKey)) fail('invalid_request');
    slots.add(binding.secretArn);apps.add(binding.clientSecretArn);scopes.add(b.scopeKey);
    const base=`arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:${prefix(config.environment)}`;
    for (const arn of [binding.secretArn,binding.clientSecretArn]) if (!arn.startsWith(base) || arn.length>2048
      || !/^[A-Za-z0-9/_+=.@-]+$/.test(arn.slice(base.length))) fail('invalid_request');
    const grants=policy.grants.filter(g=>g.connectionRef===binding.connectionRef);
    if (grants.length!==2) fail('invalid_request');
    for (const principal of [gateway,control]) {
      const grant=grants.find(g=>g.principalId===principal),operations=principal===gateway?[...Object.values(C.OPERATIONS),...(config.assetDiscovery?[D.OPERATION]:[]),...(config.assetEnrollment?Object.values(E.OPERATIONS):[])]:[C.OPERATIONS.status,C.OPERATIONS.abort,...(config.assetEnrollment?[E.OPERATIONS.status,E.OPERATIONS.revoke]:[])];
      if (!grant || grant.tenantRef!=='clinic:'+b.clinicIds[0] || grant.assetRef!=='meta-enroll:'+b.scopeKey
        || JSON.stringify([...grant.operations].sort())!==JSON.stringify(operations.sort())) fail('invalid_request');
    }
  }
  if ([...slots].some(arn=>apps.has(arn))) fail('invalid_request');
  return config;
}
async function main(filename,{awsFactory=connectAws,http=createMetaMarketingOAuthHttp()}={}) {
  const config=validateConfig(JSON.parse(privateFile(filename))),cert=privateFile(config.tlsCertFile,65536),key=privateFile(config.tlsKeyFile,65536);
  const store=new BrokerStore(config.stateFile);let aws,oauth,enrollment,server,timer,draining;
  try {
    if(config.standby) {
      // This is installation before the first cohort, never a way to hide
      // existing authority, revocations, uncertain commands or undelivered audit.
      for(const {name} of store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
        const quoted='"'+name.replace(/"/g,'""')+'"';
        if(store.db.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get())fail('invalid_request');
      }
    }
    aws=await awsFactory();
    const secrets=createMetaMarketingOAuthSecrets({client:aws.secrets,accountId:ACCOUNT,prefix:prefix(config.environment),kmsKeyArn:SECRET_KEY});
    oauth=createMetaMarketingOAuth({store,policy:config.policy,secrets,http,assetDiscovery:config.assetDiscovery===true,onAbort:id=>enrollment?.abortFlow(id)});
    if(config.assetEnrollment)enrollment=createMetaMarketingEnrollment({store,secrets,http,environment:config.environment});
    const broker=new Broker({store,policy:config.policy,secrets,policyResolver:enrollment,operations:{...createMetaMarketingOAuthOperations(oauth,{assetDiscovery:config.assetDiscovery===true}),...enrollment?.operations}});
    const controlKeys=new Set(config.policy.principals.filter(p=>p.id.startsWith('control:')).map(p=>p.keyId));
    let ordinary=0,controls=0;
    server=createServer({async execute(...args) {
      const control=controlKeys.has(args[1]?.['x-broker-key-id']);
      if (control?controls>=1:ordinary>=2) fail('rate_limited');
      if (control) controls++;else ordinary++;
      try {return await broker.execute(...args);} finally {if(control) controls--;else ordinary--;}
    }},{cert,key});
    server.maxConnections=16;server.timeout=35000;tlsReload.install(server,config,{cert,key});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.listenAddress,resolve);});
    const tick=()=>{if(!draining)draining=drainAudit(store,aws.sink,{limit:20}).catch(()=>null).finally(()=>{draining=null;});};
    tick();timer=setInterval(tick,1000);timer.unref();let closing;
    const close=()=>closing||=(async()=>{clearInterval(timer);enrollment?.close();oauth.close();await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});await draining;aws.close();key.fill(0);store.close();})();
    return {server,store,broker,close};
  } catch(error) {clearInterval(timer);enrollment?.close();oauth?.close();server?.close();aws?.close();key.fill(0);store.close();throw error;}
}
if(require.main===module)main(process.argv[2]).then(runtime=>{
  const stop=()=>runtime.close().catch(()=>{process.exitCode=1;});process.once('SIGTERM',stop);process.once('SIGINT',stop);
}).catch(()=>{process.stderr.write('META_MARKETING_OAUTH_START_FAILED\n');process.exitCode=1;});
module.exports={main,validateConfig,prefix};
