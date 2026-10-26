'use strict';

// Explicit operator integration check. Only session-local TEMPORARY tables are
// populated; closing this DEV connection removes the entire synthetic fixture.
const test=require('node:test');
const assert=require('node:assert/strict');
const {connectOperatorDatabase}=require('../../lib/cliniccloud-import/operator-database');
const store=require('../../lib/arriaga-import/store');
const {buildExternalPatientHistory}=require('../../lib/external-patient-history');
const TEMP_TABLES=Object.freeze(['Clinicas',...store.TABLES]);
const ENABLED=process.env.ARRIAGA_IMPORT_MYSQL_INTEGRATION==='1';

function fixture(){
 const patients=[2,3,4].map((row,index)=>({canonical_key:`master-row-${row}`,source_rows:[row],source_history_numbers:[index<2?'10':'30'],
  profile:{nombre:`TESTONLY Fictitious Person ${index+1}`,apellidos:'TESTONLY Synthetic',direccion:`TESTONLY Fictional Street ${index+1}`}}));
 const activity=[1,70].map((clinic,index)=>({canonical_key:'master-row-2',master_source_row:2,clinic_id:clinic,
  clinic_assignment:clinic===1?'explicit_aju':'default_arenal',record_date:'2026-09-30',source_activity_key:store.digest(`TESTONLY activity ${index}`),
  source_file:'TESTONLY activity.xlsx',source_sheet:'TESTONLY synthetic services',source_row:2+index,
  source_sha256:store.digest('TESTONLY fictional workbook'),source:{row_content_sha256:store.digest(`TESTONLY source row ${index}`)},
  service_label:'TESTONLY Quiropodía',family:'TESTONLY Clinical',classification:'TESTONLY Clinical',
  notes_imported:false,financial_state_imported:false,signed_episode:false,care_state:null,event_time:null}));
 const bundle={version:'arriaga_import_bundle/1',group_id:28,default_clinic_id:70,
  files:[{file:'TESTONLY activity.xlsx',sha256:store.digest('TESTONLY fictional workbook')}],
  policy:{messages_enabled:false,default_clinic_id:70,fixture:'TESTONLY TEMPORARY MYSQL'},patients,activity,
  catalog:[{catalog_key:'TESTONLY clinical catalogue',nombre:'TESTONLY Quiropodía',family:'TESTONLY Clinical',disciplina:'Podología',
   precio_base:null,duracion_min:null,source_labels:['TESTONLY Quiropodía']}],source_history_by_row:{2:'10',3:'10',4:'30'}};
 bundle.sha256=store.digest(bundle);return bundle;
}

function guardedSession(connection,createdTables,sqlAudit){
 const names=new Set(TEMP_TABLES.map(x=>x.toLowerCase()));
 return{
  async query(sql,values=[]){
   assert.equal(createdTables.size,TEMP_TABLES.length,'Every data table must be shadowed before importer SQL runs');
   const text=String(sql);assert.doesNotMatch(text,/\b(?:Citas|Cobros|Facturas|Recibos|PatientVouchers|Usuarios|Outbox|Queues)\b/i);
   for(const match of text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+`?([A-Za-z_][A-Za-z_0-9]*)`?/ig)){
    assert(names.has(match[1].toLowerCase()),'SQL may access only a fixture TEMPORARY table');
   }
   assert.doesNotMatch(text,/\b(?:CREATE|ALTER|DROP|TRUNCATE|USE|GRANT|REVOKE)\b/i);
   sqlAudit.push(text);return connection.query(sql,values);
  },
  beginTransaction:()=>connection.beginTransaction(),commit:()=>connection.commit(),rollback:()=>connection.rollback(),
 };
}

async function temporaryRows(connection,table){
 assert(TEMP_TABLES.includes(table));const[rows]=await connection.query(`SELECT * FROM \`${table}\` ORDER BY 1`);return rows;
}

