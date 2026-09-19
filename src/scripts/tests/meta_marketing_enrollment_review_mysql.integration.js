'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const C=require('../../services/metaMarketingOAuth.contract');
withIsolatedCampaignMysql(async({sql,models,report})=>{
  for(const [name,file] of [['Clinica','clinica'],['GrupoClinica','grupoclinica'],['MetaConnection','MetaConecction'],
    ['MetaConnectionAssignment','metaconnectionassignment'],['MetaScopeBlock','metascopeblock'],['ClinicMetaAsset','ClinicMetaAsset'],
    ['MetaMarketingBrokerBinding','metamarketingbrokerbinding'],['MetaMarketingBrokerRevocation','metamarketingbrokerrevocation']]){
    models[name]=require('../../../models/'+file)(sql,D);for(const a of Object.values(models[name].rawAttributes))delete a.references;
    models[name].refreshAttributes();await models[name].sync();
  }
  const qi=sql.getQueryInterface(),migration=require('../../../migrations/20260919070000-meta-marketing-parent-identity-indexes');
  await migration.down(qi);await migration.up(qi);await migration.down(qi);await migration.up(qi);
  for(const [table,name] of [['MetaMarketingBrokerBindings','cc_meta_marketing_parent'],['MetaMarketingBrokerRevocations','cc_meta_revoke_parent']])
    assert((await qi.showIndex(table)).some(v=>v.name===name&&v.fields[0].attribute==='parent_page_id'));
  report.checks.push('Actual MySQL parent lookup indexes down/up/down/up; no new table or data rewrite');
  await models.GrupoClinica.bulkCreate([{id_grupo:5,nombre_grupo:'Grupo ficticio'},{id_grupo:6,nombre_grupo:'Otro grupo ficticio'}]);
  await models.Clinica.bulkCreate([59,71,88].map(id=>({id_clinica:id,nombre_clinica:'Clínica ficticia '+id,grupoClinicaId:id===88?6:5,estado_clinica:true})));
  const clock=new Date(),flowId=randomUUID(),scopes=['ads_read','instagram_basic','pages_read_engagement','pages_show_list','public_profile'];
  const metadata={versionId:flowId,digest:C.hash('FICTITIOUS_CANDIDATE'),appId:'101',subjectId:'201',tokenType:'USER',scopes,
    expiresAt:+clock+3600000,dataAccessExpiresAt:+clock+3600000,granularScopes:[]};
  const row={flow_id:flowId,state:'staged',scope_key:'group:5',clinic_ids:'[59,71]',app_id:'101',scopes:JSON.stringify(scopes),scope_digest:C.hash('FICTITIOUS_SCOPE'),candidate_metadata:JSON.stringify(metadata)};
  const assets=[{kind:'ad_account',id:'401',parentPageId:null,name:'Cuenta ficticia',accountStatus:1,currency:'EUR',timezone:'Europe/Madrid'},
    {kind:'facebook_page',id:'301',parentPageId:null,name:'Página ficticia'},{kind:'instagram_business',id:'501',parentPageId:'301',name:'Instagram ficticio',username:'fictitious_account'}]
    .map(a=>({assetRef:'meta-'+a.kind+':'+a.id,...a}));
  const inventory={flowId,candidateDigest:metadata.digest,scopeKey:row.scope_key,scopeDigest:row.scope_digest,clinicSetDigest:C.hash(row.clinic_ids),accessBlocked:true,expiresAt:+clock+300000,assets};
  const review=require('../../services/metaMarketingEnrollmentReview.service').createReview({models,now:()=>clock});
  let statements=[];sql.addHook('afterQuery',(_options,query)=>{if(query.sql)statements.push(query.sql);});
  const run=(r=row,i=inventory)=>sql.transaction({isolationLevel:'REPEATABLE READ'},t=>review({row:r,inventory:i},t));
  const allClear=v=>{assert.equal(v.reservationMade,false);assert.equal(v.scopeStatus,'clear');assert(v.assets.every(a=>a.status==='clear'));};
  const has=(v,ref,reason)=>assert(v.assets.find(a=>a.assetRef===ref)?.reasons.includes(reason));
  const binding=(id,ref,parent=null)=>({mapping_id:id,asset_ref:ref,parent_page_id:parent,meta_connection_id:99,meta_user_id:'999',app_id:'101',connection_ref:'meta:foreign',scope_key:'group:6',tenant_clinic_id:88,state:'blocked'});
  const revocation=(id,ref,parent=null)=>({tuple_hash:C.hash('FICTITIOUS_WITHDRAWAL_'+id),connection_ref:'meta:foreign:'+id,asset_ref:ref,parent_page_id:parent,tenant_clinic_id:88,meta_connection_id:99,meta_user_id:'999',
    app_id:'101',scope_key:'group:6',clinic_ids:'[88]',mapping_ids:'[999]',request_id:randomUUID(),actor_user_id:90001,requested_at:clock,next_attempt_at:clock,state:'confirmed'});
  for(const [name,forbidden] of [['MetaConnection',['accessToken']],['ClinicMetaAsset',['pageAccessToken','waAccessToken','additionalData']]])
    models[name].addHook('beforeFind','no-credential-materialization',options=>assert(options.attributes&&!options.attributes.some(a=>typeof a==='string'&&forbidden.includes(a))));
  allClear(await run());assert.equal((await models.MetaConnection.count()),0);assert.equal(await models.MetaConnectionAssignment.count(),0);
  await assert.rejects(review({row,inventory}),{code:'meta_oauth_unavailable'});
  await assert.rejects(run({...row,state:'cancelled'}),{code:'meta_oauth_unavailable'});
  await assert.rejects(run(row,{...inventory,candidateDigest:C.hash('OTHER_CANDIDATE')}),{code:'meta_oauth_unavailable'});
  await assert.rejects(run(row,{...inventory,expiresAt:+clock-1}),{code:'meta_oauth_unavailable'});
  report.checks.push('Unassigned inventory remains disconnected; requires live transaction, staged matching candidate/scope and nonexpired observation');

  const shared=await models.MetaConnection.create({id:2,userId:91002,metaUserId:'201',accessToken:'FICTITIOUS_SHARED_WA_SENTINEL'});
  await models.ClinicMetaAsset.create({id:10,metaConnectionId:2,clinicaId:59,assignmentScope:'clinic',assetType:'whatsapp_phone_number',metaAssetId:'701',waAccessToken:'FICTITIOUS_WA_SENTINEL',isActive:true});
  let result=await run();assert.deepEqual(result.scopeReasons,['identity_review']);assert(result.assets.every(a=>a.status==='review_required'));
  const [[preserved]]=await sql.query('SELECT accessToken FROM MetaConnections WHERE id=2');assert.equal(preserved.accessToken,'FICTITIOUS_SHARED_WA_SENTINEL');
  const [[wa]]=await sql.query('SELECT waAccessToken,isActive FROM ClinicMetaAssets WHERE id=10');assert.equal(wa.waAccessToken,'FICTITIOUS_WA_SENTINEL');assert.equal(wa.isActive,1);
  assert(!JSON.stringify(result).includes('SENTINEL'));assert(!JSON.stringify(result).includes('201'));
  await shared.update({accessToken:null,credentials_external:true,broker_app_id:'101'});allClear(await run());
  await shared.update({broker_app_id:'999'});assert((await run()).scopeReasons.includes('identity_review'));await shared.update({broker_app_id:'101'});
  const duplicate=await models.MetaConnection.create({id:3,userId:91003,metaUserId:'201',accessToken:null,credentials_external:true,broker_app_id:'101'});
  assert((await run()).scopeReasons.includes('identity_review'));await duplicate.destroy();
  report.checks.push('Shared legacy identity, incompatible app and duplicate subject require review; external identity accepted; actual WhatsApp token and active flag unchanged and never selected by reviewer');

  const grant=await models.MetaConnectionAssignment.create({scopeKey:'group:5',assignmentScope:'group',grupoClinicaId:5,metaConnectionId:2,status:'active'});allClear(await run());
  const direct=await models.MetaConnectionAssignment.create({scopeKey:'clinic:71',assignmentScope:'clinic',clinicaId:71,metaConnectionId:99,status:'active'});
  assert((await run()).scopeReasons.includes('scope_assignment_review'));await direct.destroy();
  await grant.update({status:'revoked'});assert((await run()).scopeReasons.includes('scope_assignment_review'));await grant.update({status:'active'});
  await grant.update({scopeKey:'clinic:71'});assert((await run()).scopeReasons.includes('scope_assignment_review'));await grant.update({scopeKey:'group:5'});
  const clinicRow={...row,scope_key:'clinic:59',clinic_ids:'[59]'},clinicInventory={...inventory,scopeKey:'clinic:59',clinicSetDigest:C.hash('[59]')};
  allClear(await run(clinicRow,clinicInventory));await grant.update({metaConnectionId:99});assert((await run(clinicRow,clinicInventory)).scopeReasons.includes('scope_assignment_review'));await grant.update({metaConnectionId:2});
  report.checks.push('Group and effective direct/inherited clinic grants checked; another identity, revoked grant or malformed scope cannot appear clear');

  for(const key of ['group:5','clinic:71','meta:group:5','meta:clinic:71']){
    const block=await models.MetaScopeBlock.create({scope_key:key,reason:'scope_disconnected',connection_id:2,actor_user_id:91002,created_at:clock});
    assert((await run()).scopeReasons.includes('scope_blocked'));await block.destroy();
  }
  await models.Clinica.update({grupoClinicaId:6},{where:{id_clinica:71}});await assert.rejects(run(),{code:'meta_oauth_unavailable'});await models.Clinica.update({grupoClinicaId:5},{where:{id_clinica:71}});
  report.checks.push('Universal and marketing-only group/member tombstones retained; changed group membership rejects the complete observation');

  for(const rawId of ['401','act_401']){
    const alias=await models.ClinicMetaAsset.create({metaConnectionId:99,clinicaId:88,assignmentScope:'clinic',assetType:'ad_account',metaAssetId:rawId,isActive:false,pageAccessToken:'FICTITIOUS_FORBIDDEN_SECRET'});
    result=await run();has(result,'meta-ad_account:401','asset_assigned');assert.equal(result.assets.find(a=>a.assetRef==='meta-instagram_business:501').status,'clear');await alias.destroy();
  }
  const parent=await models.ClinicMetaAsset.create({metaConnectionId:99,clinicaId:88,assignmentScope:'clinic',assetType:'facebook_page',metaAssetId:'301',isActive:false});
  result=await run();has(result,'meta-instagram_business:501','asset_assigned');has(result,'meta-facebook_page:301','asset_assigned');await parent.destroy();
  const orphan=await models.MetaMarketingBrokerBinding.create(binding(99,'meta-ad_account:401'));
  has(await run(),'meta-ad_account:401','asset_registered');await orphan.destroy();
  report.checks.push('Inactive/foreign numeric and act_ aliases, IG parent mappings and deleted-mapping registry records remain conflicts without leaking their clinical identity');

  const old=await models.MetaMarketingBrokerRevocation.create(revocation(1,'meta-ad_account:401'));
  has(await run(),'meta-ad_account:401','asset_revoked');await old.destroy();
  const otherIg=await models.MetaMarketingBrokerBinding.create(binding(101,'meta-instagram_business:999','301'));
  result=await run();has(result,'meta-facebook_page:301','asset_registered');has(result,'meta-instagram_business:501','asset_registered');assert(!JSON.stringify(result).includes('999'));await otherIg.destroy();
  const oldIg=await models.MetaMarketingBrokerRevocation.create(revocation(2,'meta-instagram_business:998','301'));
  result=await run();has(result,'meta-facebook_page:301','asset_revoked');has(result,'meta-instagram_business:501','asset_revoked');await oldIg.destroy();
  report.checks.push('Global withdrawal history and inverse Instagram-to-page relationships block both parent and selected IG, even for a different account and deleted aliases');

  const before=statements.length;models.MetaMarketingBrokerBinding.addHook('beforeFind','qa-review-failure',()=>{throw Error('FICTITIOUS_REGISTRY_FAILURE');});
  try{await assert.rejects(run(),/FICTITIOUS_REGISTRY_FAILURE/);}finally{models.MetaMarketingBrokerBinding.removeHook('beforeFind','qa-review-failure');}
  assert(statements.slice(before).some(v=>v.startsWith('ROLLBACK')));allClear(await run());
  report.checks.push('Registry read failure rejects complete review, rolls back and releases transaction; retry is read-only');

  let concurrent,timer;
  try{
    await sql.transaction({isolationLevel:'REPEATABLE READ'},async transaction=>{
      allClear(await review({row,inventory},transaction));
      // Another scope can record a withdrawal while this observation is still
      // open. A diagnostic must not hold physical identity/range locks.
      concurrent=await Promise.race([models.MetaMarketingBrokerRevocation.create(revocation(3,'meta-ad_account:401')),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('REVIEW_BLOCKED_WITHDRAWAL')),2000);})]);
      clearTimeout(timer);allClear(await review({row,inventory},transaction));
    });
    has(await run(),'meta-ad_account:401','asset_revoked');
  }finally{clearTimeout(timer);await concurrent?.destroy();}
  report.checks.push('Open diagnostic snapshot does not lock physical identity ranges or delay another scope withdrawal; the next observation sees the committed tombstone');

  await models.MetaMarketingBrokerRevocation.bulkCreate(Array.from({length:10000},(_,i)=>revocation(100+i,'meta-instagram_business:'+String(800000+i),String(900000+i))));
  await models.MetaMarketingBrokerBinding.bulkCreate(Array.from({length:10000},(_,i)=>binding(1000+i,'meta-instagram_business:'+String(800000+i),String(900000+i))));
  await sql.query('ANALYZE TABLE MetaMarketingBrokerBindings, MetaMarketingBrokerRevocations');
  // The largest allowed inventory is deliberately all IG: 500 distinct parents.
  const many={...inventory,assets:Array.from({length:500},(_,i)=>({...assets[2],id:String(10000+i),assetRef:'meta-instagram_business:'+String(10000+i),parentPageId:String(20000+i)}))};
  statements=[];let at=Date.now();allClear(await run());const small={queries:statements.length,elapsedMs:Date.now()-at};
  statements=[];at=Date.now();result=await run(row,many);allClear(result);const large={queries:statements.length,elapsedMs:Date.now()-at};
  const observed=statements.slice();assert.equal(large.queries,small.queries);assert(large.queries<=15);assert.equal(result.assets.length,500);
  const plans=[];
  for(const statement of observed.filter(v=>/^SELECT/.test(v)&&/FROM `MetaMarketingBroker(?:Bindings|Revocations)`/.test(v))){
    const [plan]=await sql.query('EXPLAIN '+statement);assert(plan.every(p=>p.type!=='ALL'&&p.key));plans.push(...plan.map(p=>({table:p.table,key:p.key,type:p.type,rows:p.rows})));
  }
  report.capacity={assets:500,historyRows:10000,bindingRows:10000,small,large,plans};
  report.checks.push('500 IG assets and 500 parents against 10000 bindings plus 10000 withdrawals: same query count as three assets; EXPLAIN uses indexes for both identity directions');
  // Review performed no write of any kind; all fixture mutations are outside run().
  assert(observed.every(v=>!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP)\b/.test(v)));
  report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};assert.deepEqual(report.pool,{inUse:0,waiting:0});
}).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
