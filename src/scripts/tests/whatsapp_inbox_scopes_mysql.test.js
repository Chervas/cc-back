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
