'use strict';

// A read-only projection of retained source records. This is deliberately not
// an importer, a consent mapper or a writer of the final clinical forms.
const { createHash } = require('node:crypto');

function clinicId(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0 ? Number(text) : null;
}

function scopePatientCustomFields(fields, { readableClinicIds = [], sensitiveClinicIds = [], linkedClinicIds = [] } = {}) {
  const readable = new Set(readableClinicIds.map(clinicId).filter(Boolean));
  const sensitive = new Set(sensitiveClinicIds.map(clinicId).filter(Boolean));
  const linked = new Set(linkedClinicIds.map(clinicId).filter(Boolean));
  return (Array.isArray(fields) ? fields : []).filter(field => {
    const id = clinicId(field?.clinica_id);
    return id && readable.has(id) && sensitive.has(id) && linked.has(id);
  });
}

function plainText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return /^(?:null|undefined|nan)$/i.test(text) ? '' : text;
}

function dateOnly(value) {
  const text = plainText(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(text);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(text);
  const normalized = iso ? iso.slice(1).join('-') : local ? `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}` : null;
  if (!normalized || normalized < '1900-01-01' || normalized > '2199-12-31') return null;
  const epoch = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === normalized ? normalized : null;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parsedRecord(value) {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return null; }
}

function normalizedKey(key) {
  return String(key).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lookup(record, aliases) {
  if (!object(record)) return '';
  const keys = new Map(Object.keys(record).map(key => [normalizedKey(key), key]));
  for (const alias of aliases) {
    const key = keys.get(normalizedKey(alias));
    const value = key === undefined ? '' : plainText(record[key]);
    if (value) return value;
  }
  return '';
}

const PROFILE_FIELDS = [
  ['Nombre', ['nombre', 'name']], ['Apellidos', ['apellidos', 'surname']],
  ['Documento de identidad', ['dni', 'national_id']], ['Fecha de nacimiento', ['fechanac', 'F. NACIMIENTO', 'birth_date']],
  ['Teléfono móvil', ['tele1', 'TELF. MOVIL', 'phone']], ['Teléfono secundario', ['tele2', 'TELF. FIJO']],
  ['Teléfono adicional', ['telfadic', 'TELF. ADICIONAL']], ['Correo electrónico', ['email']],
  ['Domicilio', ['domicilio']], ['Código postal', ['cp']], ['Población', ['pobla', 'poblacion']],
  ['Provincia', ['provi', 'provincia']], ['País', ['pais']], ['País de origen', ['PAIS ORIGEN']],
  ['Sexo (dato de origen)', ['sexo']], ['Profesión', ['profesion']], ['Alta en ClinicCloud', ['alta']],
  ['Aficiones', ['aficiones']], ['Cómo conoció la clínica', ['fuente', 'NOS CONOCE POR']],
  ['Información adicional', ['MAS INFORMACION']], ['Mutua (dato de origen)', ['mutua']],
  ['Redes sociales', ['REDES SOCIALES']],
];
const FAMILY_FIELDS = [
  ['Nombre del padre', ['nombrep', 'NOMBRE PADRE']], ['Documento del padre', ['dnip', 'DNI PADRE']],
  ['Teléfono del padre', ['telfp', 'TELF. PADRE']], ['Nombre de la madre', ['nombrem', 'NOMBRE MADRE']],
  ['Documento de la madre', ['dnim', 'DNI MADRE']], ['Teléfono de la madre', ['telfm', 'TELF. MADRE']],
  ['Información familiar', ['¿HERMANOS O HIJOS?']],
];
const CONTACT_CLINICAL_FIELDS = [
  ['Historia anotada en origen', ['historia']], ['Alergias anotadas en origen', ['alergia']],
  ['Antecedentes anotados en origen', ['enfermedad']], ['Patología anotada en origen', ['patologia']],
  ['Motivo anotado en origen', ['motivo']], ['Notas', ['notas']],
];
const EXTRA_CLINICAL_FIELDS = [
  ['Alergias (ficha complementaria)', ['alergias']], ['Antecedentes (ficha complementaria)', ['enfermedades']],
  ['Medicación', ['medicacion']], ['Consumo de tabaco (dato de origen)', ['consumoTabaco']],
  ['Consumo de alcohol (dato de origen)', ['consumoAlcohol']], ['Fecha de parto anotada', ['fechaParto']],
];
const HISTORY_FIELDS = [
  ['Antecedentes', ['antecedentes']], ['Historia / anotaciones', ['libre']],
  ['Anotaciones adicionales', ['libre2']], ['Otras anotaciones', ['libre3']],
  ['Evolución', ['evolucion']], ['Otros datos', ['otros']],
];

function itemsFor(record, definitions, { omitNumericFlags = false } = {}) {
  return definitions.map(([label, aliases]) => ({ label, value: lookup(record, aliases) }))
    .filter(item => item.value && (!omitNumericFlags || !/^[01]$/.test(item.value)));
}

function section(label, items) { return items.length ? { label, items } : null; }

function buildClinicCloudPatientHistory(fields, { clinics = [] } = {}) {
  const names = new Map(clinics.map(clinic => [clinicId(clinic?.clinica_id ?? clinic?.id_clinica), plainText(clinic?.nombre_clinica)]).filter(([id, name]) => id && name));
  const entries = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    if (field?.source !== 'cliniccloud' || !clinicId(field.clinica_id)) continue;
    const record = parsedRecord(field.value);
    if (!record) continue;
    const sourceFile = plainText(field.source_column);
    let kind, title, sections, recordDate = null, sourceDate = null;
    let hasRecordMetadata = false;
    if (sourceFile === 'historial_1.csv') {
      kind = 'clinical_note';
      title = lookup(record, ['nombre']) || 'Anotación clínica de ClinicCloud';
      recordDate = dateOnly(record.fecha);
      hasRecordMetadata = Boolean(lookup(record, ['nombre']) || recordDate);
      // In the historical export libre is a 0/1 mode flag, not the note
      // body. Neither it nor other numeric flags establish a clinical fact.
      sections = [section('Contenido clínico original', itemsFor(record, HISTORY_FIELDS, { omitNumericFlags: true }))];
    } else if (sourceFile === 'contacto_1.csv' || sourceFile === 'cliniccloud_contact_snapshot' || /^BACKUP_CONTACTOS_\d{4}-\d{2}-\d{2}\.csv$/.test(sourceFile)) {
      if (sourceFile === 'cliniccloud_contact_snapshot' && (record.version !== 'cliniccloud_contact_snapshot/1' || record.source_account !== 'cliniccloud-5880')) continue;
      if (sourceFile.startsWith('BACKUP_CONTACTOS_') && (record.version !== 'cliniccloud_patient_history/1' || record.source_account !== 'cliniccloud-5880')) continue;
      const contact = object(record.contact);
      const extra = object(record.extra);
      const normalizedFields = sourceFile === 'cliniccloud_contact_snapshot' ? object(record.fields) : null;
      kind = 'patient_profile';
      title = 'Ficha original del paciente';
      // This date belongs to the export, never to an encounter or a diagnosis.
      sourceDate = sourceFile.startsWith('BACKUP_CONTACTOS_') ? dateOnly(record.source_date) : null;
      const profile = itemsFor(contact, PROFILE_FIELDS);
      if (normalizedFields) {
        for (const item of itemsFor(normalizedFields, PROFILE_FIELDS)) if (!profile.some(existing => existing.label === item.label)) profile.push(item);
      }
      sections = [
        section('Datos personales y de contacto', profile),
        section('Datos familiares anotados en origen', itemsFor(contact, FAMILY_FIELDS)),
        section('Notas y antecedentes de la ficha', [...itemsFor(contact, CONTACT_CLINICAL_FIELDS, { omitNumericFlags: true }), ...itemsFor(extra, EXTRA_CLINICAL_FIELDS, { omitNumericFlags: true })]),
      ];
    } else continue;
    sections = sections.filter(Boolean);
    if (!sections.length && !hasRecordMetadata) continue;
    const id = createHash('sha256').update(`${field.clinica_id}:${field.field_key || ''}:${sourceFile}`).digest('hex').slice(0, 20);
    entries.push({
      id, kind, title, clinic_id: clinicId(field.clinica_id), clinic_name: names.get(clinicId(field.clinica_id)) || null,
      source: 'ClinicCloud', source_file: sourceFile, record_date: recordDate, source_date: sourceDate,
      content_note: !sections.length
        ? 'La exportación disponible conserva este registro, pero no incluye sus anotaciones clínicas.'
        : null,
      imported_date: dateOnly(field.last_imported_at instanceof Date
        ? (Number.isFinite(field.last_imported_at.getTime()) ? field.last_imported_at.toISOString() : null)
        : field.last_imported_at),
      sections,
    });
  }
  entries.sort((a, b) => (b.record_date || b.source_date || '').localeCompare(a.record_date || a.source_date || '') || a.id.localeCompare(b.id));
  return { version: 'cliniccloud_patient_history_view/1', read_only: true, entries };
}

module.exports = { scopePatientCustomFields, buildClinicCloudPatientHistory, dateOnly, plainText };
