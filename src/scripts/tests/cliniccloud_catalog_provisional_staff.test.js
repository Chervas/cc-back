'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../../lib/cliniccloud-import/adapter');
const {BATCH}=require('../../lib/cliniccloud-import/catalog-drafts');
const {SOURCE,CONFIRMATION,WARNING,TARGETS,CAPILLARY_SCOPE,CAPILLARY_CONFIRMATION,CAPILLARY_TARGETS,prepare,verifyPackage,verifyAfter}=require('../../lib/cliniccloud-import/catalog-provisional-staff');
function fixture(){
  const before={clinics:[{id_clinica:72,grupoClinicaId:29}],
    treatments:TARGETS.map(t=>({id_tratamiento:t.id,nombre:t.name,clinica_id:72,activo:0,duracion_min:10,precio_base:null,updatedAt:'2026-09-01 00:00:00',
      clinical_config:{catalog_status:'draft',product_type:'treatment',import_batch:BATCH,source_catalog:{file_sha256:SOURCE,sheet:'Tratamientos individuales'},
        source_cabin:t.cabin,source_professional:'Aux. Piedad',import_issues:['INSTALLATION_INACTIVE',WARNING,'OTHER_REVIEW'],fiscal_mapping_pending:true,custom_human_note:'preserve me'}})),
    staff:[{id:119,doctor_id:221,clinica_id:72,activo:1,recibe_citas:1}],staff_hours:[{doctor_clinica_id:119}],
    rooms:[82,84].map(id=>({id,clinica_id:72,activo:1,capacidad:1,profesionales_permitidos:[221]})),room_hours:[82,84].map(id=>({instalacion_id:id})),
    equipment:[{id:12,owner_clinic_id:72,group_id:29,family_key:'carboxytherapy',mobility:'fixed',status:'available',home_installation_id:84,turnaround_minutes:0,revision:1}],
    equipment_clinics:[{equipment_id:12,clinic_id:72}],appointments:[],requirements:[{id:1,tratamiento_id:1973,clinic_template_id:123}]};
  const review={version:1,scope:'provisional_piedad_body_injectables_drafts',confirmation_reference:CONFIRMATION,workbook_sha256:SOURCE,
    bindings:before.treatments.map(r=>({id:r.id_tratamiento,before_sha256:hash(r)}))};
  return{before,review,createdAt:'2026-09-26T09:00:00Z'};
}
function capillaryFixture(){
 const input=fixture(),b=input.before;b.clinics=[{id_clinica:66,grupoClinicaId:29}];
 b.treatments=CAPILLARY_TARGETS.map(t=>({...structuredClone(b.treatments[0]),id_tratamiento:t.id,nombre:t.name,clinica_id:66,duracion_min:t.duration,
   clinical_config:{...structuredClone(b.treatments[0].clinical_config),source_cabin:'2',source_professional:'Aux. Ainhoa',
     source_catalog:{file_sha256:SOURCE,sheet:'Capilar · sesiones y bonos',source_row:t.source_row}}}));
 b.staff=[{id:20,doctor_id:50,clinica_id:66,activo:1,recibe_citas:1}];b.staff_hours=[{doctor_clinica_id:20}];
 b.rooms=[{id:75,clinica_id:66,activo:1,capacidad:1,profesionales_permitidos:[50]}];b.room_hours=[{instalacion_id:75}];
 b.equipment=[{...b.equipment[0],id:15,owner_clinic_id:66,family_key:'capillary_led',home_installation_id:75}];
 b.equipment_clinics=[{equipment_id:15,clinic_id:66}];b.requirements=[];
 input.review={version:1,scope:CAPILLARY_SCOPE,confirmation_reference:CAPILLARY_CONFIRMATION,workbook_sha256:SOURCE,
   bindings:b.treatments.map(r=>({id:r.id_tratamiento,before_sha256:hash(r)}))};return input;
}
test('four capillary C2/Ainhoa drafts preserve clinical warning and add LED only where already included',()=>{
 const input=capillaryFixture(),old=hash(input),pkg=prepare(input);verifyPackage(pkg);assert.equal(hash(input),old);
 assert.deepEqual(pkg.operations.map(o=>o.id),[1999,2001,2002,2003]);
 assert.deepEqual(pkg.operations.map(o=>o.after_config.booking_profile.phases[0].duration_minutes),[30,30,20,20]);
 for(const op of pkg.operations){const c=op.after_config,p=c.booking_profile.phases[0];
   assert.deepEqual(p.installation_ids,[75]);assert.deepEqual(p.professionals,{ids:[50],mode:'any',preferred_id:50});
   assert(c.import_issues.includes(WARNING));assert.equal(c.source_staff_confirmation.qualification_verified,false);
   assert.equal(c.fiscal_mapping_pending,true);assert.equal(c.catalog_status,'draft');
 }
 assert.deepEqual(pkg.operations[0].after_config.booking_profile.phases[0].equipment_requirements,[{equipment_ids:[15]}]);
 assert(pkg.operations.slice(1).every(o=>!o.after_config.booking_profile.phases[0].equipment_requirements?.length));
 const after=structuredClone(pkg.before);for(const op of pkg.operations)after.treatments.find(r=>r.id_tratamiento===op.id).clinical_config=op.after_config;
 verifyAfter(after,pkg);
});
for(const [name,edit]of [
 ['unsupported scope',x=>x.review.scope='all_capillary'],['another source row',x=>x.before.treatments[0].clinical_config.source_catalog.source_row=24],
 ['another fixed unit',x=>x.before.equipment[0].family_key='indiba_rf'],['room not permitted for Ainhoa',x=>x.before.rooms[0].profesionales_permitidos=[53]],
 ['capillary operation with body confirmation',x=>x.review.confirmation_reference=CONFIRMATION],
 ['PRP not approved by this scope',x=>x.before.treatments[0].id_tratamiento=2000],
])test('capillary scope rejects '+name,()=>{const x=capillaryFixture();edit(x);x.review.bindings=x.before.treatments.map(r=>({id:r.id_tratamiento,before_sha256:hash(r)}));assert.throws(()=>prepare(x),/PROVISIONAL_STAFF_/);});
test('prepares ONLY two inactive drafts, keeping the clinical warning, economics and annotations',()=>{
  const input=fixture(),original=structuredClone(input),pkg=prepare(input);verifyPackage(pkg);assert.deepEqual(input,original);
  assert.equal(pkg.operations.length,2);
  for(const op of pkg.operations){
    const c=op.after_config;assert.equal(c.catalog_status,'draft');assert(c.import_issues.includes(WARNING));assert(c.import_issues.includes('OTHER_REVIEW'));
    assert(!c.import_issues.includes('INSTALLATION_INACTIVE'));assert.equal(c.fiscal_mapping_pending,true);assert.equal(c.custom_human_note,'preserve me');
    assert.equal(c.source_staff_confirmation.qualification_verified,false);assert.equal(c.source_staff_confirmation.activation,false);
    assert.equal(c.source_staff_confirmation.existing_reservations_reconciled,false);assert.equal(c.booking_profile.phases[0].duration_minutes,10);
    assert.deepEqual(c.booking_profile.phases[0].professionals,{mode:'any',ids:[221],preferred_id:221});
  }
  assert.equal(pkg.operations[0].after_config.booking_profile.version,2);assert.deepEqual(pkg.operations[0].after_config.booking_profile.phases[0].equipment_requirements,[{equipment_ids:[12]}]);
  assert.deepEqual(pkg.operations[0].after_config.booking_profile.phases[0].installation_ids,[84]);
  assert.equal(pkg.operations[1].after_config.booking_profile.version,1);assert.deepEqual(pkg.operations[1].after_config.booking_profile.phases[0].installation_ids,[82]);
});
for(const [name,change] of [
  ['active treatment',x=>x.before.treatments[0].activo=1],
  ['different duration',x=>x.before.treatments[0].duracion_min=30],
  ['existing profile',x=>x.before.treatments[0].clinical_config.booking_profile={version:1}],
  ['unrelated act',x=>x.before.treatments[0].nombre='Bioestimulación'],
  ['clinical warning removed',x=>x.before.treatments[0].clinical_config.import_issues=[]],
  ['different source',x=>x.before.treatments[0].clinical_config.source_catalog.file_sha256='0'.repeat(64)],
  ['different source cabin',x=>x.before.treatments[0].clinical_config.source_cabin='9'],
  ['different clinic',x=>x.before.clinics[0].grupoClinicaId=1],
  ['used treatment',x=>x.before.appointments=[{id_cita:1,tratamiento_id:1973}]],
  ['inactive room',x=>x.before.rooms[0].activo=0],
  ['no room permission',x=>x.before.rooms[0].profesionales_permitidos=[]],
  ['inactive staff',x=>x.before.staff[0].activo=0],
  ['no staff schedule',x=>x.before.staff_hours=[]],
  ['wrong machine',x=>x.before.equipment[0].family_key='exion'],
  ['fixed machine moved',x=>x.before.equipment[0].home_installation_id=82],
  ['unconfirmed decision',x=>x.review.confirmation_reference='other'],
])test(`rejects ${name}`,()=>{const input=fixture();change(input);input.review.bindings=input.before.treatments.map(r=>({id:r.id_tratamiento,before_sha256:hash(r)}));assert.throws(()=>prepare(input),/PROVISIONAL_STAFF_/);});
test('stale row hashes, modified package and readback drift are rejected',()=>{
  const input=fixture();input.before.treatments[0].precio_base=99;assert.throws(()=>prepare(input),/TREATMENT_CHANGED/);
  const pkg=prepare(fixture()),after=structuredClone(pkg.before);
  after.treatments=after.treatments.map(r=>({...r,clinical_config:pkg.operations.find(o=>o.id===r.id_tratamiento).after_config,updatedAt:'2026-09-26 10:00:00'}));
  verifyAfter(after,pkg);const tampered=structuredClone(pkg);tampered.operations[0].after_config.catalog_status='active';assert.throws(()=>verifyPackage(tampered),/PACKAGE_CHANGED/);
  after.treatments[0].precio_base=99;assert.throws(()=>verifyAfter(after,pkg),/READBACK_MISMATCH/);
  after.treatments[0].precio_base=null;after.requirements=[];assert.throws(()=>verifyAfter(after,pkg),/UNRELATED_CHANGE/);
});

