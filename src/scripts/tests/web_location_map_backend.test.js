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

function locationMapNode(overrides = {}) {
  return {
    id: 'map_clinic',
    type: 'location_map',
    version: 1,
    props: {
      title: 'Dónde estamos',
      address: 'Carrer de la Clínica, 12, Barcelona',
      directions_url: 'https://www.google.com/maps/dir/?api=1&destination=Carrer%20de%20la%20Clinica%2012%20Barcelona',
      button_label: 'Cómo llegar',
      show_map_placeholder: true,
      ...(overrides.props || {}),
    },
    children: [],
    style_tokens: {
      content_width: 'wide',
      spacing_top: 'md',
      spacing_bottom: 'md',
      radius: 'xl',
      shadow: 'sm',
      ...(overrides.style_tokens || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'props' && key !== 'style_tokens')),
  };
}

function addLocationMap(document, node = locationMapNode()) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[node.id] = node;
  section.children.splice(1, 0, node.id);
  return node;
}

function errorKeywords(document) {
  return new Set(validateWebDocument(document).errors.map((error) => error.keyword));
}

function compilerFixture(node = locationMapNode()) {
  const document = createBlankWebDocument({ name: 'Clínica Dental Centro', locale: 'es-ES' });
  addLocationMap(document, node);
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

test('location_map es un bloque hoja cerrado con URL pública segura', () => {
  const valid = buildValidWebDocument();
  addLocationMap(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.map_clinic.children = ['text_intro'];
  assert.equal(errorKeywords(child).has('maxItems'), true);

  const httpUrl = clone(valid);
  httpUrl.nodes.map_clinic.props.directions_url = 'http://www.google.com/maps';
  assert.equal(errorKeywords(httpUrl).has('pattern') || errorKeywords(httpUrl).has('safeUrl'), true);

  const credentialUrl = clone(valid);
  credentialUrl.nodes.map_clinic.props.directions_url = 'https://user:pass@example.com/maps';
  assert.equal(errorKeywords(credentialUrl).has('safeUrl'), true);

  const markupAddress = clone(valid);
  markupAddress.nodes.map_clinic.props.address = '<strong>No permitido</strong>';
  assert.equal(errorKeywords(markupAddress).has('forbiddenContent') || errorKeywords(markupAddress).has('pattern'), true);
});

test('location_map compila HTML/CSS responsive y enlace de cómo llegar', () => {
  const input = compilerFixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-map_clinic" class="cc-node cc-location-map[^\"]*"/);
  assert.match(html, /<h2>Dónde estamos<\/h2>/);
  assert.match(html, /Carrer de la Clínica, 12, Barcelona/);
  assert.match(html, /href="https:\/\/www\.google\.com\/maps\/dir\/\?api=1&amp;destination=Carrer%20de%20la%20Clinica%2012%20Barcelona"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer">Cómo llegar<\/a>/);
  assert.match(css, /\.cc-location-map\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(16rem,1fr\)/);
  assert.match(css, /\.cc-gallery,\.cc-location-map\{grid-template-columns:1fr\}/);
  assert.doesNotMatch(html, /<iframe|onclick=|onload=|onerror=/i);

  const noPlaceholder = compilerFixture(locationMapNode({ props: { show_map_placeholder: false } }));
  assert.doesNotMatch(compileWebArtifact(noPlaceholder).files['index.html'], /cc-location-map-visual/);
});
