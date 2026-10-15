'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBsPrivacyDigitalHtml } = require('../../lib/bs-privacy-digital-template');
const { renderConsentVersionHtml } = require('../../lib/consent-version-html');
const built = buildBsPrivacyDigitalHtml();
const version = () => ({ body_html: built.html, body_json: {
  consent_form: built.consent_form, digital_presentation: built.metadata,
} });

test('digital issuance fills and escapes the frozen identity, without paper blanks', () => {
  const html = renderConsentVersionHtml(version(), { paciente: {
    nombre_completo: 'Paciente <img src=x onerror=alert(1)>', dni: 'FICTICIO-1',
    direccion: 'Calle de prueba 1', email: '',
  } }, () => { throw Error('Legacy renderer must not handle digital identity'); });
  assert(html.includes('Paciente &lt;img src=x onerror=alert(1)&gt;'));
  assert(html.includes('FICTICIO-1'));
  assert(html.includes('Calle de prueba 1'));
  assert(!html.includes('Correo electrónico'));
  assert(!/<img|<table|_{3,}|FDO:/i.test(html));
});

test('unapproved digital content and marker cannot silently use a different renderer', () => {
  const changed = version(); changed.body_html += '<p>Cambio no aprobado</p>';
  assert.throws(() => renderConsentVersionHtml(changed, {}, () => ''), { code: 'consent_digital_presentation_invalid' });
  const marker = version(); marker.body_json.digital_presentation = {};
  assert.throws(() => renderConsentVersionHtml(marker, {}, () => ''), { code: 'consent_digital_presentation_invalid' });
});

test('other consent templates preserve their existing renderer contract', () => {
  const context = { paciente: { nombre_completo: 'Prueba' } };
  const legacy = { body_html: '<p>{{paciente.nombre_completo}}</p>', body_json: {} };
  let called = false;
  const html = renderConsentVersionHtml(legacy, context, (body, frozen) => {
    called = true; assert.equal(body, legacy.body_html); assert.equal(frozen, context); return 'legacy-result';
  });
  assert(called); assert.equal(html, 'legacy-result');
});
