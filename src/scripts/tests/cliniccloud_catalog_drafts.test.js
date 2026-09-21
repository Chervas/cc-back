'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { buildCatalogPlan } = require('../../lib/cliniccloud-import/catalog');
const { areaFor, treatmentDraft, prepareDraftPackage, verifyDraftPackage } = require('../../lib/cliniccloud-import/catalog-drafts');
const { verifyResources, insertDraft, run } = require('../cliniccloud-import-catalog-drafts');
function fixture({ cabins='8', duration='30 min', name='Sesión sintética', category='EXION BODY' }={}) {
  const local = { installations:[{ id:81,clinic_id:72,name:'C8',active:false }],
    professionals:[{ id:221,clinic_id:72,name:'Piedad',active:true,receives_appointments:true }], treatments:[] };
  return buildCatalogPlan({ workbookHash:'a'.repeat(64),repliesHash:'b'.repeat(64),local,
    resourceMap:{ cabins_by_clinic:{72:{C8:81}},professionals:{'Aux. Piedad':221} },
    sheets:[{name:'Tratamientos individuales',rows:[{source_row:2,cells:{A:category,B:name,C:duration,D:'121 €',G:cabins,H:'Aux. Piedad'}}]}] });
}
const before=()=>({treatments:[],installations:[{id:81,clinica_id:72,activo:0}],professionals:[{id:20,doctor_id:221,clinica_id:72,activo:1,recibe_citas:1}]});
test('prepares individual with inactive real room, known duration and professional, not a sellable activation',()=>{
  const pkg=prepareDraftPackage({plan:fixture(),before:before()});const v=pkg.operations[0].values;
  assert.equal(v.activo,0);assert.equal(v.precio_base,null);assert.equal(v.clinical_config.fiscal_mapping_pending,true);
  assert.equal(v.clinical_config.source_price.gross_amount,121);assert.equal(v.clinical_config.price_profile,undefined);
  assert.deepEqual(v.clinical_config.booking_profile.phases[0].installation_ids,[81]);
  assert.equal(v.clinical_config.booking_profile.phases[0].professionals.preferred_id,221);
  assert.equal(v.appointment_automation_template_key,null);assert.equal(v.automation_template_bindings,null);
  assert.equal(v.clinica_id,72);verifyResources(v,before());
});
test('never flattens several rooms, unknown durations or unvalidated injectable staff into a bookable profile',()=>{
  for(const options of [{cabins:'11 y 8'},{duration:'30-45 min'},{category:'INYECTABLES CORPORALES',name:'Mesoterapia lipolítica'}]){
    const row=fixture(options).rows[0],v=treatmentDraft(row);assert.equal(v.clinical_config.booking_profile,undefined);
    assert.equal(v.activo,0);assert(v.clinical_config.import_issues.length);
  }
});
test('keeps included/from amounts and administrative source details, never turns them into free treatment',()=>{
  const row=fixture().rows[0];row.source_price={mode:'included',gross_amount:null,includes_tax:true};
  row.proposed_clinical_config.source_price=row.source_price;
  row.detail='Incluido en una compra previa';const v=treatmentDraft(row);
  assert.equal(v.precio_base,null);assert.equal(v.clinical_config.source_detail,row.detail);
});
test('clinical areas coexist: hair in its clinic, nutrition/psychology not dental or generic aesthetics',()=>{
  assert.equal(areaFor({sheet:'Capilar · sesiones y bonos'}),'capilar');
  for(const [category,area]of [['Nutrición','nutricion'],['Psicología','psicologia'],['Psiconutrición','psicologia'],['Cirugía bariátrica','cirugia_digestiva'],['Medicina','general']])
    assert.equal(areaFor({sheet:'Obesidad · tarifa',category}),area);
  const row=fixture().rows[0];row.sheet='Capilar · sesiones y bonos';assert.throws(()=>treatmentDraft(row),/CATALOG_ROW_NOT_AN_INDIVIDUAL/);
});
test('rejects programs, source code collisions, altered plan and tampered operation even with recomputed package hash',()=>{
  const plan=fixture(),row=plan.rows[0];assert.throws(()=>treatmentDraft({...row,kind:'program'}),/CATALOG_ROW_NOT_AN_INDIVIDUAL/);
  const altered=structuredClone(plan);altered.rows[0].price='1 €';assert.throws(()=>prepareDraftPackage({plan:altered,before:before()}),/CATALOG_PLAN_INTEGRITY/);
  const pkg=prepareDraftPackage({plan,before:before()});verifyDraftPackage(pkg,plan);
  pkg.operations[0].values.activo=1;const{package_sha256,...body}=pkg;pkg.package_sha256=hash(body);
  assert.throws(()=>verifyDraftPackage(pkg,plan),/CATALOG_DRAFT_PACKAGE_CHANGED/);
});
test('existing reviewed examples preserved without replacing user configuration; wrong clinic/provenance rejected',()=>{
  const plan=fixture(),row=plan.rows[0],state=before();state.treatments=[{id_tratamiento:9,codigo:row.proposed_code,clinica_id:72,activo:0,
    nombre:'Edición humana conservada',clinical_config:{source_catalog:row.provenance,custom:true}}];
  const pkg=prepareDraftPackage({plan,before:state});assert.equal(pkg.operations.length,0);assert.equal(pkg.preserved[0].id,9);
  state.treatments[0].clinica_id=66;assert.throws(()=>prepareDraftPackage({plan,before:state}),/EXISTING_SOURCE/);
  state.treatments.push({...state.treatments[0]});assert.throws(()=>prepareDraftPackage({plan,before:state}),/DUPLICATE_LOCAL_CODE/);
});
test('resources cannot cross clinic scope or ambiguous memberships',()=>{
  const v=treatmentDraft(fixture().rows[0]),state=before();state.installations[0].clinica_id=66;
  assert.throws(()=>verifyResources(v,state),/ROOM_SCOPE_CHANGED/);state.installations[0].clinica_id=72;
  state.professionals.push({...state.professionals[0],id:21});assert.throws(()=>verifyResources(v,state),/STAFF_SCOPE_CHANGED/);
});
test('SQL writer parameterizes payload, preserves private provenance and never invokes appointments or workflow',async()=>{
  const v=treatmentDraft(fixture({name:"Sintético ' ? ; DROP TABLE QA"}).rows[0]);let query;
  const result=await insertDraft({query:async(sql,values)=>{query={sql,values};return[{affectedRows:1,insertId:7}]}},{values:v},'c'.repeat(64));
  assert(!query.sql.includes('DROP'));assert.equal(result.values.clinical_config.catalog_import_package,'c'.repeat(64));
  assert.equal(query.values[0],v.nombre);assert.equal(result.id,7);
  await assert.rejects(run(['--mode','apply','--target','dev']),/EXPLICIT_CRM_CATALOG_MODE_REQUIRED/);
});
