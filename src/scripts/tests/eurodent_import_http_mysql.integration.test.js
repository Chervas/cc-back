'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {digest}=require('../../lib/eurodent-import/bundle');
const {captureImport,applyImport}=require('../../lib/eurodent-import/store');
const sourceRow=(table,record,catalog)=>({source_database:'datos/EDD00001.MDB',source_table:table,source_pk:{ID:record.ID},source_ordinal:Number(record.ID),row_sha256:digest(record),database_sha256:'a'.repeat(64),record,...(catalog?{catalog}:{})});
function sourceBundle(){
  const treatment={ID:'1','Código':'FICT',Nombre:'TESTONLY Restauración',Familia:'9',Grafico:'1',Precio_euro:'99731.23'},family={ID:'9',Familia:'Conservadora'},catalog={source_id:'1',code:'FICT',name:treatment.Nombre,family_id:'9',family_name:family.Familia,graphic:'1'};
  const bundle={version:'eurodent_patient_bundle/1',source_system:'eurodent',source_instance:'testonly-eurodent-http',source_zip_sha256:'d'.repeat(64),source_inventory_sha256:'b'.repeat(64),intake_sha256:'c'.repeat(64),source_export_date:'2026-10-09',
    context:{Tratamiento:[sourceRow('Tratamiento',treatment)],FamTrat:[sourceRow('FamTrat',family)],Doctor:[sourceRow('Doctor',{ID:'1',Nombre:'TESTONLY PRIVATE DOCTOR PAYLOAD',Nif:'TESTONLY PRIVATE NIF'})]},
    operational_effects:{appointments:false,payments:false,debt:false,messages:false,clinical_reference_update:false,current_treatment_execution:false},patients:[]};
  for(let n=1;n<=50;n++){
    const id=String(n);bundle.patients.push({source_patient_id:id,records:[
      sourceRow('Paciente',{ID:id,Nombre:`TESTONLY PATIENT ${n}`,Foto:'TESTONLY_PRIVATE_PHOTO_BYTES',Movil:`+3460000${String(n).padStart(4,'0')}`,NoCircu:'1'}),
      sourceRow('Historial',{ID:id,IDP:id,Pieza:'36',Cuadrante:'26','Nº Trat':'9',Fecha:'2020-01-01',Obs:'TESTONLY historic clinical record',Tipolin:'T'},catalog),
      sourceRow('Historial',{ID:String(1000+n),IDP:id,Pieza:'','Nº Trat':'0',Fecha:'2020-01-01',Tipolin:'C',Precio_euro:'99731.23'},{source_id:'2',code:'COBR',name:'TESTONLY Cobro',family_id:'0'}),
      sourceRow('Presupuesto',{ID:id,IDP:id,IDPre:id,Pieza:'46','Nº Trat':'9',Fecha:'2021-01-01',Precio_euro:'99731.23'},catalog),
      sourceRow('Trabajo_Pendiente',{ID:id,IDP:id,Pieza:'16',Cuadrante:'26','Nº Trat':'9',Fecha:'2021-01-01',Obs:'TESTONLY Pending'},catalog),
    ]});
  }
  bundle.sha256=digest(bundle);return bundle;
}
test('native JWT middleware, controller, per-clinic ACL, durable read audit and SQL joins protect imported history/catalogue/odontogram for 50 synthetic patients',{
  skip:process.env.EURODENT_IMPORT_HTTP_MYSQL_TEST!=='1',timeout:180000,
},async()=>withIsolatedCampaignMysql(async owned=>{
  const {sql,models:db,report,registerOwnedLoopbackServer}=owned,{Sequelize,DataTypes:D}=require('sequelize');db.Sequelize=Sequelize;
  db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},nombre_clinica:D.STRING,grupoClinicaId:D.INTEGER,estado_clinica:D.BOOLEAN},{tableName:'Clinicas',timestamps:false});await db.Clinica.sync();
  await db.Clinica.bulkCreate([{id_clinica:67,nombre_clinica:'TESTONLY LOCAL',estado_clinica:true},{id_clinica:68,nombre_clinica:'TESTONLY FOREIGN',estado_clinica:true}]);
  db.Usuario=sql.define('Usuario',{id_usuario:{type:D.INTEGER,primaryKey:true},nombre:D.STRING,email_usuario:D.STRING,password_usuario:D.STRING,estado_cuenta:D.STRING,es_provisional:D.BOOLEAN},{tableName:'Usuarios',timestamps:false});await db.Usuario.sync();
  await db.Usuario.bulkCreate([1,2,3,4].map(id=>({id_usuario:id,nombre:`TESTONLY ACTOR ${id}`,email_usuario:`testonly-${id}@example.invalid`,password_usuario:'TESTONLY stored credential',estado_cuenta:'activo',es_provisional:false})));
  await sql.query('CREATE TABLE PatientHistoryCounters(scope_key VARCHAR(64) PRIMARY KEY,next_number BIGINT NOT NULL)');
  for(const name of ['paciente','pacienteclinica','patientcustomfield','patientoperationalevent','usuarioclinica','accesspolicyoverride','platformauditevent']){
    const model=require('../../../models/'+name)(sql,D);db[model.name]=model;model.options.indexes?.forEach((index,i)=>{index.name=`qa_eurodent_http_${name}_${i}`;});await model.sync();
  }
  db.Paciente.hasMany(db.PacienteClinica,{foreignKey:'paciente_id',as:'clinicasVinculadas'});
  await db.UsuarioClinica.bulkCreate([{id_usuario:2,id_clinica:67,rol_clinica:'personaldeclinica',subrol_clinica:'Doctores'},
    {id_usuario:3,id_clinica:67,rol_clinica:'agencia'}, {id_usuario:4,id_clinica:68,rol_clinica:'personaldeclinica',subrol_clinica:'Doctores'}]);
  await require('../../../migrations/20261022143000-patient-imported-source-archive').up(sql.getQueryInterface(),Sequelize);
  db.PatientImportedIdentity=require('../../../models/patientimportedidentity')(sql,D);
  const raw=await sql.connectionManager.getConnection(),connection=raw.promise();
  let server;const auditFlag=process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED;
  try{
    const bundle=sourceBundle(),before=await captureImport(connection,{clinicId:67,bundle});
    const applied=await applyImport(connection,{clinicId:67,bundle,actorId:1,expectedSha256:before.plan.sha256,beforeCommit:async()=>{}});
    const patient=applied.created[0],foreign=await db.Paciente.create({public_id:'pac_TESTONLY_FOREIGN',nombre:'TESTONLY FOREIGN',apellidos:'',clinica_id:68});
    await db.PacienteClinica.create({paciente_id:foreign.id_paciente,clinica_id:68,es_principal:true});
    const sessions=require('../../services/accessSession.service'),secret='TESTONLY isolated JWT signing key; not a runtime credential',
      ownSessions=sessions.createService({models:db,config:()=>({mode:'legacy',ttl:3600,secret,emailMfaMode:'legacy'})});
    const originalVerify=sessions.verify;sessions.verify=ownSessions.verify;
    const jwt=require('jsonwebtoken'),adminClaims=require('../../lib/adminCredentialSession');
    const tokens={};for(const id of [1,2,3,4]){const user=await db.Usuario.findByPk(id);tokens[id]=jwt.sign({userId:id,email:user.email_usuario,...adminClaims.claims(user,secret)},secret,{expiresIn:3600});}
    process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED='true';
    const express=require('express'),app=express();app.use(require('../../routes/auth.middleware'));
    const controller=require('../../controllers/paciente.controller');
    app.get('/patients/:id/imported-history',controller.getImportedPatientHistory);
    app.get('/patients/:id/imported-catalog',controller.getImportedPatientCatalog);
    app.get('/patients/:id/imported-odontogram',controller.getImportedPatientOdontogram);
    server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));registerOwnedLoopbackServer(server);
    const request=(route,actor=1)=>new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:'GET',agent:false,headers:actor?{Authorization:`Bearer ${tokens[actor]}`}:{}} ,res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(raw)});}catch(error){reject(error);}});});req.on('error',reject);req.end();
    });
    const history=`/patients/${patient.publicId}/imported-history?clinic_id=67`,catalog=`/patients/${patient.publicId}/imported-catalog?clinic_id=67`,odontogram=`/patients/${patient.publicId}/imported-odontogram?clinic_id=67`;
    const unauthorized=await request(history,null);assert.equal(unauthorized.status,401);
    for(const route of [history,catalog,odontogram]){
      assert.equal((await request(route.replace('clinic_id=67','clinic_id=68'))).status,403);
      assert.equal((await request(route,3)).status,403);assert.equal((await request(route,4)).status,403);
      assert.equal((await request(route.replace(patient.publicId,foreign.public_id))).status,403);
    }
    for(const item of applied.created){const result=await request(`/patients/${item.publicId}/imported-history?clinic_id=67`);assert.equal(result.status,200);assert.equal(result.body.total,5);assert(result.body.entries.some(e=>e.category==='economic'));assert.equal(result.headers['cache-control'],'private, no-store');}
    const clinical=await request(history,2);assert.equal(clinical.status,200);assert.equal(clinical.body.financial_values_visible,false);assert.equal(clinical.body.total,4);assert(!clinical.body.entries.some(e=>e.category==='economic'));
    assert.doesNotMatch(JSON.stringify(clinical.body),/99731\.23|TESTONLY_PRIVATE_PHOTO_BYTES|Precio_euro|record_json|NoCircu/);
    assert.equal((await request(history+'&category=economic',2)).body.total,0);
    const catalogue=await request(catalog,2);assert.equal(catalogue.status,200);assert.equal(catalogue.body.items.length,1);assert.equal(catalogue.body.items[0].source_id,'1');
    assert.doesNotMatch(JSON.stringify(catalogue.body),/99731\.23|PRIVATE DOCTOR|PRIVATE NIF|Precio_euro|https?:\/\//);
    const odont=await request(odontogram,2);assert.equal(odont.status,200);assert.equal(odont.body.read_only,true);assert(odont.body.teeth.some(tooth=>tooth.number===36&&tooth.marks.length));
    assert.doesNotMatch(JSON.stringify(odont.body),/99731\.23|PRIVATE_PHOTO|https?:\/\//);
    assert.equal((await request(odontogram+'&at=2026-02-31')).status,400);
    assert.equal((await request(odontogram+'&at=2020-01-01')).body.cutoff,'2020-01-01');
    assert.equal(await require('../../lib/whatsappAppointmentEligibility').patientImportHeld(patient.patientId,db),true);
    // Deliberately corrupt an owned test-only row despite its composite FK, then
    // prove the real read JOIN excludes the foreign identity before projection.
    const ownIdentity=(await connection.query('SELECT * FROM PatientImportedIdentities WHERE patient_id=?',[patient.patientId]))[0][0];
    const foreignCatalog=(await connection.query(`INSERT INTO ImportedClinicalCatalogs(clinic_id,source_system,source_instance,bundle_sha256,source_zip_sha256,catalog_sha256,context_json,imported_at,actor_user_id) VALUES (68,'eurodent','testonly-foreign',?,?,?,?,UTC_TIMESTAMP(),1)`,['f'.repeat(64),'e'.repeat(64),'a'.repeat(64),JSON.stringify({Tratamiento:[{record:{ID:'999',Nombre:'TESTONLY FOREIGN CATALOG SECRET'}}]})]))[0].insertId;
    const foreignIdentity=(await connection.query(`INSERT INTO PatientImportedIdentities(catalog_id,patient_id,clinic_id,source_system,source_instance,source_patient_id,bundle_sha256,messages_hold,imported_at,actor_user_id) VALUES (?,?,68,'eurodent','testonly-foreign','999',?,TRUE,UTC_TIMESTAMP(),1)`,[foreignCatalog,foreign.id_paciente,'f'.repeat(64)]))[0].insertId;
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    try{
      const injected={version:'eurodent_source_record/1',source_instance:'testonly-foreign',source_database:'datos/EDD00001.MDB',source_table:'Historial',source_pk:{ID:'99999'},record:{ID:'99999',IDP:'999',Fecha:'2020-01-01',Obs:'TESTONLY FOREIGN CLINICAL SECRET'}};
      await connection.query(`INSERT INTO PatientImportedSourceRecords(identity_id,patient_id,clinic_id,source_key,source_database,source_table,category,row_sha256,database_sha256,bundle_sha256,record_json,imported_at) VALUES (?,?,67,?,'datos/EDD00001.MDB','Historial','historical',?,?,?, ?,UTC_TIMESTAMP())`,[foreignIdentity,patient.patientId,'9'.repeat(64),'8'.repeat(64),'7'.repeat(64),'6'.repeat(64),JSON.stringify(injected)]);
      await connection.query('UPDATE PatientImportedIdentities SET catalog_id=? WHERE id=?',[foreignCatalog,ownIdentity.id]);
    }finally{await connection.query('SET FOREIGN_KEY_CHECKS=1');}
    assert.doesNotMatch(JSON.stringify((await request(history)).body),/FOREIGN CLINICAL SECRET/);
    const isolatedCatalogue=await request(catalog);assert.equal(isolatedCatalogue.status,200);assert.equal(isolatedCatalogue.body.items.length,0);assert.doesNotMatch(JSON.stringify(isolatedCatalogue.body),/FOREIGN CATALOG SECRET/);
    await connection.query('UPDATE PatientImportedIdentities SET catalog_id=? WHERE id=?',[ownIdentity.catalog_id,ownIdentity.id]);
    const auditRows=await db.PlatformAuditEvent.findAll({raw:true});assert(auditRows.length>=100);assert(auditRows.some(row=>JSON.parse(row.body).outcome==='denied'));assert(auditRows.some(row=>JSON.parse(row.body).outcome==='success'));
    assert.doesNotMatch(JSON.stringify(auditRows),/TESTONLY PATIENT|99731\.23|PRIVATE_PHOTO|FOREIGN CLINICAL SECRET/);
    assert.equal(await db.PatientOperationalEvent.count({where:{event_type:'patient.imported'}}),50);
    sessions.verify=originalVerify;
    report.checks.push('Native JWT signature/admin credential binding, middleware, real controller/ACL SQL and durable audited no-store reads; 50 patients, clinical-versus-financial redaction and totals; catalogue whitelist; HOLD/no public URL; invalid cutoff; malformed cross-owner history/catalogue excluded by real joins. Synthetic only, no providers/CRM/DEV.');
  }finally{
    if(auditFlag===undefined)delete process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED;else process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED=auditFlag;
    if(server)await new Promise(resolve=>server.close(resolve));await sql.connectionManager.releaseConnection(raw);
  }
}));
