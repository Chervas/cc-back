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

function pageMenuNode(overrides = {}) {
  return {
    id: 'page_menu_main',
    type: 'page_menu',
    version: 1,
    props: {
      label: 'Menú',
      layout: 'horizontal',
      include_home: true,
      aria_label: 'Navegación principal',
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

function addPageMenu(document, node = pageMenuNode()) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[node.id] = node;
  section.children.unshift(node.id);
  return node;
}

function compilerFixture(node = pageMenuNode()) {
  const document = createBlankWebDocument({ name: 'Implantes dentales en Barcelona', locale: 'es-ES' });
  const extraRootId = 'page_root_extra';
  document.nodes[extraRootId] = {
    id: extraRootId,
    type: 'section',
    version: 1,
    props: { layout: 'stack', columns: 1, semantic_tag: 'section' },
    children: [],
  };
  document.pages.push({
    id: 'page_implantes',
    title: 'Implantes',
    slug: 'implantes',
    root_node_ids: [extraRootId],
    seo: {
      title: 'Implantes',
      description: 'Página de implantes',
      index: true,
      follow: true,
    },
  });
  addPageMenu(document, node);
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

test('page_menu es un bloque hoja cerrado sin URLs ni markup libre', () => {
  const valid = buildValidWebDocument();
  addPageMenu(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.page_menu_main.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const layout = clone(valid);
  layout.nodes.page_menu_main.props.layout = 'mega';
  assert.equal(validateWebDocument(layout).valid, false);

  const markup = clone(valid);
  markup.nodes.page_menu_main.props.label = '<strong>Menú</strong>';
  assert.equal(validateWebDocument(markup).valid, false);
});

test('page_menu compila navegación desde las páginas del documento', () => {
  const input = compilerFixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-page_menu_main" class="cc-node cc-page-menu cc-page-menu-horizontal[^\"]*"/);
  assert.match(html, /aria-label="Navegación principal"/);
  assert.match(html, /<span class="cc-page-menu-label">Menú<\/span>/);
  assert.match(html, /<a href="https:\/\/landing\.sites\.clinicaclick\.com\/" class="cc-page-menu-current" aria-current="page">Implantes dentales en Barcelona<\/a>/);
  assert.match(html, /<a href="https:\/\/landing\.sites\.clinicaclick\.com\/implantes\/">Implantes<\/a>/);
  assert.doesNotMatch(html, /<iframe|onclick=|onload=|onerror=|javascript:/i);
  assert.match(css, /\.cc-page-menu\{display:flex;align-items:center;gap:var\(--cc-md\);font-size:\.95rem\}/);

  const withoutHome = compilerFixture(pageMenuNode({ props: { include_home: false, layout: 'vertical' } }));
  const noHomeHtml = compileWebArtifact(withoutHome).files['index.html'];
  assert.doesNotMatch(noHomeHtml, /cc-page-menu-current/);
  assert.doesNotMatch(noHomeHtml, /Implantes dentales en Barcelona<\/a>/);
  assert.match(noHomeHtml, /cc-page-menu-vertical/);
});
