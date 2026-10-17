'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const time = require('../../lib/consent-clinic-time');
const servicePath = require.resolve('../../services/consentimientos.service');
const source = fs.readFileSync(servicePath, 'utf8');
const serviceRequire = createRequire(servicePath);
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const plain = value => value?.toJSON ? value.toJSON() : value;
const object = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const shared = {
  require: serviceRequire, process: { env: {} }, getPlain: plain, parseJsonObject: object,
  consentClinicTime: time, formatDateTime: time.formatDateTime, formatDateOnly: time.formatDateOnly,
  documentBranding: require('../../lib/consent-document-branding'),
  consentDocumentChoices: require('../../lib/consent-document-choices'),
  consentDocumentPersonalData: require('../../lib/consent-document-personal-data'),
  documentBlocks: require('../../lib/consent-document-blocks'),
  documentCompletion: require('../../lib/consent-document-completion'),
};
function compile(start, end, name, extra = {}) {
  return vm.runInNewContext(extract(start, end) + '\n' + name, { ...shared, ...extra });
}

test('clinic date/time formatting is independent of host timezone and follows DST and midnight boundaries', () => {
  assert.equal(time.formatDateTime('2026-10-25T00:30:00Z', 'Europe/Madrid'), '25/10/2026, 02:30');
  assert.equal(time.formatDateTime('2026-10-25T01:30:00Z', 'Europe/Madrid'), '25/10/2026, 02:30');
  assert.equal(time.formatDateTime('2026-01-01T00:30:00Z', 'America/New_York'), '31/12/2025, 19:30');
  assert.equal(time.formatDateTime('2026-01-01 00:30:00', 'America/New_York'), '31/12/2025, 19:30');
  assert.equal(time.formatDateOnly('2026-01-01T23:30:00Z', 'Europe/Madrid'), '02/01/2026');
  assert.equal(time.formatDateTime('2026-01-01T00:30:00Z', 'invalid/timezone'), '01/01/2026, 01:30');
  const code = `const t=require(${JSON.stringify(require.resolve('../../lib/consent-clinic-time'))}); process.stdout.write(JSON.stringify([
    t.formatDateTime('2026-01-01 00:30:00','America/New_York'),
    t.formatDateOnly('2026-01-01T23:30:00Z','Europe/Madrid'),
    t.formatCalendarDate('1980-01-02'),t.formatCalendarDate(new Date('1980-01-02T00:00:00Z'))]));`;
  const runs = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'].map(TZ => {
    const child = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, TZ }, encoding: 'utf8', timeout: 3000 });
    assert.equal(child.status, 0, child.stderr); return child.stdout;
  });
  assert.equal(new Set(runs).size, 1, 'No server TZ leaks into timestamps or calendar-only DOB');
});

test('new template contexts freeze clinic zone, preserve ISO instants, and never shift calendar birth dates', () => {
  const build = compile('function buildTemplateContext(', '\nfunction resolvePath(', 'buildTemplateContext');
  const inicio = '2026-01-01T00:30:00Z', fin = '2026-01-01T01:00:00Z';
  const context = build({ clinica: { id_clinica: 72, nombre_clinica: 'QA', configuracion: { timezone: 'America/New_York' } },
    paciente: { id_paciente: 1, nombre: 'QA', fecha_nacimiento: '1980-01-02' }, cita: { inicio, fin } });
  assert.equal(context.clinica.time_zone, 'America/New_York');
  assert.equal(context.document_presentation.patient_identity_labels, 'mobile_fixed/v1');
  assert.equal(context.cita.inicio, inicio); assert.equal(context.cita.fin, fin);
  assert.equal(context.cita.fecha, '31/12/2025, 19:30'); assert.equal(context.paciente.fecha_nacimiento, '02/01/1980');
  const now = new Date();
  assert.equal(context.fecha.firma, time.formatDateOnly(now, context.clinica.time_zone));
});

test('clinic calendar, not UTC/host day, determines DOB validation and minor status for new pending identity', () => {
  const personal = shared.consentDocumentPersonalData;
  const values = Object.fromEntries(personal.FIELDS.map(field => [field.key, '']));
  values.nombre = 'QA'; values.apellidos = 'Ficticio'; values.fecha_nacimiento = '2026-01-02';
  const now = new Date('2026-01-01T23:30:00Z');
  assert.doesNotThrow(() => personal.validateValues(values, now, personal.FIELDS.map(field => field.key), 'Europe/Madrid'));
  assert.throws(() => personal.validateValues(values, now, personal.FIELDS.map(field => field.key), 'America/New_York'),
    error => error.code === 'consent_personal_data_invalid' && error.details.field === 'fecha_nacimiento');
  assert.equal(time.isMinor('2008-01-02', { now, timeZone: 'Europe/Madrid' }), false);
  assert.equal(time.isMinor('2008-01-02', { now, timeZone: 'America/New_York' }), true);
});

