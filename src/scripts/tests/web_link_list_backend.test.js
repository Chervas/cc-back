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

function linkListNode(overrides = {}) {
  return {
    id: 'link_list_main',
    type: 'link_list',
    version: 1,
    props: {
      title: 'Enlaces útiles',
      layout: 'cards',
      aria_label: 'Enlaces útiles de la clínica',
      items: [
        {
          id: 'link_list_item_page',
          label: 'Ver tratamientos',
          action: 'internal_page',
          target: 'page_implantes',
        },
        {
          id: 'link_list_item_call',
          label: 'Llamar',
          action: 'phone',
          target: '+34930000000',
        },
        {
          id: 'link_list_item_web',
          label: 'Web oficial',
          action: 'external_url',
          target: 'https://propdental.es',
          open_in_new_tab: true,
        },
        ...(overrides.props?.items || []),
      ],
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

function addLinkList(document, node = linkListNode()) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[node.id] = node;
  section.children.unshift(node.id);
  return node;
}

function compilerFixture(node = linkListNode()) {
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
  addLinkList(document, node);
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

test('link_list es un bloque hoja cerrado sin HTML, JS ni URLs inseguras', () => {
  const valid = buildValidWebDocument();
  addLinkList(valid, linkListNode({
    props: {
      items: [
        {
          id: 'link_list_item_home',
          label: 'Inicio',
          action: 'internal_page',
          target: 'page_home',
        },
      ],
    },
  }));
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.link_list_main.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const unsafeUrl = clone(valid);
  unsafeUrl.nodes.link_list_main.props.items[0].action = 'external_url';
  unsafeUrl.nodes.link_list_main.props.items[0].target = 'javascript:alert(1)';
  assert.equal(validateWebDocument(unsafeUrl).valid, false);

  const unsafeLabel = clone(valid);
  unsafeLabel.nodes.link_list_main.props.items[0].label = '<strong>Click</strong>';
  assert.equal(validateWebDocument(unsafeLabel).valid, false);

  const tooMany = clone(valid);
  tooMany.nodes.link_list_main.props.items = Array.from({ length: 9 }, (_item, index) => ({
    id: `link_${index}_item`,
    label: `Enlace ${index}`,
    action: 'phone',
    target: '+34930000000',
  }));
  assert.equal(validateWebDocument(tooMany).valid, false);
});

test('link_list compila enlaces internos, teléfono y HTTPS de forma determinista', () => {
  const input = compilerFixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-link_list_main" class="cc-node cc-link-list cc-link-list-cards[^\"]*"/);
  assert.match(html, /aria-label="Enlaces útiles de la clínica"/);
  assert.match(html, /<h2 class="cc-link-list-title">Enlaces útiles<\/h2>/);
  assert.match(html, /<a href="https:\/\/landing\.sites\.clinicaclick\.com\/implantes\/">Ver tratamientos<\/a>/);
  assert.match(html, /<a href="tel:\+34930000000">Llamar<\/a>/);
  assert.match(html, /<a href="https:\/\/propdental\.es\/" target="_blank" rel="noopener noreferrer">Web oficial<\/a>/);
  assert.doesNotMatch(html, /<iframe|onclick=|onload=|onerror=|javascript:/i);
  assert.match(css, /\.cc-link-list\{display:grid;gap:var\(--cc-sm\)\}/);
});

test('link_list rechaza páginas internas inexistentes al compilar', () => {
  const input = compilerFixture(linkListNode({
    props: {
      items: [
        {
          id: 'link_list_item_missing',
          label: 'Página inexistente',
          action: 'internal_page',
          target: 'page_missing',
        },
      ],
    },
  }));

  assert.throws(
    () => compileWebArtifact(input),
    (error) => error?.code === 'web_artifact_internal_page_missing',
  );
});