test('Arriaga DEV TEMPORARY MySQL: rollback, preserve, replay, clinic scope and source tamper guards',{
 skip:!ENABLED?'Set ARRIAGA_IMPORT_MYSQL_INTEGRATION=1 to run the isolated DEV TEMPORARY-table integration':false,
 timeout:90000,
},async t=>{
 const connection=await connectOperatorDatabase('dev');
 const createdTables=new Set(),sqlAudit=[];
 try{
  const[[{database}]]=await connection.query('SELECT DATABASE() AS `database`');
  assert.equal(database,'clinicaclick_dev_isolated','A shared/CRM database is never an integration fixture');
  // LIKE reads schema only, not rows. It copies indexes but not real-table
  // foreign keys or triggers; INSERT/SELECT below resolve to these TEMP tables.
  for(const table of TEMP_TABLES){
   assert(/^[A-Za-z][A-Za-z0-9]*$/.test(table));
   // MySQL rejects CREATE TEMPORARY x LIKE x as a duplicate source alias.
   // Rename a distinct, already-temporary clone into the shadowing name.
   const scratch=`arriaga_fixture_${table}`;
   await connection.query(`CREATE TEMPORARY TABLE \`${scratch}\` LIKE \`clinicaclick_dev_isolated\`.\`${table}\``);
   await connection.query(`ALTER TABLE \`${scratch}\` RENAME TO \`${table}\``);createdTables.add(table);
   assert.equal((await temporaryRows(connection,table)).length,0,'A fixture must never copy real rows');
  }
  await connection.query('INSERT INTO Clinicas (id_clinica,nombre_clinica,grupoClinicaId) VALUES (1,?,28),(70,?,28)',
   ['TESTONLY Fictional Ajuriaguerra','TESTONLY Fictional Arenal']);
  await connection.query(`INSERT INTO Pacientes (id_paciente,public_id,nombre,apellidos,clinica_id,numero_historia,historia_scope,notas_paciente,createdAt,updatedAt)
   VALUES (9000001,?,?,?,?,?,?,?,? ,?)`,['pac_TESTONLY_preexisting','TESTONLY Existing Person','TESTONLY Synthetic',70,'10','group:28','TESTONLY preserve this existing fixture field','2026-01-01 00:00:00','2026-01-01 00:00:00']);
  await connection.query('INSERT INTO PacienteClinicas (paciente_id,clinica_id,es_principal) VALUES (9000001,70,1)');
  const guarded=guardedSession(connection,createdTables,sqlAudit),bundle=fixture();
  const before=await store.capture(guarded),plan=store.planImport(bundle,before);
  assert.equal(before.patients.length,1);assert.equal(before.counter.length,0);
  assert.deepEqual(plan.operations.map(o=>o.historyNumber),['31','32','30']);
  assert.equal(plan.operations.filter(o=>o.historyRenumbered).length,2);
  assert.deepEqual(plan.operations[0].clinicIds,[1,70]);assert.equal(plan.operations[0].primaryClinicId,70);
  assert.deepEqual(plan.operations.slice(1).map(o=>o.clinicIds),[[70],[70]]);

  await t.test('failure immediately before commit rolls back every temporary-table write',async()=>{
   let callbackObserved=false;
   await assert.rejects(store.applyImport(guarded,{bundle,plan,beforeCommit:async({after,result})=>{
    callbackObserved=true;assert.equal(after.patients.length,4);assert.equal(after.sourceRecords.length,2);
    assert.equal(result.patientsCreated,3);assert.equal(result.treatmentsCreated,1);
    throw Error('TESTONLY_ABORT_BEFORE_COMMIT');
   }}),/TESTONLY_ABORT_BEFORE_COMMIT/);
   assert(callbackObserved);assert.equal(store.digest(await store.capture(guarded)),store.digest(before));
   assert.equal((await temporaryRows(connection,'PatientOperationalEvents')).length,0);
   assert.equal((await temporaryRows(connection,'PatientHistoryCounters')).length,0);
   const[[{free}]]=await connection.query('SELECT IS_FREE_LOCK(?) AS free',['cc-arriaga-import:group-28']);assert.equal(Number(free),1);
  });

  let result,after;
  await t.test('commit imports only fictional profiles, clinic-bound historical evidence and one inactive draft',async()=>{
   result=await store.applyImport(guarded,{bundle,plan});after=await store.capture(guarded);
   assert.equal(result.patientsCreated,3);assert.equal(result.historyRenumbered,2);assert.equal(result.membershipsCreated,4);
   assert.equal(result.identities,4);assert.equal(result.historicalActivities,2);assert.equal(result.treatmentsCreated,1);
   assert.equal(result.messagesSent,0);assert.equal(result.appointmentsCreated,0);assert.equal(result.financialRecordsCreated,0);
   assert.equal(after.patients.length,4);assert.deepEqual(after.patients.find(p=>Number(p.id_paciente)===9000001),before.patients[0]);
   assert(after.memberships.some(m=>Number(m.paciente_id)===9000001&&Number(m.clinica_id)===70));
   assert.equal(new Set(after.histories.map(p=>p.numero_historia)).size,4);
   assert.equal(after.treatments.length,1);const treatment=after.treatments[0];
   assert.equal(treatment.precio_base,null);assert.equal(treatment.duracion_min,null);assert.equal(Number(treatment.activo),0);
   assert.equal(treatment.origen,'grupo');assert.equal(Number(treatment.grupo_clinica_id),28);
   const config=typeof treatment.clinical_config==='string'?JSON.parse(treatment.clinical_config):treatment.clinical_config;
   assert.equal(config.catalog_status,'draft');
   assert(after.identities.every(i=>Number(i.messages_hold)===1));
   const events=await temporaryRows(connection,'PatientOperationalEvents');assert.equal(events.length,3);
   for(const event of events){const data=typeof event.metadata==='string'?JSON.parse(event.metadata):event.metadata;
    assert.equal(data.messages_enabled,false);assert.equal(data.automation_activated,false);}
   const fields=after.sourceRecords.map(r=>{const i=after.identities.find(i=>Number(i.id)===Number(r.identity_id));
    return{source:i.source_system,clinica_id:r.clinic_id,archive_source_instance:i.source_instance,archive_source_patient_id:i.source_patient_id,
     archive_source_key:r.source_key,value:r.record_json,last_imported_at:r.imported_at};});
   const history=buildExternalPatientHistory(fields,{clinics:after.clinics});assert.equal(history.read_only,true);assert.equal(history.entries.length,2);
   assert.deepEqual(history.entries.map(e=>e.clinic_id).sort((a,b)=>a-b),[1,70]);
   assert(history.entries.every(e=>e.record_date==='2026-09-30'&&e.category==='historical'&&e.author===null));
   for(const r of after.sourceRecords){const envelope=JSON.parse(r.record_json);
    assert.deepEqual(Object.keys(envelope.record),['service_label','service_family','source_classification','site_assignment']);
    assert(!('care_state' in envelope));assert(!('event_time' in envelope));assert(!('signed_episode' in envelope));}
  });

  await t.test('replaying the sealed bundle preserves every record and creates nothing',async()=>{
   const replayPlan=store.planImport(bundle,after),eventsBefore=await temporaryRows(connection,'PatientOperationalEvents');
   assert(replayPlan.operations.every(o=>o.action==='preserve'));assert(replayPlan.catalogOps.every(o=>o.action==='preserve'));
   const replay=await store.applyImport(guarded,{bundle,plan:replayPlan});
   assert.equal(replay.patientsCreated,0);assert.equal(replay.treatmentsCreated,0);assert.equal(replay.membershipsCreated,0);
   assert.equal(replay.identities,4);assert.equal(replay.historicalActivities,2);
   assert.equal(store.digest(await store.capture(guarded)),store.digest(after));
   assert.deepEqual(await temporaryRows(connection,'PatientOperationalEvents'),eventsBefore);
  });

  await t.test('a retained record_json alteration is rejected before a replay can write',async()=>{
   const good=await store.capture(guarded),replayPlan=store.planImport(bundle,good),record=good.sourceRecords[0];
   const tampered=JSON.parse(record.record_json);tampered.record.service_label='TESTONLY tampered retained service';
   await connection.query('UPDATE PatientImportedSourceRecords SET record_json=? WHERE id=?',[JSON.stringify(tampered),record.id]);
   try{
    const changed=await store.capture(guarded);assert.throws(()=>store.planImport(bundle,changed),/ARRIAGA_EXISTING_RECORD_CHANGED/);
    await assert.rejects(store.applyImport(guarded,{bundle,plan:replayPlan}),/ARRIAGA_TARGET_CHANGED/);
    assert.equal((await temporaryRows(connection,'Pacientes')).length,4);
    assert.equal((await temporaryRows(connection,'PatientOperationalEvents')).length,3);
   }finally{await connection.query('UPDATE PatientImportedSourceRecords SET record_json=? WHERE id=?',[record.record_json,record.id]);}
   assert.equal(store.digest(await store.capture(guarded)),store.digest(good));
  });

  assert(sqlAudit.length>0);assert(sqlAudit.every(sql=>!/^\s*(?:CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql)));
 }finally{
  try{
   for(const table of [...createdTables].reverse())await connection.query(`DROP TEMPORARY TABLE IF EXISTS \`${table}\``);
  }finally{await connection.end();}
 }
});
