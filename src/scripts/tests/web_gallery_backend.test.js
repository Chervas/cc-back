'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compileWebArtifact } = require('../../lib/webArtifactCompiler');
const { validateWebDocument } = require('../../lib/webDocument');
const { resolveWebDocumentResources } = require('../../services/webResourceResolver.service');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const { buildValidWebDocument } = require('./fixtures/webDocumentV1.fixture');

const ASSET_ONE = '11111111-1111-4111-8111-111111111111';
const ASSET_TWO = '22222222-2222-4222-8222-222222222222';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function galleryNode() {
  return {
    id: 'gallery_clinic',
    type: 'gallery',
    version: 1,
    props: {
      items: [
        {
          asset_id: ASSET_ONE,
          alt: 'Recepción accesible de la clínica',
          decorative: false,
          focal_x: 25,
          focal_y: 75,
          caption: 'Recepción & acceso',
        },
        {
          asset_id: ASSET_TWO,
          alt: '',
          decorative: true,
        },
      ],
      columns: 3,
      fit: 'cover',
      aspect_ratio: '4:3',
    },
    children: [],
    style_tokens: {
      content_width: 'wide',
      gap: 'sm',
      radius: 'lg',
    },
  };
}

function sliderNode() {
  return {
    id: 'slider_clinic',
    type: 'slider',
    version: 1,
    props: {
      items: [
        {
          asset_id: ASSET_ONE,
          alt: 'Recepción accesible de la clínica',
          decorative: false,
          focal_x: 25,
          focal_y: 75,
          caption: 'Recepción & acceso',
        },
        {
          asset_id: ASSET_TWO,
          alt: '',
          decorative: true,
        },
      ],
      fit: 'cover',
      aspect_ratio: '16:9',
      show_arrows: true,
      show_dots: true,
      autoplay: false,
      interval_seconds: 5,
    },
    children: [],
    style_tokens: {
      content_width: 'wide',
      gap: 'sm',
      radius: 'lg',
    },
  };
}

function addGallery(document) {
  const gallery = galleryNode();
  const section = Object.values(document.nodes).find((node) => node.type === 'section');
  document.nodes[gallery.id] = gallery;
  section.children.splice(1, 0, gallery.id);
  return gallery;
}

function addSlider(document) {
  const slider = sliderNode();
  const section = Object.values(document.nodes).find((node) => node.type === 'section');
  document.nodes[slider.id] = slider;
  section.children.splice(1, 0, slider.id);
  return slider;
}

function errorKeywords(document) {
  return new Set(validateWebDocument(document).errors.map((error) => error.keyword));
}

function mediaSnapshot(url, width, height) {
  return {
    variants: [{
      key: 'original',
      url,
      content_type: 'image/webp',
      width,
      height,
    }],
    metadata: { width, height },
  };
}

