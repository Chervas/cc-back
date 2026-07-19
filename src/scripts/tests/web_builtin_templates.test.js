'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertValidWebDocument } = require('../../lib/webDocument');
const { BUILTIN_WEB_TEMPLATES_V1 } = require('../../contracts/webBuiltinTemplatesV1');

test('el catálogo inicial contiene las cinco plantillas acordadas y todas validan', () => {
  assert.equal(BUILTIN_WEB_TEMPLATES_V1.length, 5);
  assert.equal(new Set(BUILTIN_WEB_TEMPLATES_V1.map((item) => item.id)).size, 5);
  assert.equal(new Set(BUILTIN_WEB_TEMPLATES_V1.map((item) => item.catalog_key)).size, 5);
  assert.equal(
    BUILTIN_WEB_TEMPLATES_V1.find((item) => item.catalog_key === 'qualification-form-v1')?.category,
    'qualification'
  );
  for (const template of BUILTIN_WEB_TEMPLATES_V1) {
    const result = assertValidWebDocument(template.document);
    assert.match(result.hash, /^[a-f0-9]{64}$/);
    assert.equal(template.document.pages.length, 1);
    assert.ok(Object.values(template.document.nodes).some((node) => node.type === 'intake_form'));
    assert.equal(template.document.consent.preview_mode, true);
    assert.equal(template.document.seo.indexing, 'noindex');
  }
});

test('cada plantilla tiene exactamente un h1 y texto responsive sin HTML libre', () => {
  for (const template of BUILTIN_WEB_TEMPLATES_V1) {
    const nodes = Object.values(template.document.nodes);
    assert.equal(nodes.filter((node) => node.type === 'heading' && node.props.level === 1).length, 1, template.name);
    assert.doesNotMatch(JSON.stringify(template.document), /<\/?(?:script|iframe|style|div|span)\b/i);
  }
});

test('las preferencias de contacto solo ofrecen email cuando el formulario lo recoge', () => {
  for (const template of BUILTIN_WEB_TEMPLATES_V1) {
    const forms = Object.values(template.document.nodes).filter((node) => node.type === 'intake_form');
    for (const form of forms) {
      const names = new Set(form.props.fields.map((field) => field.name));
      const preferred = form.props.fields.find((field) => field.name === 'preferred_contact');
      const offersEmail = preferred?.options?.some((option) => option.value === 'email') === true;
      assert.equal(offersEmail && !names.has('email'), false, template.name);
    }
  }
});
