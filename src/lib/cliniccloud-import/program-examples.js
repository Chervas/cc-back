'use strict';
const { hash } = require('./adapter');
const fail = code => { throw new Error(code); };
const SPECS = [
  { name: 'BS Tono', treatmentRow: 31, programRow: 6, unitPrice: 120, totalPrice: 620 },
  { name: 'BS Suelo Pélvico', treatmentRow: 33, programRow: 14, unitPrice: 85, totalPrice: 420 },
];
function prepareProgramExamples(plan) {
  const { plan_sha256, ...body } = plan;
  if (hash(body) !== plan_sha256 || plan.mode !== 'catalog_dry_run_only') fail('CATALOG_PLAN_INTEGRITY_MISMATCH');
  return SPECS.map(spec => {
    const treatment = plan.rows.find(row => row.sheet === 'Tratamientos individuales' && row.source_row === spec.treatmentRow);
    const program = plan.rows.find(row => row.sheet === 'Programas y mantenimientos' && row.source_row === spec.programRow);
    if (!treatment || !program || treatment.clinic_id !== 72 || program.clinic_id !== 72
      || treatment.kind !== 'treatment' || program.kind !== 'program'
      || treatment.duration_info.mode !== 'fixed' || treatment.duration_info.minutes !== 30
      || treatment.source_price.mode !== 'fixed' || treatment.source_price.gross_amount !== spec.unitPrice
      || program.source_price.mode !== 'fixed' || program.source_price.gross_amount !== spec.totalPrice
      || !program.name.startsWith(spec.name) || !/^6 citas, 2 por semana en días no consecutivos\./.test(program.detail)
      || treatment.cabin !== '11' || program.cabin !== '11' || treatment.professional !== 'Aux. Piedad' || program.professional !== 'Aux. Piedad') fail('REAL_PROGRAM_SOURCE_CHANGED_REVIEW_REQUIRED');
    const description = `Tarifario BS Medical. Precio final del archivo: ${spec.unitPrice} EUR, impuestos incluidos. Cabina C11; profesional indicado: Piedad. Pendiente de confirmar equivalencia física, profesional y desglose fiscal. Borrador: no se ofrece para reservar ni vender.`;
    return {
      source_catalog_key: program.source_catalog_key,
      treatment: { nombre: treatment.display_name, codigo: treatment.proposed_code, disciplina: 'estetica', categoria: 'EMShape PRO',
        descripcion: description, duracion_min: 30, precio_base: null, origen: 'clinica', clinica_id: 72, activo: false, sesiones_defecto: 1,
        clinical_config: { ...treatment.proposed_clinical_config, catalog_status: 'draft', medical_area_code: 'estetica', product_type: 'treatment',
          import_batch: 'cliniccloud-program-examples-20260914', source_cabin: 'C11', source_professional: 'Aux. Piedad', fiscal_mapping_pending: true } },
      program: { name: spec.name, kind: 'program', status: 'draft', total_price: spec.totalPrice,
        cadence: { mode: 'weekly', sessions_per_week: 2, min_days_between: 2 },
        notes: `6 citas de 30 minutos en C11 con Piedad. Pauta del cliente: 2 citas por semana en días no consecutivos. Los intervalos fijos quedan sin rellenar: esta pauta no obliga a lunes/jueves. Precio del programa completo: ${spec.totalPrice} EUR, impuestos incluidos. Borrador pendiente de configuración de cabina, profesional, fiscalidad y reserva conjunta. Fuente: ${program.sheet}, fila ${program.source_row}; archivo SHA256 ${plan.workbook_sha256}.`,
        appointments: Array.from({ length: 6 }, (_, index) => ({ key: `appointment_${index + 1}`, label: `Sesión ${index + 1} · ${treatment.name}`, offset_days: index === 0 ? 0 : null, treatment_code: treatment.proposed_code })) },
      provenance: program.provenance,
    };
  });
}
module.exports = { prepareProgramExamples };
