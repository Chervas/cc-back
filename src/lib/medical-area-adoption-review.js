'use strict';

// Pure compatibility policy. Runs only in administrative review/adoption,
// never while calculating agenda slots or rendering patient records.
const POLICY_VERSION = 'medical-area-adoption-v1';
const LABELS = {
  profile: 'Configuración de tratamientos', service_examples: 'Ejemplos de servicios',
  contract_sections: 'Descripción del área', setup_steps: 'Pasos del configurador',
  protocol_rules: 'Reglas declarativas del área', patient_workspace: 'Ficha clínica',
  appointment_action: 'Acciones desde la cita',
  nutrition_service_kind_options: 'Servicios de nutrición',
  nutrition_measurement_profile_options: 'Perfiles de medición',
  nutrition_measurement_profile_schemas: 'Composición de las mediciones',
  nutrition_measurement_fields: 'Campos de medición',
};
const FIELD_LABELS = {
  label: 'Nombre', hint: 'Ayuda', defaultCategory: 'Categoría inicial', defaultDuration: 'Duración inicial (minutos)',
  defaultSessions: 'Sesiones iniciales', supportsPiece: 'Uso de piezas dentales', supportsLaboratory: 'Uso de laboratorio',
  applicationHint: 'Ayuda de aplicación', applicationOptions: 'Formas de aplicación', enabled: 'Activado', route: 'Ruta de acceso',
  title: 'Título', body: 'Descripción', description: 'Descripción', section: 'Paso', icon: 'Icono', chips: 'Etiquetas',
  groups: 'Grupos de medición', fields: 'Campos', required_fields: 'Campos obligatorios', name: 'Nombre',
  min: 'Mínimo', max: 'Máximo', unit: 'Unidad', value: 'Opción', action: 'Acción', condition: 'Condición',
  wait_min_value: 'Espera mínima', wait_min_unit: 'Unidad de espera', scope: 'Ámbito', code: 'Código',
  source_type: 'Origen', source_ref: 'Referencia de origen', target_type: 'Destino', target_ref: 'Referencia de destino',
  compareLabel: 'Nombre de comparación', detail: 'Detalle', compareIcon: 'Icono de comparación',
  noProfileMessage: 'Aviso sin perfil', latestPrefix: 'Prefijo anterior', requiresProfile: 'Requiere perfil',
  profileDetails: 'Detalles por perfil', serviceDetails: 'Detalles por servicio', labelKey: 'Clave de traducción',
};
function changedFields(before, after, path = [], rows = []) {
  if (stable(before) === stable(after)) return rows;
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) changedFields(before[key], after[key], [...path, key], rows);
  } else {
    rows.push({ path: path.join('.'), label: path.map(k => /^\d+$/.test(k) ? '#' + (Number(k) + 1) : FIELD_LABELS[k] || k).join(' · '),
      before: before ?? null, after: after ?? null });
  }
  return rows;
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function compareAreaContracts(current, target) {
  const changes = [], blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  for (const key of new Set([...Object.keys(current || {}), ...Object.keys(target)])) {
    if (['code', 'revision'].includes(key) || stable(current?.[key]) === stable(target[key])) continue;
    changes.push({ key, label: LABELS[key] || key, before: current?.[key] ?? null, after: target[key] ?? null,
      fields: changedFields(current?.[key], target[key]) });
    if (!Object.hasOwn(LABELS, key)) block('unreviewed_field:' + key, 'Este campo necesita una revisión de compatibilidad antes de actualizar: ' + key);
  }
  if (current) {
    for (const [key, field] of Object.entries(current.nutrition_measurement_fields || {})) {
      const next = target.nutrition_measurement_fields?.[key];
      if (!next || next.unit !== field.unit) block('measurement_field:' + key,
        'No se puede retirar ni cambiar la unidad del campo «' + (field.label || key) + '» sin una migración específica.');
    }
    for (const schema of current.nutrition_measurement_profile_schemas || []) {
      if (!(target.nutrition_measurement_profile_schemas || []).some(s => s.code === schema.code)) {
        block('measurement_profile:' + schema.code, 'No se puede retirar el perfil de medición «' + (schema.name || schema.code) + '» sin revisar sus tratamientos.');
      }
    }
    for (const key of ['nutrition_service_kind_options', 'nutrition_measurement_profile_options']) {
      for (const option of current[key] || []) if (!(target[key] || []).some(o => o.value === option.value)) {
        block(key + ':' + option.value, 'No se puede retirar la opción «' + (option.label || option.value) + '» sin revisar sus usos.');
      }
    }
    for (const key of ['patient_workspace', 'appointment_action']) {
      if (current[key]?.enabled && (!target[key]?.enabled || current[key].route !== target[key].route)) {
        block('clinical_access:' + key, 'El cambio retiraría o trasladaría un acceso clínico existente. Necesita una migración específica.');
      }
    }
    for (const key of ['supportsPiece', 'supportsLaboratory']) {
      if (current.profile?.[key] && !target.profile?.[key]) block('capability:' + key,
        'No se puede retirar el soporte de piezas o laboratorio sin revisar los tratamientos existentes.');
    }
    for (const option of current.profile?.applicationOptions || []) {
      if (!(target.profile?.applicationOptions || []).some(o => o.value === option.value)) block('application:' + option.value,
        'No se puede retirar la aplicación «' + option.label + '» sin revisar los tratamientos existentes.');
    }
  }
  return { policy_version: POLICY_VERSION, changes, blockers, compatible: blockers.length === 0,
    preserved: ['Ajustes particulares de la clínica', 'Tratamientos, precios y programas existentes',
      'Citas y reservas ya creadas', 'Mediciones e informes guardados', 'Consentimientos firmados'],
    notices: [
      'Los cambios se aplican a la configuración del área para operaciones nuevas. No recalculan registros anteriores.',
      'Las reglas declarativas no acreditan por sí solas una funcionalidad implementada ni una aprobación clínica.',
      'Volver a una versión anterior no deshace operaciones realizadas después de actualizar.',
    ] };
}
module.exports = { POLICY_VERSION, compareAreaContracts };
