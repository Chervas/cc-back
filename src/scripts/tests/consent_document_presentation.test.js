'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../services/consentimientos.service'), 'utf8');
const block = source.slice(source.indexOf('function buildPrintableHtml('), source.indexOf('\nasync function htmlToPdfBuffer('));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const render = vm.runInNewContext(block + '\nbuildPrintableHtml', {
  getPlain: value => value, escapeHtml, DOCUMENT_BRAND_LOGO: 'data:image/svg+xml;base64,',
  formatDateTime: require('../../lib/consent-clinic-time').formatDateTime,
  consentClinicTime: require('../../lib/consent-clinic-time'),
  documentCompletion: require('../../lib/consent-document-completion'),
  documentBranding: require('../../lib/consent-document-branding'),
});

test('LOPD has one presented title without changing frozen signed HTML, identity, choices or hashes', () => {
  const html = '<section lang="es" class="bs-privacy-digital" data-consent-presentation="bs-privacy-digital/v1"><h2>Protección de datos</h2>\n'
    + '<section class="consent-patient-identity"><h3>Datos del paciente</h3><dl><div><dt>Teléfono</dt><dd>000000000</dd></div></dl></section>'
    + '<p>Cláusula original de prueba: se conserva íntegra.</p></section>';
  const doc = { id: 1, public_id: 'qa-frozen-document', purpose: 'data_protection', status: 'signed',
    title: 'Protección de datos · Alta de pacientes', snapshot_html: html,
    snapshot_hash: 'unchanged-hash', snapshot_json: { context: { paciente: { nombre_completo: 'Paciente ficticio' } } } };
  const before = JSON.stringify(doc), result = render(doc);
  assert.equal(JSON.stringify(doc), before);
  assert(result.includes(html), 'The stored signed body remains byte-identical inside the printable wrapper');
  assert(result.includes('<h1>Protección de datos · Alta de pacientes</h1>'));
  assert(result.includes('.content > .bs-privacy-digital > h2:first-child { display: none; }'));
  assert(result.includes('unchanged-hash'));
  assert(!result.includes('.content h2 { display: none; }'), 'Other clinical and legal headings must remain visible');
});

test('ordinary clinical document titles and legal sections are not removed or rewritten', () => {
  const body = '<h2>Explicación del procedimiento</h2><p>Información clínica de prueba.</p>';
  const result = render({ id: 2, title: 'Actuación clínica', purpose: 'clinical', snapshot_html: body });
  assert(result.includes('<h1>Actuación clínica</h1>'));
  assert(result.includes('<section class="content">' + body + '</section>'));
});

test('only newly frozen presentation separates mobile and fixed phone in digital, registration and block printable bodies', () => {
  const presentation = require('../../lib/consent-document-presentation');
  const digital = require('../../lib/bs-privacy-digital-template');
  const registration = require('../../lib/registration-privacy-template');
  const blocks = require('../../lib/consent-document-blocks');
  const context = { paciente: { nombre: 'QA', apellidos: 'Ficticio', nombre_completo: 'QA Ficticio',
    telefono: '+447700900183', telefono2: '+447700900184' } };
  const registrationVersion = registration.standardDraft();
  const blockVersion = { body_json: { document_blocks: { schema_version: blocks.SCHEMA, blocks: [
    { id: 'identity', type: 'patient_data', fields: ['telefono', 'telefono2'] }, { id: 'signature', type: 'signature' },
  ] } } };
  const scenarios = [
    { render: context => digital.buildBsPrivacyDigitalHtml(context).html, oldLabel: 'Segundo teléfono' },
    { render: context => registration.render(registrationVersion, context), oldLabel: 'Segundo teléfono' },
    { render: context => blocks.renderVersion(blockVersion, context), oldLabel: 'Teléfono fijo u otro teléfono' },
  ];
  for (const scenario of scenarios) {
    const frozen = JSON.stringify(context), historical = scenario.render(context);
    assert(historical.includes('<dt>' + scenario.oldLabel + '</dt>'));
    const newlyIssued = { ...context, document_presentation: presentation.newPresentation() };
    const html = scenario.render(newlyIssued);
    assert(html.includes('<dt>Teléfono móvil</dt>')); assert(html.includes('<dt>Teléfono fijo</dt>'));
    assert(!html.includes('<dt>' + scenario.oldLabel + '</dt>'));
    const printed = render({ id: 10, purpose: 'data_protection', status: 'pending', title: 'LOPD ficticia',
      snapshot_html: html, snapshot_json: { context: newlyIssued } });
    assert(printed.includes('<dt>Teléfono móvil</dt>')); assert(printed.includes('<dt>Teléfono fijo</dt>'));
    assert.equal(scenario.render(context), historical); assert.equal(JSON.stringify(context), frozen);
  }
});
