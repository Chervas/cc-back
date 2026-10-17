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
  formatDateTime: value => String(value),
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
