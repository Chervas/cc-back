'use strict';
// Own --skip-networking MySQL only. Actual incident, delivery, panel and email
// outbox code; current-credential metadata and scheduler/transport adapters are
// closed fictitious doubles. No worker/provider send handler is executed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const {createRequire}=require('node:module'),{DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const policy=require('../../lib/metaMarketingCredentialAlerts'),notifier=require('../../services/metaMarketingCredentialNotifications.service');
function load(relative,overrides,env={}){
 const filename=path.resolve(__dirname,relative),actual=createRequire(filename),loaded={exports:{}};
 const safe=new Set(['crypto','sequelize','../lib/phone','../lib/metaMarketingCredentialAlerts','./emailTemplates.service']);
 const closed=name=>{if(Object.hasOwn(overrides,name))return overrides[name];if(safe.has(name))return actual(name);throw Error('UNEXPECTED_DEPENDENCY_IN_META_NOTIFICATION_QA');};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:closed,module:loaded,exports:loaded.exports,Buffer,Date,URL,process:{env},console},{filename});
 return loaded.exports;
}
withIsolatedCampaignMysql(async({sql,models,report})=>{
 for(const[name,file]of[['SystemNotificationIncident','systemnotificationincident'],['SystemNotificationDelivery','systemnotificationdelivery'],
  ['SystemNotificationSetting','systemnotificationsetting'],['Notification','notification'],['EmailMessage','emailmessage'],['JobRequest','jobrequest'],
  ['MetaMarketingEnrollmentRequest','metamarketingenrollmentrequest']]){
  models[name]=require('../../../models/'+file)(sql,D);for(const attribute of Object.values(models[name].rawAttributes))delete attribute.references;
  models[name].refreshAttributes();await models[name].sync();
 }
 models.Usuario=sql.define('Usuario',{id_usuario:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,email_usuario:D.STRING},{timestamps:false});await models.Usuario.sync();
 await models.Usuario.create({id_usuario:1,nombre:'Fictitious operator',email_usuario:'operator@example.invalid'});
 let clock=Date.parse('2030-01-01T12:00:00.000Z'),failQueue=false,providerCalls=0;
 const forbidden=()=>{providerCalls++;throw Error('PROVIDER_SEND_FORBIDDEN_IN_META_NOTIFICATION_QA');};
 const jobs={getCurrentRuntimeNamespace:()=> 'staging',enqueueJobRequest:async(input,{transaction})=>{
  if(failQueue)throw Error('FICTITIOUS_JOB_OUTBOX_FAILURE');return models.JobRequest.create({type:input.type,payload:input.payload,origin:input.origin,
   priority:input.priority||'normal',status:'pending',max_attempts:input.maxAttempts||3},{transaction});},
  enqueueUniqueJobRequest:async(input,options)=>({job:await jobs.enqueueJobRequest(input,options),created:true})};
 const envelope=require('../../lib/emailSensitiveEnvelope'),encryptionEnv={EMAIL_DATA_ENCRYPTION_KEY:'FICTITIOUS_META_NOTIFICATION_EMAIL_ENCRYPTION_KEY'};
 const email=load('../../services/emailDelivery.service.js',{'../../models':models,'./jobRequests.service':jobs,
  './emailProvider.service':{getConfig:()=>({provider:'mock',region:'eu-west-3',defaultFrom:'qa@example.invalid',defaultReplyTo:null}),mapStreamToConfigurationSet:()=> 'qa-transactional',send:forbidden},
  './emailRelatedState.service':{isAmbiguousProviderOutcome:()=>false,revokePendingPasswordResetToken:forbidden},
  '../lib/emailSensitiveEnvelope':{encryptEmailValue:(value,context)=>envelope.encryptEmailValue(value,context,{env:encryptionEnv}),decryptEmailValue:(value,context)=>envelope.decryptEmailValue(value,context,{env:encryptionEnv})},
  './authEmailRecipientPolicy.service':{jobPayload:(_template,id)=>({email_message_id:id})}});
 const system=load('../../services/systemNotifications.service.js',{'../../models':models,'../lib/metaQuarantineHttp':{get:forbidden,post:forbidden},
  '../lib/role-helpers':{ADMIN_USER_IDS:[1]},'./emailDelivery.service':email,'./jobRequests.service':jobs,'./whatsapp.service':{sendTemplate:forbidden},
  './whatsappAccountHealth.service':new Proxy({},{get:()=>forbidden}),'./notificationsRealtime.service':{emitNotificationCreated:()=>{}},'../lib/metaClient':{metaGet:forbidden}});
 await models.SystemNotificationSetting.create({scope:'global',enabled:true,panel_enabled:true,email_enabled:true,whatsapp_enabled:true,
  admin_email:'operator@example.invalid',admin_phone:'+34111111111',whatsapp_sender_asset_id:99,event_rules:JSON.parse(JSON.stringify(system.defaultEventRules()))});
 const id=randomUUID(),version=randomUUID(),scope='group:29',statuses=new Map(),maintenanceStatuses=new Map();
 const makeStatus=(epoch=0,versionId=version,health='healthy',lastError=null)=>{
  const expiresAt=clock+(epoch===0?3:60)*policy.DAY,observedAt=new Date(clock-1000).toISOString();
  return{enrollmentId:id,scopeKey:scope,clinicIds:[66,72],connectionId:172,appId:'101',subjectId:'201',actorUserId:1,epoch,versionId,
   expiresAt,dataAccessExpiresAt:null,expired:false,requiresRenewal:health==='permission_lost',lastError,healthKind:health,observedAt,
   tokenType:'SYSTEM_USER',issuerKind:'BISU',issuerBusinessId:'301',clientBusinessId:'301',configId:'401',unknownSince:null,lastHealthyAt:clock-1000,
   currentMetadata:{expiresAt,dataAccessExpiresAt:null,health,lastError,observedAt}};
 };
 const row={enrollment_id:id,flow_id:randomUUID(),session_ref:randomUUID(),prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID(),
  scope_key:scope,connection_ref:'meta:fixture',scope_digest:'a'.repeat(64),flow_digest:'b'.repeat(64),candidate_digest:'c'.repeat(64),assignment_digest:'d'.repeat(64),
  meta_user_id:'201',app_id:'101',clinic_ids:'[66,72]',assets:'[]',mapping_ids:'[]',meta_connection_id:172,actor_user_id:1,
  session_expires_at:new Date(clock+7200000),requested_at:new Date(clock-2000),updated_at:new Date(clock),next_attempt_at:new Date(clock),
  prepared_at:new Date(clock-1500),activated_at:new Date(clock-1000),selection_digest:'e'.repeat(64),state:'active'};
 await models.MetaMarketingEnrollmentRequest.create(row);statuses.set(id,makeStatus());
 const makeMaintenance=(value,extra={})=>({enrollmentId:id,epoch:value.epoch,versionId:value.versionId,mechanism:'business_api',automaticSupported:true,
  attemptState:'failed',humanReason:null,lastAttemptAt:clock-1000,nextAttemptAt:null,unknownSince:null,lastHealthyAt:clock-1000,...extra});
 const create=()=>notifier.createCredentialNotifications({models,queue:system.queueNotification,namespace:'staging',now:()=>clock,enabled:()=>true,
  channels:()=>['panel','email','whatsapp'],credentialStatus:async enrollment=>structuredClone(statuses.get(enrollment.enrollment_id)),
  maintenanceStatus:async enrollment=>structuredClone(maintenanceStatuses.get(enrollment.enrollment_id)||makeMaintenance(statuses.get(enrollment.enrollment_id)))});
 await Promise.all(Array.from({length:8},()=>create().run()));
 assert.equal(await models.SystemNotificationIncident.count(),1);assert.equal(await models.SystemNotificationDelivery.count(),2);assert.equal(await models.JobRequest.count(),2);
 assert.equal(await models.SystemNotificationDelivery.count({where:{channel:'whatsapp'}}),0);assert.equal(providerCalls,0);
 clock+=policy.DAY;await create().run();assert.equal(await models.SystemNotificationDelivery.count(),2);
 report.checks.push('Eight concurrent actual MySQL incident/outbox transactions and a later sweep create one panel/email pair, no daily reminder and no WhatsApp channel despite enabled settings');
 const deliveries=await models.SystemNotificationDelivery.findAll({order:[['id','ASC']]});
 for(const delivery of deliveries)await system.runDispatchJob({system_notification_delivery_id:delivery.id});
 for(const delivery of deliveries)await system.runDispatchJob({system_notification_delivery_id:delivery.id});
 assert.equal(await models.Notification.count(),1);assert.equal(await models.EmailMessage.count(),1);assert.equal(await models.JobRequest.count({where:{type:'email_send'}}),1);
 const panel=await models.Notification.findOne({raw:true}),message=await models.EmailMessage.findOne({raw:true});
 assert.equal(panel.data.link,policy.actionPath(scope));assert.equal(message.status,'queued');assert.equal(message.template_key,'ops.system_alert');
 assert.equal(message.metadata.contains_clinical_data,false);assert.equal(message.template_context.action_scope,scope);
 assert(!message.recipient_email_envelope.includes('operator@example.invalid'));
 assert.equal(envelope.decryptEmailValue(message.recipient_email_envelope,'message:'+message.public_id+':'+message.recipient_hash,{env:encryptionEnv}),'operator@example.invalid');
 const rendered=require('../../services/emailTemplates.service').renderTemplate(message.template_key,message.template_context);
 assert(rendered.html.includes('action=renew_meta'));assert(rendered.text.includes(policy.actionUrl(scope)));assert.equal(providerCalls,0);
 report.checks.push('Actual dispatch persists one scoped platform notice and the normal encrypted ops.system_alert EmailMessage plus email_send outbox job; repeat dispatch deduplicates and no email/Meta/WhatsApp send handler runs');
 clock+=3*policy.DAY;failQueue=true;
 const incomplete=await create().run();assert.equal(incomplete.incomplete,true);assert.equal(incomplete.failed,1);
 assert.equal(await models.SystemNotificationIncident.count(),1);assert.equal(await models.SystemNotificationDelivery.count(),2);assert.equal(await models.JobRequest.count(),3);
 failQueue=false;await create().run();assert.equal(await models.SystemNotificationIncident.count(),2);assert.equal(await models.SystemNotificationDelivery.count(),4);
 report.checks.push('Failed native job enqueue rolls back a newly expired incident, deliveries and jobs atomically; an explicit later sweep retries without consuming dedupe state');
 const temporary=makeStatus(1,randomUUID(),'temporary','rate_limited');statuses.set(id,temporary);await create().run();
 assert.equal(await models.SystemNotificationIncident.count({where:{state:'closed'}}),0);
 statuses.set(id,makeStatus(1,temporary.versionId));await create().run();await create().run();
 assert.equal(await models.SystemNotificationIncident.count({where:{state:'closed'}}),2);assert.equal(await models.SystemNotificationDelivery.count(),4);
 assert.equal(await models.SystemNotificationDelivery.count({where:{channel:'whatsapp'}}),0);assert.equal(providerCalls,0);
 report.checks.push('Temporary quota error cannot close incidents; confirmed healthy replacement closes prior incidents without a success notification or email job, preserving history and no WhatsApp delivery');
 const unknown=makeStatus(1,temporary.versionId,'temporary','provider_timeout');statuses.set(id,unknown);
 maintenanceStatuses.set(id,makeMaintenance(unknown,{unknownSince:clock-policy.UNKNOWN_MARGIN,lastHealthyAt:clock-policy.UNKNOWN_MARGIN-1000}));
 await create().run();assert.equal(await models.SystemNotificationDelivery.count(),6);
 const beforeRecoveredJobs=await models.JobRequest.count(),beforeRecoveredEmails=await models.EmailMessage.count();
 clock+=1000;statuses.set(id,makeStatus(1,temporary.versionId));maintenanceStatuses.set(id,makeMaintenance(statuses.get(id),{lastHealthyAt:clock}));
 await create().run();await create().run();assert.equal(await models.SystemNotificationIncident.count({where:{state:'closed'}}),3);
 assert.equal(await models.SystemNotificationDelivery.count(),6);assert.equal(await models.JobRequest.count(),beforeRecoveredJobs);assert.equal(await models.EmailMessage.count(),beforeRecoveredEmails);
 report.checks.push('Six-hour unknown supervision has a separate incident; a real newer healthy observation on the SAME version closes it transactionally with zero recovery deliveries, email messages or jobs');
 const success=makeStatus(1,temporary.versionId);success.expiresAt=clock+policy.DAY;success.currentMetadata.expiresAt=success.expiresAt;statuses.set(id,success);
 maintenanceStatuses.set(id,makeMaintenance(success,{attemptState:'succeeded',lastHealthyAt:clock}));
 await create().run();assert.equal(await models.SystemNotificationDelivery.count(),6);assert.equal(providerCalls,0);
 report.checks.push('Confirmed successful automatic maintenance within the calendar safety window generates no date-only email or panel outbox');
 report.scope={currentCredentialMetadata:'closed fictitious adapter; renewal authority tested separately',notificationEmailOutbox:'actual production modules/models and AES-GCM with fictitious key',scheduler:'closed SQL job adapter',providerSends:providerCalls,clinicalData:false};
 report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};assert.deepEqual(report.pool,{inUse:0,waiting:0});
}).catch(error=>{process.stderr.write('META_CREDENTIAL_NOTIFICATIONS_OWNED_MYSQL_FAILED '+String(error.code||error.name)+'\n');process.exitCode=1;});
