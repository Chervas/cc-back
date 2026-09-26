'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { prepare, verifyPackage, verifyAfter, initialNotice } = require('../../lib/cliniccloud-import/catalog-simple-activation');
const { BATCH } = require('../../lib/cliniccloud-import/catalog-drafts');
const { execute, run } = require('../cliniccloud-import-catalog-simple-activation');

function fixture() {
  const source = { kind:'treatment', sheet:'Facial · tratamientos', proposed_code:'test', source_catalog_key:'source',
    provenance:{file_sha256:'a'.repeat(64)}, display_name:'Modalidad de prueba', duration_info:{mode:'fixed',minutes:30},
    source_price:{mode:'fixed',gross_amount:120,includes_tax:true} };
  const body = {version:1, mode:'catalog_dry_run_only', clinics:{medical:72,capilar:66},workbook_sha256:'a'.repeat(64),rows:[source]};
  const plan = {...body,plan_sha256:hash(body)};
  const priceProfile = {schema_version:1,price_semantics:'gross_tax_included',tax_percent:21,exemption_reason:null};
  const treatment = {id_tratamiento:7,nombre:source.display_name,codigo:'test',clinica_id:72,origen:'clinica',activo:0,
    precio_base:'120.00',duracion_min:30,sesiones_defecto:1,descripcion:'Anotación conservada.\n'+initialNotice,updatedAt:'2030-01-01',
    clinical_config:{catalog_status:'draft',import_batch:BATCH,product_type:'treatment',medical_area_code:'estetica',
      source_catalog_key:'source',source_catalog:source.provenance,import_issues:['INSTALLATION_INACTIVE'],
      fiscal_mapping_pending:false,price_profile:priceProfile,imported_price_review:{gross_amount:120,price_profile:priceProfile},
      booking_profile:{version:1,phases:[{key:'p1',duration_minutes:30,installation_ids:[80],professionals:{mode:'any',ids:[53],preferred_id:53}}]}}};
  const before = {clinics:[{id_clinica:72,grupo_clinica_id:29}],treatments:[treatment],appointments:[],
    rooms:[{id:80,clinica_id:72,activo:1,capacidad:1,tipo:'consulta',tiempo_preparacion_minutos:0,profesionales_permitidos:[53]}],
    staff:[{id:23,doctor_id:53,clinica_id:72,activo:1,recibe_citas:1,rol_en_clinica:'Doctores'}],
    staff_hours:[{doctor_clinica_id:23,activo:1,hora_inicio:'10:00',hora_fin:'14:00'}],
    room_hours:[{instalacion_id:80,activo:1,hora_inicio:'10:00',hora_fin:'14:00'}],
    requirements:[{tratamiento_id:7,clinica_id:72,clinic_template_id:93,requirement_scope:'treatment',condition_key:null,required:1,blocking_policy:'hard'}],
    templates:[{id:93,clinic_id:72,purpose:'clinical',status:'active',blocking_policy:'hard',name:'Consentimiento de prueba'}],
    versions:[{id:10,clinic_template_id:93,version:1,status:'published',locale:'es',body_html:'<p>Documento sintético de prueba</p>'}]};
  const review = {version:1,scope:'reviewed_simple_facial_catalogue',plan_sha256:plan.plan_sha256,
    bindings:[{id:7,before_sha256:hash(treatment),reason:'Configuración individual simple revisada expresamente en esta prueba aislada.'}]};
  return {plan,review,before,createdAt:'2030-01-01T00:00:00Z'};
}
const rehash = f => { f.review.bindings[0].before_sha256=hash(f.before.treatments[0]); return f; };

