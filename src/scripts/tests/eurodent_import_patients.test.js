'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {digest,validateBundle,profileFor}=require('../../lib/eurodent-import/bundle');
const {buildImportPlan,captureImport,applyImport}=require('../../lib/eurodent-import/store');
const {buildExternalPatientHistory,paginateExternalHistory,redactImportedHistoryFinancials,buildImportedClinicalCatalog}=require('../../lib/external-patient-history');
const sourceRow=(table,record)=>({source_database:'datos/EDD00001.MDB',source_table:table,source_pk:{ID:record.ID},source_ordinal:Number(record.ID),
  row_sha256:digest(record),database_sha256:'a'.repeat(64),record});
function makeBundle(count=1){
  const bundle={version:'eurodent_patient_bundle/1',source_system:'eurodent',source_instance:'testonly-eurodent',source_inventory_sha256:'b'.repeat(64),intake_sha256:'c'.repeat(64),source_zip_sha256:'d'.repeat(64),
    operational_effects:{appointments:false,payments:false,debt:false,messages:false,clinical_reference_update:false,current_treatment_execution:false},context:{},patients:[]};
  for(let n=1;n<=count;n++){
    const id=String(n);bundle.patients.push({source_patient_id:id,records:[
      sourceRow('Paciente',{ID:id,Nombre:`TESTONLY PERSON ${n}`,Movil:`+3460100${String(n).padStart(4,'0')}`,Nif:`TESTONLY${n}`,FechNac:'1980-01-01',Alergias:'Antecedente sin confirmar','NºHist':String(n+1000),'Dirección':'Calle ficticia','CódPostal':'00000','Población':'TESTONLY','Provincia':'TESTONLY'}),
      {...sourceRow('Historial',{ID:id,IDP:id,IDT:'2',Pieza:'36',Fecha:'2020-01-01',Obs:'Anotación histórica',Tipolin:'T'}),catalog:{source_id:'2',name:'Tratamiento ficticio',code:'TESTONLY',family_id:'1',family_name:'Ficticia'}},
      sourceRow('Primera_Visita',{ID:id,IDP:id,Pieza:'46',Fecha:'2018-01-01',Obs:'Presente antes de la clínica'}),
      sourceRow('Trabajo_Pendiente',{ID:id,IDP:id,Pieza:'16',Fecha:'2021-01-01',Obs:'Pendiente original'}),
      sourceRow('Presupuestos',{ID:id,IDP:id,Fecha:'2021-01-01',Num:'TESTONLY',Aceptado:'0'}),
      sourceRow('Factura',{ID:id,IDP:id,Fecha:'2020-01-01',total:'80',Num:'TESTONLY'})]});
  }
  bundle.sha256=digest(bundle);return bundle;
}
const blankSnapshot=()=>({clinic:{id_clinica:67,nombre_clinica:'TESTONLY',grupoClinicaId:null,estado_clinica:1},patients:[],memberships:[],identities:[],records:[],catalogs:[]});
test('bundle is hash-bound, each original row hash and source owner validated; max50, oversized and duplicate source keys rejected',()=>{
  const bundle=makeBundle(50);assert.equal(validateBundle(bundle),bundle);
  const tamper=structuredClone(bundle);tamper.patients[0].records[0].record.Nombre='changed';assert.throws(()=>validateBundle(tamper),/BUNDLE_INVALID/);
  delete tamper.sha256;tamper.sha256=digest(tamper);assert.throws(()=>validateBundle(tamper),/ROW_INVALID/);
  assert.throws(()=>validateBundle(makeBundle(51)),/BUNDLE_INVALID/);
  const dup=makeBundle();dup.patients[0].records.push(dup.patients[0].records[1]);delete dup.sha256;dup.sha256=digest(dup);assert.throws(()=>validateBundle(dup),/DUPLICATED/);
  assert.equal(profileFor(bundle.patients[0]).nombre,'TESTONLY PERSON 1');assert.equal(profileFor(bundle.patients[0]).apellidos,'');
  assert(!Object.hasOwn(profileFor(bundle.patients[0]),'alergias'));
});
test('plan never merges by phone/name/document, flags collisions, and binds clinic/bundle/snapshot changes',()=>{
  const bundle=makeBundle(),snapshot=blankSnapshot();assert.equal(buildImportPlan(bundle,snapshot).counts.create,1);
  const before=buildImportPlan(bundle,snapshot).sha256;snapshot.clinic.nombre_clinica='changed';assert.notEqual(buildImportPlan(bundle,snapshot).sha256,before);
  const inactive=blankSnapshot();inactive.clinic.estado_clinica=0;assert.throws(()=>buildImportPlan(bundle,inactive),/CLINIC_REQUIRED/);
  snapshot.patients=[{id_paciente:4,nombre:'Someone',dni:'TESTONLY1'}];assert.equal(buildImportPlan(bundle,snapshot).operations[0].action,'review');
  assert.equal(buildImportPlan(bundle,snapshot).operations[0].reason,'possible_existing_identity');
});
test('source histories stay read-only, separate categories/date/provenance and paginate/search without interpreting current debt or clinical reference',()=>{
  const bundle=makeBundle(),fields=bundle.patients[0].records.map((r,i)=>({source:'eurodent',clinica_id:67,last_imported_at:'2026-10-22',value:JSON.stringify({version:'eurodent_source_record/1',source_instance:bundle.source_instance,...r})}));
  const history=buildExternalPatientHistory(fields);assert.equal(history.entries.length,6);assert(history.read_only);
  assert.deepEqual(new Set(history.entries.map(e=>e.category)),new Set(['profile','historical','prior_state','pending_work','budget','economic']));
  const page=paginateExternalHistory(history,{limit:2});assert.equal(page.total,6);assert(page.next_cursor);
  const next=paginateExternalHistory(history,{limit:2,cursor:page.next_cursor});assert.equal(next.entries.length,2);assert.notEqual(page.entries[0].id,next.entries[0].id);
  assert.equal(paginateExternalHistory(history,{category:'pending_work'}).entries.length,1);
  assert.equal(paginateExternalHistory(history,{search:'anotacion historica'}).entries.length,1);
  assert.throws(()=>paginateExternalHistory(history,{cursor:page.next_cursor,category:'pending_work'}),/cursor_invalid/);
  assert.throws(()=>paginateExternalHistory(history,{limit:10000}),/limit_invalid/);
});
test('financial redaction precedes history totals and source catalogue never exposes prices, doctors or payment context',()=>{
  const history={entries:[{id:'x',provider:'eurodent',category:'economic',sections:[{items:[{label:'Importe original (€)',value:'500'}]}]},{id:'y',provider:'eurodent',category:'budget',sections:[{items:[{label:'Tratamiento',value:'Obturación'},{label:'Importe original (€)',value:'400'},{label:'Documento en origen',value:'123'}]}]}],providers:['eurodent']};
  const redacted=redactImportedHistoryFinancials(history);assert.equal(redacted.entries.length,1);assert.deepEqual(redacted.entries[0].sections[0].items,[{label:'Tratamiento',value:'Obturación'}]);assert.equal(paginateExternalHistory(redacted).total,1);
  assert.equal(redactImportedHistoryFinancials(history,{mayViewFinancial:true}).entries.length,2);
  const catalogue=buildImportedClinicalCatalog([{source_system:'eurodent',context_json:JSON.stringify({Tratamiento:[{record:{ID:'1',Nombre:'Ficticio',Precio_euro:'999',Familia:'1'}}],FamTrat:[{record:{ID:'1',Familia:'Ficticia'}}],Doctor:[{record:{Nombre:'TESTONLY private doctor'}}],FPago:[{record:{Nombre:'TESTONLY finance'}}]})}]);
  assert.equal(catalogue.items.length,1);assert.doesNotMatch(JSON.stringify(catalogue),/999|private doctor|TESTONLY finance|Precio/);
});
test('complete category navigation survives an economic first page and filters without leaking financial categories to a clinical role',()=>{
  const bundle=makeBundle(),records=[...bundle.patients[0].records];
  for(let n=1;n<=40;n++)records.push(sourceRow('Factura',{ID:String(1000+n),IDP:'1',Fecha:'2026-10-20',total:'10'}));
  const history=buildExternalPatientHistory(records.map(row=>({source:'eurodent',clinica_id:67,value:JSON.stringify({version:'eurodent_source_record/1',source_instance:bundle.source_instance,...row})})));
  const admin=redactImportedHistoryFinancials(history,{mayViewFinancial:true});
  const first=paginateExternalHistory(admin,{limit:40});
  assert(first.entries.every(entry=>entry.category==='economic'));
  assert.deepEqual(first.category_counts,{economic:41,budget:1,pending_work:1,historical:1,prior_state:1,profile:1});
  const next=paginateExternalHistory(admin,{limit:40,cursor:first.next_cursor});
  assert(next.entries.some(entry=>entry.category==='historical'));
  assert.deepEqual(next.category_counts,first.category_counts);
  for(const query of [{category:'historical'},{search:'anotacion historica'},{tooth:'36'},{from:'2020-01-01',to:'2020-12-31'}]){
    const filtered=paginateExternalHistory(admin,{...query,limit:1});
    assert(filtered.total>0);assert.deepEqual(filtered.category_counts,first.category_counts);
  }
  const clinical=redactImportedHistoryFinancials(history,{mayViewFinancial:false}),safe=paginateExternalHistory(clinical,{limit:1});
  assert.deepEqual(safe.category_counts,{budget:1,pending_work:1,historical:1,prior_state:1,profile:1});
  assert.equal(safe.total,5);assert(!Object.hasOwn(safe.category_counts,'economic'));
  const hidden=paginateExternalHistory(clinical,{category:'economic'});
  assert.equal(hidden.total,0);assert.equal(hidden.entries.length,0);assert.deepEqual(hidden.category_counts,safe.category_counts);
});
test('mixed Historial and Hist_Borr rows classify by financial evidence without losing source deletion provenance',()=>{
  const records=[];
  for(const table of ['Historial','Hist_Borr']){
    records.push({...sourceRow(table,{ID:String(records.length+1),Tipolin:'T',Obs:'TESTONLY clinical annotation'}),catalog:{code:'TESTONLY'}});
    for(const evidence of [{catalog:{code:'COBR'}},{catalog:{code:'0213'}},{record:{Tipolin:'C'}},{record:{Tipolin:'A'}}]){
      records.push({...sourceRow(table,{ID:String(records.length+1),Tipolin:'T',Precio_euro:'17.25',...evidence.record}),catalog:evidence.catalog||{code:'TESTONLY'}});
    }
  }
  const history=buildExternalPatientHistory(records.map(row=>({source:'eurodent',clinica_id:67,value:{version:'eurodent_source_record/1',source_instance:'testonly-mixed-archive',...row}})));
  assert.equal(history.entries.filter(entry=>entry.category==='economic').length,8);
  assert.equal(history.entries.filter(entry=>entry.category==='historical').length,1);
  assert.equal(history.entries.filter(entry=>entry.category==='deleted_history').length,1);
  const deleted=history.entries.filter(entry=>entry.source_document.table==='Hist_Borr');
  assert.equal(deleted.length,5);
  for(const entry of deleted){
    assert.equal(entry.source_deleted,true);assert.match(entry.content_note,/eliminado en origen/);
    assert(entry.source_document.record_id);assert(entry.source_document.row_sha256);
  }
  const safe=redactImportedHistoryFinancials(history);
  assert.equal(safe.entries.length,2);
  assert.deepEqual(new Set(safe.entries.map(entry=>entry.category)),new Set(['historical','deleted_history']));
  assert.doesNotMatch(JSON.stringify(safe),/17\.25/);
});
test('archive scopes partition authorized categories before navigation counts, filters and pagination, and bind every cursor to its domain',()=>{
  const bundle=makeBundle(),records=[...bundle.patients[0].records,
    sourceRow('Comentarios',{ID:'101',Fecha:'2022-01-01',Obs:'TESTONLY archive comment'}),
    sourceRow('Hist_Borr',{ID:'102',Fecha:'2022-01-01',Tipolin:'T',Obs:'TESTONLY deleted clinical annotation'}),
    sourceRow('Hist_Borr',{ID:'103',Fecha:'2022-01-01',Tipolin:'C',Precio_euro:'17.25'}),
    {...sourceRow('Historial',{ID:'104',Fecha:'2022-01-01',Tipolin:'T',Precio_euro:'17.25'}),catalog:{code:'0213'}},
    sourceRow('Paciente',{ID:'105','NºHist':'TESTONLY second source profile'}),
  ];
  const history=buildExternalPatientHistory(records.map(row=>({source:'eurodent',clinica_id:67,value:{version:'eurodent_source_record/1',source_instance:bundle.source_instance,...row}})));
  const domains={clinical:{historical:1,prior_state:1,pending_work:1,comment:1,deleted_history:1},economy:{budget:1,economic:3},profile:{profile:2}};
  assert.equal(paginateExternalHistory(history).total,11);
  for(const [scope,counts] of Object.entries(domains)){
    const first=paginateExternalHistory(history,{scope,limit:1});
    assert.deepEqual(first.category_counts,counts);assert.equal(first.total,Object.values(counts).reduce((a,b)=>a+b,0));assert(first.next_cursor);
    const ids=[first.entries[0].id];let cursor=first.next_cursor;
    while(cursor){
      const page=paginateExternalHistory(history,{scope,limit:1,cursor});
      assert.deepEqual(page.category_counts,counts);assert(page.entries.every(entry=>Object.hasOwn(counts,entry.category)));
      ids.push(...page.entries.map(entry=>entry.id));cursor=page.next_cursor;
    }
    assert.equal(new Set(ids).size,first.total);
    const otherCategory=scope==='economy'?'historical':'economic';
    const excluded=paginateExternalHistory(history,{scope,category:otherCategory});
    assert.equal(excluded.total,0);assert.deepEqual(excluded.category_counts,counts);
    const searched=paginateExternalHistory(history,{scope,search:'TESTONLY archive comment'});
    assert.deepEqual(searched.category_counts,counts);
    for(const otherScope of [...Object.keys(domains).filter(value=>value!==scope),undefined]){
      assert.throws(()=>paginateExternalHistory(history,{scope:otherScope,limit:1,cursor:first.next_cursor}),error=>error.status===400&&error.message==='imported_history_cursor_invalid');
    }
  }
  const all=paginateExternalHistory(history,{limit:1});
  assert.throws(()=>paginateExternalHistory(history,{scope:'clinical',cursor:all.next_cursor}),/cursor_invalid/);
  const safe=paginateExternalHistory(redactImportedHistoryFinancials(history),{scope:'clinical',limit:1});
  assert.deepEqual(safe.category_counts,domains.clinical);assert.equal(safe.total,5);
  for(const scope of ['','all','Clinical','budget','__proto__',null,[],{},['clinical','economy']]){
    assert.throws(()=>paginateExternalHistory(history,{scope}),error=>error.status===400&&error.message==='imported_history_scope_invalid');
  }
});
test('clinical scope removes financial fields before search even for a billing administrator and preserves the original clinical note',()=>{
  const row=sourceRow('Hist_Borr',{ID:'700',Fecha:'2020-04-08',Tipolin:'T',Precio_euro:'987654.32',Num:'TESTONLY finance reference',Obs:'TESTONLY clinical observation',Obs_fra:'TESTONLY invoice-only remark'});
  const history=buildExternalPatientHistory([{source:'eurodent',clinica_id:67,value:{version:'eurodent_source_record/1',source_instance:'testonly-clinical-redaction',...row}}]);
  const original=JSON.stringify(history),admin=redactImportedHistoryFinancials(history,{mayViewFinancial:true});
  const clinical=paginateExternalHistory(admin,{scope:'clinical'});
  assert.equal(clinical.total,1);assert.equal(clinical.financial_values_visible,false);
  assert.equal(clinical.entries[0].category,'deleted_history');assert.equal(clinical.entries[0].source_deleted,true);
  assert.match(JSON.stringify(clinical),/TESTONLY clinical observation/);
  assert.doesNotMatch(JSON.stringify(clinical),/987654|finance reference|invoice-only remark|Importe original|Observaciones de factura|Documento en origen/);
  assert.equal(paginateExternalHistory(admin,{scope:'clinical',search:'987654.32'}).total,0);
  assert.equal(paginateExternalHistory(admin,{scope:'clinical',search:'invoice-only remark'}).total,0);
  assert.equal(JSON.stringify(history),original);
  assert.match(JSON.stringify(paginateExternalHistory(admin)),/987654/);
  const economy=paginateExternalHistory(admin,{scope:'economy'});
  assert.equal(economy.total,1);assert.deepEqual(economy.category_counts,{economic:1});
  assert.equal(economy.entries[0].id,clinical.entries[0].id);
  assert.equal(economy.entries[0].category,'economic');assert.equal(economy.entries[0].source_category,'deleted_history');
  assert.equal(economy.entries[0].source_deleted,true);assert.equal(economy.entries[0].source_document.table,'Hist_Borr');
  assert.match(JSON.stringify(economy),/987654/);assert.match(economy.entries[0].content_note,/no acredita un tratamiento realizado/);
  assert.equal(paginateExternalHistory(admin,{scope:'economy',search:'987654.32'}).total,1);
});
test('new source hold is checked independently of ClinicCloud and fails closed on read failure',async()=>{
  const {patientImportHeld}=require('../../lib/whatsappAppointmentEligibility');let legacy=0;
  const db={PatientImportedIdentity:{findOne:async options=>{assert.equal(options.where.messages_hold,true);return{id:1};}},sequelize:{query:async()=>{legacy++;return[[]];}}};
  assert.equal(await patientImportHeld(6,db),true);assert.equal(legacy,0);
  db.PatientImportedIdentity.findOne=async()=>null;assert.equal(await patientImportHeld(6,db),false);assert.equal(legacy,1);
  db.PatientImportedIdentity.findOne=async()=>{throw Error('TESTONLY storage unavailable');};await assert.rejects(patientImportHeld(6,db),/storage unavailable/);
});
test('catalogue distinguishes source zero flags from drawable restorations and never advertises an unavailable symbol',()=>{
  const rows=[
    {ID:'1',Nombre:'TESTONLY consulta',Familia:'23',Grafico:'0'},
    {ID:'2',Nombre:'TESTONLY restauración',Familia:'2',Grafico:'1'},
    {ID:'3',Nombre:'TESTONLY apunte económico',Familia:'0',Grafico:'1'},
    {ID:'4',Nombre:'TESTONLY restauración archivada',Familia:'99',FamOldOcu:'2',Grafico:'1'},
  ];
  const view=buildImportedClinicalCatalog([{source_system:'eurodent',context_json:JSON.stringify({Tratamiento:rows.map(record=>({record}))})}]);
  assert.deepEqual(view.items.map(item=>item.graphic),[false,true,false,true]);
  assert.equal(view.items[0].visual_type,null);
  assert.equal(view.items[1].visual_type,'obturacion');
  assert.equal(view.items[2].visual_type,null);
  assert.equal(view.items[3].hidden,true);
  assert.equal(view.items[3].visual_type,'obturacion');
});
test('catalogue joins graphic family numbers while retaining source row identities and unregistered zero',()=>{
  const context={FamTrat:[{record:{ID:'26',NumFamilia:'99',Familia:'Tratamientos ocultos'}},{record:{ID:'2',Familia:'Obturación'}},{record:{ID:'8',NumFamilia:null,Familia:'No corresponde al código ocho'}}],Tratamiento:[{record:{ID:'archived',Familia:'99',FamOldOcu:'2',Grafico:'1'}},{record:{ID:'zero',Familia:0,Grafico:'0'}},{record:{ID:'filling',Familia:'2',Grafico:'1'}},{record:{ID:'unregistered',Familia:'8',Grafico:'0'}}]};
  const view=buildImportedClinicalCatalog([{source_system:'eurodent',context_json:JSON.stringify(context)}]);
  assert.deepEqual(view.families[0],{id:'99',source_id:'26',name:'Tratamientos ocultos'});
  assert.equal(view.items[0].family_id,'99');assert.equal(view.items[0].family_name,'Tratamientos ocultos');assert.equal(view.items[0].visual_type,'obturacion');
  assert.equal(view.items[1].family_id,'0');assert.equal(view.items[1].family_name,null);
  assert.equal(view.items[2].family_name,'Obturación');
  assert.equal(view.items[3].family_name,null);
});
test('owned MySQL: actual migration, 50 native profiles/archive rows, rollback, concurrent exclusion and exact replay without economic/citation/provider side effects',{
  skip:process.env.EURODENT_IMPORT_MYSQL_TEST!=='1',timeout:180000,
},async()=>{
  const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
  await withIsolatedCampaignMysql(async({sql,report})=>{
    const {DataTypes,Sequelize}=require('sequelize');
    await sql.query('CREATE TABLE Clinicas (id_clinica INT PRIMARY KEY,nombre_clinica VARCHAR(255),grupoClinicaId INT,estado_clinica TINYINT)');
    await sql.query("INSERT INTO Clinicas VALUES (67,'TESTONLY',NULL,1)");
    await sql.query('CREATE TABLE Usuarios (id_usuario INT PRIMARY KEY)');await sql.query('INSERT INTO Usuarios VALUES (1)');
    await sql.query('CREATE TABLE PatientHistoryCounters (scope_key VARCHAR(64) PRIMARY KEY,next_number BIGINT NOT NULL)');
    for(const name of ['paciente','pacienteclinica','patientoperationalevent']){const model=require('../../../models/'+name)(sql,DataTypes);model.options.indexes?.forEach((index,i)=>{index.name=`qa_eurodent_${name}_${i}`;});await model.sync();}
    await require('../../../migrations/20261022143000-patient-imported-source-archive').up(sql.getQueryInterface(),Sequelize);
    const raw=await sql.connectionManager.getConnection(),connection=raw.promise();
    try{
      const bundle=makeBundle(50),snapshot=await captureImport(connection,{clinicId:67,bundle});assert.equal(snapshot.plan.counts.create,50);
      await assert.rejects(applyImport(connection,{clinicId:67,bundle,actorId:999,expectedSha256:snapshot.plan.sha256,beforeCommit:async()=>{}}),/REVIEWED_PLAN_AND_JOURNAL_REQUIRED/);
      await assert.rejects(applyImport(connection,{clinicId:67,bundle,actorId:44,expectedSha256:snapshot.plan.sha256,beforeCommit:async()=>{}}),/ACTOR_NOT_PRESENT/);
      await assert.rejects(applyImport(connection,{clinicId:67,bundle,actorId:1,expectedSha256:snapshot.plan.sha256,beforeCommit:async()=>{throw Error('TESTONLY rollback');}}),/rollback/);
      assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM Pacientes'))[0][0].n),0);
      assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM PatientImportedSourceRecords'))[0][0].n),0);
      assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM ImportedClinicalCatalogs'))[0][0].n),0);
      assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM PatientHistoryCounters'))[0][0].n),0);
      const parallelRaw=await sql.connectionManager.getConnection();let result;
      try{
        result=await applyImport(connection,{clinicId:67,bundle,actorId:1,expectedSha256:snapshot.plan.sha256,beforeCommit:async journal=>{
          assert.equal(journal.result.created.length,50);assert.equal(journal.after.records.length,300);
          await assert.rejects(applyImport(parallelRaw.promise(),{clinicId:67,bundle,actorId:1,expectedSha256:snapshot.plan.sha256,beforeCommit:async()=>{}}),/BUSY/);
        }});
      }finally{await sql.connectionManager.releaseConnection(parallelRaw);}
      assert.equal(result.created.length,50);assert.equal(result.recordCount,300);assert.equal(result.messagesSent,0);assert.equal(result.appointmentsCreated,0);assert.equal(result.newDebt,0);
      const [profiles]=await connection.query('SELECT * FROM Pacientes ORDER BY id_paciente');assert.equal(profiles.length,50);assert.equal(new Set(profiles.map(p=>p.numero_historia)).size,50);
      assert.equal(profiles[0].direccion,'Calle ficticia');assert.equal(profiles[0].alergias,null);assert.equal(profiles[0].foto,null);
      const [holds]=await connection.query('SELECT * FROM PatientImportedIdentities');assert.equal(holds.length,50);assert(holds.every(i=>i.messages_hold===1));assert.equal(new Set(holds.map(i=>i.catalog_id)).size,1);
      assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM ImportedClinicalCatalogs'))[0][0].n),1);
      await assert.rejects(connection.query('UPDATE PatientImportedSourceRecords SET patient_id=? WHERE identity_id=?',[holds[1].patient_id,holds[0].id]),error=>error.code==='ER_NO_REFERENCED_ROW_2');
      const after=await captureImport(connection,{clinicId:67,bundle});assert.equal(after.plan.counts.preserve,50);
      await assert.rejects(applyImport(connection,{clinicId:67,bundle,actorId:1,expectedSha256:snapshot.plan.sha256,beforeCommit:async()=>{}}),/PLAN_OR_TARGET_CHANGED/);
      const replay=await applyImport(connection,{clinicId:67,bundle,actorId:1,expectedSha256:after.plan.sha256,beforeCommit:async()=>{}});assert.equal(replay.created.length,0);assert.equal(replay.preserved,50);
      assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM PatientOperationalEvents'))[0][0].n),50);
      await connection.query("UPDATE Pacientes SET nombre='TESTONLY MANUAL CHANGE' WHERE id_paciente=?",[result.created[0].patientId]);
      const edited=await captureImport(connection,{clinicId:67,bundle});assert.equal(edited.plan.counts.preserve,50);
      await applyImport(connection,{clinicId:67,bundle,actorId:1,expectedSha256:edited.plan.sha256,beforeCommit:async()=>{}});
      assert.equal((await connection.query('SELECT nombre FROM Pacientes WHERE id_paciente=?',[result.created[0].patientId]))[0][0].nombre,'TESTONLY MANUAL CHANGE');
      await connection.query("UPDATE PatientImportedSourceRecords SET record_json='{}' LIMIT 1");
      await assert.rejects(captureImport(connection,{clinicId:67,bundle}),/ARCHIVE_CHANGED/);
      report.checks.push('Actual archive migration and transactional operator, 50 synthetic patients/300 retained records, HOLD, rollback/counter rollback, concurrent lock, identity replay, manual edit preserved, source tampering rejected. No app model index/providers.');
    }finally{await sql.connectionManager.releaseConnection(raw);}
  });
});
