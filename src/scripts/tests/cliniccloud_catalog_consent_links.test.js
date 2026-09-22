'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { buildCatalogPlan } = require('../../lib/cliniccloud-import/catalog');
const { treatmentDraft } = require('../../lib/cliniccloud-import/catalog-drafts');
const { prepareConsentLinks, verifyConsentLinks, verifyLinkedState } = require('../../lib/cliniccloud-import/catalog-consent-links');
const { execute, run } = require('../cliniccloud-import-catalog-consent-links');
function fixture() {
  const plan = buildCatalogPlan({ workbookHash:'a'.repeat(64), repliesHash:'b'.repeat(64), local:{ installations:[], professionals:[], treatments:[] },
    sheets:[{ name:'Tratamientos individuales', rows:[{ source_row:3, cells:{ A:'PEELING', B:'Peeling sintético', C:'30 min', D:'121 €', G:'7', H:'Dra. Camacho' } }] }] });
  const source = plan.rows[0];
  const treatment = { id_tratamiento:10, ...structuredClone(treatmentDraft(source)), createdAt:'2026-09-21', updatedAt:'2026-09-21' };
  const template = { id:99, clinic_id:72, name:'Consentimiento sintético de peeling', purpose:'clinical', status:'active', blocking_policy:'hard' };
  const version = { id:120, clinic_template_id:99, version:2, locale:'es', status:'published', body_html:'<p>El peeling sintético se aplica en la piel.</p>' };
  const before = { clinics:[{ id_clinica:66, grupo_clinica_id:29 },{ id_clinica:72, grupo_clinica_id:29 }],
    treatments:[treatment], templates:[template], versions:[version], requirements:[], appointments:[] };
  const review = { version:1, plan_sha256:plan.plan_sha256, scope:'inactive_draft_documentary_associations', bindings:[{
    source_catalog_key:source.source_catalog_key, treatment_sha256:hash(treatment), clinic_template_id:99, template_sha256:hash(template),
    version_id:120, version_sha256:hash(version), source_quote:'Peeling sintético', document_quote:'El peeling sintético se aplica en la piel.',
    reason:'Correspondencia documental explícita del procedimiento sintético; no implica aprobación clínica.' }] };
  return { plan, review, before, createdAt:'2026-09-22T00:30:00.000Z' };
}
const packageOf = f => prepareConsentLinks(f);
const linked = pkg => ({ ...structuredClone(pkg.before), requirements:pkg.desired.map((r,i)=>({ id:200+i,...r,createdAt:'2026-09-22',updatedAt:'2026-09-22' })) });
test('prepares only canonical associations, preserves all treatment/source/price/booking fields and does not sign or activate',()=>{
  const f=fixture(), prior=hash(f), p=packageOf(f);
  assert.equal(hash(f),prior);assert.equal(p.operations.length,1);assert.equal(p.operations[0].clinic_template_id,99);
  assert.equal(p.operations[0].blocking_policy,'hard');assert.equal(p.policy.clinical_approval,false);
  assert.equal(p.policy.patient_consents_created,false);assert.equal(p.policy.reminders_activated,false);
  verifyConsentLinks(p,f.plan);assert(verifyLinkedState(linked(p),p));
});
for(const [name,mutate,pattern] of [
  ['active treatment',f=>f.before.treatments[0].activo=1,/DRAFT_CHANGED/],
  ['not a draft',f=>f.before.treatments[0].clinical_config.catalog_status='active',/DRAFT_CHANGED/],
  ['other treatment clinic',f=>f.before.treatments[0].clinica_id=66,/DRAFT_CHANGED/],
  ['changed treatment name',f=>f.before.treatments[0].nombre='Nuevo nombre',/DRAFT_CHANGED/],
  ['changed treatment provenance',f=>f.before.treatments[0].clinical_config.source_catalog.row_sha256='0'.repeat(64),/DRAFT_CHANGED/],
  ['later price edit',f=>f.before.treatments[0].precio_base=42,/TREATMENT_REVIEW_STALE/],
  ['foreign template',f=>f.before.templates[0].clinic_id=66,/TEMPLATE_SCOPE/],
  ['demo template',f=>f.before.templates[0].name='DEMO - Peeling',/TEMPLATE_SCOPE/],
  ['marketing purpose',f=>f.before.templates[0].purpose='marketing_image',/TEMPLATE_SCOPE/],
  ['archived template',f=>f.before.templates[0].status='archived',/TEMPLATE_SCOPE/],
  ['changed template',f=>f.before.templates[0].name+=' editado',/TEMPLATE_REVIEW_STALE/],
  ['changed version',f=>f.before.versions[0].body_html+=' nuevo',/VERSION_REVIEW_STALE/],
  ['newer draft version',f=>f.before.versions.push({...f.before.versions[0],id:121,version:3,status:'draft'}),/VERSION_REVIEW_STALE/],
  ['other locale',f=>f.before.versions[0].locale='en',/VERSION_REVIEW_STALE/],
  ['missing documentary quote',f=>f.review.bindings[0].document_quote='No existe esta cita en el documento.',/EVIDENCE_REQUIRED/],
  ['missing source quote',f=>f.review.bindings[0].source_quote='Otro procedimiento',/EVIDENCE_REQUIRED/],
  ['missing reason',f=>f.review.bindings[0].reason='',/EVIDENCE_REQUIRED/],
  ['duplicate binding',f=>f.review.bindings.push({...f.review.bindings[0]}),/DUPLICATE_BINDING/],
  ['group drift',f=>f.before.clinics[0].grupo_clinica_id=30,/GROUP_CHANGED/],
  ['already used by an appointment',f=>f.before.appointments.push({id_cita:8,tratamiento_id:10}),/DRAFT_ALREADY_USED/],
  ['tampered plan',f=>f.plan.rows[0].name='Cambiado',/PLAN_INTEGRITY/],
  ['extra treatment',f=>f.before.treatments.push({...f.before.treatments[0],codigo:'other',id_tratamiento:11}),/SCOPE_MISMATCH/],
]) test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>packageOf(f),pattern);});
test('preserves existing identical relation including identity/timestamps; refuses unrelated, conditional or cross-clinic requirements',()=>{
  const f=fixture(), p=packageOf(f);f.before.requirements=linked(p).requirements;
  const again=packageOf(f);assert.equal(again.operations.length,0);assert.equal(again.preserved.length,1);
  for(const change of [{clinic_template_id:77},{clinica_id:66},{requirement_scope:'conditional'},{required:0}]){
    const other=structuredClone(f);Object.assign(other.before.requirements[0],change);
    assert.throws(()=>packageOf(other),/EXISTING_REQUIREMENTS/);
  }
  f.before.requirements.push({...f.before.requirements[0],id:201});assert.throws(()=>packageOf(f),/EXISTING_DUPLICATE/);
});
test('package recomputation detects tampering even after replacing the package checksum',()=>{
  const f=fixture(),p=packageOf(f);p.operations[0].required=0;const{package_sha256,...body}=p;p.package_sha256=hash(body);
  assert.throws(()=>verifyConsentLinks(p,f.plan),/PACKAGE_CHANGED/);
});
test('post-write comparison rejects template/price changes, missing/extra links, or modified old links',()=>{
  const p=packageOf(fixture());
  for(const mutate of [s=>s.treatments[0].precio_base=7,s=>s.templates[0].status='draft',s=>s.versions[0].version++,
    s=>s.requirements.pop(),s=>s.requirements.push({...s.requirements[0],id:400}),s=>s.requirements[0].required=0]){
    const state=linked(p);mutate(state);assert.throws(()=>verifyLinkedState(state,p),/CONSENT_LINK_/);
  }
  const f=fixture();f.before.requirements=linked(p).requirements;const existing=packageOf(f);
  const state=structuredClone(existing.before);state.requirements[0].id=900;
  assert.throws(()=>verifyLinkedState(state,existing),/EXISTING_CHANGED/);
});
function fakeConnection(initial, {failInsert=false}={}) {
  let state=structuredClone(initial), snapshot, writes=[];
  const tables={ Clinicas:'clinics',Tratamientos:'treatments',ClinicConsentTemplates:'templates',ClinicConsentTemplateVersions:'versions',TreatmentConsentRequirements:'requirements',CitasPacientes:'appointments' };
  return { writes,getState:()=>state,
    beginTransaction:async()=>{snapshot=structuredClone(state);},rollback:async()=>{if(snapshot)state=structuredClone(snapshot);},
    query:async(sql,args)=>{
      if(sql.startsWith('SET TRANSACTION'))return[[]];
      if(sql.startsWith('SELECT')){const name=Object.keys(tables).find(t=>sql.includes(' FROM '+t+' WHERE'));assert(name);return[structuredClone(state[tables[name]])];}
      assert(sql.startsWith('INSERT INTO TreatmentConsentRequirements SET ?'));writes.push({sql,args});
      if(failInsert)throw Error('TEST_INSERT_FAILURE');
      state.requirements.push({id:200,...args[0],createdAt:'now',updatedAt:'now'});return[{affectedRows:1,insertId:200}];
    } };
}
test('dry-run exercises parameterized insert and verifies rollback without commit',async()=>{
  const f=fixture(),pkg=packageOf(f),c=fakeConnection(pkg.before),events=[];
  const result=await execute({c,pkg,plan:f.plan,dryRun:true,journal:{append:async e=>events.push(e)}});
  assert.equal(result.status,'rolled_back_and_verified');assert.deepEqual(c.getState(),pkg.before);
  assert.equal(c.writes.length,1);assert.deepEqual(c.writes[0].args[0],pkg.operations[0]);
  assert.equal(events.at(-1).stage,'consent_links_dry_run_rolled_back');
});
test('exact replay writes nothing and SQL failure rolls back',async()=>{
  const f=fixture(),pkg=packageOf(f),journal={append:async()=>{}};
  const replay=fakeConnection(linked(pkg));const result=await execute({c:replay,pkg,plan:f.plan,journal});
  assert.equal(result.status,'replay_preserved');assert.equal(replay.writes.length,0);
  const broken=fakeConnection(pkg.before,{failInsert:true});await assert.rejects(execute({c:broken,pkg,plan:f.plan,journal}),/TEST_INSERT_FAILURE/);
  assert.deepEqual(broken.getState(),pkg.before);
});
test('refuses implicit CRM target and non-operator modes before accessing credentials',async()=>{
  await assert.rejects(run(['--mode','apply','--target','dev']),/EXPLICIT_CRM/);
  await assert.rejects(run(['--mode','activate','--target','crm']),/EXPLICIT_CRM/);
});