function equipmentFixture(family = 'exion') {
  const f = fixture(), source = f.plan.rows[0], t = f.before.treatments[0];
  source.sheet = 'Tratamientos individuales'; source.provenance.source_row = family === 'exion' ? 21 : 18;
  source.source_price.gross_amount = 90; source.duration_info.minutes = 45;
  const { plan_sha256, ...body } = f.plan; f.plan.plan_sha256 = hash(body); f.review.plan_sha256 = f.plan.plan_sha256;
  f.review.scope = 'reviewed_single_equipment_cosmetic_catalogue';
  t.precio_base = '90.00'; t.duracion_min = 45;
  const config = t.clinical_config; config.imported_price_review.gross_amount = 90;
  config.booking_profile.version = 2;
  Object.assign(config.booking_profile.phases[0], { duration_minutes:45, professionals:{ mode:'any', ids:[221], preferred_id:221 }, equipment_requirements:[{ equipment_ids:[4] }] });
  Object.assign(f.before.rooms[0], { tipo:'box', profesionales_permitidos:[221] });
  Object.assign(f.before.staff[0], { doctor_id:221, rol_en_clinica:'Auxiliares y enfermeros' });
  f.before.equipment = { clinics:[{ id_clinica:72, equipment_booking_enabled:1 }],
    units:[{ id:4, owner_clinic_id:72, group_id:29, family_key:family, status:'available', turnaround_minutes:0,
      mobility:family === 'exion' ? 'mobile' : 'fixed', home_installation_id:family === 'exion' ? null : 80 }],
    shares:[{ equipment_id:4, clinic_id:72 }], aliases:[], policies:[{ installation_id:80, mode:'selected', equipment_ids:[4] }] };
  return rehash(f);
}

test('separate reviewed body scope preserves one fixed/mobile unit and confirmed operator', () => {
  for (const family of ['exion','indiba_rf']) {
    const f = equipmentFixture(family), pkg = prepare(f);
    assert.equal(pkg.operations[0].after.activo, 1);
    assert.deepEqual(pkg.operations[0].after.clinical_config.booking_profile, f.before.treatments[0].clinical_config.booking_profile);
    verifyPackage(pkg, f.plan);
    assert(verifyAfter({ ...f.before, treatments:pkg.operations.map(o=>o.after) }, pkg));
  }
});
test('body scope rejects unrelated/combined source, price or duration changes', () => {
  for (const change of [f=>{ f.plan.rows[0].provenance.source_row=22; },
    f=>{ f.before.treatments[0].duracion_min=30; }, f=>{ f.before.treatments[0].precio_base='91.00'; }]) {
    const f=equipmentFixture();change(f);const {plan_sha256,...body}=f.plan;f.plan.plan_sha256=hash(body);f.review.plan_sha256=f.plan.plan_sha256;
    assert.throws(()=>prepare(rehash(f)));
  }
});
test('body activation fails closed for equipment, clinic, physical room and personal eligibility', () => {
  for (const mutate of [b=>b.equipment.units[0].status='maintenance', b=>b.equipment.units[0].turnaround_minutes=5,
    b=>b.equipment.units[0].owner_clinic_id=66, b=>b.equipment.units[0].family_key='indiba_ona',
    b=>b.equipment.units.push({...b.equipment.units[0],id:5}), b=>b.equipment.shares=[],
    b=>b.equipment.clinics[0].equipment_booking_enabled=0, b=>b.equipment.policies[0].mode='none',
    b=>b.equipment.aliases.push({installation_id:80,canonical_installation_id:999}),
    b=>b.staff[0].doctor_id=999, b=>b.requirements=[], b=>b.rooms[0].activo=0]) {
    const f=equipmentFixture();mutate(f.before);assert.throws(()=>prepare(f));
  }
  const fixed=equipmentFixture('indiba_rf');fixed.before.equipment.units[0].home_installation_id=999;
  assert.throws(()=>prepare(fixed),/EQUIPMENT_PENDING/);
});
test('equipment dependencies remain protected during readback and replay', () => {
  const f=equipmentFixture(),pkg=prepare(f),after={...f.before,treatments:pkg.operations.map(o=>o.after)};
  after.equipment=structuredClone(after.equipment);after.equipment.policies[0].mode='none';
  assert.throws(()=>verifyAfter(after,pkg),/DEPENDENCIES_CHANGED/);
});

