'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {preparePatientIntake}=require('../../lib/patient-intake-consents');
function fixture({clinic=72,templates=[{id:90,blocking_policy:'hard'}],existing=false,published=true,version=null,document=null,oldVersions=[],compatibleDocuments=[]}={}){
 const writes=[],queries=[];const transaction={LOCK:{UPDATE:'UPDATE',SHARE:'SHARE'}};
 const db={Sequelize:{Op:{in:Symbol('in'),or:Symbol('or'),gt:Symbol('gt')}},sequelize:{transaction:async cb=>cb(transaction)},
 Paciente:{findByPk:async(id,q)=>{assert.equal(q.lock,'UPDATE');return{id_paciente:id,clinica_id:clinic}}},
 Clinica:{findByPk:async()=>({id_clinica:clinic})},
 ClinicConsentTemplate:{findAll:async q=>{assert.deepEqual(q.where,{clinic_id:72,purpose:'data_protection',status:'active',is_default:true});return templates}},
 ClinicConsentTemplateVersion:{findOne:async q=>{assert.equal(q.where.status,'published');assert.equal(q.where.locale,'es');return published?(version||{id:312,body_html:'<p>Texto publicado</p>',locale:'es'}):null},
  findAll:async q=>{assert.equal(q.lock,'SHARE');assert.equal(q.transaction,transaction);assert.equal(q.limit,101);return oldVersions}},
 PatientConsentDocument:{findOne:async q=>{queries.push(q);return document||(existing?{id:800,status:'signed'}:null)},
  findAll:async q=>{queries.push(q);assert.equal(q.lock,'SHARE');assert.equal(q.transaction,transaction);assert.equal(q.limit,101);return compatibleDocuments},
  create:async(v,q)=>{assert.equal(q.transaction,transaction);writes.push(v)}},
 PatientConsentExternalAttestation:{findAll:async()=>[]},PatientOperationalEvent:{findAll:async()=>[]},
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

const digital = require('../../lib/bs-privacy-digital-template');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const legacyHtml = require('node:fs').readFileSync(require.resolve('./fixtures/bs-privacy-approved-legacy.html'), 'utf8').replace(/\n$/, '');
const rendered = digital.buildBsPrivacyDigitalHtml();
const bsTemplate = { id: 90, clinic_id: 72, blocking_policy: 'hard', purpose: 'data_protection', status: 'active', is_default: true, catalog_key: privacy.FINAL_PRIVACY_KEY };
const oldVersion = { id: 312, clinic_template_id: 90, version: 1, status: 'published', locale: 'es', body_html: legacyHtml,
 body_json: { consent_form: rendered.consent_form } };
const newVersion = { id: 313, clinic_template_id: 90, version: 2, status: 'published', locale: 'es', body_html: rendered.html,
 body_json: { consent_form: rendered.consent_form, digital_presentation: rendered.metadata } };
function bsDocument(version, patch = {}) {
 const document = { id: 800, package_id: 700, paciente_id: 82, clinica_id: 72, clinic_template_id: 90,
  clinic_template_version_id: version.id, purpose: 'data_protection', status: 'signed', signed_at: '2026-01-01',
  snapshot_json: { template: bsTemplate, version: { id: version.id, body_json: version.body_json },
   integrity: { algorithm: choices.CHOICE_HASH_ALGORITHM }, signature_evidence: { accepted_statement: true, signed_at: '2026-01-01',
    consent_choices: { schema_version: choices.CHOICE_SCHEMA_VERSION, answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) } } }, ...patch };
 document.snapshot_html = choices.appendSignedChoiceHtml(version.body_html.trim(), document,
  document.snapshot_json.signature_evidence.consent_choices);
 document.snapshot_hash = choices.choiceSnapshotHash(document.snapshot_json, document.snapshot_html);
 return document;
}
function digitalFixture(compatibleDocuments, extra = {}) {
 return fixture({ templates: [bsTemplate], version: newVersion, oldVersions: [oldVersion], compatibleDocuments, ...extra });
}
test('preparing the digital presentation reuses an exact valid old four-No signature with zero writes', async () => {
 const old = bsDocument(oldVersion), before = JSON.stringify(old);
 const f = digitalFixture([old]), result = await f.run();
 assert.equal(result.created_count, 0); assert.equal(result.existing_count, 1); assert.equal(result.privacy_signed, true);
 assert.equal(f.writes.length, 0); assert.equal(JSON.stringify(old), before);
 const query = f.queries.find(q => q.where.status === 'signed');
 assert.equal(query.where.paciente_id, 82); assert.equal(query.where.clinica_id, 72);
 assert.equal(query.where.clinic_template_id, 90); assert.equal(query.where.purpose, 'data_protection');
 assert.deepEqual(query.where.clinic_template_version_id[f.db.Sequelize.Op.in], [312]);
});
test('an already valid current digital signature is reused without historical lookups', async () => {
 const f = digitalFixture([], { document: bsDocument(newVersion) }), result = await f.run();
 assert.equal(result.created_count, 0); assert.equal(result.privacy_signed, true);
 assert.equal(f.queries.some(q => q.where.status === 'signed'), false);
});
test('current digital evidence whose rehashed HTML differs from its approved clauses is not reused', async () => {
 const doc = bsDocument(newVersion); doc.snapshot_html = doc.snapshot_html.replace('INSTITUTO OBES ALICANTE', 'OTRA ENTIDAD');
 doc.snapshot_hash = choices.choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html);
 const f = digitalFixture([], { document: doc }), result = await f.run();
 assert.equal(result.created_count, 1); assert.equal(result.privacy_signed, false);
});
test('an old signed notice wins over a newer pending duplicate without altering either', async () => {
 const current = bsDocument(newVersion, { id: 801, status: 'pending', signed_at: null });
 const old = bsDocument(oldVersion), before = JSON.stringify([old, current]);
 const f = digitalFixture([old], { document: current }), result = await f.run();
 assert.equal(result.privacy_signed, true); assert.equal(result.created_count, 0);
 assert.equal(f.writes.length, 0); assert.equal(JSON.stringify([old, current]), before);
});
test('pending old paper presentations do not supersede the current digital document', async () => {
 const f = digitalFixture([bsDocument(oldVersion, { status: 'viewed', signed_at: null })]), result = await f.run();
 assert.equal(result.created_count, 1); assert.equal(result.privacy_signed, false);
 assert.equal(f.writes[1].clinic_template_version_id, 313);
});
test('presentation compatibility never reuses revoked, foreign, expired or unverified evidence', async () => {
 for (const patch of [{ revoked_at: '2026-02-01' }, { paciente_id: 83 }, { clinica_id: 66 },
  { clinic_template_id: 91 }, { expires_at: '2026-01-02' }, { snapshot_hash: 'a'.repeat(64) }]) {
  const old = bsDocument(oldVersion);
  const f = digitalFixture([{ ...old, ...patch }]), result = await f.run();
  assert.equal(result.created_count, 1); assert.equal(result.privacy_signed, false);
 }
});
test('unsigned paper presentation or copied digital metadata cannot create a compatibility waiver', async () => {
 const f = digitalFixture([bsDocument(oldVersion)], { version: { ...newVersion, body_html: '<p>HTML no aprobado</p>' } });
 const result = await f.run(); assert.equal(result.created_count, 1); assert.equal(result.privacy_signed, false);
 assert.equal(f.queries.some(q => q.where.status === 'signed'), false);
});
test('paper privacy satisfies registration without inventing a digital signature or duplicating pending tablet documents', async () => {
 const paper = require('../../lib/registration-privacy-paper'), at = new Date('2026-01-01T12:00:00Z');
 const f = digitalFixture([]), original = bsDocument(newVersion, { status: 'pending', signed_at: null });
 const attestation = { id: 400, paciente_id: 82, clinica_id: 72, tratamiento_id: null, purpose: 'data_protection',
  source: paper.PAPER_SOURCE, status: 'active', attested_by: 7, attested_at: at, revoked_at: null };
 const event = { id: 401, patient_id: 82, clinic_id: 72, actor_user_id: 7, source: paper.PAPER_SOURCE,
  event_type: paper.PAPER_EVENT, channel: 'internal', occurred_at: at, metadata: {
   schema_version: paper.PAPER_SOURCE, attestation_id: 400, appointment_id: 11, clinic_template_id: 90,
   clinic_template_version_id: 313, catalog_key: privacy.FINAL_PRIVACY_KEY,
   source_document_sha256: digital.SOURCE_DOCUMENT_SHA256, legal_text_sha256: digital.LEGAL_TEXT_SHA256,
   acknowledged: true, recorded_at: at.toISOString() } };
 f.db.PatientConsentExternalAttestation.findAll = async () => [attestation];
 f.db.PatientOperationalEvent.findAll = async () => [event];
 const before = JSON.stringify(original), result = await f.run();
 assert.equal(result.created_count, 0); assert.equal(result.privacy_satisfied, true); assert.equal(result.privacy_signed, false);
 assert.equal(result.privacy_on_paper, true); assert.equal(result.paper_count, 1); assert.deepEqual(result.current_package_ids, []);
 assert.equal(f.writes.length, 0); assert.equal(f.queries.length, 0); assert.equal(JSON.stringify(original), before);
 attestation.revoked_at = new Date('2026-02-01');
 const afterRevocation = await f.run(); assert.equal(afterRevocation.created_count, 1); assert.equal(afterRevocation.privacy_satisfied, false);
});
