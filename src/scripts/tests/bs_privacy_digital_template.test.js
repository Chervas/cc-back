'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const helper = require('../../lib/bs-privacy-digital-template');
const choices = require('../../lib/consent-document-choices');

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const normalize = value => value.replace(/\s+/gu, ' ').trim();
const text = html => normalize(html.replace(/<[^>]*>/g, ''));
const sourcePath = '/home/ubuntu/secure-imports/bs-final-consents-reviewed-20261015-v1/'
  + 'e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f/body-text-responsive.html';

test('native presentation contains no paper artwork, blank lines, duplicated choices or signature fields', () => {
  const result = helper.buildBsPrivacyDigitalHtml();
  assert.match(result.html, /^<section lang="es" class="bs-privacy-digital"/);
  assert.match(result.html, /<h2>Protección de datos<\/h2>/);
  assert.match(result.html, /<h3>¿Cuál es la legitimación/);
  assert.equal((result.html.match(/<ul>/g) || []).length, 1);
  assert.equal((result.html.match(/<li>/g) || []).length, 5);
  assert(!/<img\b|<table\b|data:image|FDO:|_{3,}|\{\{|No consta|<input\b|<canvas\b/i.test(result.html));
  assert(!result.html.includes('Datos del paciente'), 'An empty publication has no fake or missing personal data');
  for (const key of choices.CHOICE_KEYS) assert(!result.html.includes(choices.CHOICE_LABELS[key]), 'The engine renders each decision once, not twice');
  assert.equal(choices.validateForm(result.consent_form).fields.length, 4);
});

test('all 27 source blocks and the final declaration are preserved literally', () => {
  const { html } = helper.buildBsPrivacyDigitalHtml();
  assert.equal(helper.LEGAL_BLOCKS.length, 27);
  for (const block of helper.LEGAL_BLOCKS) {
    assert(html.includes(`<${block.tag}>${block.text}</${block.tag}>`), block.text);
    assert.equal(html.split(block.text).length - 1, 1, 'No legal block is duplicated');
  }
  assert(html.endsWith('<p>Con la firma del presente documento me considero informado y consiento el tratamiento de mis datos con las premisas anteriormente expuestas.</p>\n</section>'));
  // These independent digest pins were calculated from the supplied source,
  // not by hashing the renderer's output during assertion setup.
  assert.equal(helper.LEGAL_BODY_SHA256, 'b915388680f4674a3f919132e800a044dece6c994b8948ce72afde0239e42bcd');
  assert.equal(helper.LEGAL_TEXT_SHA256, '2bc8b240b535f861cdfbb4d985e173c31d5c3969109a1e80533a87413fbc62c5');
  assert.equal(sha256(helper.LEGAL_TEXT), helper.LEGAL_TEXT_SHA256);
});

test('reviewed source comparison: only paper presentation and duplicate controls are removed', { skip: !fs.existsSync(sourcePath) }, () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(sha256(source), helper.APPROVED_LEGACY_HTML_SHA256);
  const tables = [...source.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(match => match[0]);
  assert.equal(tables.length, 2);
  const paragraphs = [...source.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, '')
    .matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(match => text(match[1])).filter(Boolean);
  assert.deepEqual(paragraphs.slice(6, 33), helper.LEGAL_BLOCKS.map(block => block.text));
  const optionLabels = [...tables[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => text(match[1])).filter(Boolean).slice(3);
  assert.deepEqual(optionLabels, choices.CHOICE_KEYS.map(key => choices.CHOICE_LABELS[key]));
  const sourceLegalText = [...paragraphs.slice(6, 32), ...optionLabels, paragraphs[32]].join('\n');
  assert.equal(sourceLegalText, helper.LEGAL_TEXT);
  assert.equal(sha256(sourceLegalText), helper.LEGAL_TEXT_SHA256);
});

test('patient identity is separate native data, uses every supplied field and omits missing fields', () => {
  const patient = {
    nombre_completo: ' Paciente  ficticio ', dni: '00000000T', fecha_nacimiento: '01/02/2000',
    direccion: 'Calle de prueba 1', codigo_postal: '03003', ciudad: 'Alicante', provincia: 'Alicante',
    telefono: '+34 600000000', email: 'qa@example.invalid',
  };
  const result = helper.buildBsPrivacyDigitalHtml({ paciente: patient });
  assert.match(result.html, /<section class="consent-patient-identity"><h3>Datos del paciente<\/h3><dl>/);
  assert.equal((result.html.match(/<dd>/g) || []).length, 9);
  assert.match(result.html, /<dt>Paciente<\/dt><dd>Paciente ficticio<\/dd>/);
  assert.match(result.html, /<dt>DNI o documento de identidad<\/dt><dd>00000000T<\/dd>/);
  assert.match(result.html, /<dt>Dirección<\/dt><dd>Calle de prueba 1<\/dd>/);
  const partial = helper.buildBsPrivacyDigitalHtml({ paciente: { nombre_completo: 'Paciente ficticio', dni: ' ', email: null } });
  assert.equal((partial.html.match(/<dd>/g) || []).length, 1);
  assert(!partial.html.includes('DNI o documento de identidad'));
  assert(!partial.html.includes('Correo electrónico'));
  assert.deepEqual(result.metadata, helper.buildBsPrivacyDigitalHtml().metadata, 'Audit metadata never contains patient identifiers');
});

test('all patient strings are escaped; unknown fields and inherited properties cannot add markup or replace legal clauses', () => {
  const malicious = ` <img src=x onerror="alert('x')"> & <script>bad()</script> `;
  const patient = Object.fromEntries(helper.IDENTITY_FIELDS.map(field => [field.key, malicious]));
  patient.legal_html = '<h1>Replacement</h1>';
  const { html } = helper.buildBsPrivacyDigitalHtml({ paciente: patient,
    clinica: { razon_social: 'Replacement controller' }, html: '<script>bad()</script>' });
  assert(!/<img\b|<script\b|onerror="/i.test(html));
  assert(html.includes('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; &lt;script&gt;bad()&lt;/script&gt;'));
  assert(!html.includes('Replacement'));
  assert(html.includes('INSTITUTO OBES ALICANTE S.L. con CIF B54847090'));
  assert(!helper.buildBsPrivacyDigitalHtml({ paciente: Object.create({ nombre_completo: 'Inherited' }) }).html.includes('Inherited'));
  assert(!helper.buildBsPrivacyDigitalHtml({ paciente: { nombre_completo: { toString() { throw Error('Never stringify arbitrary objects'); } } } }).html.includes('Datos del paciente'));
});

test('publication approval pins canonical empty-context HTML, full source metadata and exact interactive decision schema', () => {
  const built = helper.buildBsPrivacyDigitalHtml();
  const bodyJson = { digital_presentation: built.metadata, consent_form: built.consent_form };
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html, bodyJson }), true);
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html, bodyJson: JSON.stringify(bodyJson) }), true);
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html, bodyJson: {} }), false);
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html, bodyJson: '{bad' }), false);
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html.replace('cinco años', 'dos años'), bodyJson }), false);
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: helper.buildBsPrivacyDigitalHtml({ paciente: { nombre_completo: 'Fixed patient' } }).html, bodyJson }), false);
  for (const key of Object.keys(built.metadata)) {
    const changed = structuredClone(bodyJson); changed.digital_presentation[key] = 'forged';
    assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html, bodyJson: changed }), false, key);
  }
  const extra = structuredClone(bodyJson); extra.digital_presentation.unreviewed = true;
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html, bodyJson: extra }), false);
  const noChoices = structuredClone(bodyJson); delete noChoices.consent_form;
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html, bodyJson: noChoices }), false);
  const changedChoice = structuredClone(bodyJson); changedChoice.consent_form.fields[1].label = 'Accept marketing';
  assert.equal(helper.isApprovedPrivacyPresentation({ bodyHtml: built.html, bodyJson: changedChoice }), false);
});

test('build results are independent and audit constants cannot be mutated by a caller', () => {
  const first = helper.buildBsPrivacyDigitalHtml();
  first.metadata.source_html_sha256 = 'forged'; first.consent_form.fields[0].label = 'forged';
  const second = helper.buildBsPrivacyDigitalHtml();
  assert.equal(second.metadata.source_html_sha256, helper.APPROVED_LEGACY_HTML_SHA256);
  assert.equal(second.consent_form.fields[0].label, choices.CHOICE_LABELS.health_nonmedical);
  assert(Object.isFrozen(helper.LEGAL_BLOCKS)); assert(Object.isFrozen(helper.LEGAL_BLOCKS[0]));
  assert(Object.isFrozen(helper.IDENTITY_FIELDS)); assert(Object.isFrozen(helper.IDENTITY_FIELDS[0]));
});
