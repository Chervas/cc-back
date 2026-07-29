'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileWebArtifact } = require('../../lib/webArtifactCompiler');
const { validateWebDocument } = require('../../lib/webDocument');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const { resolveWebDocumentResources } = require('../../services/webResourceResolver.service');
const { buildValidWebDocument } = require('./fixtures/webDocumentV1.fixture');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function row(value) {
  return {
    id: value.id,
    get() {
      return value;
    },
  };
}

function postListNode(overrides = {}) {
  return {
    id: 'post_list_main',
    type: 'post_list',
    version: 1,
    props: {
      title: 'Últimos contenidos',
      content_types: ['article', 'faq', 'treatment_copy'],
      limit: 3,
      layout: 'cards',
      show_excerpt: true,
      show_type: true,
      empty_message: 'Aún no hay contenido publicado para mostrar.',
      aria_label: 'Listado de contenidos publicados',
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

function addPostList(document, node = postListNode()) {
  const section = Object.values(document.nodes).find((candidate) => candidate.type === 'section');
  document.nodes[node.id] = node;
  section.children.unshift(node.id);
  return node;
}

function compilerFixture(node = postListNode()) {
  const document = createBlankWebDocument({ name: 'Implantes dentales en Barcelona', locale: 'es-ES' });
  addPostList(document, node);
  return {
    document,
    contentSnapshot: {
      schema_version: 1,
      content_entries: {
        content_article: {
          id: 'content_article',
          version: 4,
          scope: { type: 'clinic', id: 66, inherited: false },
          type: 'article',
          locale: 'es-ES',
          title: 'Etiqueta editorial interna',
          content: {},
          fields: {
            content_title: 'Guía de implantes sin cirugía',
            excerpt: 'Una explicación clara para pacientes que comparan opciones.',
          },
        },
        content_faq: {
          id: 'content_faq',
          version: 2,
          scope: { type: 'group', id: 7, inherited: true },
          type: 'faq',
          locale: 'es-ES',
          title: 'FAQ',
          content: {},
          fields: {
            question: '¿Cuánto dura la primera visita?',
            answer: 'Normalmente dura entre 30 y 45 minutos.',
          },
        },
        content_legal: {
          id: 'content_legal',
          version: 1,
          scope: { type: 'clinic', id: 66, inherited: false },
          type: 'legal_copy',
          locale: 'es-ES',
          title: 'Legal',
          content: {},
          fields: {
            content_title: 'Aviso legal',
            text: 'No debe aparecer porque el bloque filtra tipos.',
          },
        },
      },
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

test('post_list es un bloque hoja cerrado que no admite HTML ni consultas libres', () => {
  const valid = buildValidWebDocument();
  addPostList(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.post_list_main.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const unknownType = clone(valid);
  unknownType.nodes.post_list_main.props.content_types = ['article', 'script'];
  assert.equal(validateWebDocument(unknownType).valid, false);

  const markup = clone(valid);
  markup.nodes.post_list_main.props.title = '<strong>Blog</strong>';
  assert.equal(validateWebDocument(markup).valid, false);

  const tooMany = clone(valid);
  tooMany.nodes.post_list_main.props.limit = 99;
  assert.equal(validateWebDocument(tooMany).valid, false);
});

test('post_list compila contenido CMS publicado de forma determinista y escapada', () => {
  const input = compilerFixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-post_list_main" class="cc-node cc-post-list cc-post-list-cards[^\"]*"/);
  assert.match(html, /aria-label="Listado de contenidos publicados"/);
  assert.match(html, /<h2 class="cc-post-list-title">Últimos contenidos<\/h2>/);
  assert.match(html, /<span class="cc-post-list-type">Artículo<\/span>/);
  assert.match(html, /<h3>Guía de implantes sin cirugía<\/h3>/);
  assert.match(html, /Una explicación clara para pacientes que comparan opciones\./);
  assert.match(html, /<span class="cc-post-list-type">Pregunta frecuente<\/span>/);
  assert.match(html, /<h3>¿Cuánto dura la primera visita\?<\/h3>/);
  assert.doesNotMatch(html, /Aviso legal|onclick=|onload=|javascript:/i);
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/i);
  assert.match(css, /\.cc-post-list-cards \.cc-post-list-items\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
});

test('post_list muestra estado vacío cuando no hay contenido congelado', () => {
  const input = compilerFixture(postListNode({ props: { content_types: ['article'], limit: 2 } }));
  input.contentSnapshot.content_entries = {};
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /<p class="cc-post-list-empty">Aún no hay contenido publicado para mostrar\.<\/p>/);
});

test('resolver congela contenido publicado para post_list desde clínica y grupo heredado', async () => {
  const document = createBlankWebDocument({ name: 'Landing clínica', locale: 'es-ES' });
  addPostList(document, postListNode({ props: { content_types: ['article', 'faq'], limit: 6 } }));
  const calls = [];
  const models = {
    Clinica: {
      findByPk: async () => ({ grupoClinicaId: 7 }),
      findAll: async () => [],
    },
    WebMediaAsset: { findAll: async () => [] },
    PublicMediaAsset: {},
    WebContentEntry: {
      findAll: async (query) => {
        calls.push(query);
        return [
          row({
            id: 'clinic_article',
            scopeType: 'clinic',
            clinicaId: 66,
            grupoClinicaId: null,
            type: 'article',
            locale: 'es-ES',
            title: 'Artículo clínica',
            content: { title: 'Artículo publicado', excerpt: 'Texto publicado.' },
            sources: [],
            schemaConfig: { enabled: true, profile: 'Article', include_sources: false },
            contentHash: 'a'.repeat(64),
            status: 'published',
            version: 3,
          }),
          row({
            id: 'group_faq',
            scopeType: 'group',
            clinicaId: null,
            grupoClinicaId: 7,
            type: 'faq',
            locale: 'es-ES',
            title: 'FAQ grupo',
            content: { question: '¿Primera visita?', answer: 'Sí.' },
            sources: [],
            schemaConfig: { enabled: true, profile: 'FAQPage', include_sources: false },
            contentHash: 'b'.repeat(64),
            status: 'published',
            version: 5,
          }),
          row({
            id: 'draft_article',
            scopeType: 'clinic',
            clinicaId: 66,
            grupoClinicaId: null,
            type: 'article',
            locale: 'es-ES',
            title: 'Borrador',
            content: { title: 'Borrador', excerpt: 'No publicable.' },
            sources: [],
            schemaConfig: { enabled: true, profile: 'Article', include_sources: false },
            contentHash: 'c'.repeat(64),
            status: 'draft',
            version: 1,
          }),
        ];
      },
    },
    Tratamiento: { findAll: async () => [] },
    DoctorClinica: { findAll: async () => [] },
    Usuario: {},
    IntakeConfig: { findAll: async () => [] },
  };

  const resolution = await resolveWebDocumentResources({
    document,
    scope: { type: 'clinic', id: 66 },
    models,
    allowGroupInheritance: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 6);
  assert.deepEqual(Object.keys(resolution.snapshot.content_entries).sort(), ['clinic_article', 'group_faq']);
  assert.equal(resolution.snapshot.content_entries.clinic_article.fields.content_title, 'Artículo publicado');
  assert.equal(resolution.snapshot.content_entries.group_faq.fields.question, '¿Primera visita?');
  assert.equal(resolution.unresolved.length, 0);
});
