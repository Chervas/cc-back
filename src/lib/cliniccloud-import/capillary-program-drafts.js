'use strict';

// Reviewed documentary skeletons, not a prescription or an activation tool.
// Unknown timing/clinical variants remain visibly incomplete, never guessed.
const { hash } = require('./adapter');
const { verifyPlan } = require('./catalog-drafts');
const { normalizeValues } = require('../treatmentPrograms.contract');
const PDF_NAME = 'BS-Medical-Protocolos-V3-Capilar.pdf';
const PDF_SHA256 = '472dfeecb86324553bbf56e23b2541ee34af2884b46b77c8640cb83b61baeb50';
const VERSION = 'cliniccloud-capillary-program-drafts/1';
const SPECS = [
  { code:'CAP-25', name:'BS Esencial', page:36, price:690, blocks:[['dutasteride',3],['prp',3]] },
  { code:'CAP-26', name:'BS Dermapen', page:37, price:790, blocks:[['dutasteride',3],['dermapen',4]] },
  { code:'CAP-27', name:'BS Avanzado', page:38, price:840, blocks:[['dutasteride',3],['prp',3],['carbo',3]] },
  { code:'CAP-28', name:'BS Anual', page:39, price:990, blocks:[['dutasteride',3],['prp',3],['vitamins',3],['carbo',3]] },
  { code:'CAP-29', name:'BS Premium', page:40, price:1350, blocks:[['cyj',4],['dutasteride',3],['indiba',6]] },
];
const SERVICES = {
  dutasteride:{ label:'Dutasteride + LED incluido', rows:[22], minutes:[30] },
  prp:{ label:'PRP + LED incluido', rows:[24], minutes:[30] },
  dermapen:{ label:'Dermapen + LED', rows:[33,43], minutes:[20,10] },
  cyj:{ label:'Dr. CYJ Hair Filler + LED', rows:[31,43], minutes:[20,10] },
  // These are NOT the existing à-la-carte services. A shorter treatment plus
  // an LED appointment would produce the wrong protocol and/or duration.
  vitamins:{ label:'Vitaminas + LED · variante de programa pendiente', rows:[] },
  carbo:{ label:'Carboxiterapia + LED · variante de 30 min pendiente', rows:[] },
  indiba:{ label:'INDIBA sin LED · variante de 30 min pendiente', rows:[] },
};
const fail = code => { throw Error(code); };

