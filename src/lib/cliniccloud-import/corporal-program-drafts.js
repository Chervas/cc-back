'use strict';

// Closed documentary scope. No activation, prescription, price effective-date
// override, clinical phase invention or change to existing program definitions.
const { hash } = require('./adapter');
const { verifyPlan } = require('./catalog-drafts');
const { normalizeValues, payloadHash } = require('../treatmentPrograms.contract');
const VERSION = 'cliniccloud-corporal-program-drafts/1';
const SOURCES = Object.freeze({
  'BS-Medical-Protocolos-V1-Corporal (2) - copia.pdf': '5361917f6de9b68d52c18befcde09789fbeb674b7bbb2ec78c2aed27aa7000fc',
  'Tarifa-2026-Corporal.pdf': '57137efdbc73c6aacc03e817165e0a984dbf72b8bffd8c6120b2c0914d7a6068',
});
const BINDINGS = Object.freeze({ recovery:[9,45], lymphedema:[11,60], lipedema:[14,60], firmness:[22,45], cellulite:[29,45], mesotherapy:[36,10] });
const SPECS = [
  { code:'COR-05', name:'BS Contorno', count:8, minutes:45, price:1040, pages:[10,11], weekly:true,
    label:'Cyclone + EXION · variante COR-43 pendiente', injections:[2,5,8],
    detail:'La cita base es COR-43 (45 min), no Cyclone completo de 45 min más EXION suelto de 45 min ni COR-42 de 75 min. Falta crear su variante individual. En las citas 2, 5 y 8 se añaden 10 min de mesoterapia DESPUÉS: total 55 min. No se vincula solo la mesoterapia mientras falte la base.' },
  { code:'COR-06', name:'BS Firmeza', count:8, minutes:45, price:780, pages:[12,13], weekly:true,
    label:'EXION Body + INDIBA', service:'firmness',
    detail:'Sesión combinada de 45 min, no suma de dos sesiones sueltas. El protocolo reparte 5 + 15 + 12 + 10 + 3 min. Falta conciliar su perfil con el INDIBA fijo de C12 y el EXION móvil.' },
  { code:'COR-07', name:'BS Celulitis', count:8, minutes:45, price:860, pages:[14,15],
    label:'Ondas acústicas + RF Cyclone', service:'cellulite', injections:[3,6],
    detail:'Fuente: 1–2 sesiones por semana; no se elige una pauta clínica por defecto. Mesoterapia en las citas 3 y 6, DESPUÉS de los 45 min: se añaden los 10 min de la sesión individual, total 55 min. Ondas BTL y Cyclone son equipos distintos; no mantener C10 como sala de ondas móviles.' },
  { code:'COR-09', name:'BS Recuperación', count:10, minutes:45, price:690, pages:[18,19], service:'recovery', label:'INDIBA + Lymphastim',
    detail:'Fuente: 2–3 sesiones por semana al principio; falta pauta individual posterior. Alta escrita del cirujano antes de iniciar. Los 45 min incluyen ambos equipos (8 + 20 + 3 + 12 + 2). La tarifa de 590 € solo corresponde al presupuesto de cirugía, no a venta libre en recepción; se conserva como condición, sin crear otro programa ni aplicar un descuento automático.' },
  { code:'COR-09-SHORT', name:'BS Recuperación · versión corta', count:6, minutes:45, price:440, pages:[18,19], service:'recovery', label:'INDIBA + Lymphastim',
    detail:'Variante corta explícita de COR-09: seis citas, no diez sesiones truncadas después de vender. Pauta inicial de 2–3 por semana pendiente de indicación individual. Requiere alta escrita del cirujano y conciliación de las dos salas fijas.' },
  { code:'COR-10', name:'BS Lipedema', count:10, minutes:60, price:1290, pages:[20,21], service:'lipedema', label:'INDIBA + Lymphastim · lipedema',
    detail:'Fuente: 1–2 sesiones por semana en fase de ataque; no define todo el calendario. Confirmación médica de estadio, no venta desde recepción. Sesión estándar de 60 min (35 + 25), no la sesión ampliada de 75 min. El borrador no acredita diagnóstico ni aprobación clínica.' },
  { code:'COR-11', name:'BS Linfedema · control', count:10, minutes:60, price:1050, pages:[22,23], service:'lymphedema', label:'INDIBA + Lymphastim · linfedema',
    detail:'Fuente: 1–2 sesiones por semana. Requiere diagnóstico, pauta médica y personal con formación acreditada; no venta desde recepción. Lymphastim debe usar programa de LINFEDEMA, no drenaje corporal. Los 60 min son 5 + 5 + 30 + 3 + 15 + 2; queda por conciliar el perfil de ambas salas.' },
  { code:'COR-11-CONT', name:'BS Linfedema · continuidad', count:6, minutes:60, price:690, pages:[22,23], service:'lymphedema', label:'INDIBA + Lymphastim · linfedema',
    detail:'Continuidad explícita del protocolo COR-11: seis citas de 60 min. No es un bono retirado de cinco ni una única sesión de mantenimiento. Requiere diagnóstico, pauta médica y formación acreditada; calendario individual pendiente.' },
  { code:'COR-13', name:'BS Contorno Arranque', count:4, minutes:45, price:129, pages:[26], weekly:true,
    label:'Carboxiterapia 300 cc + drenaje · variante pendiente', injections:[4],
    detail:'Cada cita: carboxiterapia 300 cc seguida de drenaje. Mesoterapia en la cita 4. La composición indicada dura 45 min, pero este apartado no precisa si la mesoterapia se añade o está incluida: no se copia el reparto de COR-05. Falta variante, distribución temporal y confirmar si el drenaje es manual o con equipo.' },
  { code:'COR-14', name:'BS Contorno 10', count:10, minutes:45, price:349, pages:[26], weekly:true,
    label:'Carboxiterapia 600 cc + drenaje · variante pendiente', injections:[3,6,9],
    detail:'Cada cita: carboxiterapia 600 cc seguida de drenaje; mesoterapia en las citas 3, 6 y 9. Falta variante y reparto temporal, incluida la mesoterapia. Control médico con medición en citas 1, 5 y 10. Precio desde Arranque: 249 €, únicamente por crédito de 100 € tras completarlo. No se crea un programa duplicado ni se aplica ese crédito automáticamente.' },
  { code:'COR-15', name:'BS Contorno Continuidad', count:12, minutes:45, price:590, pages:[26], weekly:true,
    label:'HIFU + carboxiterapia + drenaje · variante pendiente', injections:[4,8,12],
    detail:'Orden documentado: HIFU del Cyclone, carboxiterapia y drenaje. Mesoterapia en citas 4, 8 y 12; control médico en 1, 6 y 12. Los 45 min no aportan reparto por técnica ni aclaran el tiempo adicional de mesoterapia: no se inventan fases ni se suman sesiones sueltas.' },
];
const fail = code => { throw Error(code); };

