'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {preparePatientIntake}=require('../../lib/patient-intake-consents');
function fixture({clinic=72,templates=[{id:90,blocking_policy:'hard'}],existing=false,published=true}={}){
 const writes=[],queries=[];const transaction={LOCK:{UPDATE:'UPDATE'}};
 const db={Sequelize:{Op:{in:Symbol('in'),or:Symbol('or'),gt:Symbol('gt')}},sequelize:{transaction:async cb=>cb(transaction)},
 Paciente:{findByPk:async(id,q)=>{assert.equal(q.lock,'UPDATE');return{id_paciente:id,clinica_id:clinic}}},
 Clinica:{findByPk:async()=>({id_clinica:clinic})},
 ClinicConsentTemplate:{findAll:async q=>{assert.deepEqual(q.where,{clinic_id:72,purpose:'data_protection',status:'active',is_default:true});return templates}},
 ClinicConsentTemplateVersion:{findOne:async q=>{assert.equal(q.where.status,'published');assert.equal(q.where.locale,'es');return published?{id:312,body_html:'<p>Texto publicado</p>',locale:'es'}:null}},
 PatientConsentDocument:{findOne:async q=>{queries.push(q);return existing?{id:800,status:'signed'}:null},create:async(v,q)=>{assert.equal(q.transaction,transaction);writes.push(v)}},
 ConsentSignaturePackage:{create:async(v,q)=>{assert.equal(q.transaction,transaction);writes.push(v);return{id:900,update:async x=>writes.push(x)}}}};
 return{db,writes,queries,run:()=>preparePatientIntake({db,patientId:82,clinicId:72,actorId:1,snapshot:()=>({snapshot_html:'<p>Publicado</p>',snapshot_json:{},snapshot_hash:'hash'})})};
}
test('prepares only published default data-protection templates without a treatment, appointment or delivery',async()=>{const f=fixture();const r=await f.run();assert.equal(r.created_count,1);assert.equal(f.writes[0].trigger_source,'patient_intake');assert.equal(f.writes[1].cita_id,null);assert.equal(f.writes[1].tratamiento_id,null);assert.equal(f.writes[1].status,'pending');assert.deepEqual(f.writes[2],{required_count:1,signed_count:0});});
test('repeated preparation preserves the existing pending or signed document',async()=>{const f=fixture({existing:true});const r=await f.run();assert.equal(r.created_count,0);assert.equal(r.existing_count,1);assert.equal(f.writes.length,0)});
test('clinic drift fails closed before reading templates or writing a package',async()=>{const f=fixture({clinic:66});await assert.rejects(f.run(),/patient_clinic_changed/);assert.equal(f.writes.length,0)});
test('no active templates or published version fails without creating an empty package',async()=>{for(const config of [{templates:[]},{published:false}]){const f=fixture(config);await assert.rejects(f.run(),/intake_published_templates_required/);assert.equal(f.writes.length,0)}});
test('nonmandatory onboarding documents stay optional',async()=>{const f=fixture({templates:[{id:92,blocking_policy:'optional'}]});await f.run();assert.equal(f.writes[1].required,false);assert.equal(f.writes[2].required_count,0)});
