'use strict';

// Source-bound preparation only. Never change the à-la-carte treatment,
// prescribe cadence, approve qualification, activate or assign a sale price.
const assert = require('node:assert/strict');
const { hash } = require('./adapter');
const { normalizeBookingProfile } = require('../booking-profile');
const { normalizeValues } = require('../treatmentPrograms.contract');
const { prepare: preparePrograms, PDF_SHA256, PDF_NAME } = require('./capillary-program-drafts');
const VERSION = 'cliniccloud-capillary-program-variants/1';
const SPECS = [
  { key:'vitamins', code:'BS26-CAP18-PROGRAM', base:2001, sourceRow:26, protocol:'CAP-18', pages:[25,35,39],
    name:'Vitaminas y aminoácidos + LED · sesión de programa capilar', programs:['CAP-28'],
    phases:[{room:75,minutes:30,equipment:15,label:'Vitaminas y LED incluidos en la misma sesión'}] },
  { key:'carbo', code:'BS26-CAP22-PROGRAM', base:2005, sourceRow:36, protocol:'CAP-22', pages:[30,35,38,39],
    name:'Carboxiterapia capilar + LED · sesión de programa', programs:['CAP-27','CAP-28'],
    phases:[{room:83,minutes:18,equipment:12,label:'Carboxiterapia: preparación, aplicación y masaje'},
      {room:75,minutes:12,equipment:15,label:'LED (10 min) y registro (2 min)'}] },
  { key:'indiba', code:'BS26-CAP23-PROGRAM', base:2006, sourceRow:39, protocol:'CAP-23', pages:[32,35,40],
    name:'INDIBA capilar sin LED · sesión de programa', programs:['CAP-29'],
    phases:[{room:86,minutes:30,equipment:14,label:'INDIBA capilar de programa, sin LED'}] },
];
const text = v => typeof v === 'string' ? JSON.parse(v) : v;

function prepare({ plan, pdfSha256, before }) {
  assert.equal(pdfSha256, PDF_SHA256);
  const original = preparePrograms({ plan, pdfSha256, clinics:before.clinics, treatments:before.treatments, existingPrograms:before.programs });
  assert.equal(before.existingVariants.length,0,'Prepare only before creating variants; resume with the original reviewed package');
  const staff=before.staff.find(s=>s.doctor_id===50&&s.clinica_id===66);
  assert(staff?.activo&&staff.recibe_citas);
  assert(before.staff_hours.some(h=>h.doctor_clinica_id===staff.id&&h.activo&&h.hora_inicio<h.hora_fin));
  const variants=SPECS.map(spec=>{
    const source=plan.rows.find(r=>r.sheet==='Capilar · sesiones y bonos'&&r.source_row===spec.sourceRow&&r.kind==='treatment');
    const base=before.treatments.find(t=>t.id_tratamiento===spec.base);
    assert(base&&source&&base.codigo===source.proposed_code&&base.nombre===source.display_name);
    assert.equal(base.clinica_id,66);assert.equal(Number(base.activo),0);
    const config=text(base.clinical_config);
    assert.equal(config.catalog_status,'draft');assert.equal(hash(config.source_catalog),hash(source.provenance));
    assert.equal(base.duracion_min,{vitamins:30,carbo:10,indiba:20}[spec.key]);
    const profile=normalizeBookingProfile({version:2,phases:spec.phases.map((phase,i)=>{
      const room=before.rooms.find(r=>r.id===phase.room);
      assert(room&&room.clinica_id===66&&room.activo&&room.capacidad===1&&room.tiempo_preparacion_minutos===0);
      assert(text(room.profesionales_permitidos).includes(50));
      assert(before.room_hours.some(h=>h.instalacion_id===room.id&&h.activo&&h.hora_inicio<h.hora_fin));
      const unit=before.units.find(u=>u.id===phase.equipment);
      assert(unit&&unit.status==='available'&&unit.mobility==='fixed'&&unit.turnaround_minutes===0&&unit.group_id===29);
      assert(before.shares.some(s=>s.equipment_id===unit.id&&s.clinic_id===66));
      const canonical=before.aliases.find(a=>a.installation_id===room.id)?.canonical_installation_id||room.id;
      assert.equal(canonical,unit.home_installation_id);
      assert.equal(unit.family_key,{12:'carboxytherapy',14:'indiba_rf',15:'capillary_led'}[phase.equipment]);
      return {key:'phase_'+(i+1),label:phase.label,duration_minutes:phase.minutes,installation_ids:[room.id],
        professionals:{mode:'any',ids:[50],preferred_id:50},equipment_requirements:[{equipment_ids:[unit.id]}]};
    })});
    assert.equal(profile.phases.reduce((n,p)=>n+p.duration_minutes,0),30);
    const payload={codigo:spec.code,nombre:spec.name,disciplina:'capilar',categoria:'Sesiones de programas capilares',
      origen:'clinica',clinica_id:66,activo:false,precio_base:null,duracion_min:30,sesiones_defecto:1,
      descripcion:`Sesión incluida en ${spec.programs.join(', ')}. Borrador documental; no es una sesión gratuita ni sustituye la sesión suelta. `+
        `Fuente: ${PDF_NAME}, ${spec.protocol}, páginas ${spec.pages.join(', ')}. Vigencia documental 01/10/2026. `+
        'Confirmar pauta, prescripción, cualificación, consentimiento y fiscalidad antes de habilitar el programa.',
      clinical_config:{catalog_status:'draft',product_type:'treatment',medical_area_code:'capilar',
        import_batch:VERSION,fiscal_mapping_pending:true,import_issues:['PROGRAM_VARIANT_CLINICAL_REVIEW_REQUIRED','PROGRAM_VARIANT_CONSENT_REVIEW_REQUIRED'],
        source_price:{mode:'included',currency:'EUR',includes_tax:true},
        source_program_variant:{version:1,base_treatment_id:base.id_tratamiento,base_sha256:hash(base),
          base_catalog:config.source_catalog,pdf_name:PDF_NAME,pdf_sha256:PDF_SHA256,protocol:spec.protocol,
          pages:spec.pages,program_codes:spec.programs,effective_date:'2026-10-01',qualification_verified:false,
          clinical_approval:false,activation:false},booking_profile:profile}};
    return {key:spec.key,payload};
  });
  const programs=original.programs.filter(p=>['CAP-27','CAP-28','CAP-29'].includes(p.code)).map(p=>{
    const row=before.programs.find(r=>r.clinic_id===66&&r.name===p.payload.name);
    assert(row&&row.version_number===1,'Only untouched original documentary definitions');
    assert.equal(hash(normalizeValues(row)),hash(normalizeValues(p.payload)),'Existing program was edited');
    return {code:p.code,before:row,before_sha256:hash(row)};
  });
  const body={version:VERSION,pdf_sha256:PDF_SHA256,plan_sha256:plan.plan_sha256,before,variants,programs,
    policy:{draft_only:true,old_treatments_unchanged:true,clinical_approval:false,prices_assigned:false,
      cadence_invented:false,appointments_created:false,reminders_activated:false}};
  return {...body,package_sha256:hash(body)};
}

