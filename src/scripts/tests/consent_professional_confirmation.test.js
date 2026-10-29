'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const {signatureProgress}=require('../../lib/consent-signature-progress');
const filename=require.resolve('../../services/consentimientos.service');
const HASH='a'.repeat(64),clone=value=>JSON.parse(JSON.stringify(value));
function harness(options={}){
 let doc={id:1,public_id:'qa_synthetic_professional',package_id:1,paciente_id:2,clinica_id:72,status:'signed',required:true,purpose:'clinical',
  signed_at:'2020-01-01T10:00:00Z',snapshot_hash:HASH,snapshot_html:'<p>Documento ficticio de prueba</p>',
  snapshot_json:{template:{requires_professional_signature:true},context:{profesional:{id:99,nombre:'Profesional indicado al emitir'}},signature_evidence:{signer_name:'Paciente ficticio',signed_at:'2020-01-01T10:00:00Z'}},...options.document};
 let pack={id:1,status:'pending',clinica_id:72,...options.package};const events=[],queries=[];
 let serial=Promise.resolve();
 const db={Sequelize:{Op:{notIn:Symbol('notIn')}},
  Usuario:{findByPk:async id=>options.inactive?{id_usuario:id,estado_cuenta:'inactivo'}:{id_usuario:id,nombre:'Firmante',apellidos:String(id),estado_cuenta:'activo',isProfesional:!options.genericAssistant}},
  UsuarioClinica:{findOne:async query=>{queries.push(query);return options.foreign||options.noMembership?null:{rol_clinica:options.admin?'propietario':'personaldeclinica',subrol_clinica:options.admin?'Administrativos':options.genericAssistant?'Auxiliares y enfermeros':'Doctores',estado_invitacion:'aceptada'};}},
  DoctorClinica:{findOne:async query=>{queries.push(query);return options.noClinicalLink||options.admin?null:{doctor_id:query.where.doctor_id,clinica_id:query.where.clinica_id,activo:true};}},
  PatientConsentDocument:{findByPk:async()=>clone(doc),findAll:async()=>[clone(doc)],update:async(values,{where})=>{
    if(where.snapshot_hash!==doc.snapshot_hash || doc.professional_signed_at || doc.revoked_at)return[0];Object.assign(doc,clone(values));return[1];}},
  ConsentSignaturePackage:{findByPk:async()=>clone(pack),update:async values=>Object.assign(pack,clone(values))},PatientIntakeRequest:{findOne:async()=>null},
  ConsentDeliveryEvent:{create:async event=>{if(options.eventFailure)throw Error('SYNTHETIC_EVENT_FAILURE');events.push(clone(event));}},
  sequelize:{transaction:async(_settings,work)=>{let release;const previous=serial;serial=new Promise(resolve=>{release=resolve;});await previous;
   if(options.beforeTransaction){options.beforeTransaction(doc,pack);options.beforeTransaction=null;}
   const before=clone(doc),previousPack=clone(pack),size=events.length;
   try{return await work({LOCK:{UPDATE:'UPDATE',SHARE:'SHARE'}});}catch(error){doc=before;pack=previousPack;events.length=size;throw error;}finally{release();}}},
 };
 const native=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:name=>name==='../../models'?db:native(name),__dirname:path.dirname(filename),process:{env:{}},Buffer,console});
 return{service:module.exports,events,queries,doc:()=>clone(doc),pack:()=>clone(pack),payload:(hash=HASH)=>({accepted_statement:true,expected_snapshot_hash:hash})};
}
test('professional signs explicitly in their own authenticated identity, preserves patient evidence/context, and PDF uses actual signer',async()=>{
 const h=harness(),before=h.doc();const preview=await h.service.getProfessionalSigningContext(1,17);
 assert.equal(preview.actor.name,'Firmante 17');assert.equal(preview.document.snapshot_hash,HASH);assert.match(preview.statement,/informado personalmente/);
 const signed=await h.service.signProfessionalConsentDocument(1,{...h.payload(),professional_name:'Nombre falsificado'},17);
 assert.equal(signed.professional_signed_by,17);assert.equal(signed.snapshot_json.professional_signature_evidence.professional_name,'Firmante 17');
 assert.deepEqual(signed.snapshot_json.context,before.snapshot_json.context);assert.deepEqual(signed.snapshot_json.signature_evidence,before.snapshot_json.signature_evidence);
 assert.equal(signed.snapshot_html,before.snapshot_html);assert.equal(signed.signature_progress.complete,true);
 const html=await h.service.renderConsentDocument(1);assert.match(html,/<dt>Profesional<\/dt><dd>Firmante 17<\/dd>/);
 assert.equal(h.events.length,1);assert.equal(h.events[0].event_payload.evidence.snapshot_hash_before_signature,HASH);
 assert(h.queries.every(q=>Number(q.where.id_clinica||q.where.clinica_id)===72));
});
for(const flag of ['admin','genericAssistant','noMembership','foreign','noClinicalLink','inactive'])test('no professional signature for '+flag,async()=>{
 const h=harness({[flag]:true});await assert.rejects(h.service.signProfessionalConsentDocument(1,h.payload(),17),e=>e.statusCode===403);
 assert.equal(h.events.length,0);assert.equal(h.doc().snapshot_hash,HASH);
});
test('patient must have signed first, and exact viewed hash is mandatory',async()=>{
 for(const document of [{status:'pending',signed_at:null},{status:'signed',signed_at:null}]){
  const h=harness({document});await assert.rejects(h.service.signProfessionalConsentDocument(1,h.payload(),17),e=>e.message==='professional_signature_patient_required');assert.equal(h.events.length,0);
 }
 const h=harness();await assert.rejects(h.service.signProfessionalConsentDocument(1,{accepted_statement:true},17),e=>e.message==='professional_signature_snapshot_required');
 await assert.rejects(h.service.signProfessionalConsentDocument(1,h.payload('b'.repeat(64)),17),e=>e.message==='consent_document_signature_conflict');assert.equal(h.events.length,0);
});
test('same actor/hash replay is idempotent, another actor cannot obtain success for their signature',async()=>{
 const h=harness();await h.service.signProfessionalConsentDocument(1,h.payload(),17);const signed=h.doc();
 await h.service.signProfessionalConsentDocument(1,h.payload(),17);assert.equal(h.events.length,1);assert.equal(h.doc().snapshot_hash,signed.snapshot_hash);
 await assert.rejects(h.service.signProfessionalConsentDocument(1,h.payload(),18),e=>e.message==='professional_signature_already_recorded');assert.equal(h.events.length,1);
});
test('different actors racing for the same reviewed document produce one signature and no overwrite',async()=>{
 const h=harness();const result=await Promise.allSettled([17,18].map(id=>h.service.signProfessionalConsentDocument(1,h.payload(),id)));
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);assert.equal(h.events.length,1);
});
for(const status of ['revoked','cancelled','expired','superseded'])test('late signature cannot revive '+status,async()=>{
 const h=harness({beforeTransaction:(doc)=>{doc.status=status;if(status==='revoked')doc.revoked_at='2020-01-02';}});
 await assert.rejects(h.service.signProfessionalConsentDocument(1,h.payload(),17),e=>e.statusCode===409);assert.equal(h.doc().status,status);assert.equal(h.events.length,0);
});
test('closed/expired package is rechecked under the transaction anchor',async()=>{
 const h=harness({beforeTransaction:(_doc,pack)=>{pack.status='cancelled';}});await assert.rejects(h.service.signProfessionalConsentDocument(1,h.payload(),17),e=>e.statusCode===410);assert.equal(h.events.length,0);
});
test('signature event failure rolls back document, patient evidence and aggregate package state',async()=>{
 const h=harness({eventFailure:true}),before=h.doc();await assert.rejects(h.service.signProfessionalConsentDocument(1,h.payload(),17),/SYNTHETIC_EVENT_FAILURE/);assert.deepEqual(h.doc(),before);assert.equal(h.events.length,0);
});
test('package remains incomplete after patient signature, completes only after required professional',async()=>{
 const h=harness();const first=await h.service.refreshPackageCounts(1);assert.equal(first.status,'pending');assert.equal(first.signed_count,0);assert.equal(first.satisfied_count,0);
 await h.service.signProfessionalConsentDocument(1,h.payload(),17);assert.equal(h.pack().status,'signed');assert.equal(h.pack().signed_count,1);
});
test('old patient-only snapshots stay patient-only, regardless of a new template policy',()=>{
 const doc={status:'signed',signed_at:'2020-01-01',snapshot_json:{template:{requires_professional_signature:false}}};
 assert.equal(signatureProgress(doc,{requires_professional_signature:true}).complete,true);assert.equal(signatureProgress(doc).requires_professional_signature,false);
});


