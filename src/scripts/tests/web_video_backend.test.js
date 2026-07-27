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

function videoNode(overrides = {}) {
  return {
    id: 'video_clinic',
    type: 'video',
    version: 1,
    props: {
      provider: 'youtube',
      video_id: 'VIDEOID1234',
      title: 'Presentación de la clínica',
      aspect_ratio: '16:9',
      loading: 'lazy',
      caption: 'Conoce nuestro equipo',
      ...(overrides.props || {}),
    },
    children: [],
    style_tokens: {
      content_width: 'wide',
      spacing_top: 'md',
      spacing_bottom: 'md',
      radius: 'lg',
      ...(overrides.style_tokens || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'props' && key !== 'style_tokens')),
  };
}

function addVideo(document, node = videoNode()) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[node.id] = node;
  section.children.splice(1, 0, node.id);
  return node;
}

function errorKeywords(document) {
  return new Set(validateWebDocument(document).errors.map((error) => error.keyword));
}

function compilerFixture(node = videoNode()) {
  const document = createBlankWebDocument({ name: 'Clínica Dental Centro', locale: 'es-ES' });
  addVideo(document, node);
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

test('video es un bloque hoja cerrado sin HTML, iframe ni URL arbitraria persistida', () => {
  const valid = buildValidWebDocument();
  addVideo(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  const vimeo = clone(valid);
  vimeo.nodes.video_clinic.props.provider = 'vimeo';
  vimeo.nodes.video_clinic.props.video_id = '123456789';
  assert.equal(validateWebDocument(vimeo).valid, true);

  const child = clone(valid);
  child.nodes.video_clinic.children = ['text_intro'];
  assert.equal(errorKeywords(child).has('maxItems'), true);

  const rawIframe = clone(valid);
  rawIframe.nodes.video_clinic.props.video_id = '<iframe src="https://example.com"></iframe>';
  assert.equal(errorKeywords(rawIframe).has('forbiddenContent'), true);

  const youtubeUrl = clone(valid);
  youtubeUrl.nodes.video_clinic.props.video_id = 'https://www.youtube.com/watch?v=VIDEOID1234';
  assert.equal(errorKeywords(youtubeUrl).has('pattern'), true);

  const invalidVimeo = clone(valid);
  invalidVimeo.nodes.video_clinic.props.provider = 'vimeo';
  invalidVimeo.nodes.video_clinic.props.video_id = 'abc123xyz';
  assert.equal(errorKeywords(invalidVimeo).has('pattern'), true);

  const markupTitle = clone(valid);
  markupTitle.nodes.video_clinic.props.title = '<strong>No permitido</strong>';
  assert.equal(errorKeywords(markupTitle).has('pattern'), true);
});

test('video compila iframe seguro y CSS responsive determinista', () => {
  const input = compilerFixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-video_clinic" class="cc-node cc-video cc-video-aspect-16-9[^\"]*"/);
  assert.match(html, /src="https:\/\/www\.youtube-nocookie\.com\/embed\/VIDEOID1234"/);
  assert.match(html, /title="Presentación de la clínica"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /referrerpolicy="strict-origin-when-cross-origin"/);
  assert.match(html, /<figcaption>Conoce nuestro equipo<\/figcaption>/);
  assert.match(html, /frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/player\.vimeo\.com/);
  assert.match(first.manifest.headers['content-security-policy'], /frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/player\.vimeo\.com/);
  assert.match(css, /\.cc-video-frame iframe\{position:absolute;inset:0;width:100%;height:100%;border:0\}/);
  assert.match(css, /\.cc-video-aspect-16-9 \.cc-video-frame\{aspect-ratio:16\/9\}/);
  assert.doesNotMatch(html, /onclick=|onload=|onerror=/i);

  const vimeo = compilerFixture(videoNode({ props: { provider: 'vimeo', video_id: '123456789' } }));
  assert.match(compileWebArtifact(vimeo).files['index.html'], /src="https:\/\/player\.vimeo\.com\/video\/123456789"/);
});
