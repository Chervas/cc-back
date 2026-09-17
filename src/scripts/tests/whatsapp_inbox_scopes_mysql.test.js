'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {SCHEMA,importLease}=require('../../lib/whatsappInboxImport');const S=require('../../lib/whatsappInboxScopes');
test('multiclinic passive importer preserves parent on partial failure, retries children once and blocks ownership drift',async()=>{
 await withIsolatedCampaignMysql(async({sql,report})=>{
  await sql.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY,grupoClinicaId INT)');await sql.query('INSERT INTO Clinicas VALUES(71,9),(72,9)');
  await sql.query('CREATE TABLE ClinicMetaAssets(id INT PRIMARY KEY,assignmentScope VARCHAR(20),clinicaId INT,grupoClinicaId INT,assetType VARCHAR(40),phoneNumberId VARCHAR(30),wabaId VARCHAR(30))');
  await sql.query("INSERT INTO ClinicMetaAssets VALUES(81,'clinic',71,NULL,'whatsapp_phone_number','201','101'),(82,'clinic',72,NULL,'whatsapp_phone_number','202','102'),(83,'group',NULL,9,'whatsapp_phone_number','203','103')");
  await sql.query('CREATE TABLE PatientDirectionSettings(clinic_id INT,director_phone_asset_id INT)');await sql.query('CREATE TABLE MetaScopeBlocks(scope_key VARCHAR(100) PRIMARY KEY)');
  await sql.query("CREATE TABLE Conversations(id INT PRIMARY KEY AUTO_INCREMENT,clinic_id INT,channel VARCHAR(20),contact_id VARCHAR(32),unread_count INT,last_message_at DATETIME(3),last_inbound_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))");
  await sql.query("CREATE TABLE Messages(id INT PRIMARY KEY AUTO_INCREMENT,conversation_id INT,direction VARCHAR(20),content TEXT,message_type VARCHAR(20),status VARCHAR(20),metadata JSON,sent_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))");
  for(const ddl of SCHEMA)await sql.query(ddl);const rawConnection=await sql.connectionManager.getConnection();const c=rawConnection.promise();
  const config={version:1,scopes:[{assetId:81,wabaId:'101',phoneId:'201',clinicIds:[71]},{assetId:82,wabaId:'102',phoneId:'202',clinicIds:[72]}]};
  const m=(id,from)=>({id:'wamid.'+id,from,timestamp:'1789430400',type:'text',text:{body:'FICTITIOUS PASSIVE TEXT'}});
  const make=(scopes=config.scopes,peer='19995550101')=>({receipt:randomUUID(),lease:randomUUID(),automaticActionsAllowed:false,scopeBindings:scopes.map(({assetId,...s})=>s),raw:Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:scopes.map((s,i)=>({id:s.wabaId,changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:s.phoneId},messages:[m('message'+i,peer)]}}]}))}))});
  const count=async table=>(await sql.query('SELECT COUNT(*) n FROM '+table))[0][0].n;
  try{
   await sql.query("CREATE USER 'inbox_metadata_only'@'localhost' IDENTIFIED BY 'FICTITIOUS_Metadata_Only_2026!'");
   await sql.query("GRANT SELECT (id,assignmentScope,clinicaId,grupoClinicaId,assetType,phoneNumberId,wabaId) ON campaign_optimization_qa.ClinicMetaAssets TO 'inbox_metadata_only'@'localhost'");
   await sql.query("GRANT SELECT (id_clinica,grupoClinicaId) ON campaign_optimization_qa.Clinicas TO 'inbox_metadata_only'@'localhost'");
   await sql.query("GRANT SELECT (clinic_id,director_phone_asset_id) ON campaign_optimization_qa.PatientDirectionSettings TO 'inbox_metadata_only'@'localhost'");
   await sql.query("GRANT SELECT (scope_key) ON campaign_optimization_qa.MetaScopeBlocks TO 'inbox_metadata_only'@'localhost'");
   const readOnly=await require('mysql2/promise').createConnection({socketPath:sql.options.dialectOptions.socketPath,database:'campaign_optimization_qa',user:'inbox_metadata_only',password:'FICTITIOUS_Metadata_Only_2026!'});
   try{await readOnly.beginTransaction();await S.assertScope(readOnly,config.scopes[0],{lock:true});await readOnly.rollback();}
   finally{await readOnly.end();}
   await sql.query("CREATE USER 'inbox_importer_only'@'localhost' IDENTIFIED BY 'FICTITIOUS_Importer_Only_2026!'");
   for(const table of ['Conversations','Messages'])await sql.query("GRANT SELECT,INSERT,UPDATE ON campaign_optimization_qa."+table+" TO 'inbox_importer_only'@'localhost'");
   for(const table of ['WhatsappInboxImports','WhatsappInboxMessageKeys','WhatsappInboxContactKeys'])await sql.query("GRANT SELECT,INSERT ON campaign_optimization_qa."+table+" TO 'inbox_importer_only'@'localhost'");
   await sql.query("GRANT SELECT (id,assignmentScope,clinicaId,grupoClinicaId,assetType,phoneNumberId,wabaId) ON campaign_optimization_qa.ClinicMetaAssets TO 'inbox_importer_only'@'localhost'");
   await sql.query("GRANT SELECT ON campaign_optimization_qa.Clinicas TO 'inbox_importer_only'@'localhost'");
   await sql.query("GRANT SELECT (clinic_id,director_phone_asset_id) ON campaign_optimization_qa.PatientDirectionSettings TO 'inbox_importer_only'@'localhost'");
   await sql.query("GRANT SELECT (scope_key) ON campaign_optimization_qa.MetaScopeBlocks TO 'inbox_importer_only'@'localhost'");
   const restricted=await require('mysql2/promise').createConnection({socketPath:sql.options.dialectOptions.socketPath,database:'campaign_optimization_qa',user:'inbox_importer_only',password:'FICTITIOUS_Importer_Only_2026!'});
   try{
    const packet=make(undefined,'19995550117');await S.importScopedLease(restricted,packet,config);await S.importScopedLease(restricted,packet,config);
    assert.equal(await count('Messages'),2);assert.equal(await count('WhatsappInboxImports'),2);
    const legacy=make([config.scopes[0]],'19995550118');const legacyBody=JSON.parse(legacy.raw);legacyBody.entry[0].changes[0].value.messages[0].id='wamid.legacy_permission';legacy.raw=Buffer.from(JSON.stringify(legacyBody));await importLease(restricted,legacy,{clinicId:71,wabaId:'101',phoneId:'201'});assert.equal(await count('Messages'),3);
    // Exercise the actual scoped consumer path with its restricted DB grants,
    // including mobile echoes. Testing the single-clinic parser alone missed
    // a deployed consumer that still discarded new attachment references.
    const attachments=make(undefined,'19995550119');const body=JSON.parse(attachments.raw);
    body.entry[0].changes[0].value.messages=[{...m('scoped_image','19995550119'),type:'image',image:{id:'501',mime_type:'image/jpeg'}}];
    body.entry[1].changes=[{field:'smb_message_echoes',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'202'},
      message_echoes:[{...m('scoped_audio','19995559999'),to:'19995550119',type:'audio',audio:{id:'502',mime_type:'audio/ogg; codecs=opus',voice:true}}]}}];
    attachments.raw=Buffer.from(JSON.stringify(body));
    await S.importScopedLease(restricted,attachments,config);await S.importScopedLease(restricted,attachments,config);
    const [media]=await sql.query("SELECT c.clinic_id,m.direction,m.message_type,m.metadata FROM Messages m JOIN Conversations c ON c.id=m.conversation_id WHERE JSON_CONTAINS_PATH(m.metadata,'one','$.media.id') ORDER BY c.clinic_id");
    assert.equal(media.length,2);assert.equal(await count('Messages'),5);
    assert.deepEqual(media.map(r=>[r.clinic_id,r.direction,r.message_type,r.metadata.media.kind,r.metadata.media.id]),
      [[71,'inbound','image','image','501'],[72,'outbound','text','audio','502']]);
    for(const r of media){assert.equal(r.metadata.automatic_actions_allowed,false);assert.equal(r.metadata.passive_recovery,true);}
    assert.equal(media[1].metadata.audio_transcribed,false);assert.equal(media[1].metadata.media.playable,true);
    report.checks.push('scoped image and mobile audio preserve media IDs under consumer grants without duplicate import');
   }finally{await restricted.end();}
   // The rest exercises failure/replay independently of the privilege check.
   for(const table of ['WhatsappInboxImports','WhatsappInboxMessageKeys','WhatsappInboxContactKeys','Messages','Conversations'])await sql.query('DELETE FROM '+table);
   const lease=make();let calls=0;await assert.rejects(S.importScopedLease(c,lease,config,{importer:async(...args)=>{if(++calls===2)throw Error('synthetic interruption');return importLease(...args);}}),/synthetic interruption/);
   assert.equal(await count('Messages'),1);assert.equal(await count('WhatsappInboxImports'),1);
   const complete=await S.importScopedLease(c,lease,config);assert.equal(await count('Messages'),2);assert.equal(await count('WhatsappInboxImports'),2);
   assert.equal((await S.importScopedLease(c,lease,config)).importReceipt,complete.importReceipt);assert.equal(await count('Messages'),2);
   const routes=(await sql.query('SELECT clinic_id,COUNT(*) n FROM Conversations GROUP BY clinic_id ORDER BY clinic_id'))[0];assert.deepEqual(routes.map(r=>[r.clinic_id,r.n]),[[71,1],[72,1]]);
   await sql.query("INSERT INTO MetaScopeBlocks VALUES('group:9')");await assert.rejects(S.importScopedLease(c,make(),config),/review_required/);assert.equal(await count('Messages'),2);await sql.query('DELETE FROM MetaScopeBlocks');
   await sql.query('UPDATE ClinicMetaAssets SET clinicaId=72 WHERE id=81');await assert.rejects(S.importScopedLease(c,make(),config),/review_required/);await sql.query('UPDATE ClinicMetaAssets SET clinicaId=71 WHERE id=81');
   const mismatched=make();mismatched.scopeBindings[0].clinicIds=[72];await assert.rejects(S.importScopedLease(c,mismatched,config),/review_required/);
   const unknown=make();const raw=JSON.parse(unknown.raw);raw.entry[1].changes[0].field='smb_app_state_sync';unknown.raw=Buffer.from(JSON.stringify(raw));await assert.rejects(S.importScopedLease(c,unknown,config),/review_required/);assert.equal(await count('Messages'),2);
   const changed=structuredClone(config);changed.scopes[0].assetId=999;await assert.rejects(S.importScopedLease(c,make(),config,{loadConfiguration:()=>changed}),/review_required/);assert.equal(await count('Messages'),2);
   const precommit=make(undefined,'19995550108');let checks=0;
   await assert.rejects(S.importScopedLease(c,precommit,config,{importer:(connection,child,scope,now,options)=>importLease(connection,child,scope,now,{validateScope:async tx=>{
    await options.validateScope(tx);if(++checks===2)throw Error('synthetic scope changed before commit');
   }})}),/review_required/);assert.equal(await count('Messages'),2);assert.equal(await count('WhatsappInboxImports'),2);
   const grouped={version:1,scopes:[{assetId:83,wabaId:'103',phoneId:'203',clinicIds:[71,72]}]};
   await assert.rejects(S.importScopedLease(c,make(grouped.scopes),grouped),/review_required/); // Same contact exists in both clinics.
   await assert.rejects(S.importScopedLease(c,make(grouped.scopes,'19995550109'),grouped),/review_required/); // No arbitrary first-clinic routing.
   await sql.query("INSERT INTO Conversations(clinic_id,channel,contact_id,unread_count,createdAt,updatedAt) VALUES(72,'whatsapp','19995550109',0,NOW(3),NOW(3))");
   await S.importScopedLease(c,make(grouped.scopes,'19995550109'),grouped);assert.equal(await count('Messages'),3);
   report.checks.push('metadata-only ownership queries','exact clinic/group membership','durable group block','child receipts after partial failure','parent only after all children','retry idempotency','unknown events held','shared-phone unique conversation routing','configuration snapshot drift');
  }finally{await sql.connectionManager.releaseConnection(rawConnection);}
 });
});