test('activation preserves price, profile, source, consents and clinical annotation', () => {
  const f=fixture(), pkg=prepare(f), after=pkg.operations[0].after;
  assert.equal(after.activo,1); assert.equal(after.clinical_config.catalog_status,'active');
  assert.equal(after.descripcion,'Anotación conservada.'); assert.deepEqual(after.clinical_config.import_issues,[]);
  assert.equal(after.precio_base,'120.00'); assert.deepEqual(after.clinical_config.booking_profile,f.before.treatments[0].clinical_config.booking_profile);
  assert.equal(pkg.policy.clinical_approval,false); assert.equal(pkg.policy.reminders_activated,false);
  verifyPackage(pkg,f.plan);
  assert.equal(verifyAfter({...f.before,treatments:[{...after,updatedAt:'2030-01-02'}]},pkg),true);
});
test('rejects changed workbook or stale row review', () => {
  const f=fixture(); f.plan.rows[0].display_name='changed'; assert.throws(()=>prepare(f),/PLAN_INTEGRITY/);
  const g=fixture(); g.before.treatments[0].nombre='changed'; assert.throws(()=>prepare(g),/DRAFT_CHANGED/);
});
test('never activates pending tax, changed price, missing fiscal profile or old active rows', () => {
  for(const mutate of [t=>t.clinical_config.fiscal_mapping_pending=true,t=>t.precio_base=null,
    t=>t.precio_base='121.00',t=>delete t.clinical_config.price_profile,t=>t.activo=1]) {
    const f=fixture(); mutate(f.before.treatments[0]); assert.throws(()=>prepare(rehash(f)));
  }
});
test('does not activate equipment, multi-phase, missing duration or ambiguous profiles', () => {
  for(const mutate of [t=>t.clinical_config.booking_profile.version=2,
    t=>t.duracion_min=null,t=>t.clinical_config.booking_profile.phases.push({...t.clinical_config.booking_profile.phases[0],key:'p2'}),
    t=>t.clinical_config.booking_profile.phases[0].professionals.ids.push(99),
    t=>t.clinical_config.booking_profile.phases[0].equipment_requirements=[{equipment_ids:[5]}]]) {
    const f=fixture();mutate(f.before.treatments[0]);assert.throws(()=>prepare(rehash(f)));
  }
});
test('a retired room, absent/unauthorized doctor, non-doctor or no schedule blocks this cut', () => {
  for(const mutate of [b=>b.rooms[0].activo=0,b=>b.rooms[0].profesionales_permitidos=[],
    b=>b.staff[0].recibe_citas=0,b=>b.staff[0].rol_en_clinica='Auxiliar',b=>b.staff_hours=[],b=>b.room_hours=[]]) {
    const f=fixture();mutate(f.before);assert.throws(()=>prepare(f),/RESOURCES_PENDING/);
  }
});
test('consents must remain in scope, hard-required and latest published version', () => {
  for(const mutate of [b=>b.requirements=[],b=>b.requirements[0].blocking_policy='optional',
    b=>b.templates[0].clinic_id=66,b=>b.templates[0].status='inactive',b=>b.versions[0].status='draft',
    b=>b.versions.push({...b.versions[0],id:11,version:2,status:'draft'})]) {
    const f=fixture();mutate(f.before);assert.throws(()=>prepare(f),/CONSENT_PENDING/);
  }
});
test('a source issue, clinical description edit or already-used draft requires fresh review', () => {
  const f=fixture();f.before.appointments.push({id_cita:1,tratamiento_id:7});assert.throws(()=>prepare(f),/ALREADY_USED/);
  for(const mutate of [t=>t.clinical_config.import_issues.push('QUANTITY_REQUIRED'),t=>t.descripcion='Edited by clinic']) {
    const g=fixture();mutate(g.before.treatments[0]);assert.throws(()=>prepare(rehash(g)));
  }
});
test('readback/replay rejects collateral data changes and never erases a later edit', () => {
  const f=fixture(),pkg=prepare(f),after={...f.before,treatments:[pkg.operations[0].after]};
  const changed=structuredClone(after);changed.treatments[0].precio_base='121.00';assert.throws(()=>verifyAfter(changed,pkg),/AFTER_CHANGED/);
  const dependency=structuredClone(after);dependency.templates[0].status='inactive';assert.throws(()=>verifyAfter(dependency,pkg),/DEPENDENCIES_CHANGED/);
  pkg.operations[0].after.clinical_config.booking_profile.phases[0].duration_minutes=15;assert.throws(()=>verifyPackage(pkg,f.plan));
});