test('new standalone intake issuer freezes an explicit professional-policy boolean, including a legacy template without the field', async()=>{
 const source=fs.readFileSync(filename,'utf8'),start=source.indexOf('async function createPatientIntakePackage('),end=source.indexOf('\nasync function createPackageForAppointment',start);
 for(const flag of [true,false,undefined]){
  const template={id:5,clinic_id:72,purpose:'clinical',...(flag===undefined?{}:{requires_professional_signature:flag})};
  const context={db:{},findPacienteByIdentifier:async()=>({id_paciente:2}),getPlain:x=>x,
   documentCompletion:{policy(){}},documentBlocks:{versionBlocks:()=>null},documentBranding:{buildDocumentBranding:()=>({})},
   parseJsonObject:x=>x||{},buildTemplateContext:()=>({}),renderConsentVersionHtml:()=>'<p>Documento sintético</p>',renderTemplateHtml:()=>'',
   getSigningPolicyFromVersion:()=>({}),isMinorPatient:()=>false,getRepresentativeSnapshot:()=>[],hashRenderedSnapshot:()=>HASH,
   process:{env:{}},require:name=>{if(name==='../lib/patient-intake-consents')return{preparePatientIntake:async({snapshot})=>snapshot({template,version:{id:6,version:1,locale:'es'},patient:{id_paciente:2},clinic:{id_clinica:72}})};if(name==='../lib/registration-privacy-template')return{schema:()=>null};throw Error(name);}};
  vm.runInNewContext(source.slice(start,end)+'\nthis.issue=createPatientIntakePackage;',context);
  const result=await context.issue(2,{clinicId:72});
  assert.equal(Object.hasOwn(result.snapshot_json.template,'requires_professional_signature'),true);
  assert.equal(result.snapshot_json.template.requires_professional_signature,flag===true);
 }
});
