'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scopePatientCustomFields, buildClinicCloudPatientHistory, dateOnly, plainText } = require('../../lib/cliniccloud-patient-history');

const field = (record, extra = {}) => ({ clinica_id: 72, source: 'cliniccloud', source_column: 'contacto_1.csv', field_key: 'opaque-source-key', value: JSON.stringify(record), ...extra });
const entries = (fields) => buildClinicCloudPatientHistory(fields, { clinics: [{ clinica_id: 72, nombre_clinica: 'Clínica ficticia' }] }).entries;
const values = (entry) => entry.sections.flatMap(section => section.items);

test('custom fields require clinic readability, sensitive permission and a real patient membership', () => {
  const fields = [field({ contact: { nombre: 'Ejemplo' } }), field({}, { clinica_id: 66 }), field({}, { clinica_id: 80 }), field({}, { clinica_id: null }), field({}, { clinica_id: '72invalid' })];
  assert.deepEqual(scopePatientCustomFields(fields, { readableClinicIds: [72, 66, 80], sensitiveClinicIds: [72, 80], linkedClinicIds: [66, 72] }), [fields[0]]);
  assert.deepEqual(scopePatientCustomFields(fields), []);
  assert.deepEqual(scopePatientCustomFields(fields, { readableClinicIds: [72], linkedClinicIds: [72] }), []);
});

test('malformed, unknown, empty and demo records do not become clinical entries', () => {
  assert.deepEqual(entries([
    field(null), field([]), field({}, { value: '{broken' }), field({ arbitrary: 'not a mapped field' }),
    field({ contact: { nombre: 'Nombre ficticio' } }, { source: 'cliniccloud_demo' }),
    field({ contact: { nombre: 'Nombre ficticio' } }, { source_column: 'idContacto' }),
    field({ contact: { nombre: 'Nombre ficticio' } }, { clinica_id: null }),
  ]), []);
});

test('source aliases are mapped to human labels; neither identifiers nor communication settings are projected', () => {
  const [entry] = entries([field({ contact: {
    NOMBRE: 'Paciente ficticio', APELLIDOS: 'de prueba', 'TELF. MOVIL': '+34 600 000 000',
    DOMICILIO: 'Dirección ficticia', POBLACIÓN: 'Localidad', CP: '00000',
    'F. NACIMIENTO': '01/01/1980', NOTAS: 'Una anotación previa',
    IDCONTACTO: 'private-source-id', WHATSAPP: 'SI', RGPD: 'SI', PUBLICIDAD: 'SI', estado: 'BAJA',
  }, extra: { enfermedades: 'Antecedente de prueba', medicacion: 'Medicación de prueba', comunicacionWhatsapp: '1' } })]);
  assert.equal(entry.clinic_name, 'Clínica ficticia');
  assert.equal(values(entry).find(item => item.label === 'Población').value, 'Localidad');
  assert.equal(values(entry).find(item => item.label === 'Notas').value, 'Una anotación previa');
  assert.equal(values(entry).find(item => item.label === 'Medicación').value, 'Medicación de prueba');
  assert.doesNotMatch(JSON.stringify(entry), /private-source-id|WHATSAPP|RGPD|PUBLICIDAD|comunicacionWhatsapp|BAJA/);
});

test('historical contact and extra retain actual clinical text but numeric flags do not invent diagnoses', () => {
  const [entry] = entries([field({ contact: { historia: 'Antecedente histórico', alergia: '0', enfermedad: '1' }, extra: { alergias: 'Alergia de prueba', consumoTabaco: '0' } })]);
  assert.deepEqual(values(entry).map(item => item.value), ['Antecedente histórico', 'Alergia de prueba']);
});

test('original notes keep their actual date, including notes without a date', () => {
  const dated = field({ nombre: 'Evolución de prueba', fecha: '2023-10-13 10:00:00', evolucion: 'Evolución original', libre2: 'Anotación adicional' }, { source_column: 'historial_1.csv', last_imported_at: '2026-07-26 12:00:00' });
  const [entry] = entries([dated]);
  assert.equal(entry.record_date, '2023-10-13');
  assert.equal(entry.source_date, null);
  assert.equal(entry.imported_date, '2026-07-26');
  assert.equal(entry.kind, 'clinical_note');
  const [undated] = entries([field({ evolucion: 'Sin fecha conocida', fecha: '0000-00-00' }, { source_column: 'historial_1.csv', last_imported_at: '2026-07-26' })]);
  assert.equal(undated.record_date, null, 'import date must never become the clinical date');
});

test('historical export mode flags do not become narrative; real source metadata remains visible with its limitation', () => {
  const [entry] = entries([field({ nombre: 'Título de origen', fecha: '2023-01-01', libre: '1' }, { source_column: 'historial_1.csv' })]);
  assert.deepEqual(entry.sections, []);
  assert.equal(entry.title, 'Título de origen');
  assert.equal(entry.record_date, '2023-01-01');
  assert.equal(entry.content_note, 'La exportación disponible conserva este registro, pero no incluye sus anotaciones clínicas.');
  const [undated] = entries([field({ nombre: 'Título de origen', libre: '0', antecedentes: '0', otros: '' }, { source_column: 'historial_1.csv' })]);
  assert.deepEqual(undated.sections, []);
  assert.equal(undated.record_date, null);
  assert.deepEqual(entries([field({ libre: '0' }, { source_column: 'historial_1.csv' })]), []);
});

