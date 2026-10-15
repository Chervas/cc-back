'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {preparePatientIntake}=require('../../lib/patient-intake-consents');
function fixture({clinic=72,templates=[{id:90,blocking_policy:'hard'}],existing=false,published=true,version=null,document=null}={}){
 const writes=[],queries=[];const transaction={LOCK:{UPDATE:'UPDATE'}};
 const db={Sequelize:{Op:{in:Symbol('in'),or:Symbol('or'),gt:Symbol('gt')}},sequelize:{transaction:async cb=>cb(transaction)},
 Paciente:{findByPk:async(id,q)=>{assert.equal(q.lock,'UPDATE');return{id_paciente:id,clinica_id:clinic}}},
 Clinica:{findByPk:async()=>({id_clinica:clinic})},
 ClinicConsentTemplate:{findAll:async q=>{assert.deepEqual(q.where,{clinic_id:72,purpose:'data_protection',status:'active',is_default:true});return templates}},
 ClinicConsentTemplateVersion:{findOne:async q=>{assert.equal(q.where.status,'published');assert.equal(q.where.locale,'es');return published?(version||{id:312,body_html:'<p>Texto publicado</p>',locale:'es'}):null}},
 PatientConsentDocument:{findOne:async q=>{queries.push(q);return document||(existing?{id:800,status:'signed'}:null)},create:async(v,q)=>{assert.equal(q.transaction,transaction);writes.push(v)}},
 ConsentSignaturePackage:{findByPk:async()=>({id:700,status:'pending',expires_at:'2099-01-01'}),create:async(v,q)=>{assert.equal(q.transaction,transaction);writes.push(v);return{id:900,update:async x=>writes.push(x)}}}};
 return{db,writes,queries,run:()=>preparePatientIntake({db,patientId:82,clinicId:72,actorId:1,snapshot:()=>({snapshot_html:'<p>Publicado</p>',snapshot_json:{},snapshot_hash:'hash'})})};
}
test('prepares only published default data-protection templates without a treatment, appointment or delivery',async()=>{const f=fixture();const r=await f.run();assert.equal(r.created_count,1);assert.equal(f.writes[0].trigger_source,'patient_intake');assert.equal(f.writes[1].cita_id,null);assert.equal(f.writes[1].tratamiento_id,null);assert.equal(f.writes[1].status,'pending');assert.deepEqual(f.writes[2],{required_count:1,signed_count:0});});
test('repeated preparation preserves the existing pending or signed document',async()=>{const f=fixture({existing:true});const r=await f.run();assert.equal(r.created_count,0);assert.equal(r.existing_count,1);assert.equal(f.writes.length,0)});
test('clinic drift fails closed before reading templates or writing a package',async()=>{const f=fixture({clinic:66});await assert.rejects(f.run(),/patient_clinic_changed/);assert.equal(f.writes.length,0)});
test('no active templates or published version fails without creating an empty package',async()=>{for(const config of [{templates:[]},{published:false}]){const f=fixture(config);await assert.rejects(f.run(),/intake_published_templates_required/);assert.equal(f.writes.length,0)}});
test('nonmandatory onboarding documents stay optional',async()=>{const f=fixture({templates:[{id:92,blocking_policy:'optional'}]});await f.run();assert.equal(f.writes[1].required,false);assert.equal(f.writes[2].required_count,0)});

const choices=require('../../lib/consent-document-choices');
function interactiveFixture(patch={}){
 const form={schema_version:choices.CHOICE_SCHEMA_VERSION,fields:choices.CHOICE_KEYS.map(key=>({key,type:'yes_no',required:true,label:choices.CHOICE_LABELS[key]}))};
 const template={id:90,clinic_id:72,blocking_policy:'hard'};
 const version={id:312,body_html:'<p>Texto publicado</p>',locale:'es',body_json:{consent_form:form}};
 const document={id:800,package_id:700,status:'signed',signed_at:'2026-01-01',snapshot_html:'<p>LOPD final firmada</p>',snapshot_json:{template:{id:90,clinic_id:72},version,integrity:{algorithm:choices.CHOICE_HASH_ALGORITHM},
  signature_evidence:{accepted_statement:true,signed_at:'2026-01-01',consent_choices:{schema_version:choices.CHOICE_SCHEMA_VERSION,answers:Object.fromEntries(choices.CHOICE_KEYS.map(key=>[key,'no']))}}},...patch};
 if(!Object.hasOwn(patch,'snapshot_hash'))document.snapshot_hash=choices.choiceSnapshotHash(document.snapshot_json,document.snapshot_html);
 return fixture({templates:[template],version,document});
}
test('valid interactive privacy with four explicit No answers is reused without forcing another signature',async()=>{
 const f=interactiveFixture(),r=await f.run();assert.equal(r.created_count,0);assert.equal(r.privacy_signed,true);assert.deepEqual(r.current_package_ids,[700]);assert.equal(f.writes.length,0);
});
test('invalid signed privacy is replaced even if its package is still available',async()=>{
 for(const patch of [{revoked_at:'2026-02-01'},{signed_at:null},{snapshot_json:{}},{snapshot_json:{version:{id:312}}},{snapshot_hash:'a'.repeat(64)}]){
  const f=interactiveFixture(patch),r=await f.run();assert.equal(r.created_count,1);assert.equal(r.privacy_signed,false);assert.equal(r.existing_count,0);assert.deepEqual(r.current_package_ids,[900]);
 }
});
test('pending privacy missing the frozen current choice form is replaced, not offered for incomplete signing',async()=>{
 const f=interactiveFixture({status:'pending',signed_at:null,snapshot_json:{template:{id:90,clinic_id:72},version:{id:312}}});
 const r=await f.run();assert.equal(r.created_count,1);assert.equal(r.existing_count,0);
});
test('pending current privacy with frozen choices reuses its available package',async()=>{
 const f=interactiveFixture({status:'pending',signed_at:null}),r=await f.run();assert.equal(r.created_count,0);assert.equal(r.privacy_signed,false);assert.deepEqual(r.current_package_ids,[700]);
});