function compilerFixture() {
  const document = createBlankWebDocument({ name: 'Clínica Dental Centro', locale: 'es-ES' });
  addGallery(document);
  return {
    document,
    contentSnapshot: {
      schema_version: 1,
      content_entries: {},
      media_assets: {
        [ASSET_ONE]: mediaSnapshot('https://media.clinicaclick.com/web/gallery-one.webp', 1200, 900),
        [ASSET_TWO]: mediaSnapshot('https://media.clinicaclick.com/web/gallery-two.webp', 1600, 1200),
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

function row(values) {
  return {
    ...values,
    get() { return { ...this }; },
  };
}

function mediaRow(id, url) {
  return row({
    id,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    kind: 'image',
    title: 'Imagen de clínica',
    altText: 'Imagen informativa',
    decorative: false,
    focalPoints: {},
    rights: { origin: 'owned' },
    variants: [{
      key: 'original',
      url,
      content_type: 'image/webp',
      width: 1200,
      height: 900,
    }],
    mediaMetadata: { content_type: 'image/webp', width: 1200, height: 900 },
    status: 'ready',
    version: 2,
    publicMediaAsset: row({
      id: id === ASSET_ONE ? 101 : 102,
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

test('gallery es un bloque hoja cerrado con assets únicos y alt semántico', () => {
  const valid = buildValidWebDocument();
  addGallery(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  for (const columns of [2, 3, 4]) {
    const variant = clone(valid);
    variant.nodes.gallery_clinic.props.columns = columns;
    assert.equal(validateWebDocument(variant).valid, true);
  }
  for (const aspectRatio of ['1:1', '4:3', '3:2', '16:9']) {
    const variant = clone(valid);
    variant.nodes.gallery_clinic.props.aspect_ratio = aspectRatio;
    assert.equal(validateWebDocument(variant).valid, true);
  }

  const duplicate = clone(valid);
  duplicate.nodes.gallery_clinic.props.items[1].asset_id = ASSET_ONE;
  assert.equal(errorKeywords(duplicate).has('uniqueGalleryAsset'), true);

  const decorativeAlt = clone(valid);
  decorativeAlt.nodes.gallery_clinic.props.items[1].alt = 'No debe describirse';
  assert.equal(errorKeywords(decorativeAlt).has('galleryAlt'), true);

  const missingAlt = clone(valid);
  missingAlt.nodes.gallery_clinic.props.items[0].alt = '   ';
  assert.equal(errorKeywords(missingAlt).has('galleryAlt'), true);

  const oneItem = clone(valid);
  oneItem.nodes.gallery_clinic.props.items.pop();
  assert.equal(errorKeywords(oneItem).has('minItems'), true);

  const repeatedItems = clone(valid);
  repeatedItems.nodes.gallery_clinic.props.items = Array.from({ length: 13 }, (_, index) => ({
    asset_id: `gallery_asset_${index}`,
    alt: `Imagen ${index}`,
    decorative: false,
  }));
  assert.equal(errorKeywords(repeatedItems).has('maxItems'), true);

  const child = clone(valid);
  child.nodes.gallery_clinic.children = ['text_intro'];
  assert.equal(errorKeywords(child).has('maxItems'), true);

  const arbitraryMarkup = clone(valid);
  arbitraryMarkup.nodes.gallery_clinic.props.items[0].caption = '<strong>No permitido</strong>';
  assert.equal(validateWebDocument(arbitraryMarkup).valid, false);

  const arbitraryCss = clone(valid);
  arbitraryCss.nodes.gallery_clinic.props.items[0].css = 'position:fixed';
  assert.equal(errorKeywords(arbitraryCss).has('forbiddenProperty'), true);

  const binding = clone(valid);
  binding.bindings.gallery_binding = {
    target_node_id: 'gallery_clinic',
    target_prop: 'text',
    source: 'clinic',
    source_id: null,
    field: 'name',
  };
  binding.nodes.gallery_clinic.binding_ids = ['gallery_binding'];
  assert.equal(errorKeywords(binding).has('bindingTarget'), true);
});

test('slider es un bloque hoja cerrado con assets únicos y opciones seguras', () => {
  const valid = buildValidWebDocument();
  addSlider(valid);
  assert.equal(validateWebDocument(valid).valid, true);

  const child = clone(valid);
  child.nodes.slider_clinic.children = ['text_intro'];
  assert.equal(validateWebDocument(child).valid, false);

  const duplicated = clone(valid);
  duplicated.nodes.slider_clinic.props.items[1].asset_id = ASSET_ONE;
  assert.equal(validateWebDocument(duplicated).valid, false);

  const markup = clone(valid);
  markup.nodes.slider_clinic.props.items[0].caption = '<script>alert(1)</script>';
  assert.equal(validateWebDocument(markup).valid, false);

  const interval = clone(valid);
  interval.nodes.slider_clinic.props.interval_seconds = 30;
  assert.equal(validateWebDocument(interval).valid, false);
});

test('gallery compila HTML/CSS responsive, accesible y determinista en renderer actual', () => {
  const input = compilerFixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((path) => path.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.equal(first.manifest.renderer_version, 'clinicaclick-web-renderer/1.14.0');
  assert.match(html, /id="cc-gallery_clinic" class="cc-node cc-gallery cc-gallery-cols-3[^\"]*"/);
  assert.doesNotMatch(html, /aria-label="Galería de imágenes"/);
  assert.match(html, /cc-gallery-item cc-fit-cover cc-aspect-4-3 cc-focal-25-75/);
  assert.match(html, /gallery-one\.webp" alt="Recepción accesible de la clínica" loading="lazy" decoding="async" width="1200" height="900"/);
  assert.match(html, /gallery-two\.webp" alt="" loading="lazy" decoding="async" width="1600" height="1200"/);
  assert.match(html, /<figcaption>Recepción &amp; acceso<\/figcaption>/);
  assert.match(css, /\.cc-gallery-cols-3\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.cc-focal-25-75 img\{object-position:25% 75%\}/);
  assert.match(css, /@media\(max-width:767px\)\{/);
  assert.match(css, /\.cc-layout-grid>\.cc-container,\.cc-gallery,\.cc-location-map\{grid-template-columns:1fr\}/);
  assert.doesNotMatch(html, /<iframe|onclick=|onload=|onerror=/i);

  const unresolved = compilerFixture();
  delete unresolved.contentSnapshot.media_assets[ASSET_TWO];
  assert.throws(
    () => compileWebArtifact(unresolved),
    (error) => error.code === 'web_artifact_media_unresolved'
      && error.details?.node_id === 'gallery_clinic'
      && error.details?.item_index === 1
      && error.details?.media_id === ASSET_TWO
  );
});

test('resource resolver congela cada asset de gallery con su ruta exacta y scope', async () => {
  const gallery = galleryNode();
  const media = [
    mediaRow(ASSET_ONE, 'https://media.clinicaclick.com/web/gallery-one.webp'),
    mediaRow(ASSET_TWO, 'https://media.clinicaclick.com/web/gallery-two.webp'),
  ];
  const models = {
    WebMediaAsset: { findAll: async () => media },
    WebContentEntry: { findAll: async () => [] },
    PublicMediaAsset: {},
    Clinica: { findAll: async () => [] },
  };
  const document = {
    seo: { default_social_asset_id: null },
    pages: [],
    nodes: { [gallery.id]: gallery },
    bindings: {},
    integrations: { intake_config_id: null },
  };

  const result = await resolveWebDocumentResources({
    document,
    scope: { type: 'clinic', id: 66 },
    models,
    allowGroupInheritance: false,
  });

  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.references.map(({ kind, id, path }) => ({ kind, id, path })), [
    { kind: 'media', id: ASSET_ONE, path: '/nodes/gallery_clinic/props/items/0/asset_id' },
    { kind: 'media', id: ASSET_TWO, path: '/nodes/gallery_clinic/props/items/1/asset_id' },
  ]);
  assert.equal(result.resolved.length, 2);
  assert.deepEqual(Object.keys(result.snapshot.media_assets).sort(), [ASSET_ONE, ASSET_TWO]);
  assert.equal(result.snapshot.media_assets[ASSET_ONE].scope.type, 'clinic');
  assert.equal(result.snapshot.media_assets[ASSET_ONE].scope.id, 66);
  assert.equal(result.snapshot.media_assets[ASSET_ONE].public_media.url, 'https://media.clinicaclick.com/web/gallery-one.webp');
});

test('slider compila scroll-snap seguro sin JavaScript público', () => {
  const input = compilerFixture();
  input.document = createBlankWebDocument({ name: 'Clínica Dental Centro', locale: 'es-ES' });
  addSlider(input.document);
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const html = first.files['index.html'];
  const cssPath = Object.keys(first.files).find((path) => path.endsWith('.css'));
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /id="cc-slider_clinic" class="cc-node cc-slider cc-slider-aspect-16-9[^\"]*"/);
  assert.match(html, /class="cc-slider-track"/);
  assert.match(html, /id="cc-slider_clinic-slide-1" class="cc-slider-slide cc-fit-cover cc-aspect-16-9 cc-focal-25-75"/);
  assert.match(html, /gallery-one\.webp" alt="Recepción accesible de la clínica" loading="lazy" decoding="async" width="1200" height="900"/);
  assert.match(html, /<span class="cc-slider-arrow cc-slider-prev" aria-hidden="true">‹<\/span>/);
  assert.match(html, /<div class="cc-slider-dots" aria-hidden="true"><a href="#cc-slider_clinic-slide-1">1<\/a><a href="#cc-slider_clinic-slide-2">2<\/a><\/div>/);
  assert.match(css, /\.cc-slider-track\{display:flex;gap:var\(--cc-md\);overflow-x:auto;scroll-snap-type:x mandatory/);
  assert.doesNotMatch(html, /<iframe|onclick=|onload=|onerror=|javascript:/i);
});
