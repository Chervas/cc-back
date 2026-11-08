'use strict';
// Own mysqld/socket with --skip-networking, actual SQL transactions and signed
// broker/SQLite. All identities, provider responses and credentials are fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
if(process.env.META_MARKETING_LEGACY_RECOVERY_ENABLED!=='true')throw Error('Explicit test-only recovery opt-in required');
const checkedSources=['src/services/metaMarketingLegacyRecovery.service.js','src/services/metaScopeBlock.service.js',
  'src/services/metaMarketingOAuthScope.service.js','src/services/metaMarketingOAuth.service.js','src/services/metaMarketingEnrollmentAuthority.service.js',
  'src/services/metaMarketingEnrollmentBinding.service.js','src/services/metaMarketingBrokerScope.service.js','src/services/metaMarketingEnrollmentReview.service.js',
  'migrations/20261104123000-create-meta-marketing-recoveries.js','models/metamarketingrecovery.js','src/scripts/tests/meta_marketing_recovery_mysql.integration.js'];
const sourceHashes=()=>Object.fromEntries(checkedSources.map(file=>[file,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../../..',file))).digest('hex')]));
const initialSources=sourceHashes();
withIsolatedCampaignMysql(async({sql,models,report})=>{
  const cleanup=[];
  try{
    const {fixture,TOKEN,APP}=require('../../../services/integrations-broker/test/meta-marketing-oauth-fixture.cjs');
    const f=fixture({after:fn=>cleanup.push(fn)},{enrollment:true});
    const C=require('../../services/metaMarketingOAuth.contract'),E=require('../../services/metaMarketingEnrollment.contract');
    const B=require('../../../services/integrations-broker/src/meta-marketing-oauth-contract');
    const M=require('../../../services/integrations-broker/src/meta-marketing-contract');
    const G=require('../../services/metaMarketingLegacyRecovery.service');
    const now=()=>new Date(f.now()),advance=ms=>{f.state.clock+=ms;};
    for(const [name,file] of [['Usuario','usuario'],['Clinica','clinica'],['GrupoClinica','grupoclinica'],['AuthSession','authsession'],['AuthEmailChallenge','authemailchallenge'],
      ['PlatformAuditEvent','platformauditevent'],['MetaScopeBlock','metascopeblock'],['MetaMarketingBrokerRevocation','metamarketingbrokerrevocation'],
      ['MetaConnection','MetaConecction'],['MetaConnectionAssignment','metaconnectionassignment'],['ClinicMetaAsset','ClinicMetaAsset'],
      ['MetaMarketingBrokerBinding','metamarketingbrokerbinding'],['GroupAssetClinicAssignment','groupassetclinicassignment']]){
      models[name]=require('../../../models/'+file)(sql,D);
      for(const attr of Object.values(models[name].rawAttributes))delete attr.references;
      models[name].refreshAttributes();await models[name].sync();
    }
    await sql.query("ALTER TABLE MetaConnections ADD CONSTRAINT cc_meta_recovery_fixture_credentials CHECK ((credentials_external=0 AND broker_app_id IS NULL AND accessToken IS NOT NULL) OR (credentials_external=1 AND broker_app_id IS NOT NULL AND broker_app_id REGEXP '^[1-9][0-9]{0,29}$' AND accessToken IS NULL))");
    models.UsuarioClinica=sql.define('UsuarioClinica',{id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING},{timestamps:false});await models.UsuarioClinica.sync();
    const qi=sql.getQueryInterface();
    for(const file of ['20260919060000-meta-marketing-oauth','20260919080000-meta-marketing-enrollment-journal',
      '20260919100000-meta-marketing-enrollment-delivery-markers','20260919110000-meta-marketing-enrollment-due-index',
      '20260919120000-meta-marketing-enrollment-scope-latest'])await require('../../../migrations/'+file).up(qi);
    await require('../../../migrations/20261104123000-create-meta-marketing-recoveries').up(qi,D);
    const [recoveryColumns]=await sql.query("SELECT COLUMN_NAME,DATA_TYPE,DATETIME_PRECISION,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='MetaMarketingRecoveries'");
    const textColumn=recoveryColumns.find(column=>column.COLUMN_NAME==='snapshot');assert.equal(textColumn.DATA_TYPE,'longtext');assert.equal(textColumn.COLLATION_NAME,'utf8mb4_bin');
    assert.equal(Number(recoveryColumns.find(column=>column.COLUMN_NAME==='prepared_at').DATETIME_PRECISION),3);
    const recoveryIndexes=await qi.showIndex('MetaMarketingRecoveries');
    for(const column of ['flow_id','enrollment_id','canonical_connection_id'])assert(recoveryIndexes.some(index=>index.unique&&index.fields.length===1&&index.fields[0].attribute===column));
    const native=await require('../../lib/securitySchemaContract').snapshot(async(statement,parameters)=>(await sql.query(statement,{replacements:parameters}))[0]);
    const onlyRecovery=rows=>rows.filter(row=>row.TABLE_NAME==='MetaMarketingRecoveries');
    const schemaMetadata={migration:'20261104123000-create-meta-marketing-recoveries.js',migrationSha256:initialSources['migrations/20261104123000-create-meta-marketing-recoveries.js'],
      defaults:native.defaults,tables:onlyRecovery(native.tables),columns:onlyRecovery(native.columns),indexes:onlyRecovery(native.indexes),checks:onlyRecovery(native.checks),foreignKeys:onlyRecovery(native.foreignKeys)};
    report.schemaMetadataPath=path.join(report.root,'recovery-schema.native.json');
    fs.writeFileSync(report.schemaMetadataPath,JSON.stringify(schemaMetadata,null,2)+'\n',{mode:0o600});
    report.checks.push('Exact recovery migration creates real UTF8MB4 binary long-text storage, millisecond dates and unique flow/enrollment/canonical identities in owned MySQL');
    for(const [name,file] of [['MetaMarketingOAuthSlot','metamarketingoauthslot'],['MetaMarketingOAuthRequest','metamarketingoauthrequest'],
      ['MetaMarketingEnrollmentRequest','metamarketingenrollmentrequest'],['MetaMarketingEnrollmentClaim','metamarketingenrollmentclaim'],
      ['MetaMarketingEnrollmentIdentity','metamarketingenrollmentidentity'],['MetaMarketingRecovery','metamarketingrecovery']])models[name]=require('../../../models/'+file)(sql,D);
    await models.GrupoClinica.create({id_grupo:28,nombre_grupo:'Grupo de recuperación ficticio',ads_assignment_delimiter:'clínica'});
    await models.Clinica.bulkCreate([1,70].map(id=>({id_clinica:id,nombre_clinica:'Clínica ficticia '+id,grupoClinicaId:28,estado_clinica:true})));
    const actor=await models.Usuario.create({id_usuario:1,nombre:'Titular ficticio',email_usuario:'meta-recovery@example.invalid',password_usuario:'FICTITIOUS_PASSWORD_HASH'});
    const role=require('../../lib/role-helpers').MARKETING_WRITE_ROLES[0];
    await models.UsuarioClinica.bulkCreate([1,70].map(id_clinica=>({id_usuario:1,id_clinica,rol_clinica:role,estado_invitacion:'aceptada'})));
    const sessionSecret='FICTITIOUS_RECOVERY_SESSION_SIGNING';
    const sessions=require('../../services/accessSession.service').createService({models,now,config:()=>({mode:'enforce',ttl:3600,secret:sessionSecret})});
    const challenge=randomUUID(),at=new Date(Math.floor(f.now()/1000)*1000);
    await models.AuthEmailChallenge.create({challenge_id:challenge,user_id:1,challenge_hash:C.hash(challenge),code_hash:C.hash('fixture-code:'+challenge),
      credential_binding:require('../../services/accessSession.service').binding(actor,sessionSecret),email_hash:C.hash('fixture-email'),state:'verified',
      created_at:at,expires_at:new Date(+at+300000),absolute_expires_at:new Date(+at+300000),last_sent_at:at,verified_at:at});
    const token=(await sessions.authenticated(actor,{emailChallengeId:challenge})).body.token,claims=await sessions.verify(token);
    const input={scopeKey:'group:28',actorId:1,sessionRef:claims.jti,sessionExpiresAt:new Date(claims.exp*1000)};
    const LEGACY_TOKEN='FICTITIOUS_LEGACY_SHARED_META_TOKEN',PAGE_TOKEN='FICTITIOUS_IG_PAGE_TOKEN',WA_TOKEN='FICTITIOUS_SHARED_WA_TOKEN';
    await models.MetaConnection.create({id:158,userId:1,metaUserId:'201',accessToken:LEGACY_TOKEN,credentials_external:false,broker_app_id:null});
    await models.MetaConnectionAssignment.bulkCreate([
      {id:11,scopeKey:'clinic:1',assignmentScope:'clinic',clinicaId:1,grupoClinicaId:null,metaConnectionId:158,status:'disconnected'},
      {id:17,scopeKey:'group:28',assignmentScope:'group',clinicaId:null,grupoClinicaId:28,metaConnectionId:158,status:'active'},
    ]);
    await models.ClinicMetaAsset.bulkCreate([
      {id:359,metaConnectionId:158,assetType:'ad_account',metaAssetId:'act_301',assignmentScope:'group',clinicaId:1,grupoClinicaId:28,isActive:true,pageAccessToken:null,waAccessToken:null,additionalData:null},
      {id:360,metaConnectionId:158,assetType:'facebook_page',metaAssetId:'401',assignmentScope:'group',clinicaId:1,grupoClinicaId:28,isActive:false},
      {id:361,metaConnectionId:158,assetType:'instagram_business',metaAssetId:'501',assignmentScope:'group',clinicaId:1,grupoClinicaId:28,isActive:false,pageAccessToken:PAGE_TOKEN,waAccessToken:WA_TOKEN},
      ...Array.from({length:39},(_,i)=>({id:400+i,metaConnectionId:158,assetType:i%2?'whatsapp_phone_number':'whatsapp_business_account',metaAssetId:String(900000+i),
        assignmentScope:'clinic',clinicaId:i%2?1:70,grupoClinicaId:null,isActive:true,waAccessToken:WA_TOKEN})),
    ]);
    const initialBlock=await models.MetaScopeBlock.create({scope_key:'clinic:1',reason:'scope_disconnected',connection_id:158,actor_user_id:1,created_at:now()});
    const baseline=async()=>G.hash(G.encode({source:await models.MetaConnection.findByPk(158,{raw:true}),
      grants:await models.MetaConnectionAssignment.findAll({raw:true,order:[['id','ASC']]}),
      untouched:await models.ClinicMetaAsset.findAll({where:{id:{[require('sequelize').Op.ne]:359}},raw:true,order:[['id','ASC']]}),
      block:await models.MetaScopeBlock.findByPk('clinic:1',{raw:true})}));
    const preserved=await baseline();
    const mb=f.binding.metaMarketingOAuth;mb.scopeKey='group:28';mb.clinicIds=[1,70];mb.scopes.sort();
    for(const grant of f.policy.grants){grant.tenantRef='clinic:1';grant.assetRef='meta-enroll:group:28';}
    f.records.get(f.binding.secretArn).get(mb.slotVersionId).body=JSON.stringify({version:1,provider:'meta-marketing-oauth-slot',connectionRef:f.binding.connectionRef,
      scopeKey:mb.scopeKey,clinicSetDigest:B.clinicDigest(mb),appId:mb.appId});
    // Broker snapshots its policy at construction. Reconstruct the owned empty
    // fixture after setting this test's scope, before any OAuth request exists.
    f.restart();
    await models.MetaMarketingOAuthSlot.create({scope_key:mb.scopeKey,connection_ref:f.binding.connectionRef,asset_ref:'meta-enroll:'+mb.scopeKey,app_id:mb.appId,
      clinic_ids:'[1,70]',scopes:JSON.stringify(mb.scopes),redirect_uri:mb.redirectUri,expires_at:new Date(f.binding.expiresAt),state:'active'});
    const commands=[];
    const wire={execute:async command=>{
      commands.push({operation:command.operation,requestId:command.requestId});
      const control=[...Object.values(B.OPERATIONS).filter(op=>/\.(?:status|abort)\./.test(op)),E.E.OPERATIONS.status,E.E.OPERATIONS.revoke].includes(command.operation);
      const signed=f.signed(command,control);return f.current.broker.execute(signed.raw,signed.headers);
    }};
    const oauth=require('../../services/metaMarketingOAuth.service').createService({models,sessions,now,client:wire,enabled:()=>true,workerEnabled:()=>true,discoveryEnabled:()=>true,returnOrigin:'https://app.example.invalid'});
    await assert.rejects(oauth.begin(input),{code:'meta_oauth_scope_blocked'});assert.equal(commands.length,0);
    report.checks.push('Universal raw scope block denies the ordinary OAuth path before any signed broker operation');
    const guard=G.createRecovery({models,sessions,now,enabled:()=>true});
    const snapshot=await sql.transaction(t=>guard.captureSnapshot({scopeKey:'group:28',clinicIds:[1,70],sourceConnectionId:158,appId:'101',subjectId:'201',actorId:1,mappingIds:[359]},t));
    const snapshotText=G.encode(snapshot);assert(!snapshotText.includes(LEGACY_TOKEN));assert(!snapshotText.includes(PAGE_TOKEN));assert(!snapshotText.includes(WA_TOKEN));
    assert(snapshotText.includes('clínica'));
    assert.equal(snapshot.inventory.aliases.length,42);assert.equal(snapshot.inventory.blocks.length,1);
    const recoveryId=randomUUID();
    await models.MetaMarketingRecovery.create({recovery_id:recoveryId,scope_key:'group:28',clinic_ids:'[1,70]',app_id:'101',meta_user_id:'201',source_connection_id:158,
      canonical_connection_id:null,mapping_ids:'[359]',snapshot:snapshotText,snapshot_digest:G.hash(snapshotText),prepared_by_user_id:1,
      prepared_at:new Date(f.now()-1000),expires_at:new Date(f.now()+600000),state:'prepared',flow_id:null,candidate_digest:null,enrollment_id:null,bound_at:null,activated_at:null,retired_at:null});
    await models.MetaConnection.update({accessToken:LEGACY_TOKEN+'_CHANGED'},{where:{id:158},silent:true});
    await assert.rejects(oauth.begin(input));
    await models.MetaConnection.update({accessToken:LEGACY_TOKEN},{where:{id:158},silent:true});
    const flow=await oauth.begin(input);
    await oauth.callback({state:new URL(flow.authUrl).searchParams.get('state'),code:'FICTITIOUS_RECOVERY_CODE_'+flow.requestId});
    const storedFlow=await models.MetaMarketingOAuthRequest.findByPk(flow.requestId,{raw:true});assert.equal(storedFlow.state,'staged');
    const inventory=await oauth.assets(input,flow.requestId),review=inventory.assignmentReview;
    assert.equal(review.scopeStatus,'clear');assert.deepEqual(review.scopeReasons,[]);
    assert.equal(review.assets.find(a=>a.assetRef==='meta-ad_account:301').status,'clear');
    for(const ref of ['meta-facebook_page:401','meta-instagram_business:501']){
      const asset=review.assets.find(a=>a.assetRef===ref);assert.equal(asset.status,'review_required');assert(asset.reasons.includes('recovery_not_selected'));
    }
    report.checks.push('Actual managed email MFA and fresh signed OAuth candidate bind exactly one prepared generation; UI review enables only the pinned Ads alias');
    const enrollment=require('../../services/metaMarketingEnrollment.service').createService({models,sessions,oauth,now,client:wire,enabled:()=>true,workerEnabled:()=>true});
    const R=models.MetaMarketingEnrollmentRequest;
    await assert.rejects(enrollment.reserve(input,flow.requestId,['meta-facebook_page:401']),{code:'meta_enrollment_asset_in_use'});
    models.PlatformAuditEvent.addHook('beforeCreate','qa-recovery-reserve-failure',row=>{if(JSON.parse(row.body).reason==='meta_enrollment_requested')throw Error('FICTITIOUS_RECOVERY_AUDIT_FAILURE');});
    try{await assert.rejects(enrollment.reserve(input,flow.requestId,['meta-ad_account:301']),/FICTITIOUS_RECOVERY_AUDIT_FAILURE/);}
    finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-recovery-reserve-failure');}
    assert.equal(await R.count(),0);assert.equal(await models.MetaMarketingEnrollmentIdentity.count(),0);assert.equal(await models.MetaMarketingEnrollmentClaim.count(),0);
    assert.equal(await models.MetaConnection.count(),1);assert.equal((await models.MetaMarketingRecovery.findByPk(recoveryId)).canonical_connection_id,null);
    assert.equal(await baseline(),preserved);
    const reserved=await enrollment.reserve(input,flow.requestId,['meta-ad_account:301']),id=reserved.requestId;
    let row=await R.findByPk(id,{raw:true}),canonicalId=Number(row.meta_connection_id);
    assert.notEqual(canonicalId,158);const canonical=await models.MetaConnection.findByPk(canonicalId,{raw:true});
    assert.equal(canonical.userId,null);assert.equal(canonical.accessToken,null);assert.equal(Number(canonical.credentials_external),1);assert.equal(canonical.broker_app_id,'101');
    assert.equal(await baseline(),preserved);assert.equal(await models.ClinicMetaAsset.count(),42);
    assert.equal((await models.ClinicMetaAsset.findByPk(359)).metaConnectionId,158);
    report.checks.push('Reservation creates a separate clean canonical connection and one claim; a failed final audit rolls back canonical allocation, identity, enrollment and recovery CAS together');
    let outcome=await enrollment.run({enrollmentId:id});assert.equal(outcome.failed,0);row=await R.findByPk(id,{raw:true});assert.equal(row.state,'prepared');
    await enrollment.confirm(input,id,row.selection_digest);
    models.PlatformAuditEvent.addHook('beforeCreate','qa-recovery-activate-failure',event=>{if(JSON.parse(event.body).reason==='meta_enrollment_activated')throw Error('FICTITIOUS_RECOVERY_ACTIVATION_AUDIT_FAILURE');});
    try{outcome=await enrollment.run({enrollmentId:id});assert.equal(outcome.failed,1);}
    finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-recovery-activate-failure');}
    assert.equal((await R.findByPk(id)).state,'activate_pending');assert.equal((await models.MetaMarketingRecovery.findByPk(recoveryId)).state,'flow_bound');
    assert.equal((await models.ClinicMetaAsset.findByPk(359)).metaConnectionId,158);assert.equal(await models.MetaMarketingBrokerBinding.count(),0);
    assert.equal(await baseline(),preserved);advance(130000);
    outcome=await enrollment.run({enrollmentId:id});assert.equal(outcome.failed,0);
    row=await R.findByPk(id,{raw:true});assert.equal(row.state,'active');assert.equal(row.mapping_ids,'[359]');
    const adopted=await models.ClinicMetaAsset.findByPk(359,{raw:true});assert.equal(adopted.metaConnectionId,canonicalId);assert.equal(adopted.clinicaId,null);
    assert.equal(adopted.metaAssetId,'act_301');
    assert.equal(adopted.grupoClinicaId,28);assert.equal(Number(adopted.isActive),1);assert.equal(adopted.pageAccessToken,null);assert.equal(adopted.waAccessToken,null);assert.equal(adopted.additionalData,null);
    assert.equal(await models.ClinicMetaAsset.count(),42);assert.equal(await models.MetaMarketingBrokerBinding.count(),1);assert.equal(await baseline(),preserved);
    assert.equal(commands.filter(c=>c.operation===E.E.OPERATIONS.activate).length,1);
    const bindings=require('../../services/metaMarketingEnrollmentBinding.service').createBindings({models,sessions,now});
    const committed=()=>sql.transaction({isolationLevel:'REPEATABLE READ'},t=>bindings.committed(id,t));
    const proof=await committed();assert.equal(proof.recovery.recoveryId,recoveryId);assert.equal(proof.recovery.canonicalConnectionId,canonicalId);
    const repository=require('../../services/metaMarketingBrokerScope.service').createMetaMarketingScopeRepository(()=>models);
    let reads=0;
    const reader=require('../../services/metaMarketingBrokerReader.service').createMetaMarketingBroker({...repository,enabled:()=>true,
      client:{execute:async command=>{reads++;const signed=f.signed(command,'reader');return f.current.broker.execute(signed.raw,signed.headers);}}});
    const context=await reader.prepare(359),asset=await reader.read(context,M.ASSET,{authorize:async value=>assert.deepEqual(value.clinicIds,[1,70])});
    assert.equal(asset.id,'act_301');assert.equal(reads,1);
    report.checks.push('Lost final SQL audit rolls back adoption; status recovery commits the same original mapping ID with clean canonical identity, claims and active binding without replaying broker activation');
    report.checks.push('Full committed scope and configured metadata reader reach the actual signed broker/SQLite only through the recovered generation; generic grants and all source/WA data remain unchanged');
    const deny=async()=>{const n=reads;await assert.rejects(committed());await assert.rejects(reader.prepare(359));assert.equal(reads,n);};
    const extraBlock=await models.MetaScopeBlock.create({scope_key:'meta:clinic:70',reason:'scope_disconnected',connection_id:158,actor_user_id:1,created_at:now()});
    await deny();await extraBlock.destroy();await committed();
    const extraAlias=await models.ClinicMetaAsset.create({metaConnectionId:158,assetType:'ad_account',metaAssetId:'act_301',assignmentScope:'clinic',clinicaId:1,isActive:false});
    await deny();await extraAlias.destroy();await committed();
    const unrelated=await models.ClinicMetaAsset.create({metaConnectionId:158,assetType:'whatsapp_phone_number',metaAssetId:'999999',assignmentScope:'clinic',clinicaId:1,isActive:false});
    await committed();await unrelated.destroy();
    await models.MetaConnection.update({accessToken:LEGACY_TOKEN+'_CHANGED'},{where:{id:158},silent:true});await committed();
    await models.MetaConnection.update({accessToken:LEGACY_TOKEN},{where:{id:158},silent:true});await committed();
    await models.ClinicMetaAsset.update({pageAccessToken:PAGE_TOKEN+'_CHANGED',additionalData:{fixtureProfileCache:'unrelated update'}},{where:{id:361},silent:true});await committed();
    await models.ClinicMetaAsset.update({pageAccessToken:PAGE_TOKEN,additionalData:null},{where:{id:361},silent:true});await committed();
    await models.MetaConnection.update({accessToken:'FICTITIOUS_FORBIDDEN_CANONICAL',credentials_external:false,broker_app_id:null},{where:{id:canonicalId}});await deny();
    await models.MetaConnection.update({accessToken:null,credentials_external:true,broker_app_id:'101'},{where:{id:canonicalId}});await committed();
    report.checks.push('A new scope block, duplicate physical Ads alias or credential-bearing canonical row denies committed scope and reader; unrelated legacy/WhatsApp profile or token changes preserve the independent active Meta generation');
    await models.AuthSession.update({state:'revoked'},{where:{user_id:1}});advance(600001);
    await committed();const afterLogin=await reader.prepare(359);assert(afterLogin);
    for(const purpose of ['meta','whatsapp'])assert.equal(await require('../../services/metaScopeBlock.service').blocked({assignmentScope:'group',groupId:28,clinicId:null},{models,purpose}),true);
    assert.equal(await baseline(),preserved);assert.equal((await initialBlock.reload()).scope_key,'clinic:1');
    report.checks.push('Confirmed generation remains valid after preparation expiry and origin logout; original universal block still denies ordinary Meta and WhatsApp routes');
    models.PlatformAuditEvent.addHook('beforeCreate','qa-recovery-disconnect-audit-failure',event=>{if(JSON.parse(event.body).version===14)throw Error('FICTITIOUS_RECOVERY_DISCONNECT_AUDIT_FAILURE');});
    const block=require('../../services/metaScopeBlock.service'),retireArgs={scope:{assignmentScope:'clinic',clinicId:1,groupId:null},connectionId:158,actorId:1,clinicIds:[1],models};
    const retirement=async()=>{const preparedContext=await block.prepareRetirement(retireArgs);return sql.transaction(async transaction=>{await block.lockRetirement(preparedContext,transaction,{models});await block.validateRetirement(preparedContext,transaction,{models});return block.preserve({...retireArgs,transaction,preparedContext});});};
    try{await assert.rejects(retirement(),/FICTITIOUS_RECOVERY_DISCONNECT_AUDIT_FAILURE/);}
    finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-recovery-disconnect-audit-failure');}
    assert.equal((await models.MetaMarketingRecovery.findByPk(recoveryId)).state,'active');assert.equal((await R.findByPk(id)).state,'active');
    assert.equal((await models.MetaMarketingBrokerBinding.findByPk(359)).state,'active');assert.equal(Number((await models.ClinicMetaAsset.findByPk(359)).isActive),1);
    await committed();assert.equal(await baseline(),preserved);
    report.checks.push('Failure of the native disconnect audit rolls back generation retirement, pending withdrawal, binding block and mapping deactivation together');
    await retirement();
    assert.equal((await models.MetaMarketingRecovery.findByPk(recoveryId)).state,'retired');
    assert.equal((await R.findByPk(id)).state,'revoke_pending');assert.equal((await models.MetaMarketingBrokerBinding.findByPk(359)).state,'blocked');
    await deny();assert.equal((await initialBlock.reload()).scope_key,'clinic:1');assert.equal(await baseline(),preserved);
    report.checks.push('Repeating the existing universal disconnect retires the generation and its binding atomically even when no tombstone field changes; it cannot replay the old recovery proof');
    const serialized=JSON.stringify(await models.MetaMarketingRecovery.findAll({raw:true}));
    for(const hidden of [TOKEN,APP,LEGACY_TOKEN,PAGE_TOKEN,WA_TOKEN])assert(!serialized.includes(hidden));
    report.recovery={legacyAliases:42,adoptedAliases:1,preservedMappingId:359,canonicalConnectionAllocated:true,genericGrantsUnchanged:true,
      sourceAndWhatsappUnchanged:true,fullScope:[1,70],signedBroker:true,realProvider:false};
    report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};assert.deepEqual(report.pool,{inUse:0,waiting:0});
    assert.deepEqual(sourceHashes(),initialSources,'Reviewed sources changed while the isolated integration was running');report.sourceSha256=initialSources;
  }catch(error){
    fs.writeFileSync(path.join(report.root,'recovery-failure.private.json'),JSON.stringify({message:error.message,code:error.original?.code||error.code||null,stack:error.stack},null,2),{mode:0o600});
    throw Object.assign(Error('meta_recovery_sql_integration_failed_consult_private_evidence'),{code:'META_RECOVERY_FIXTURE_FAILED'});
  }finally{for(const close of cleanup.reverse())await close();}
}).catch(()=>{process.stderr.write('META_RECOVERY_ISOLATED_MYSQL_TEST_FAILED\n');process.exitCode=1;});