function verifyVariant(row,variant) {
  assert(row&&row.clinica_id===66);
  for(const [key,value]of Object.entries(variant.payload)){
    if(key==='activo')assert.equal(Number(row.activo),0);
    else assert.equal(hash(row[key]),hash(value),'Variant field changed: '+key);
  }
}
function programUpdate(program,variants) {
  let changed=0;
  const appointments=text(program.before.appointments).map(a=>{
    const spec=SPECS.find(s=>s.programs.includes(program.code)&&a.key.startsWith(program.code.toLowerCase()+'_'+s.key+'_'));
    if(!spec)return a;
    assert.equal(a.treatment_ids.length,0);
    const row=variants.find(v=>v.codigo===spec.code);assert(row&&row.id_tratamiento);changed++;
    const occurrence=a.key.split('_').at(-1);
    return {...a,label:`${spec.key==='indiba'?'INDIBA sin LED':spec.key==='carbo'?'Carboxiterapia + LED':'Vitaminas + LED'} · ${occurrence}/${spec.key==='indiba'?6:3}`,treatment_ids:[row.id_tratamiento]};
  });
  assert.equal(changed,{'CAP-27':3,'CAP-28':6,'CAP-29':6}[program.code]);
  const old='Vitaminas con LED, carboxiterapia con LED e INDIBA de programa requieren variantes específicas de 30 minutos. Se conservan sin vincular hasta configurarlas; no se acortan ni alargan los tratamientos individuales.';
  assert(program.before.notes.includes(old));
  return {expected_version:program.before.version_number,status:'draft',appointments,
    notes:program.before.notes.replace(old,'Las variantes de programa de vitaminas con LED, carboxiterapia con LED e INDIBA ya se vinculan como borradores específicos de 30 minutos. Las sesiones sueltas conservan su duración y configuración. No activa estos tratamientos ni resuelve la pauta, la documentación o la validación profesional pendientes.')};
}
function verifyProgram(row,program,variants) {
  const update=programUpdate(program,variants);
  assert.equal(row.version_number,program.before.version_number+1);
  assert.equal(hash(normalizeValues(row)),hash(normalizeValues(update,{current:program.before})));
  for(const field of ['id','public_id','clinic_id','request_key','request_payload_hash','created_by','created_at'])assert.equal(hash(row[field]),hash(program.before[field]));
}
module.exports={VERSION,SPECS,prepare,verifyVariant,programUpdate,verifyProgram};
