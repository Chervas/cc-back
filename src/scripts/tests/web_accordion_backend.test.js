'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileWebArtifact } = require('../../lib/webArtifactCompiler');
const { validateWebDocument } = require('../../lib/webDocument');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const { buildValidWebDocument } = require('./fixtures/webDocumentV1.fixture');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function accordionNode(overrides = {}) {
  return {
    id: 'accordion_main',
    type: 'accordion',
    version: 1,
    props: {
      title: 'Información útil',
      items: [
        {
          id: 'accordion_item_first',
          title: 'Primer apartado',
          body: 'Respuesta clara para el paciente.',
          open: true,
        },
        {
          id: 'accordion_item_second',
          title: 'Segundo apartado',
          body: 'Más información sin HTML.',
          open: false,
        },
      ],
      allow_multiple_open: false,
      aria_label: 'Información desplegable',
      ...(overrides.props || {}),
    },
    children: [],
    style_tokens: {
      spacing_top: 'sm',
      spacing_bottom: 'sm',
      ...(overrides.style_tokens || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'props' && key !== 'style_tokens')),
  };
}

function addAccordion(document, node = accordionNode()) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[node.id] = node;
  section.children.unshift(node.id);
  return node;
}

function compilerFixture(node = accordionNode()) {
  const document = createBlankWebDocument({ name: 'Implantes dentales en Barcelona', locale: 'es-ES' });
  addAccordion(document, node);
  return {
    document,
    contentSnapshot: {
      schema_version: 1,
      content_entries: {},
      media_assets: {},
      live_bindings: [],
    },
    project: {
      id: '9ed2cc0a-31a8-4469-990a-22b279ac81ca',
      name: 'Landing clínica',
      locale: 'es-ES',
    },
    revisionId: '35b08398-0d39-4ca8-b100-7bc9db5c66c0',
    baseUrl: 'https://landing.sites.clinicaclick.com',
    environment: 'preview',
    clinicSnapshot: { clinic_id: 66, schema_type: 'Dentist', name: 'Clínica Dental Centro' },
    intakeEndpoint: '/api/intake/web',
  };
}

test('accordion es un bloque hoja cerrado sin HTML, JS ni hijos', () => {
  const valid = buildValidWebDocument();
  addAccordion(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.accordion_main.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const unsafeTitle = clone(valid);
  unsafeTitle.nodes.accordion_main.props.items[0].title = '<strong>Click</strong>';
  assert.equal(validateWebDocument(unsafeTitle).valid, false);

  const unsafeBody = clone(valid);
  unsafeBody.nodes.accordion_main.props.items[0].body = '<script>alert(1)</script>';
  assert.equal(validateWebDocument(unsafeBody).valid, false);

  const tooMany = clone(valid);
  tooMany.nodes.accordion_main.props.items = Array.from({ length: 13 }, (_item, index) => ({
    id: `accordion_item_${index}`,
    title: `Apartado ${index + 1}`,
    body: 'Contenido válido.',
    open: false,
  }));
  assert.equal(validateWebDocument(tooMany).valid, false);
});

test('accordion compila detalles seguros, escapados y deterministas', () => {
  const input = compilerFixture(accordionNode({
    props: {
      title: 'Dudas & frecuentes',
      items: [
        {
          id: 'accordion_item_first',
          title: '¿Qué incluye?',
          body: 'Texto seguro & claro.',
          open: true,
        },
      ],
      allow_multiple_open: false,
      aria_label: 'Información desplegable',
    },
  }));
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-accordion_main" class="cc-node cc-accordion[^\"]*"/);
  assert.match(html, /aria-label="Información desplegable"/);
  assert.match(html, /<h2 class="cc-accordion-title">Dudas &amp; frecuentes<\/h2>/);
  assert.match(html, /<details class="cc-accordion-item" name="cc-accordion-accordion_main" open><summary>¿Qué incluye\?<\/summary><p>Texto seguro &amp; claro\.<\/p><\/details>/);
  const accordionHtml = html.match(/<section id="cc-accordion_main"[\s\S]*?<\/section>/)?.[0] || '';
  assert.doesNotMatch(accordionHtml, /<iframe|onclick=|onload=|onerror=|javascript:|<script/i);
  assert.match(css, /\.cc-accordion\{display:grid;gap:var\(--cc-sm\)/);
});