function prepare({ plan, sourceHashes, clinics, treatments, existingPrograms }) {
  verifyPlan(plan);
  if (hash(sourceHashes) !== hash(SOURCES)) fail('CORPORAL_PROGRAM_SOURCES_CHANGED');
  if (!clinics.some(c => c.id_clinica === 72 && c.grupoClinicaId === 29)) fail('CORPORAL_PROGRAM_CLINIC_CHANGED');
  const bindings = {};
  for (const [key,[sourceRow,minutes]] of Object.entries(BINDINGS)) {
    const found = plan.rows.filter(r => r.sheet === 'Tratamientos individuales' && r.source_row === sourceRow && r.kind === 'treatment');
    if (found.length !== 1 || found[0].clinic_id !== 72) fail('CORPORAL_PROGRAM_SOURCE_BINDING_INVALID');
    const source = found[0], rows = treatments.filter(r => r.codigo === source.proposed_code), row = rows[0], config = row?.clinical_config;
    if (rows.length !== 1 || row.clinica_id !== 72 || row.origen !== 'clinica' || row.nombre !== source.display_name
      || Number(row.sesiones_defecto) !== 1 || Number(row.duracion_min) !== minutes
      || Number(row.activo) !== 0 || config?.catalog_status !== 'draft'
      || config.source_catalog_key !== source.source_catalog_key || hash(config.source_catalog) !== hash(source.provenance)) fail('CORPORAL_PROGRAM_TREATMENT_CHANGED');
    bindings[key] = { id:row.id_tratamiento, source_row:sourceRow, before_sha256:hash(row) };
  }
  const programs = SPECS.map(spec => {
    const appointments = Array.from({length:spec.count},(_,index) => {
      const injection = spec.injections?.includes(index+1);
      const ids = spec.service ? [bindings[spec.service].id] : [];
      if (injection && spec.service) ids.push(bindings.mesotherapy.id);
      return { key:`${spec.code.toLowerCase().replace(/-/g,'_')}_${index+1}`,
        label:`${index+1}/${spec.count} · ${spec.label}${injection?' + mesoterapia':''}`,
        treatment_ids:ids, offset_days:spec.weekly ? index*7 : null };
    });
    const notes = [
      'BORRADOR DOCUMENTAL · No habilitado para vender ni reservar.',
      `${spec.code} · Protocolo Corporal V1, páginas PDF ${spec.pages.join(', ')}; Tarifa 2026 Corporal, páginas 1 y 3. La numeración impresa del protocolo es distinta.`,
      `${spec.count} citas; sesión base ${spec.minutes} min. Precio documental: ${spec.price} € finales. Tarifa desde 01/10/2026: no aplicada al precio comercial; confirmar vigencia y fiscalidad. El anexo del protocolo contiene una fecha de vigencia abierta y una validación cronológicamente contradictoria.`,
      spec.weekly ? 'Una cita por semana: propuesta base días 0, 7, 14…; revisar con la clínica antes de habilitar.' : 'Separación entre citas pendiente de pauta individual. El rango de frecuencia del documento no se convierte en días fijos.',
      spec.detail,
      'Se conserva el número de visitas del documento. Valoración, mediciones e informe incluidos no crean citas adicionales ni se dan por realizados. Tratamientos asociados, cabinas y máquinas requieren cierre operativo; los borradores existentes no se activan por vincularlos.',
      'Faltan revisión clínica, cualificación cuando proceda, consentimientos y cierre fiscal. No se aprueba el protocolo, no se firma por pacientes y no se crean compras, citas ni recordatorios.',
      `Procedencia PDF SHA-256: ${Object.entries(SOURCES).map(([name,sha])=>`${name}: ${sha}`).join('; ')}.`,
    ].join('\n\n');
    const values = normalizeValues({name:spec.name,kind:'program',status:'draft',total_price:null,cadence:null,appointments,notes});
    const idempotency_key = `${VERSION}:${spec.code}`;
    if (existingPrograms.some(p => p.name.normalize('NFKC').toLowerCase() === spec.name.toLowerCase()
      && p.request_key !== payloadHash([72,idempotency_key]))) fail('CORPORAL_PROGRAM_NAME_COLLISION');
    return {code:spec.code,clinic_id:72,payload:{...values,idempotency_key},source_pages:spec.pages,
      source_gross_price:spec.price,source_effective_date:'2026-10-01'};
  });
  const body = {version:VERSION,source_hashes:SOURCES,source_plan_sha256:plan.plan_sha256,bindings,programs,
    policy:{draft_only:true,treatments_changed:false,existing_programs_changed:false,clinical_approval:false,
      appointments_created:false,sales_created:false,reminders_activated:false,future_prices_applied:false}};
  return {...body,package_sha256:hash(body)};
}
module.exports = {VERSION,SOURCES,BINDINGS,SPECS,prepare};
