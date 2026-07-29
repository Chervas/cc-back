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

function breadcrumbsNode(overrides = {}) {
  return {
    id: 'breadcrumbs_main',
    type: 'breadcrumbs',
    version: 1,
    props: {
      home_label: 'Inicio',
      separator: '›',
      show_current: true,
      aria_label: 'Ruta de navegación',
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

function addBreadcrumbs(document, node = breadcrumbsNode()) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[node.id] = node;
  section.children.unshift(node.id);
  return node;
}

function compilerFixture(node = breadcrumbsNode()) {
  const document = createBlankWebDocument({ name: 'Implantes dentales en Barcelona', locale: 'es-ES' });
  document.pages[0].slug = 'implantes-dentales-barcelona';
  addBreadcrumbs(document, node);
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

test('breadcrumbs es un bloque hoja cerrado sin URLs ni markup libre', () => {
  const valid = buildValidWebDocument();
  addBreadcrumbs(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.breadcrumbs_main.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const separator = clone(valid);
  separator.nodes.breadcrumbs_main.props.separator = '>';
  assert.equal(validateWebDocument(separator).valid, false);

  const markup = clone(valid);
  markup.nodes.breadcrumbs_main.props.home_label = '<strong>Inicio</strong>';
  assert.equal(validateWebDocument(markup).valid, false);
});

test('breadcrumbs compila navegación determinista desde la página actual', () => {
  const input = compilerFixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['implantes-dentales-barcelona/index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-breadcrumbs_main" class="cc-node cc-breadcrumbs[^\"]*"/);
  assert.match(html, /aria-label="Ruta de navegación"/);
  assert.match(html, /<a href="https:\/\/landing\.sites\.clinicaclick\.com\/">Inicio<\/a>/);
  assert.match(html, /aria-current="page">Implantes dentales en Barcelona<\/span>/);
  assert.doesNotMatch(html, /<iframe|onclick=|onload=|onerror=|javascript:/i);
  assert.match(css, /\.cc-breadcrumbs\{font-size:\.875rem;color:#5f6b7f\}/);

  const hiddenCurrent = compilerFixture(breadcrumbsNode({ props: { show_current: false } }));
  assert.doesNotMatch(
    compileWebArtifact(hiddenCurrent).files['implantes-dentales-barcelona/index.html'],
    /aria-current="page"/
  );
});
