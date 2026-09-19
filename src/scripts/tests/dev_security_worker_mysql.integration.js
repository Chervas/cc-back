'use strict';
// Real DEV scheduler lanes, SQL leases/jobs, encrypted MFA outbox and session.
// Owned MySQL only; SES and audit transport are fictitious and externally blocked.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { DataTypes: D } = require('sequelize');
const { SESv2Client } = require('@aws-sdk/client-sesv2');
const dotenv = require.resolve('dotenv');
require.cache[dotenv] = { id: dotenv, filename: dotenv, loaded: true, exports: { config: () => ({ parsed: {} }) } };
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { fixture } = require('../../../services/platform-audit/test/fixture.cjs');
const { keyFor } = require('../../../services/platform-audit/src/event');
const { startSecurityLoops, createEmailPoller } = require('../dev-security-worker');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check, description) {
  const deadline = Date.now() + 8000;
  while (!await check()) { assert(Date.now() < deadline, description); await new Promise(r => setTimeout(r, 30)); }
}
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const keyFile = path.join(report.root, 'mfa.key'); fs.writeFileSync(keyFile, Buffer.alloc(32, 17), { mode: 0o600 });
  Object.assign(process.env, { JWT_SECRET: 'FICTITIOUS_WORKER_JWT_KEY', EMAIL_DATA_ENCRYPTION_KEY: 'FICTITIOUS_WORKER_EMAIL_KEY',
    EMAIL_PROVIDER: 'ses', EMAIL_ENABLED: 'true', EMAIL_REQUIRE_RECIPIENT_ALLOWLIST: 'true', EMAIL_RECIPIENT_ALLOWLIST: 'unused@example.invalid',
    EMAIL_AUTHENTICATION_RECIPIENT_POLICY: 'registered-account', EMAIL_AWS_ACCESS_KEY_ID: 'FICTITIOUS_KEY', EMAIL_AWS_SECRET_ACCESS_KEY: 'FICTITIOUS_SECRET',
    EMAIL_PUBLIC_APP_URL: 'http://localhost:4203', AUTH_EMAIL_MFA_KEY_FILE: keyFile, AUTH_EMAIL_MFA_MODE: 'enforce', AUTH_SESSION_MODE: 'enforce',
    PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1', DEV_SECURITY_WORKER: 'true',
    RUNTIME_ROLE: 'api', RUNTIME_NAMESPACE: 'dev', JOB_RUNTIME_NAMESPACE: 'dev', QUEUE_PREFIX: 'dev', JOBS_WORKER_ENABLED: 'false',
    DB_NAME: 'clinicaclick_dev_isolated', JOB_RUNTIME_NAMESPACE_ALIASES: '', JOB_RUNTIME_CLAIM_UNSCOPED: 'false' });
  // DB_NAME is only a policy input: the injected models remain on the owned socket.
  assert.equal(sql.config.database, 'campaign_optimization_qa'); models.Sequelize = require('sequelize');
  for (const [name, filename] of [['Usuario','usuario'],['EmailMessage','emailmessage'],['EmailSuppression','emailsuppression'],['JobRequest','jobrequest']]) {
    models[name] = require('../../../models/'+filename)(sql,D); await models[name].sync();
  }
  for (const name of ['20260912210000-create-platform-audit-events','20260912213000-create-platform-audit-delivery-states',
    '20260912220000-create-auth-sessions','20260913003000-add-platform-audit-result-part','20260913130000-create-auth-email-challenges',
    '20260914220000-create-auth-trusted-devices']) await require('../../../migrations/'+name).up(sql.getQueryInterface(),D);
  for (const [name,filename] of [['AuthSession','authsession'],['AuthEmailChallenge','authemailchallenge'],['AuthTrustedDevice','authtrusteddevice'],
    ['PlatformAuditEvent','platformauditevent'],['PlatformAuditDeliveryState','platformauditdeliverystate']]) models[name]=require('../../../models/'+filename)(sql,D);
  const repo = require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const stateFactory = () => require('../../services/platformAudit.monitor').createStateRepository(models);
  const { createDelivery } = require('../../services/platformAudit.delivery'), { createReconciliation } = require('../../services/platformAudit.reconciliation');
  const jobs = require('../../services/jobRequests.service'), delivery = require('../../services/emailDelivery.service');
  const challenges = require('../../services/authEmailChallenge.service'), C = require('../../services/authEmailChallenge.contract');
  const sessions = require('../../services/accessSession.service');
  const email = createEmailPoller({ jobs, model: models.EmailMessage, delivery });
  const sourceRoleArn = 'arn:aws:iam::137819318729:role/fictitious-audit-source';
  const writerEntered = deferred(), readerEntered = deferred(), writerRelease = deferred(), readerRelease = deferred();
  const metaEntered = deferred(), metaRelease = deferred(); let metaRuns = 0, metaClosing;
  const objects = new Map(), errors = []; let loops, writes = 0, reads = 0, sends = 0, offset = 0;
  const now = () => new Date(Date.now()+offset), originalSend = SESv2Client.prototype.send;
  SESv2Client.prototype.send = async () => ({ MessageId: 'FICTITIOUS_SES_'+(++sends) });
  const first = await repo.append(fixture({ occurredAt: now().toISOString() }));
  const old = await repo.append(fixture({ occurredAt: now().toISOString() }));
  await models.PlatformAuditEvent.update({state:'reconcile'}, {where:{event_id:old.event.eventId}});
  objects.set(keyFor(old), {key:keyFor(old),digest:old.digest,versionId:randomUUID()});
  const foreign = await models.JobRequest.create({type:'email_send',priority:'critical',payload:{email_message_id:999999,__runtime_namespace:'staging'}});
  const clinical = await models.JobRequest.create({type:'fictitious_clinical_job',priority:'critical',payload:{__runtime_namespace:'dev'}});
  const makeDelivery = write => createDelivery({repository:repo,state:stateFactory(),now,config:()=>({enabled:true,sourceRoleArn}),write});
  const write = async (_settings, rows) => ({version:1,results:rows.map(row=>{
    const key=keyFor(row);assert(!objects.has(key),'no duplicate object delivery');writes++;
    const receipt={key,digest:row.digest,versionId:randomUUID()};objects.set(key,receipt);
    return {eventId:row.event_id,digest:row.digest,status:'delivered',receipt};
  })});
  const slowWriter = makeDelivery(async (...args)=>{writerEntered.resolve();await writerRelease.promise;return write(...args);});
  const slowReader = createReconciliation({repository:repo,now,reader:{read:async()=>{reads++;readerEntered.resolve();await readerRelease.promise;throw Error('fictitious reader outage');}}});
  async function enqueue(index) {
    const user=await models.Usuario.create({nombre:'Fictitious',email_usuario:'worker'+index+'@example.invalid',password_usuario:'FICTITIOUS_HASH'});
    const challenge=await challenges.begin(user);
    const proof=await models.AuthEmailChallenge.findOne({where:{challenge_hash:C.challengeHash(challenge.challengeToken)}});
    const message=await models.EmailMessage.findByPk(proof.email_message_id);
    assert.equal((await models.JobRequest.findByPk(message.job_request_id)).payload.__runtime_namespace,'dev');
    return {user,challenge,message};
  }
  try {
    loops=startSecurityLoops({email,audit:()=>slowWriter.run(),reconcile:()=>slowReader.run(),onError:name=>errors.push(name),
      meta:{metaEnrollment:async closing=>{metaRuns++;metaClosing=closing;metaEntered.resolve();await metaRelease.promise;}}});
    await until(async()=>Boolean((await stateFactory().read())?.lease_token),'writer entered');
    await Promise.all([writerEntered.promise,readerEntered.promise,metaEntered.promise]);
    assert.equal((await makeDelivery(write).run()).reason,'audit_delivery_in_progress');
    assert.equal(await repo.claim(now(),'reconcile'),null);
    const begin=performance.now(),pending=await enqueue(1);
    await until(async()=>(await models.JobRequest.findByPk(pending.message.job_request_id)).status==='completed','MFA job must complete while both audit calls remain pending');
    report.mfaJobMs=performance.now()-begin;assert.equal(sends,1);assert.equal(writes,0);assert.equal(reads,1);
    const code=delivery.unsealSensitiveTemplateContext(pending.message.template_context,pending.message).verification_code;
    const authenticated=await challenges.verify(pending.challenge.challengeToken,code);
    assert.equal((await sessions.verify(authenticated.token)).userId,pending.user.id_usuario);
    report.checks.push('Actual SQL MFA challenge/outbox/job sends once and verifies a managed session while writer and reader remain unresolved; duplicate delivery lease and reconcile claim are denied');
    loops.stop();let drained=false;loops.done.then(()=>{drained=true;});await new Promise(r=>setImmediate(r));assert.equal(drained,false);
    writerRelease.resolve();readerRelease.resolve();await new Promise(r=>setImmediate(r));
    assert.equal(drained,false);assert.equal(metaClosing(),true);assert.equal(metaRuns,1);
    metaRelease.resolve();await loops.done;loops=null;
    report.checks.push('Actual encrypted MFA/outbox/session proceeds while Meta enrollment remains unresolved; stop also drains that lane without another run');
    assert.equal((await models.PlatformAuditEvent.findByPk(first.event.eventId)).state,'delivered');
    assert.equal((await models.PlatformAuditEvent.findByPk(old.event.eventId)).state,'reconcile');
    assert.equal(errors.filter(x=>x==='reconcile').length,1);
    report.checks.push('Shutdown waits for active calls, writer receipt persists, failed reader retains its original UUID and backoff without deletion');
    const uncertain=await enqueue(2);await uncertain.message.update({status:'sending'});
    const recovered=await enqueue(3);offset=6000;
    const reader=createReconciliation({repository:repo,now,reader:{read:async command=>{reads++;return {results:command.refs.map(ref=>({status:'verified',receipt:objects.get(ref.key)}))};}}});
    const resumed=makeDelivery(write);
    loops=startSecurityLoops({email,audit:()=>resumed.run(),reconcile:()=>reader.run(),onError:name=>errors.push(name)});
    await until(async()=>(await models.JobRequest.findByPk(recovered.message.job_request_id)).status==='completed'
      && (await models.PlatformAuditEvent.findByPk(old.event.eventId)).state==='delivered','restart recovers pending MFA and original audit receipt');
    loops.stop();await loops.done;loops=null;
    const unknownJob=await models.JobRequest.findByPk(uncertain.message.job_request_id);
    assert.equal(unknownJob.status,'failed');assert.equal(unknownJob.error_message,'email_delivery_outcome_unknown');
    assert.equal((await uncertain.message.reload()).status,'sending');assert.equal(sends,2);
    assert.equal((await foreign.reload()).status,'pending');assert.equal((await clinical.reload()).status,'pending');
    assert.equal(await models.PlatformAuditEvent.count({where:{state:'reconcile'}}),0);
    report.checks.push('New loop instances recover persisted pending work and reconcile the original receipt once; uncertain SES is never resent, staging and clinical jobs stay untouched');
    report.sesSends=sends;report.auditWrites=writes;report.auditReads=reads;report.externalCalls=0;report.realProvider=false;report.publicMfaAcceptance=false;
  } finally {
    loops?.stop();writerRelease.resolve();readerRelease.resolve();metaRelease.resolve();if(loops)await loops.done;SESv2Client.prototype.send=originalSend;
  }
}).catch(error=>{console.error(error.stack);process.exitCode=1;});