function fakeConnection(initial, failUpdate=false) {
  let state=structuredClone(initial), saved;
  const writes=[],tables={Clinicas:'clinics',Tratamientos:'treatments',Instalaciones:'rooms',DoctorClinicas:'staff',
    InstalacionHorarios:'room_hours',DoctorHorarios:'staff_hours',TreatmentConsentRequirements:'requirements',
    ClinicConsentTemplates:'templates',ClinicConsentTemplateVersions:'versions',CitasPacientes:'appointments'};
  return {writes,getState:()=>state,beginTransaction:async()=>{saved=structuredClone(state);},
    rollback:async()=>{if(saved)state=structuredClone(saved);},
    query:async(sql,args)=>{
      if(sql.startsWith('SET TRANSACTION'))return[[]];
      if(sql.startsWith('SELECT')){
        if(sql.startsWith('SELECT id_clinica,equipment_booking_enabled'))return[structuredClone(state.equipment.clinics)];
        for(const [fragment,key] of [['FROM BookingEquipment WHERE','units'],['FROM BookingEquipmentClinics WHERE','shares'],
          ['FROM InstallationPhysicalAliases WHERE','aliases'],['FROM BookingEquipmentRoomPolicies p','policies']]) {
          if(sql.includes(fragment))return[structuredClone(state.equipment[key])];
        }
        const table=Object.keys(tables).find(t=>sql.includes(' FROM '+t+' WHERE'));assert(table);return[structuredClone(state[tables[table]])];
      }
      assert(sql.startsWith('UPDATE Tratamientos SET activo=1,clinical_config=?,descripcion=?'));writes.push({sql,args});
      if(failUpdate)throw Error('TEST_UPDATE_FAILURE');
      Object.assign(state.treatments.find(t=>t.id_tratamiento===args[2]),{activo:1,clinical_config:JSON.parse(args[0]),descripcion:args[1],updatedAt:'later'});
      return[{affectedRows:1}];
    }};
}
test('dry-run executes parameterized updates under lock, then verifies a complete rollback',async()=>{
  const pkg=prepare(fixture()),c=fakeConnection(pkg.before),events=[];
  const result=await execute({c,pkg,dryRun:true,journal:{append:async e=>events.push(e)}});
  assert.equal(result.status,'rolled_back_and_verified');assert.equal(c.writes.length,1);
  assert.deepEqual(c.getState(),pkg.before);assert.equal(events.at(-1).stage,'activation_dry_run_rolled_back');
});
test('exact replay writes nothing, a later edit is rejected and SQL failures roll back',async()=>{
  const pkg=prepare(fixture()),journal={append:async()=>{}};
  const c=fakeConnection({...pkg.before,treatments:pkg.operations.map(o=>o.after)});
  assert.equal((await execute({c,pkg,journal})).status,'replay_preserved');assert.equal(c.writes.length,0);
  const edited=structuredClone(pkg.before);edited.treatments[0].nombre='Clinic edit';
  await assert.rejects(execute({c:fakeConnection(edited),pkg,journal}),/AFTER_CHANGED/);
  const broken=fakeConnection(pkg.before,true);await assert.rejects(execute({c:broken,pkg,journal}),/TEST_UPDATE_FAILURE/);
  assert.deepEqual(broken.getState(),pkg.before);
});
test('implicit target or unsupported mode fail before credential access',async()=>{
  await assert.rejects(run(['--mode','apply','--target','dev']),/EXPLICIT_CATALOG/);
  await assert.rejects(run(['--mode','activate','--target','crm']),/EXPLICIT_CATALOG/);
});
test('body activation captures equipment dependencies under lock and rolls back/replays without collateral writes',async()=>{
  const pkg=prepare(equipmentFixture()),c=fakeConnection(pkg.before),journal={append:async()=>{}};
  assert.equal((await execute({c,pkg,dryRun:true,journal})).status,'rolled_back_and_verified');
  assert.deepEqual(c.getState(),pkg.before);
  const replay=fakeConnection({...pkg.before,treatments:pkg.operations.map(o=>o.after)});
  assert.equal((await execute({c:replay,pkg,journal})).status,'replay_preserved');
  assert.equal(replay.writes.length,0);
});