test('dated export snapshots separate export date from a clinical encounter and enforce their source contract', () => {
  const record = { version: 'cliniccloud_patient_history/1', source_account: 'cliniccloud-5880', source_date: '2026-10-03', contact: { NOTAS: 'Nota anterior', DOMICILIO: 'Domicilio histórico' } };
  const source_column = 'BACKUP_CONTACTOS_2026-10-03.csv';
  const [entry] = entries([field(record, { source_column })]);
  assert.equal(entry.source_date, '2026-10-03');
  assert.equal(entry.record_date, null);
  assert.deepEqual(entries([field({ ...record, source_account: 'another-account' }, { source_column })]), []);
  assert.deepEqual(entries([field({ ...record, version: 'untrusted-version' }, { source_column })]), []);
});

test('normalized contact snapshots show original fields, never a fabricated stored birth-date or consent state', () => {
  const record = { version: 'cliniccloud_contact_snapshot/1', source_account: 'cliniccloud-5880', contact: { idContacto: '111', num: '123' }, fields: { name: 'Ejemplo', surname: 'Ficticio', birth_date: '2026-09-03', email: 'example@example.invalid' }, stored_fields: { birth_date: '' }, import: { messages_enabled: true } };
  const [entry] = entries([field(record, { source_column: 'cliniccloud_contact_snapshot' })]);
  assert.equal(values(entry).find(item => item.label === 'Fecha de nacimiento').value, '2026-09-03');
  assert.doesNotMatch(JSON.stringify(entry), /messages_enabled|idContacto|stored_fields/);
});

test('untrusted markup remains plain source text for Angular interpolation; no HTML or IDs become actions', () => {
  const malicious = '<img src=x onerror=alert(1)> & <script>bad()</script>';
  const [entry] = entries([field({ nombre: malicious, libre: malicious }, { source_column: 'historial_1.csv', field_key: 'id-patient-sensitive' })]);
  assert.equal(entry.title, malicious);
  assert.equal(values(entry)[0].value, malicious);
  assert.doesNotMatch(entry.id, /sensitive/);
  assert.match(entry.id, /^[a-f0-9]{20}$/);
});

test('scalar values and valid dates are handled conservatively, with no object stringification or rollover', () => {
  assert.equal(plainText({ text: 'unknown' }), '');
  assert.equal(plainText(false), '');
  assert.equal(plainText(' NULL '), '');
  assert.equal(plainText(' Texto\r\noriginal '), 'Texto\noriginal');
  assert.equal(dateOnly('31/02/2026'), null);
  assert.equal(dateOnly('2026-04-31'), null);
  assert.equal(dateOnly('29/02/2024'), '2024-02-29');
  assert.equal(dateOnly('2026-10-03T10:00:00Z'), '2026-10-03');
});

test('entries are deterministic and newest dated source first; records from two clinics remain distinct', () => {
  const fields = [field({ evolucion: 'Anterior', fecha: '2023-01-01' }, { source_column: 'historial_1.csv', field_key: 'history-key' }), field({ evolucion: 'Reciente', fecha: '2025-01-01' }, { source_column: 'historial_1.csv', field_key: 'other-key' })];
  const result = entries(fields);
  assert.equal(values(result[0])[0].value, 'Reciente');
  assert.deepEqual(entries(fields.slice().reverse()), result);
  assert.notEqual(entries([fields[0]])[0].id, entries([{ ...fields[0], clinica_id: 66 }])[0].id);
});

test('HTTP detail filters original rows before projection and uses existing per-clinic sensitive ACL, without new endpoint or DDL', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/paciente.controller.js'), 'utf8');
  const detail = source.slice(source.indexOf('exports.getPacienteById'), source.indexOf('exports.getPacienteActivity'));
  assert.match(detail, /attributes: \[[^\]]*'clinica_id'[^\]]*'source_column'[^\]]*'last_imported_at'/);
  assert.match(source, /return decisions\.every\(Boolean\)/);
  assert.match(detail, /if \(!mayViewSensitive\)[\s\S]*return res\.status\(403\)/);
  assert.match(detail, /restrictPacientePayloadToClinics\(paciente, readableClinicIds, \{ sensitiveClinicIds: readableClinicIds \}\)/);
  assert.match(detail, /buildClinicCloudPatientHistory\(scopedPatient\.camposPersonalizados/);
  assert.match(source, /linkedClinicIds: originalClinicIds/);
  assert.match(source, /delete redacted\.camposPersonalizados/);
  assert.match(source, /delete redacted\.historialClinicCloud/);
});
