'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileWebArtifact } = require('../../lib/webArtifactCompiler');
const { validateWebDocument } = require('../../lib/webDocument');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const { resolveWebDocumentResources } = require('../../services/webResourceResolver.service');
const { buildValidWebDocument } = require('./fixtures/webDocumentV1.fixture');

const ARTICLE_IMAGE_ASSET = 'article_image_asset';

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

function mediaAssetRow(id = ARTICLE_IMAGE_ASSET, url = 'https://media.clinicaclick.com/web/article-card.webp') {
  return row({
    id,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    kind: 'image',
    title: 'Imagen editorial',
    altText: 'Imagen editorial segura',
    decorative: false,
    focalPoints: {},
    rights: { origin: 'owned' },
    variants: [{
      key: 'original',
      url,
      content_type: 'image/webp',
      width: 1200,
      height: 675,
    }],
    mediaMetadata: { content_type: 'image/webp', width: 1200, height: 675 },
    status: 'ready',
    version: 2,
    publicMediaAsset: row({
      id: 501,
      scope_type: 'clinic',
      clinica_id: 66,
      grupo_clinica_id: null,
      public_url: url,
      content_type: 'image/webp',
      size_bytes: 1000,
      sensitivity: 'public',
      status: 'active',
      metadata: { non_clinical_asserted: true },
    }),
  });
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

function categoryListNode(overrides = {}) {
  return {
    id: 'category_list_main',
    type: 'category_list',
    version: 1,
    props: {
      title: 'Temas principales',
      limit: 4,
      layout: 'chips',
      show_description: true,
      empty_message: 'Aún no hay categorías publicadas para mostrar.',
      aria_label: 'Listado de categorías publicadas',
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

function contentMetaNode(overrides = {}) {
  return {
    id: 'content_meta_main',
    type: 'content_meta',
    version: 1,
    props: {
      title: 'Información del contenido',
      content_types: ['article', 'treatment_copy'],
      show_author: true,
      show_date: true,
      show_category: true,
      date_format: 'long',
      layout: 'chips',
      empty_message: 'Aún no hay metadatos publicados para mostrar.',
      aria_label: 'Metadatos del contenido publicado',
      ...(overrides.props || {}),
    },
    children: [],
    style_tokens: {
      spacing_top: 'xs',
      spacing_bottom: 'xs',
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
          content: {
            blocks: [{
              type: 'image',
              image_asset_id: ARTICLE_IMAGE_ASSET,
              alt_text: 'Paciente sonriendo tras revisar opciones de implantes',
              caption: 'Imagen de apoyo editorial',
            }, {
              type: 'text',
              heading: 'Opciones',
              content: 'Texto editorial interno.',
            }],
          },
          fields: {
            content_title: 'Guía de implantes sin cirugía',
            excerpt: 'Una explicación clara para pacientes que comparan opciones.',
            author_name: 'Dra. Dévora & Asociados',
            published_at: '2026-07-17T08:00:00.000Z',
            category_name: 'Implantes & cirugía',
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
        content_category: {
          id: 'content_category',
          version: 1,
          scope: { type: 'clinic', id: 66, inherited: false },
          type: 'category',
          locale: 'es-ES',
          title: 'Categoría interna',
          content: {},
          fields: {
            name: 'Implantes dentales',
            short_description: 'Opciones de implantología explicadas para pacientes.',
          },
        },
      },
      media_assets: {
        [ARTICLE_IMAGE_ASSET]: {
          id: ARTICLE_IMAGE_ASSET,
          version: 2,
          scope: { type: 'clinic', id: 66, inherited: false },
          kind: 'image',
          title: 'Imagen editorial',
          alt_text: 'Imagen editorial segura',
          decorative: false,
          focal_points: {},
          rights: { origin: 'owned', license_url: null, credit: null, expires_at: null },
          variants: [{
            key: 'original',
            url: 'https://media.clinicaclick.com/web/article-card.webp',
            content_type: 'image/webp',
            width: 1200,
            height: 675,
          }],
          metadata: { content_type: 'image/webp', width: 1200, height: 675 },
          public_media: {
            id: 501,
            url: 'https://media.clinicaclick.com/web/article-card.webp',
            content_type: 'image/webp',
            size_bytes: 1000,
          },
        },
      },
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
  assert.match(html, /<img class="cc-post-list-image" src="https:\/\/media\.clinicaclick\.com\/web\/article-card\.webp" alt="Paciente sonriendo tras revisar opciones de implantes" loading="lazy" decoding="async" width="1200" height="675">/);
  assert.match(html, /<h3>Guía de implantes sin cirugía<\/h3>/);
  assert.match(html, /Una explicación clara para pacientes que comparan opciones\./);
  assert.match(html, /<span class="cc-post-list-type">Pregunta frecuente<\/span>/);
  assert.match(html, /<h3>¿Cuánto dura la primera visita\?<\/h3>/);
  assert.doesNotMatch(html, /Aviso legal|onclick=|onload=|javascript:/i);
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/i);
  assert.match(css, /\.cc-post-list-cards \.cc-post-list-items\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.cc-post-list-image\{width:100%;aspect-ratio:16\/9;object-fit:cover/);
});

test('post_list muestra estado vacío cuando no hay contenido congelado', () => {
  const input = compilerFixture(postListNode({ props: { content_types: ['article'], limit: 2 } }));
  input.contentSnapshot.content_entries = {};
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /<p class="cc-post-list-empty">Aún no hay contenido publicado para mostrar\.<\/p>/);
});

test('category_list es un bloque hoja cerrado que compila categorías CMS publicadas', () => {
  const valid = buildValidWebDocument();
  addPostList(valid, categoryListNode());
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.category_list_main.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const markup = clone(valid);
  markup.nodes.category_list_main.props.title = '<strong>Categorías</strong>';
  assert.equal(validateWebDocument(markup).valid, false);

  const invalidLayout = clone(valid);
  invalidLayout.nodes.category_list_main.props.layout = 'carousel';
  assert.equal(validateWebDocument(invalidLayout).valid, false);

  const input = compilerFixture(categoryListNode());
  const artifact = compileWebArtifact(input);
  const html = artifact.files['index.html'];
  const cssPath = Object.keys(artifact.files).find((filePath) => filePath.endsWith('.css'));
  const css = artifact.files[cssPath];

  assert.match(html, /id="cc-category_list_main" class="cc-node cc-category-list cc-category-list-chips[^\"]*"/);
  assert.match(html, /aria-label="Listado de categorías publicadas"/);
  assert.match(html, /<h2 class="cc-category-list-title">Temas principales<\/h2>/);
  assert.match(html, /<strong>Implantes dentales<\/strong>/);
  assert.match(html, /Opciones de implantología explicadas para pacientes\./);
  assert.doesNotMatch(html, /Aviso legal|onclick=|onload=|javascript:/i);
  assert.match(css, /\.cc-category-list-chips \.cc-category-list-item/);
});

test('category_list muestra estado vacío cuando no hay categorías congeladas', () => {
  const input = compilerFixture(categoryListNode());
  input.contentSnapshot.content_entries = {};
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /<p class="cc-category-list-empty">Aún no hay categorías publicadas para mostrar\.<\/p>/);
});

test('content_meta es un bloque hoja cerrado y exige al menos un metadato visible', () => {
  const valid = buildValidWebDocument();
  addPostList(valid, contentMetaNode());
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.content_meta_main.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const markup = clone(valid);
  markup.nodes.content_meta_main.props.title = '<strong>Meta</strong>';
  assert.equal(validateWebDocument(markup).valid, false);

  const invalidType = clone(valid);
  invalidType.nodes.content_meta_main.props.content_types = ['article', 'script'];
  assert.equal(validateWebDocument(invalidType).valid, false);

  const invalidLayout = clone(valid);
  invalidLayout.nodes.content_meta_main.props.layout = 'carousel';
  assert.equal(validateWebDocument(invalidLayout).valid, false);

  const noneVisible = clone(valid);
  noneVisible.nodes.content_meta_main.props.show_author = false;
  noneVisible.nodes.content_meta_main.props.show_date = false;
  noneVisible.nodes.content_meta_main.props.show_category = false;
  assert.equal(validateWebDocument(noneVisible).valid, false);
});

test('content_meta compila metadatos CMS publicados de forma determinista y escapada', () => {
  const input = compilerFixture(contentMetaNode());
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((filePath) => filePath.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-content_meta_main" class="cc-node cc-content-meta cc-content-meta-chips[^\"]*"/);
  assert.match(html, /aria-label="Metadatos del contenido publicado"/);
  assert.match(html, /<h2 class="cc-content-meta-title">Información del contenido<\/h2>/);
  assert.match(html, /<span class="cc-content-meta-label">Autor<\/span><span class="cc-content-meta-value">Dra\. Dévora &amp; Asociados<\/span>/);
  assert.match(html, /<span class="cc-content-meta-label">Fecha<\/span><span class="cc-content-meta-value">17 de julio de 2026<\/span>/);
  assert.match(html, /<span class="cc-content-meta-label">Categoría<\/span><span class="cc-content-meta-value">Implantes &amp; cirugía<\/span>/);
  assert.doesNotMatch(html, /onclick=|onload=|javascript:/i);
  assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/i);
  assert.match(css, /\.cc-content-meta-chips \.cc-content-meta-item/);
});

test('content_meta muestra estado vacío cuando no hay metadatos congelados', () => {
  const input = compilerFixture(contentMetaNode({ props: { content_types: ['testimonial'] } }));
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /<p class="cc-content-meta-empty">Aún no hay metadatos publicados para mostrar\.<\/p>/);
});

test('resolver congela contenido publicado para post_list desde clínica y grupo heredado', async () => {
  const document = createBlankWebDocument({ name: 'Landing clínica', locale: 'es-ES' });
  addPostList(document, postListNode({ props: { content_types: ['article', 'faq'], limit: 6 } }));
  const calls = [];
  const mediaCalls = [];
  const models = {
    Clinica: {
      findByPk: async () => ({ grupoClinicaId: 7 }),
      findAll: async () => [],
    },
    WebMediaAsset: {
      findAll: async (query) => {
        mediaCalls.push(query);
        return [mediaAssetRow()];
      },
    },
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
            content: {
              title: 'Artículo publicado',
              excerpt: 'Texto publicado.',
              blocks: [{
                type: 'image',
                image_asset_id: ARTICLE_IMAGE_ASSET,
                alt_text: 'Imagen editorial segura',
              }],
            },
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
  assert.equal(mediaCalls.length, 1);
  assert.equal(calls[0].limit, 6);
  assert.deepEqual(Object.keys(resolution.snapshot.content_entries).sort(), ['clinic_article', 'group_faq']);
  assert.equal(resolution.snapshot.content_entries.clinic_article.fields.content_title, 'Artículo publicado');
  assert.equal(resolution.snapshot.content_entries.group_faq.fields.question, '¿Primera visita?');
  assert.equal(
    resolution.snapshot.media_assets[ARTICLE_IMAGE_ASSET].public_media.url,
    'https://media.clinicaclick.com/web/article-card.webp'
  );
  assert.equal(
    resolution.resolved.some((item) => item.kind === 'media'
      && item.id === ARTICLE_IMAGE_ASSET
      && item.source === 'content_entry'
      && item.content_entry_id === 'clinic_article'),
    true
  );
  assert.equal(resolution.unresolved.length, 0);
});

test('resolver congela categorías publicadas para category_list', async () => {
  const document = createBlankWebDocument({ name: 'Landing clínica', locale: 'es-ES' });
  addPostList(document, categoryListNode({ props: { limit: 6 } }));
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
            id: 'clinic_category',
            scopeType: 'clinic',
            clinicaId: 66,
            grupoClinicaId: null,
            type: 'category',
            locale: 'es-ES',
            title: 'Categoría clínica',
            content: { name: 'Ortodoncia', short_description: 'Categoría publicada.' },
            sources: [],
            schemaConfig: { enabled: true, profile: 'CollectionPage', include_sources: false },
            contentHash: 'c'.repeat(64),
            status: 'published',
            version: 2,
          }),
          row({
            id: 'group_article',
            scopeType: 'group',
            clinicaId: null,
            grupoClinicaId: 7,
            type: 'article',
            locale: 'es-ES',
            title: 'Artículo grupo',
            content: { title: 'No debe entrar' },
            sources: [],
            schemaConfig: { enabled: true, profile: 'Article', include_sources: false },
            contentHash: 'd'.repeat(64),
            status: 'published',
            version: 1,
          }),
        ];
      },
    },
  };

  const resolution = await resolveWebDocumentResources({
    document,
    scope: { type: 'clinic', id: 66 },
    models,
    allowGroupInheritance: true,
  });

  assert.equal(calls.length, 1);
  const typeSymbols = Object.getOwnPropertySymbols(calls[0].where.type);
  assert.equal(typeSymbols.length, 1);
  assert.deepEqual(calls[0].where.type[typeSymbols[0]], ['category']);
  assert.equal(resolution.snapshot.content_entries.clinic_category.type, 'category');
  assert.equal(resolution.snapshot.content_entries.group_article, undefined);
});
