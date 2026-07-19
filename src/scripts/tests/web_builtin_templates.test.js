'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertValidWebDocument } = require('../../lib/webDocument');
const {
  BUILTIN_WEB_TEMPLATES_V1,
  BUILTIN_WEB_TEMPLATE_COMPATIBILITY,
  BUILTIN_WEB_TEMPLATES_REVISION,
} = require('../../contracts/webBuiltinTemplatesV1');

const EXPECTED_IDENTITIES = Object.freeze([
  ['61e5a73e-bcd5-47f0-a145-a0ddcbd76001', 'quick-treatment-v1'],
  ['61e5a73e-bcd5-47f0-a145-a0ddcbd76002', 'considered-treatment-v1'],
  ['61e5a73e-bcd5-47f0-a145-a0ddcbd76003', 'general-clinic-v1'],
  ['61e5a73e-bcd5-47f0-a145-a0ddcbd76004', 'local-call-whatsapp-v1'],
  ['61e5a73e-bcd5-47f0-a145-a0ddcbd76005', 'qualification-form-v1'],
]);

function walkDocument(document) {
  const visited = new Set();
  const visit = (nodeId) => {
    assert.equal(visited.has(nodeId), false, `nodo reutilizado o ciclo: ${nodeId}`);
    const node = document.nodes[nodeId];
    assert.ok(node, `falta el nodo ${nodeId}`);
    assert.equal(node.id, nodeId);
    visited.add(nodeId);
    for (const childId of node.children) visit(childId);
  };
  for (const page of document.pages) {
    for (const rootId of page.root_node_ids) visit(rootId);
  }
  for (const globalId of [document.globals.header_node_id, document.globals.footer_node_id]) {
    if (globalId) visit(globalId);
  }
  return visited;
}

test('el catálogo inicial contiene las cinco plantillas acordadas y todas validan', () => {
  assert.equal(BUILTIN_WEB_TEMPLATES_V1.length, 5);
  assert.deepEqual(
    BUILTIN_WEB_TEMPLATES_V1.map((item) => [item.id, item.catalog_key]),
    EXPECTED_IDENTITIES
  );
  assert.equal(BUILTIN_WEB_TEMPLATES_REVISION, 2);
  assert.deepEqual(BUILTIN_WEB_TEMPLATE_COMPATIBILITY.breakpoints, ['desktop', 'tablet', 'mobile']);
  assert.equal(
    BUILTIN_WEB_TEMPLATES_V1.find((item) => item.catalog_key === 'qualification-form-v1')?.category,
    'qualification'
  );
  for (const template of BUILTIN_WEB_TEMPLATES_V1) {
    const result = assertValidWebDocument(template.document);
    assert.match(result.hash, /^[a-f0-9]{64}$/);
    assert.equal(template.document.pages.length, 1);
    const nodes = Object.values(template.document.nodes);
    const forms = nodes.filter((node) => node.type === 'intake_form');
    const ctas = nodes.filter((node) => node.type === 'button' && node.props.action === 'intake_form_anchor');
    assert.equal(forms.length, 1, template.name);
    assert.ok(ctas.length >= 1, `${template.name} necesita al menos un CTA nativo`);
    assert.ok(ctas.every((cta) => cta.props.target === forms[0].id), template.name);
    assert.equal(template.document.consent.preview_mode, true);
    assert.equal(template.document.seo.indexing, 'noindex');
  }
});

test('cada plantilla conserva una jerarquía completa, única y sin HTML libre', () => {
  for (const template of BUILTIN_WEB_TEMPLATES_V1) {
    const nodes = Object.values(template.document.nodes);
    assert.equal(nodes.filter((node) => node.type === 'heading' && node.props.level === 1).length, 1, template.name);
    assert.equal(walkDocument(template.document).size, nodes.length, `${template.name} contiene nodos huérfanos`);
    assert.doesNotMatch(JSON.stringify(template.document), /<\/?(?:script|iframe|style|div|span)\b/i);
  }
});

test('todas las rejillas declaran desktop, tablet y mobile de forma coherente', () => {
  for (const template of BUILTIN_WEB_TEMPLATES_V1) {
    const grids = Object.values(template.document.nodes).filter((node) => (
      node.type === 'section' && node.props.layout === 'grid' && node.props.columns > 1
    ));
    for (const grid of grids) {
      assert.deepEqual(Object.keys(grid.responsive), ['desktop', 'tablet', 'mobile'], `${template.name}/${grid.id}`);
      assert.equal(grid.responsive.desktop.columns, grid.props.columns, `${template.name}/${grid.id}`);
      assert.ok(grid.responsive.tablet.columns <= grid.responsive.desktop.columns, `${template.name}/${grid.id}`);
      assert.ok(grid.responsive.tablet.columns >= grid.responsive.mobile.columns, `${template.name}/${grid.id}`);
      assert.equal(grid.responsive.mobile.columns, 1, `${template.name}/${grid.id}`);
    }
  }
});

test('las plantillas no incluyen teléfonos, URL ni dominios ficticios', () => {
  const serialized = JSON.stringify(BUILTIN_WEB_TEMPLATES_V1);
  assert.doesNotMatch(serialized, /\+3490{6,}|900000000|example\.(?:com|org|net)|localhost|127\.0\.0\.1/i);

  for (const template of BUILTIN_WEB_TEMPLATES_V1) {
    for (const node of Object.values(template.document.nodes)) {
      if (node.type !== 'button') continue;
      assert.notEqual(node.props.action, 'phone', `${template.name}/${node.id}`);
      assert.notEqual(node.props.action, 'whatsapp', `${template.name}/${node.id}`);
    }
  }
});

test('Contacto local recoge la preferencia sin activar canales sin binding real', () => {
  const template = BUILTIN_WEB_TEMPLATES_V1.find((item) => item.catalog_key === 'local-call-whatsapp-v1');
  const document = template.document;
  const form = document.nodes['local-form-primary'];
  const preference = form.props.fields.find((field) => field.name === 'preferred_contact');
  assert.deepEqual(preference.options.map((option) => option.value), ['telefono', 'whatsapp', 'email']);
  assert.equal(document.nodes['local-call'].props.action, 'intake_form_anchor');
  assert.equal(document.nodes['local-whatsapp'].props.action, 'intake_form_anchor');
  assert.equal(document.integrations.phone_enabled, false);
  assert.equal(document.integrations.whatsapp_enabled, false);
  assert.deepEqual(Object.keys(document.bindings), ['local-address-binding']);
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
