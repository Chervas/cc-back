'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{DataTypes:D}=require('sequelize');
const fs=require('node:fs'),path=require('node:path'),C=require('../../../services/metaMarketingEnrollment.contract');
module.exports=async({models,sql,sessions,service,begin,callback,cancel,latest,token,now,report,app,server,base,auditView,visualHostMounted})=>{
  await require('../../../../migrations/20260919080000-meta-marketing-enrollment-journal').up(sql.getQueryInterface());
  for(const [name,file] of [['MetaMarketingEnrollmentRequest','metamarketingenrollmentrequest'],['MetaMarketingEnrollmentClaim','metamarketingenrollmentclaim'],['MetaMarketingEnrollmentIdentity','metamarketingenrollmentidentity']])models[name]=require('../../../../models/'+file)(sql,D);
  const R=models.MetaMarketingEnrollmentRequest,P=models.MetaMarketingEnrollmentClaim,I=models.MetaMarketingEnrollmentIdentity;
  const claims=await sessions.verify(token()),input={scopeKey:'group:5',actorId:claims.userId,sessionRef:claims.jti,sessionExpiresAt:new Date(claims.exp*1000)};
  let enabled=true;const authority=require('../../../services/metaMarketingEnrollmentAuthority.service').createAuthority({models,sessions,oauth:service,now,enabled:()=>enabled});
  const flow=await service.begin(input);await callback(flow);assert.equal((await latest(flow.requestId)).state,'staged');
  const refs=['meta-ad_account:301','meta-instagram_business:501'];
  const reserve=selected=>authority.reserve(input,flow.requestId,selected||refs);
  const assertPending=row=>sql.transaction({isolationLevel:'REPEATABLE READ'},t=>authority.assertPending(row,t));
  const count=async()=>({requests:await R.count(),claims:await P.count(),identities:await I.count(),connections:await models.MetaConnection.count(),grants:await models.MetaConnectionAssignment.count(),mappings:await models.ClinicMetaAsset.count()});
  const before=await count();assert.deepEqual(before,{requests:0,claims:0,identities:0,connections:0,grants:0,mappings:0});
  const publicEvents=()=>models.PlatformAuditEvent.findAll({attributes:['body'],raw:true}).then(rows=>rows.map(r=>JSON.parse(r.body)).filter(v=>v.version===24));
  models.PlatformAuditEvent.addHook('beforeCreate','qa-enrollment-audit-failure',row=>{if(JSON.parse(row.body).version===24)throw Error('FICTITIOUS_ENROLLMENT_AUDIT_FAILURE');});
  try{await assert.rejects(reserve(),/FICTITIOUS_ENROLLMENT_AUDIT_FAILURE/);assert.deepEqual(await count(),before);assert.equal((await publicEvents()).length,0);}
  finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-enrollment-audit-failure');}
  report.checks.push('Selection uses actual authenticated OAuth inventory over HTTPS; failing human v24 append atomically rolls back new external identity, request and physical claims');

  const legacy=await models.MetaConnection.create({userId:91002,metaUserId:'201',accessToken:'FICTITIOUS_SHARED_WHATSAPP_TOKEN'});
  const wa=await models.ClinicMetaAsset.create({metaConnectionId:legacy.id,clinicaId:59,assignmentScope:'clinic',assetType:'whatsapp_phone_number',metaAssetId:'701',waAccessToken:'FICTITIOUS_WA_TOKEN',isActive:true});
  try{await assert.rejects(reserve(),{code:'meta_enrollment_identity_review'});await legacy.reload();await wa.reload();assert.equal(legacy.accessToken,'FICTITIOUS_SHARED_WHATSAPP_TOKEN');assert.equal(wa.waAccessToken,'FICTITIOUS_WA_TOKEN');assert.equal(wa.isActive,true);assert.equal(await I.count(),0);}
  finally{await wa.destroy();await legacy.destroy();}
  const alias=await models.ClinicMetaAsset.create({metaConnectionId:99,clinicaId:88,assignmentScope:'clinic',assetType:'ad_account',metaAssetId:'act_301',isActive:false});
  try{await assert.rejects(reserve(),{code:'meta_enrollment_asset_in_use'});}finally{await alias.destroy();}
  const binding=await models.MetaMarketingBrokerBinding.create({mapping_id:987,asset_ref:'meta-instagram_business:999',parent_page_id:'401',meta_connection_id:99,meta_user_id:'999',app_id:'101',connection_ref:'meta:foreign',scope_key:'group:6',tenant_clinic_id:88,state:'blocked'});
  try{await assert.rejects(reserve(),{code:'meta_enrollment_asset_in_use'});}finally{await binding.destroy();}
  const history=await models.MetaMarketingBrokerRevocation.create({tuple_hash:C.hash('FICTITIOUS_ENROLLMENT_PARENT_HISTORY'),connection_ref:'meta:foreign',asset_ref:'meta-instagram_business:998',parent_page_id:'401',tenant_clinic_id:88,
    meta_connection_id:99,meta_user_id:'999',app_id:'101',scope_key:'group:6',clinic_ids:'[88]',mapping_ids:'[997]',request_id:randomUUID(),actor_user_id:91002,requested_at:now(),next_attempt_at:now(),state:'confirmed'});
  try{await assert.rejects(reserve(),{code:'meta_enrollment_asset_revoked'});}finally{await history.destroy();}
  assert.deepEqual(await count(),before);
  report.checks.push('Legacy shared WhatsApp credentials unchanged; inactive act_ alias, foreign IG parent binding and independent withdrawal history deny reservation without new ownership');

  const role=(await models.UsuarioClinica.findOne({where:{id_clinica:71},raw:true})).rol_clinica;
  await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});
  try{await assert.rejects(reserve(),{httpStatus:403});}finally{await models.UsuarioClinica.update({rol_clinica:role},{where:{id_clinica:71}});}
  await assert.rejects(reserve(['meta-whatsapp_phone_number:701']),{code:'meta_enrollment_invalid'});
  await assert.rejects(reserve(['meta-ad_account:301','meta-ad_account:301']),{code:'meta_enrollment_invalid'});
  await assert.rejects(reserve(['meta-ad_account:999']),{code:'meta_enrollment_invalid'});
  enabled=false;try{await assert.rejects(reserve(),{code:'meta_enrollment_disabled'});}finally{enabled=true;}
  report.checks.push('Managed whole-group permission, closed typed selection, inventory membership and disabled enrollment gate deny new reservation');

  let statements=[];sql.addHook('afterQuery','qa-authority-sql',(_options,query)=>{if(query.sql)statements.push(query.sql);});
  const at=Date.now(),results=await Promise.all([reserve(),reserve()]);
  const saved=results[0];assert.equal(saved.enrollment_id,results[1].enrollment_id);assert.equal(saved.assets,results[1].assets);assert.equal(saved.state,'prepare_pending');
  assert.deepEqual(await count(),{requests:1,claims:3,identities:1,connections:1,grants:0,mappings:0});
  assert.equal((await publicEvents()).length,1);assert.equal((await publicEvents())[0].assetCount,2);
  assert.equal((await publicEvents())[0].clinicCount,2);assert.equal((await publicEvents())[0].subjectUserId,'91002');
  const [[audit]]=await sql.query("SELECT result_part FROM PlatformAuditEvents WHERE JSON_EXTRACT(body,'$.version')=24");assert.equal(Number(audit.result_part),1);
  report.enrollmentAuthority={concurrentReserveMs:Date.now()-at,queries:statements.length,selected:2,physicalClaims:3,clinics:2,brokerEnrollmentActivated:false};
  sql.removeHook('afterQuery','qa-authority-sql');
  for(const name of ['MetaConnection','ClinicMetaAsset'])assert(!statements.some(s=>/^SELECT/.test(s)&&new RegExp('`'+name+'`\\.`(?:accessToken|pageAccessToken|waAccessToken|additionalData)`').test(s)));
  await assertPending(saved);await assert.rejects(reserve(['meta-ad_account:301']),{code:'meta_enrollment_selection_fixed'});
  report.checks.push('Concurrent identical selection requests converge on one durable request/event and three claims for two assets; no local mapping, connection grant or broker activation; selection cannot be replaced');

  const unchanged=JSON.stringify(await R.findByPk(saved.enrollment_id,{raw:true}));
  await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});
  try{await assert.rejects(assertPending(saved),{httpStatus:403});}finally{await models.UsuarioClinica.update({rol_clinica:role},{where:{id_clinica:71}});}
  const group=await models.GrupoClinica.findByPk(5),oldPrimary=group.facebook_primary_asset_id;
  await group.update({facebook_primary_asset_id:987});try{await assert.rejects(assertPending(saved),{code:'meta_enrollment_scope_changed'});}finally{await group.update({facebook_primary_asset_id:oldPrimary});}
  const grant=await models.MetaConnectionAssignment.create({scopeKey:'clinic:71',assignmentScope:'clinic',clinicaId:71,metaConnectionId:99,status:'active'});
  try{await assert.rejects(assertPending(saved),{code:'meta_enrollment_assignment_review'});}finally{await grant.destroy();}
  const blocked=await models.MetaScopeBlock.create({scope_key:'group:5',reason:'scope_disconnected',connection_id:saved.meta_connection_id,actor_user_id:91002,created_at:now()});
  try{await assert.rejects(assertPending(saved),{code:'meta_enrollment_scope_blocked'});}finally{await blocked.destroy();}
  await assertPending(saved);assert.equal(JSON.stringify(await R.findByPk(saved.enrollment_id,{raw:true})),unchanged);assert.equal(await P.count(),3);
  report.checks.push('Pending authority rechecks original session/ACL, full group, primary policy, effective grants and universal block; failures leave request/ownership untouched');

  await cancel(flow);await assert.rejects(assertPending(saved),{code:'meta_enrollment_scope_changed'});assert.equal(await P.count(),3);
  report.checks.push('Source OAuth cancellation prevents use of a pending selection and preserves claims; enrollment cancellation worker integration remains pending');
  await auditView.verify(token());
  if(process.env.META_OAUTH_CRM_VISUAL==='1'){
    if(!visualHostMounted)await require('./meta_settings_visual_host.fixture')({app,server,token,groupMode:true});
    const output=path.join(report.root,'enrollment-authority-visual');fs.mkdirSync(output,{mode:0o700});
    const browser=await require('puppeteer-core').launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const errors=[],blocked=[],shots=[];try{
      const tab=await browser.newPage();await tab.setRequestInterception(true);tab.on('pageerror',e=>errors.push(e.message));
      tab.on('request',r=>{if(!r.url().startsWith(base+'/')&&!r.url().startsWith('data:')||!['GET','HEAD'].includes(r.method())){blocked.push(r.url().split('?')[0]);return r.abort();}r.continue();});
      for(const size of [{name:'desktop',width:1440,height:1050},{name:'mobile',width:390,height:844}]){
        await tab.setViewport(size);await tab.goto(base,{waitUntil:'networkidle0'});await tab.evaluate(value=>window.QA_TOKEN=value,auditView.token);await tab.click('#audit');
        await tab.waitForSelector('[data-qa="audit-meta-enrollment"]');await tab.$eval('[data-qa="audit-meta-enrollment"]',e=>{e.closest('details').open=true;e.scrollIntoView({block:'center'});});
        const text=await tab.$eval('body',e=>e.innerText);assert.match(text,/Selección guardada/);assert.match(text,/preparación y conexión siguen pendientes/);assert.match(text,/Clínicas: 2 · Activos: 2/);
        assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);const name=size.name+'-reservation-audit';await tab.screenshot({path:path.join(output,name+'.png')});shots.push(name);
      }
      assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);report.enrollmentAuthorityVisual={shots,errors,blocked,source:'Actual reserved SQL v24 event via audit writer/reader with fictitious S3, actual API and Angular Activity component; no selection UI or public MFA acceptance'};
    }finally{await browser.close();}
  }
};
