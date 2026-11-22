'use strict';
// Disposable QA child only: no actual AWS or provider is constructed.
const fs=require('node:fs'),{randomUUID}=require('node:crypto');
const {allowPort}=require('./offline-guard.cjs'),{oauthSecretsFixture}=require('./google-oauth-fixture.cjs');
const {main}=require('../src/google-first-admission-main');
const [filename,applicationFile]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(filename)),application=JSON.parse(fs.readFileSync(applicationFile));
allowPort(config.port);const f=oauthSecretsFixture('google_analytics');
for(const slot of config.slots){
 const marker={version:1,provider:'google-first-empty-slot',connectionRef:'google-first:'+slot.service+':'+slot.scopeKey,scopeKey:slot.scopeKey,service:slot.service};
 f.state.records.set(slot.secretArn,new Map([[slot.baselineVersion,{body:JSON.stringify(marker),stages:new Set(['AWSCURRENT'])}]]));
 f.state.records.set(slot.clientSecretArn,new Map([[application.applicationVersion,{body:JSON.stringify(application.app),stages:new Set(['AWSCURRENT'])}]]));
}
main(filename,{awsFactory:async()=>({secrets:f.client,sink:{async write(row){return{versionId:randomUUID(),digest:row.digest};}},close(){}}),
 http(){throw Error('PROVIDER_FORBIDDEN_IN_DISPOSABLE_CHILD');}}).then(()=>process.send({ready:true})).catch(()=>{process.send({ready:false});process.exitCode=1;});
