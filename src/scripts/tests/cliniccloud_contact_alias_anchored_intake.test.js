'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareAnchoredIntakeReview}=require('../../lib/cliniccloud-import/contact-alias-evidence');
const {validateContactAlias}=require('../../lib/cliniccloud-import/contact-aliases');
function fixture(){
 const source={source_contact_id:'456',fields:{name:'Mariana',surname:'MOD',phone:'+34 600 000 001'}};
 const anchor={source_contact_id:'123',fields:{name:'Mariana',surname:'Ejemplo Ficticio',phone:'600000001',national_id:'TEST-123',birth_date:'1980-01-01'}};
 const patient={id_paciente:9,clinica_id:72,nombre:'Mariana',apellidos:'Ejemplo Ficticio',telefono_movil:'600000001',dni:'TEST123',fecha_nacimiento:'1980-01-01'};
 return{source,contacts:[anchor,source],live:{patients:[patient],source_links:[{source_contact_id:'123',paciente_id:9}]},
  link:{source_contact_id:'456',patient_id:9,reviewed_intake_alias:{policy:'phone_given_name_and_existing_source_identity',
   policy_reference:'Owner authorizes clear partial name and complete telephone; operator documentary review only',
   reviewed_at:'2026-09-27T12:00:00Z',existing_source_contact_id:'123',patient_full_name:'Mariana Ejemplo Ficticio',intake_label:'MOD',
   reason:'Existing exported identity already belongs to the unique local phone owner; exact given name, document and birth date corroborate this intake label.'}},
  reviewedBy:'Operator, not claimed pair-specific human confirmation',now:Date.parse('2026-09-27T12:05:00Z')};
}
const check=f=>validateContactAlias(f.source,9,f.live,prepareAnchoredIntakeReview(f));
test('reviewed intake alias uses existing full identity without rewriting either patient or visit',()=>{
 const f=fixture(),before=structuredClone(f);assert.throws(()=>validateContactAlias(f.source,9,f.live));
 const r=check(f);assert.equal(r.patient.id_paciente,9);assert.equal(r.evidence,'operator_reviewed_intake_with_existing_identity');
 assert.equal(r.field_key,'cliniccloud_contact_alias_456');assert.equal(r.already_linked,false);assert.deepEqual(f,before);
});
test('PV label and country-prefix normalization work only with the same corroboration',()=>{
 const f=fixture();f.source.fields.surname='pv';f.link.reviewed_intake_alias.intake_label='PV';f.source.fields.phone='0034600000001';
 assert.equal(check(f).patient.id_paciente,9);
});
for(const [name,mutate]of [
 ['missing review',f=>delete f.link.reviewed_intake_alias],
 ['missing reason',f=>f.link.reviewed_intake_alias.reason=''],
 ['unapproved policy',f=>f.link.reviewed_intake_alias.policy='phone_only'],
 ['expired evidence',f=>f.link.reviewed_intake_alias.reviewed_at='2026-09-26T12:00:00Z'],
 ['future evidence',f=>f.link.reviewed_intake_alias.reviewed_at='2026-09-28T12:00:00Z'],
 ['another evidence path',f=>f.link.confirmed_identity=true],
 ['arbitrary ignored surname',f=>f.source.fields.surname='OtroApellido'],
 ['different given name',f=>f.source.fields.name='Margarita'],
 ['nickname',f=>f.source.fields.name='Mari'],
 ['missing source anchor',f=>f.contacts.shift()],
 ['third source phone owner even with same name',f=>f.contacts.push({...f.contacts[0],source_contact_id:'789'})],
 ['duplicate anchor row',f=>f.contacts.push(structuredClone(f.contacts[0]))],
 ['missing anchor document',f=>f.contacts[0].fields.national_id=''],
 ['missing anchor birth',f=>f.contacts[0].fields.birth_date=''],
 ['shared local phone',f=>f.live.patients.push({...f.live.patients[0],id_paciente:10})],
 ['anchor belonging to another patient',f=>f.live.source_links[0].paciente_id=10],
 ['unlinked anchor',f=>f.live.source_links=[]],
 ['anchor linked to two patients',f=>f.live.source_links.push({source_contact_id:'123',paciente_id:10})],
 ['changed local name',f=>f.live.patients[0].apellidos='Otro Apellido'],
 ['changed local document',f=>f.live.patients[0].dni='TEST456'],
 ['changed local birth',f=>f.live.patients[0].fecha_nacimiento='1981-01-01'],
 ['new source contradicts document',f=>f.source.fields.national_id='TEST456'],
 ['new source contradicts birth',f=>f.source.fields.birth_date='1981-01-01'],
 ['target outside BS group scope',f=>f.live.patients[0].clinica_id=59],
 ['new alias already owned elsewhere',f=>f.live.source_links.push({source_contact_id:'456',paciente_id:10})],
])test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>check(f));});
test('replay is recognized, but a subsequently reassigned anchor stops even when alias exists',()=>{
 const f=fixture();f.live.source_links.push({source_contact_id:'456',paciente_id:9});assert.equal(check(f).already_linked,true);
 f.live.source_links[0].paciente_id=10;assert.throws(()=>check(f),/ANCHOR_NOT_ALREADY_OWNED/);
});
