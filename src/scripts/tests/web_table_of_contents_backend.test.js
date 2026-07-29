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

function tableOfContentsNode(overrides = {}) {
  return {
    id: 'toc_main',
    type: 'table_of_contents',
    version: 1,
    props: {
      title: 'En esta página',
      min_level: 2,
      max_level: 3,
      layout: 'boxed',
      show_numbers: true,
      empty_message: 'Añade títulos a la página para generar el índice.',
      aria_label: 'Tabla de contenidos',
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

function addTableOfContents(document, node = tableOfContentsNode()) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[node.id] = node;
  section.children.unshift(node.id);
  return node;
}

function addHeading(document, id, text, level) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[id] = {
    id,
    type: 'heading',
    version: 1,
    props: { text, level, size: 'lg', align: 'left', tone: 'default' },
    children: [],
  };
  section.children.push(id);
}

function compilerFixture(node = tableOfContentsNode()) {
  const document = createBlankWebDocument({ name: 'Implantes dentales en Barcelona', locale: 'es-ES' });
  addTableOfContents(document, node);
  addHeading(document, 'heading_benefits', 'Ventajas de los implantes', 2);
  addHeading(document, 'heading_process', 'Cómo será tu primera visita', 3);
  addHeading(document, 'heading_hidden_h4', 'No entra por nivel', 4);
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

test('table_of_contents es un bloque hoja cerrado sin URLs ni HTML libre', () => {
  const valid = buildValidWebDocument();
  addTableOfContents(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.toc_main.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const markup = clone(valid);
  markup.nodes.toc_main.props.title = '<strong>Índice</strong>';
  assert.equal(validateWebDocument(markup).valid, false);

  const unsafeLayout = clone(valid);
  unsafeLayout.nodes.toc_main.props.layout = 'script';
  assert.equal(validateWebDocument(unsafeLayout).valid, false);

  const unsafeLevel = clone(valid);
  unsafeLevel.nodes.toc_main.props.min_level = 9;
  assert.equal(validateWebDocument(unsafeLevel).valid, false);
});

test('table_of_contents compila anchors de headings de la página activa', () => {
  const input = compilerFixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-toc_main" class="cc-node cc-table-of-contents cc-toc-boxed[^\"]*"/);
  assert.match(html, /aria-label="Tabla de contenidos"/);
  assert.match(html, /<h2 class="cc-toc-title">En esta página<\/h2>/);
  assert.match(html, /<a href="#cc-heading_benefits">Ventajas de los implantes<\/a>/);
  assert.match(html, /<li class="cc-toc-item cc-toc-level-3"><span class="cc-toc-marker" aria-hidden="true">2<\/span><a href="#cc-heading_process">Cómo será tu primera visita<\/a><\/li>/);
  assert.doesNotMatch(html, /cc-toc-level-4|#cc-heading_hidden_h4|onclick=|onload=|javascript:/i);
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/i);
  assert.match(css, /\.cc-table-of-contents\{display:grid;gap:var\(--cc-md\)\}/);
});

test('table_of_contents muestra vacío si no hay headings en el rango elegido', () => {
  const input = compilerFixture(tableOfContentsNode({
    props: {
      min_level: 6,
      max_level: 6,
      show_numbers: false,
      layout: 'plain',
    },
  }));
  const html = compileWebArtifact(input).files['index.html'];
  assert.match(html, /cc-toc-plain/);
  assert.match(html, /<p class="cc-toc-empty">Añade títulos a la página para generar el índice\.<\/p>/);
});