test('executor rolls back a full rehearsal, rejects stale replay, and rolls back a late second-row failure',async()=>{
  const {execute}=require('../cliniccloud-import-catalog-provisional-staff'),pkg=prepare(fixture());
  function database(initial,failSecond=false){
    let current=structuredClone(initial),saved;const updates=[];
    const tables={Clinicas:'clinics',Tratamientos:'treatments',Instalaciones:'rooms',InstalacionHorarios:'room_hours',DoctorClinicas:'staff',
      DoctorHorarios:'staff_hours',BookingEquipment:'equipment',BookingEquipmentClinics:'equipment_clinics',TreatmentConsentRequirements:'requirements',CitasPacientes:'appointments'};
    return{updates,state:()=>current,beginTransaction:async()=>{saved=structuredClone(current);},rollback:async()=>{if(saved)current=structuredClone(saved);},commit:async()=>{throw Error('Unexpected real commit');},
      query:async(sql,args)=>{
        if(sql.startsWith('SET '))return[];
        if(sql.startsWith('SELECT '))return[structuredClone(current[tables[sql.match(/FROM (\w+)/)[1]]])];
        assert(sql.startsWith('UPDATE Tratamientos SET clinical_config=?'));const [value,id]=args;
        if(failSecond&&id===1974)throw Error('SIMULATED_SECOND_ROW_FAILURE');
        updates.push(id);const row=current.treatments.find(t=>t.id_tratamiento===id);row.clinical_config=JSON.parse(value);row.updatedAt='2026-09-26 10:00:00';return[{affectedRows:1}];
      }};
  }
  const journal={append:async()=>{}},db=database(pkg.before);
  assert.equal((await execute({c:db,pkg,journal,dryRun:true})).status,'rolled_back_and_verified');assert.deepEqual(db.state(),pkg.before);assert.deepEqual(db.updates,[1973,1974]);
  const broken=database(pkg.before,true);await assert.rejects(execute({c:broken,pkg,journal,dryRun:true}),/SIMULATED_SECOND_ROW_FAILURE/);assert.deepEqual(broken.state(),pkg.before);
  const after=structuredClone(pkg.before);after.treatments.forEach(row=>{row.clinical_config=pkg.operations.find(o=>o.id===row.id_tratamiento).after_config;});
  const replay=database(after);assert.equal((await execute({c:replay,pkg,journal})).updated,0);assert.deepEqual(replay.updates,[]);
  after.treatments[0].activo=1;await assert.rejects(execute({c:database(after),pkg,journal}),/READBACK_MISMATCH/);
});