function prepare({ plan, pdfSha256, clinics, treatments, existingPrograms }) {
  verifyPlan(plan);
  if (pdfSha256 !== PDF_SHA256) fail('CAPILLARY_PROGRAM_SOURCE_CHANGED');
  const clinic = clinics.find(c => c.id_clinica === 66);
  if (!clinic || clinic.grupoClinicaId !== 29) fail('CAPILLARY_PROGRAM_CLINIC_CHANGED');
  const bindings = new Map();
  for (const service of Object.values(SERVICES)) service.rows.forEach((rowNumber, index) => {
    if (bindings.has(rowNumber)) return;
    const sources = plan.rows.filter(r => r.sheet === 'Capilar · sesiones y bonos' && r.source_row === rowNumber && r.kind === 'treatment');
    if (sources.length !== 1 || sources[0].clinic_id !== 66) fail('CAPILLARY_PROGRAM_SOURCE_BINDING_INVALID');
    const source = sources[0], rows = treatments.filter(t => t.codigo === source.proposed_code);
    const row = rows[0], config = row?.clinical_config;
    if (rows.length !== 1 || row.clinica_id !== 66 || row.origen !== 'clinica'
      || row.nombre !== source.display_name || Number(row.sesiones_defecto) !== 1
      || Number(row.duracion_min) !== service.minutes[index]
      || config?.source_catalog_key !== source.source_catalog_key
      || hash(config.source_catalog) !== hash(source.provenance)
      || Number(row.activo) !== 0 || config.catalog_status !== 'draft') fail('CAPILLARY_PROGRAM_TREATMENT_CHANGED');
    bindings.set(rowNumber, { id:row.id_tratamiento, before_sha256:hash(row) });
  });
  const programs = SPECS.map(spec => {
    const appointments = [];
    for (const [serviceKey, count] of spec.blocks) {
      const service = SERVICES[serviceKey];
      for (let i=0; i<count; i++) appointments.push({
        key:`${spec.code.toLowerCase()}_${serviceKey}_${i+1}`,
        label:`${service.label} · ${i+1}/${count}`,
        treatment_ids:service.rows.map(row => bindings.get(row).id),
        // Only CYJ's initial fortnightly series is explicit. Do not turn a
        // twelve-month entitlement into a twelve-month appointment cadence.
        offset_days:serviceKey === 'cyj' ? i*14 : null,
      });
    }
    for (let i=1; i<=2; i++) appointments.push({ key:`${spec.code.toLowerCase()}_review_${i}`,
      label:`Revisión médica ${i}/2 · profesional y fecha pendientes`, treatment_ids:[], offset_days:null });
    const notes = [
      'BORRADOR DOCUMENTAL · No habilitado para vender ni reservar.',
      `${spec.code} · ${PDF_NAME}, páginas PDF 35 y ${spec.page} (la numeración impresa es distinta).`,
      `Tarifa indicada desde el 01/10/2026: ${spec.price} € finales. No aplicada al precio de venta; revisar vigencia y fiscalidad antes de activar.`,
      'Composición en el orden del documento. Falta confirmar los intervalos entre tratamientos y cuándo encajar las dos revisiones médicas. Las revisiones se muestran al final solo para conservarlas, no como pauta clínica.',
      'Incluye seguimiento anual y cuatro recetas: son prestaciones incluidas, no cuatro citas adicionales. Caducidad documental de doce meses desde la compra, todavía no aplicada por este borrador.',
      'Dutasteride y PRP ya incluyen LED: no se añade otra sesión ni otros diez minutos. Dermapen y Dr. CYJ se componen con LED en una única cita de 30 minutos.',
      'Vitaminas con LED, carboxiterapia con LED e INDIBA de programa requieren variantes específicas de 30 minutos. Se conservan sin vincular hasta configurarlas; no se acortan ni alargan los tratamientos individuales.',
      'Las revisiones deben realizarlas médicos. No se vincula la revisión antigua asignada a auxiliar. Confirmar duración, profesional y sala antes de vincularla.',
      ...(spec.code === 'CAP-29' ? ['Premium se ofrece al alta tras cirugía. Solo el ciclo inicial de Dr. CYJ tiene pauta explícita: días 0, 14, 28 y 42. Esta pauta no se extiende a las demás sesiones.'] : []),
      'Faltan validación clínica, consentimientos y cierre de la configuración de agenda de los tratamientos. Este borrador no acredita formación ni aprueba protocolos.',
      `Trazabilidad documental SHA-256: ${PDF_SHA256}.`,
    ].join('\n\n');
    const values = normalizeValues({ name:spec.name, kind:'program', status:'draft', total_price:null, cadence:null, notes, appointments });
    const idempotency_key = `${VERSION}:${spec.code}`;
    // Name-only matching must never overwrite an existing human definition.
    if (existingPrograms.some(p => p.name.normalize('NFKC').toLowerCase() === spec.name.toLowerCase()
      && p.request_key !== require('../treatmentPrograms.contract').payloadHash([66,idempotency_key]))) fail('CAPILLARY_PROGRAM_NAME_COLLISION');
    return { code:spec.code, clinic_id:66, payload:{ ...values,idempotency_key }, source_page:spec.page,
      source_gross_price:spec.price, source_effective_date:'2026-10-01' };
  });
  const body = { version:VERSION, source_pdf_sha256:PDF_SHA256, source_plan_sha256:plan.plan_sha256,
    bindings:[...bindings.entries()].map(([source_row,value]) => ({ source_row,...value })), programs,
    policy:{ draft_only:true, treatments_changed:false, medical_approval:false, sales_created:false,
      appointments_created:false, reminders_activated:false, future_prices_applied:false } };
  return { ...body, package_sha256:hash(body) };
}

module.exports = { VERSION, PDF_NAME, PDF_SHA256, SPECS, SERVICES, prepare };