test('printable evidence uses clinic timezone while signed body, context, ISO evidence and hash remain byte-identical', () => {
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const render = compile('function buildPrintableHtml(', '\nasync function htmlToPdfBuffer(', 'buildPrintableHtml', {
    escapeHtml, DOCUMENT_BRAND_LOGO: 'data:image/svg+xml;base64,',
  });
  const body = '<p>Texto legal y fecha histórica 01/01/2026: no se reescriben.</p>';
  const doc = { id: 1, title: 'Ficticio', purpose: 'clinical', status: 'signed', signed_at: '2026-01-01T00:30:00Z',
    snapshot_html: body, snapshot_hash: 'frozen-hash', clinica: { configuracion: { timezone: 'America/New_York' } },
    snapshot_json: { context: { clinica: { id: 72, time_zone: 'Europe/Madrid' } },
      signature_evidence: { signed_at: '2026-01-01T00:30:00Z', signer_name: 'QA' },
      professional_signature_evidence: { signed_at: '2026-01-01T01:00:00Z' }, revocation_evidence: { revoked_at: '2026-01-01T01:30:00Z' } } };
  const frozen = JSON.stringify(doc), html = render(doc);
  assert(html.includes(body)); assert(html.includes('31/12/2025, 19:30'));
  assert(html.includes('31/12/2025, 20:00')); assert(html.includes('31/12/2025, 20:30'));
  assert(html.includes('frozen-hash')); assert.equal(JSON.stringify(doc), frozen);
  assert.equal(time.documentTimezone({ snapshot_json: doc.snapshot_json }), 'Europe/Madrid');
});

test('public and kiosk DTO expose effective clinic zone and passive app branding, not configuration or queue-scope changes', async () => {
  const helpers = extract('function consentPresentationClinicInclude(', '\nasync function loginTabletKiosk(');
  const compileDto = (start, end, name) => vm.runInNewContext(helpers + '\n' + extract(start, end) + '\n' + name,
    { ...shared, requiresRepresentative: () => false, publicSignatureEvidenceForDocument: () => null,
      DOCUMENT_PENDING_STATUSES: new Set(['pending', 'sent', 'viewed']), medicalQuestionnaireEnabled: () => false });
  const clinic = { id_clinica: 72, nombre_clinica: 'Clínica QA', grupoClinicaId: 5, url_avatar: 'https://example.com/clinic.png',
    configuracion: { timezone: 'Pacific/Auckland', patient_intake: { tablet_branding: { source: 'group',
      logo_url: 'https://example.com/group.png', logo_background: 'dark' } } },
    grupoClinica: { id_grupo: 5, nombre_grupo: 'Grupo QA' } };
  const pack = { id: 4, clinica_id: 72, paciente_id: 1, clinica: clinic, paciente: { nombre: 'QA' },
    documents: [{ id: 8, package_id: 4, paciente_id: 1, clinica_id: 72, title: 'Título para el paciente', status: 'pending' }] };
  const frozen = JSON.stringify(pack);
  const publicDto = await compileDto('async function serializePublicPackage(', '\nasync function resolveActivePublicPackage(', 'serializePublicPackage')(pack);
  assert.equal(publicDto.clinica.time_zone, 'Pacific/Auckland'); assert.equal(publicDto.tablet_branding.source, 'group');
  assert.equal(publicDto.tablet_branding.display_name, 'Grupo QA'); assert.equal(publicDto.tablet_branding.logo_url, 'https://example.com/group.png');
  assert.equal(publicDto.documents[0].title, 'Título para el paciente'); assert.equal(publicDto.documents[0].document_branding, null);
  assert.equal(publicDto.clinica.configuracion, undefined);
  const kioskDto = compileDto('function serializeKioskPackage(', '\nfunction publicSignatureEvidenceForDocument(', 'serializeKioskPackage')(pack);
  assert.equal(kioskDto.time_zone, 'Pacific/Auckland'); assert.equal(kioskDto.clinic.time_zone, 'Pacific/Auckland');
  assert.equal(kioskDto.pending_count, 1); assert.equal(kioskDto.documents[0].title, 'Título para el paciente');
  assert.equal(JSON.stringify(pack), frozen);
  const foreign = { ...clinic, grupoClinica: { id_grupo: 6, nombre_grupo: 'Grupo ajeno' } };
  const denied = publicDto && await compileDto('async function serializePublicPackage(', '\nasync function resolveActivePublicPackage(', 'serializePublicPackage')({ ...pack, clinica: foreign });
  assert.equal(denied.tablet_branding.source, 'clinic'); assert.equal(denied.tablet_branding.display_name, 'Clínica QA');
  assert.equal(denied.tablet_branding.logo_url, 'https://example.com/clinic.png', 'Foreign group metadata cannot supply a group name or logo');
});

test('staff rows expose clinic-local timezone without leaking loaded config or rewriting frozen evidence', () => {
  const project = compile('function withConsentClinicTime(', '\nasync function loginTabletKiosk(', 'withConsentClinicTime');
  const doc = { id: 1, snapshot_hash: 'unchanged', signed_at: '2026-10-17T10:00:00Z',
    snapshot_html: '<p>Firmado, no editar</p>', clinica: { id_clinica: 72, nombre_clinica: 'QA', configuracion: { timezone: 'Asia/Tokyo', private_value: 'not public' } } };
  const before = JSON.stringify(doc), dto = project(doc);
  assert.equal(dto.time_zone, 'Asia/Tokyo'); assert.equal(dto.clinica.time_zone, 'Asia/Tokyo');
  assert.equal(dto.clinica.configuracion, undefined); assert.equal(dto.signed_at, doc.signed_at);
  assert.equal(dto.snapshot_html, doc.snapshot_html); assert.equal(dto.snapshot_hash, doc.snapshot_hash);
  assert.equal(JSON.stringify(doc), before);
  const privacy = require('../../services/patientPrivacyStatus.service');
  const state = privacy.privacyStateFromContext({ appointment: { paciente_id: 1, clinica_id: 72 },
    context: { now: new Date(), policies: new Map([[72, { enabled: false }]]), timeZones: new Map([[72, 'Asia/Tokyo']]) } });
  assert.equal(state.time_zone, 'Asia/Tokyo'); assert.equal(state.applicable, false);
});
