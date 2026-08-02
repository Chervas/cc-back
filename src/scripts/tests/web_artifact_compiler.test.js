'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const {
  compileWebArtifact,
  escapeHtml,
  faviconDataUrl,
  safePublicButtonUrl,
} = require('../../lib/webArtifactCompiler');
const { MAX_WEB_ARTIFACT_BUNDLE_BYTES } = require('../../lib/webArtifactBudget');

function fixture(overrides = {}) {
  const document = createBlankWebDocument({ name: 'Implantes dentales', locale: 'es-ES' });
  document.pages[0].seo.title = 'Implantes dentales en Barcelona';
  document.pages[0].seo.description = 'Primera valoración y plan claro en una clínica cercana.';
  document.consent = {
    provider: 'clinicaclick',
    preview_mode: false,
    privacy_policy_url: 'https://example.test/privacidad/',
    privacy_policy_version: '2026-07',
    privacy_consent_text: 'Acepto la política de privacidad.',
  };
  return {
    document,
    contentSnapshot: { schema_version: 1, content_entries: {}, media_assets: {}, live_bindings: [] },
    project: { id: '9ed2cc0a-31a8-4469-990a-22b279ac81ca', name: 'Landing implantes', locale: 'es-ES' },
    revisionId: '35b08398-0d39-4ca8-b100-7bc9db5c66c0',
    baseUrl: 'https://implantes.sites.clinicaclick.com',
    environment: 'preview',
    clinicSnapshot: {
      clinic_id: 66,
      schema_type: 'Dentist',
      name: 'Clínica Dental Centro',
      address: 'Carrer de la Salut 1, Barcelona',
      phone: '+34930000000',
      website: 'https://clinic.example.test/',
    },
    intakeEndpoint: '/api/intake/web',
    ...overrides,
  };
}

test('compila el mismo input de forma determinista y preview siempre es noindex', () => {
  const input = fixture();
  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.files, second.files);
  assert.match(first.files['index.html'], /name="robots" content="noindex,nofollow"/);
  assert.match(first.files['robots.txt'], /Disallow: \/$/m);
  assert.match(first.manifest.headers['content-security-policy'], /default-src 'none'/);
  assert.match(first.manifest.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(first.files['index.html'], /http-equiv="Content-Security-Policy"/);
  const metaCsp = first.files['index.html'].match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  assert.doesNotMatch(metaCsp, /frame-ancestors/);
  assert.match(first.files['index.html'], /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(first.manifest.headers['content-security-policy'], /img-src[^;]+data:/);
  assert.match(first.files['index.html'], /href="https:\/\/implantes\.sites\.clinicaclick\.com\/assets\/styles\./);
  assert.doesNotMatch(first.files['index.html'], /on(?:click|load|error)=/i);
  const stylesheet = Object.entries(first.files).find(([name]) => name.startsWith('assets/styles.'))?.[1];
  assert.match(stylesheet, /\.cc-section\.cc-bg-brand \.cc-button-primary\{background:var\(--cc-surface\);color:var\(--cc-primary\)\}/);
});

test('publica anchos dinámicos de columnas desde el modelo seguro de 12 partes', () => {
  const input = fixture();
  const sectionId = input.document.pages[0].root_node_ids[0];
  const section = input.document.nodes[sectionId];
  section.props = {
    ...section.props,
    layout: 'grid',
    columns: 2,
    column_tracks: {
      desktop: [8, 4],
      tablet: [7, 5],
      mobile: [12],
    },
  };
  section.responsive = {
    tablet: { columns: 2 },
    mobile: { columns: 1 },
  };

  const artifact = compileWebArtifact(input);
  const stylesheetPath = Object.keys(artifact.files).find((path) => path.startsWith('assets/styles.'));
  const css = artifact.files[stylesheetPath];
  const html = artifact.files['index.html'];

  assert.match(html, /cc-layout-grid cc-cols-2 cc-tracks-8-4 cc-tablet-tracks-7-5 cc-mobile-tracks-12/);
  assert.match(css, /\.cc-section\.cc-tracks-8-4>\.cc-container\{display:grid;grid-template-columns:minmax\(0,8fr\) minmax\(0,4fr\)\}/);
  assert.match(css, /\.cc-section\.cc-tablet-tracks-7-5>\.cc-container\{display:grid;grid-template-columns:minmax\(0,7fr\) minmax\(0,5fr\)\}/);
  assert.match(css, /\.cc-section\.cc-mobile-tracks-12>\.cc-container\{display:grid;grid-template-columns:minmax\(0,12fr\)\}/);
});

test('publica anchos propios de columna con fallback seguro para hermanas heredadas', () => {
  const input = fixture();
  const rowId = input.document.pages[0].root_node_ids[0];
  const row = input.document.nodes[rowId];
  const originalChildren = [...row.children];
  const leftColumnId = 'column_left_widths';
  const rightColumnId = 'column_right_widths';
  row.props = {
    ...row.props,
    layout: 'grid',
    columns: 2,
    structure_role: 'row',
    column_tracks: {
      desktop: [6, 6],
      tablet: [6, 6],
      mobile: [12],
    },
  };
  row.responsive = {
    tablet: { columns: 2 },
    mobile: { columns: 1 },
  };
  row.children = [leftColumnId, rightColumnId];
  input.document.nodes[leftColumnId] = {
    id: leftColumnId,
    type: 'section',
    version: 1,
    props: {
      layout: 'stack',
      columns: 1,
      structure_role: 'column',
      column_widths: {
        desktop: 8,
        tablet: 6,
        mobile: 12,
      },
      column_heights: {
        desktop: 320,
        tablet: 240,
      },
      column_orders: {
        desktop: 2,
        mobile: -1,
      },
    },
    children: originalChildren,
  };
  input.document.nodes[rightColumnId] = {
    id: rightColumnId,
    type: 'section',
    version: 1,
    props: {
      layout: 'stack',
      columns: 1,
      structure_role: 'column',
    },
    children: [],
  };

  const artifact = compileWebArtifact(input);
  const stylesheetPath = Object.keys(artifact.files).find((path) => path.startsWith('assets/styles.'));
  const css = artifact.files[stylesheetPath];
  const html = artifact.files['index.html'];

  assert.match(html, /cc-role-row cc-layout-grid cc-cols-2 cc-column-widths/);
  assert.doesNotMatch(html, /cc-tracks-6-6/);
  assert.match(html, new RegExp(`${leftColumnId}[^"]*" class="[^"]*cc-col-span-8[^"]*cc-tablet-col-span-6[^"]*cc-mobile-col-span-12[^"]*cc-col-min-h-320[^"]*cc-tablet-col-min-h-240[^"]*cc-col-order-2[^"]*cc-mobile-col-order-n1`));
  assert.match(html, new RegExp(`${rightColumnId}[^"]*" class="[^"]*cc-col-span-6[^"]*cc-tablet-col-span-6[^"]*cc-mobile-col-span-12`));
  assert.match(css, /\.cc-role-row\.cc-column-widths>\.cc-container\{display:grid;grid-template-columns:repeat\(12,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.cc-role-row\.cc-column-widths>\.cc-container>\.cc-role-column\.cc-col-span-8\{grid-column:span 8\/span 8\}/);
  assert.match(css, /\.cc-role-column\.cc-col-min-h-320\{min-height:320px\}/);
  assert.match(css, /\.cc-role-column\.cc-tablet-col-min-h-240\{min-height:240px\}/);
  assert.match(css, /\.cc-role-column\.cc-col-order-2\{order:2\}/);
  assert.match(css, /\.cc-role-column\.cc-mobile-col-order-n1\{order:-1\}/);
});

test('publica animaciones tipadas como clases seguras generadas por el renderer', () => {
  const input = fixture();
  const sectionId = input.document.pages[0].root_node_ids[0];
  const section = input.document.nodes[sectionId];
  section.animation = 'slide_up';

  const artifact = compileWebArtifact(input);
  const stylesheetPath = Object.keys(artifact.files).find((path) => path.startsWith('assets/styles.'));
  const css = artifact.files[stylesheetPath];
  const html = artifact.files['index.html'];

  assert.equal(artifact.manifest.renderer_version, 'clinicaclick-web-renderer/1.16.0');
  assert.match(html, /cc-animate-slide_up/);
  assert.match(css, /\.cc-animate-slide_up\{animation:ccSlideUp \.46s cubic-bezier/);
  assert.match(css, /@media\(prefers-reduced-motion:no-preference\)/);
  assert.doesNotMatch(html, /animate-\[/);
  assert.doesNotMatch(css, /style="/);
});

test('el favicon inline es determinista, generado por el compilador y no contiene markup ejecutable', () => {
  const first = faviconDataUrl('Clínica Centro');
  const second = faviconDataUrl('Clínica Centro');
  assert.equal(first, second);
  assert.match(first, /^data:image\/svg\+xml,/);
  assert.doesNotMatch(decodeURIComponent(first), /<script|onload=|onerror=/i);
});

test('rechaza antes de persistir una expansión HTML que supera el contrato común del bundle', () => {
  const input = fixture();
  const document = input.document;
  const headerId = 'oversize-global-header';
  const textIds = Array.from({ length: 19 }, (_, index) => `oversize-global-text-${index}`);
  document.nodes[headerId] = {
    id: headerId,
    type: 'section',
    version: 1,
    props: { layout: 'stack', columns: 1, semantic_tag: 'header' },
    children: textIds,
  };
  for (const textId of textIds) {
    document.nodes[textId] = {
      id: textId,
      type: 'text',
      version: 1,
      props: { text: "'".repeat(5000) },
      children: [],
    };
  }
  document.globals.header_node_id = headerId;
  for (let index = 1; index < 18; index += 1) {
    const rootId = `oversize-page-root-${index}`;
    document.nodes[rootId] = {
      id: rootId,
      type: 'section',
      version: 1,
      props: { layout: 'stack', columns: 1, semantic_tag: 'main' },
      children: [],
    };
    document.pages.push({
      ...document.pages[0],
      id: `oversize-page-${index}`,
      title: `Página ${index}`,
      slug: `pagina-${index}`,
      root_node_ids: [rootId],
      seo: { ...document.pages[0].seo, title: `Página ${index}` },
    });
  }
  assert.equal(MAX_WEB_ARTIFACT_BUNDLE_BYTES, 8 * 1024 * 1024);
  assert.throws(
    () => compileWebArtifact(input),
    (error) => error.code === 'web_artifact_bundle_too_large'
      && error.details.max_size_bytes === MAX_WEB_ARTIFACT_BUNDLE_BYTES
      && error.details.size_bytes > MAX_WEB_ARTIFACT_BUNDLE_BYTES
  );
});

test('producción indexa únicamente las páginas expresamente indexables', () => {
  const input = fixture({ environment: 'production', intakeEndpoint: '/_clinicaclick/intake' });
  input.document.seo.indexing = 'index';
  input.document.pages[0].seo.index = true;
  input.document.pages[0].seo.follow = true;
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /name="robots" content="index,follow"/);
  assert.match(artifact.files['sitemap.xml'], /<loc>https:\/\/implantes\.sites\.clinicaclick\.com\/<\/loc>/);
  assert.match(artifact.files['robots.txt'], /Sitemap: https:\/\/implantes\.sites\.clinicaclick\.com\/sitemap\.xml/);
});

test('canonical, Open Graph, Schema y sitemap conservan una única URL autoritativa', () => {
  const input = fixture({ environment: 'production', intakeEndpoint: '/_clinicaclick/intake' });
  const canonical = 'https://www.clinic.example/implantes/';
  input.document.seo.indexing = 'index';
  input.document.pages[0].seo.index = true;
  input.document.pages[0].seo.canonical_url = canonical;

  const artifact = compileWebArtifact(input);
  const html = artifact.files['index.html'];
  const webPage = artifact.pages[0].json_ld['@graph'].find((entry) => entry['@type'] === 'WebPage');

  assert.match(html, new RegExp(`<link rel="canonical" href="${canonical}">`));
  assert.match(html, new RegExp(`<meta property="og:url" content="${canonical}">`));
  assert.equal(webPage.url, canonical);
  assert.equal(webPage['@id'], `${canonical}#webpage`);
  assert.doesNotMatch(artifact.files['sitemap.xml'], /clinic\.example/);
  assert.doesNotMatch(artifact.files['sitemap.xml'], /implantes\.sites\.clinicaclick\.com/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  assert.match(html, /<meta name="twitter:title" content="Implantes dentales en Barcelona">/);
});

test('la imagen social alimenta Open Graph, Twitter y la entidad clínica de Schema', () => {
  const input = fixture();
  const socialAssetId = '22222222-2222-4222-8222-222222222222';
  const socialUrl = 'https://media.clinicaclick.com/web/social-clinica.webp';
  input.document.seo.default_social_asset_id = socialAssetId;
  input.contentSnapshot.media_assets[socialAssetId] = {
    id: socialAssetId,
    scope: { type: 'clinic', id: 66, inherited: false },
    status: 'ready',
    kind: 'image',
    title: 'Imagen social',
    alt_text: 'Clínica Dental Centro',
    decorative: false,
    focal_points: {},
    rights: { origin: 'owned' },
    variants: [{
      key: 'social',
      url: socialUrl,
      content_type: 'image/webp',
      width: 1200,
      height: 630,
    }],
    metadata: {},
    version: 1,
  };

  const artifact = compileWebArtifact(input);
  const html = artifact.files['index.html'];
  const clinic = artifact.pages[0].json_ld['@graph'].find((entry) => entry['@type'] === 'Dentist');
  assert.match(html, new RegExp(`<meta property="og:image" content="${socialUrl}">`));
  assert.match(html, /<meta property="og:image:alt" content="Clínica Dental Centro">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, new RegExp(`<meta name="twitter:image" content="${socialUrl}">`));
  assert.match(html, /<meta name="twitter:image:alt" content="Clínica Dental Centro">/);
  assert.equal(clinic.image, socialUrl);
});

test('la imagen pública de la clínica cubre el fallback social sin inventar contenido', () => {
  const clinicImage = 'https://media.clinicaclick.com/clinics/demo-avatar.webp';
  const input = fixture({
    clinicSnapshot: {
      ...fixture().clinicSnapshot,
      image: clinicImage,
    },
  });
  const artifact = compileWebArtifact(input);
  const html = artifact.files['index.html'];
  const clinic = artifact.pages[0].json_ld['@graph'].find((entry) => entry['@type'] === 'Dentist');
  assert.match(html, new RegExp(`<meta property="og:image" content="${clinicImage}">`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.equal(clinic.image, clinicImage);
});

test('un avatar legacy no público se omite sin bloquear la publicación', () => {
  const input = fixture({
    clinicSnapshot: {
      ...fixture().clinicSnapshot,
      image: '/uploads/clinics/avatar.webp',
    },
  });
  const artifact = compileWebArtifact(input);
  const html = artifact.files['index.html'];
  const clinic = artifact.pages[0].json_ld['@graph'].find((entry) => entry['@type'] === 'Dentist');

  assert.match(html, /<meta name="twitter:card" content="summary">/);
  assert.doesNotMatch(html, /property="og:image"/);
  assert.equal(clinic.image, undefined);
});

test('producción fija el envío de formularios al puente same-origin', () => {
  const input = fixture({ environment: 'production', intakeEndpoint: '/_clinicaclick/intake' });
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /action="\/_clinicaclick\/intake"/);
  assert.match(
    artifact.files['index.html'],
    new RegExp(`name="web_artifact_input_hash" value="${artifact.manifest.artifact_input_hash}"`)
  );
  assert.throws(
    () => compileWebArtifact(fixture({ environment: 'production', intakeEndpoint: '/api/intake/web' })),
    (error) => error.code === 'web_artifact_intake_endpoint_invalid'
  );
});

test('no publica una preferencia por email cuando el formulario no recoge email', () => {
  const input = fixture({ environment: 'production', intakeEndpoint: '/_clinicaclick/intake' });
  const form = Object.values(input.document.nodes).find((node) => node.type === 'intake_form');
  form.props.fields = form.props.fields.filter((field) => field.name !== 'email');
  form.props.fields.splice(form.props.fields.length - 1, 0, {
    id: 'preferred_contact_without_email',
    name: 'preferred_contact',
    type: 'select',
    label: '¿Cómo prefieres que contactemos?',
    required: false,
    options: [
      { value: 'telefono', label: 'Por teléfono' },
      { value: 'email', label: 'Por email' },
    ],
  });

  const html = compileWebArtifact(input).files['index.html'];
  assert.match(html, /value="telefono">Por teléfono/);
  assert.doesNotMatch(html, /value="email">Por email/);
});

test('escapa todo texto editorial y nunca lo convierte en markup', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  const input = fixture();
  const text = Object.values(input.document.nodes).find((node) => node.type === 'text');
  text.props.text = 'Tratamiento seguro & claro';
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /Tratamiento seguro &amp; claro/);
});

test('renderiza divider y spacer como primitivas semánticas, cerradas y deterministas', () => {
  const input = fixture();
  const section = Object.values(input.document.nodes).find((node) => node.type === 'section');
  input.document.nodes.divider_layout = {
    id: 'divider_layout',
    type: 'divider',
    version: 1,
    props: { line_style: 'dashed', tone: 'brand' },
    children: [],
  };
  input.document.nodes.spacer_layout = {
    id: 'spacer_layout',
    type: 'spacer',
    version: 1,
    props: { size: '2xl' },
    children: [],
  };
  section.children.splice(1, 0, 'divider_layout', 'spacer_layout');

  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const cssPath = Object.keys(first.files).find((path) => path.endsWith('.css'));
  const html = first.files['index.html'];
  const css = first.files[cssPath];

  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.deepEqual(first.files, second.files);
  assert.match(html, /<hr id="cc-divider_layout" class="cc-node cc-divider cc-divider-dashed cc-divider-tone-brand [^"]+">/);
  assert.match(html, /<div id="cc-spacer_layout" class="cc-node cc-spacer cc-spacer-2xl [^"]+" aria-hidden="true" role="presentation"><\/div>/);
  assert.doesNotMatch(html, /<hr[^>]*(?:aria-hidden|role="presentation")/);
  assert.match(css, /\.cc-divider-dashed\{border-top-style:dashed\}/);
  assert.match(css, /\.cc-divider-tone-brand\{border-top-color:var\(--cc-primary\)\}/);
  assert.match(css, /\.cc-spacer-2xl\{height:var\(--cc-2xl\)\}/);
});

test('rechaza base URL y endpoint con parámetros o credenciales', () => {
  assert.throws(
    () => compileWebArtifact(fixture({ baseUrl: 'https://user:secret@example.test/?token=x' })),
    (error) => error.code === 'web_artifact_base_url_invalid'
  );
  assert.throws(
    () => compileWebArtifact(fixture({ intakeEndpoint: 'https://example.test/intake?token=secret' })),
    (error) => error.code === 'web_artifact_intake_endpoint_invalid'
  );
});

test('revalida URLs después de aplicar bindings y bloquea esquemas, credenciales y hosts privados', () => {
  for (const unsafe of [
    'javascript:alert(1)',
    'data:text/html,boom',
    'http://clinic.example.test/',
    'https://user:secret@clinic.example.test/',
    'https://127.0.0.1/admin',
    'https://10.0.0.1/admin',
    'https://localhost/admin',
    'https://intranet/admin',
  ]) {
    assert.throws(
      () => safePublicButtonUrl(unsafe, 'button-test'),
      (error) => error.code === 'web_artifact_button_url_invalid',
      unsafe
    );
  }
  assert.equal(
    safePublicButtonUrl('https://clinic.example.test/cita?source=landing', 'button-test'),
    'https://clinic.example.test/cita?source=landing'
  );

  const input = fixture();
  const button = Object.values(input.document.nodes).find((node) => node.type === 'button');
  button.props.action = 'external_url';
  button.props.target = 'https://safe.example.test/';
  button.binding_ids = ['binding_private_url'];
  input.document.bindings.binding_private_url = {
    target_node_id: button.id,
    target_prop: 'target',
    source: 'content_entry',
    source_id: 'content-private',
    field: 'website',
  };
  input.contentSnapshot.content_entries['content-private'] = {
    id: 'content-private',
    fields: { website: 'https://192.168.1.10/admin' },
  };
  assert.throws(
    () => compileWebArtifact(input),
    (error) => error.code === 'web_artifact_button_url_invalid'
  );

  assert.throws(
    () => compileWebArtifact(fixture({
      clinicSnapshot: {
        clinic_id: 66,
        name: 'Clínica',
        website: 'https://127.0.0.1/private',
      },
    })),
    (error) => error.code === 'web_artifact_clinic_url_invalid'
  );
});

test('un binding no resuelto bloquea el artefacto en vez de publicar placeholders', () => {
  const input = fixture();
  const heading = Object.values(input.document.nodes).find((node) => node.type === 'heading');
  heading.binding_ids = ['binding_heading'];
  input.document.bindings.binding_heading = {
    target_node_id: heading.id,
    target_prop: 'text',
    source: 'content_entry',
    source_id: 'missing-content-entry',
    field: 'title',
  };
  assert.throws(
    () => compileWebArtifact(input),
    (error) => error.code === 'web_artifact_binding_unresolved'
  );
});

test('un binding vivo solo se publica para la clínica congelada y elegida', () => {
  const input = fixture();
  const heading = Object.values(input.document.nodes).find((node) => node.type === 'heading');
  heading.binding_ids = ['binding_clinic_name'];
  input.document.bindings.binding_clinic_name = {
    target_node_id: heading.id,
    target_prop: 'text',
    source: 'clinic',
    source_id: '66',
    field: 'name',
  };
  input.contentSnapshot.live_bindings = [{
    source: 'clinic',
    source_id: '66',
    field: 'name',
    resolver: 'clinic_public_v1',
    implicit_scope: false,
  }];
  assert.match(compileWebArtifact(input).files['index.html'], /Clínica Dental Centro/);
  input.clinicSnapshot.clinic_id = 67;
  assert.throws(
    () => compileWebArtifact(input),
    (error) => error.code === 'web_artifact_live_binding_scope_mismatch'
  );
});

test('congela y aplica tratamiento, profesional y configuración de captación canónicos', () => {
  const input = fixture();
  const heading = Object.values(input.document.nodes).find((node) => node.type === 'heading');
  const text = Object.values(input.document.nodes).find((node) => node.type === 'text');
  heading.binding_ids = ['binding_treatment'];
  text.binding_ids = ['binding_professional'];
  input.document.bindings.binding_treatment = {
    target_node_id: heading.id,
    target_prop: 'text',
    source: 'treatment',
    source_id: '7',
    field: 'title',
  };
  input.document.bindings.binding_professional = {
    target_node_id: text.id,
    target_prop: 'text',
    source: 'professional',
    source_id: '9',
    field: 'name',
  };
  input.document.integrations.intake_config_id = '12';
  input.contentSnapshot.treatments = {
    7: { id: '7', scope: { type: 'group', id: 4, inherited: true }, fields: { title: 'Implantes dentales' } },
  };
  input.contentSnapshot.professionals = {
    9: { id: '9', clinic_id: 66, fields: { name: 'Dra. Dévora' } },
  };
  input.contentSnapshot.intake_config = {
    id: '12',
    scope: { type: 'group', id: 4, inherited: true },
  };
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /Implantes dentales/);
  assert.match(artifact.files['index.html'], /Dra\. Dévora/);
  input.contentSnapshot.intake_config.id = '13';
  assert.throws(
    () => compileWebArtifact(input),
    (error) => error.code === 'web_artifact_intake_config_unresolved'
  );
});

test('los enlaces internos respetan el subpath de la publicación', () => {
  const input = fixture({ baseUrl: 'https://sites.clinicaclick.com/implantes' });
  const button = Object.values(input.document.nodes).find((node) => node.type === 'button');
  button.props.action = 'internal_page';
  button.props.target = input.document.pages[0].id;
  const html = compileWebArtifact(input).files['index.html'];
  assert.match(html, /href="https:\/\/sites\.clinicaclick\.com\/implantes\/"/);
  assert.match(html, /href="https:\/\/sites\.clinicaclick\.com\/implantes\/assets\/styles\./);
});

test('JSON-LD usa clínica canónica sin inventar ratings, precios ni reseñas', () => {
  const artifact = compileWebArtifact(fixture());
  const html = artifact.files['index.html'];
  assert.match(html, /"@type":"Dentist"/);
  assert.match(html, /Clínica Dental Centro/);
  assert.doesNotMatch(html, /AggregateRating|Review|priceRange/);
});

test('JSON-LD publica Dentist/MedicalClinic con PostalAddress estructurada', () => {
  const input = fixture({
    clinicSnapshot: {
      clinic_id: 66,
      schema_type: 'MedicalClinic',
      name: 'Clínica Dental Centro',
      address: {
        street_address: 'Carrer de la Salut 1',
        postal_code: '08001',
        locality: 'Barcelona',
        region: 'Barcelona',
        country: 'ES',
      },
      phone: '+34930000000',
      website: 'https://clinic.example.test/',
    },
  });
  const artifact = compileWebArtifact(input);
  const clinic = artifact.pages[0].json_ld['@graph'].find((entry) => entry['@type'] === 'MedicalClinic');
  assert.deepEqual(clinic.address, {
    '@type': 'PostalAddress',
    streetAddress: 'Carrer de la Salut 1',
    addressLocality: 'Barcelona',
    addressRegion: 'Barcelona',
    postalCode: '08001',
    addressCountry: 'ES',
  });
  assert.doesNotMatch(JSON.stringify(clinic), /AggregateRating|Review|priceRange/);
});

test('JSON-LD convierte periodos válidos de Google en openingHoursSpecification determinista', () => {
  const input = fixture({
    clinicSnapshot: {
      ...fixture().clinicSnapshot,
      hours: {
        periods: [
          {
            openDay: 'TUESDAY',
            openTime: { hours: 22 },
            closeDay: 'WEDNESDAY',
            closeTime: { hours: 6 },
          },
          {
            openDay: 'MONDAY',
            openTime: { hours: 9, minutes: 30 },
            closeDay: 'MONDAY',
            closeTime: { hours: 18 },
          },
          {
            openDay: 'MONDAY',
            openTime: { hours: 9, minutes: 30 },
            closeDay: 'MONDAY',
            closeTime: { hours: 18 },
          },
          {
            openDay: 'THURSDAY',
            openTime: { hours: 19 },
            closeDay: 'THURSDAY',
            closeTime: { hours: 8 },
          },
          {
            openDay: 'FRIDAY',
            openTime: {},
            closeDay: 'FRIDAY',
            closeTime: { hours: 13 },
          },
        ],
      },
    },
  });

  const first = compileWebArtifact(input);
  const second = compileWebArtifact(input);
  const clinic = first.pages[0].json_ld['@graph'].find((entry) => entry['@type'] === 'Dentist');
  assert.deepEqual(clinic.openingHoursSpecification, [{
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: 'https://schema.org/Monday',
    opens: '09:30',
    closes: '18:00',
  }, {
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: 'https://schema.org/Tuesday',
    opens: '22:00',
    closes: '06:00',
  }]);
  assert.equal(first.artifact_hash, second.artifact_hash);
  assert.doesNotMatch(JSON.stringify(clinic), /Thursday|Friday/);
});

test('FAQ se renderiza como disclosure seguro y su schema solo alcanza la página visible', () => {
  const input = fixture();
  const primarySection = Object.values(input.document.nodes).find((node) => node.type === 'section');
  input.document.nodes.faq_primary = {
    id: 'faq_primary',
    type: 'faq',
    version: 1,
    props: { question: 'Pregunta provisional', answer: 'Respuesta provisional' },
    children: [],
    binding_ids: ['faq_question_binding', 'faq_answer_binding'],
  };
  input.document.bindings.faq_question_binding = {
    target_node_id: 'faq_primary',
    target_prop: 'question',
    source: 'content_entry',
    source_id: 'faq_content_entry',
    field: 'question',
  };
  input.document.bindings.faq_answer_binding = {
    target_node_id: 'faq_primary',
    target_prop: 'answer',
    source: 'content_entry',
    source_id: 'faq_content_entry',
    field: 'answer',
  };
  input.contentSnapshot.content_entries.faq_content_entry = {
    id: 'faq_content_entry',
    fields: {
      question: '¿Qué incluye la primera visita?',
      answer: 'Valoración y un plan claro & personalizado.',
    },
  };
  primarySection.children.push('faq_primary');
  input.document.pages.push({
    id: 'page_secondary',
    title: 'Otra página',
    slug: 'otra-pagina',
    root_node_ids: ['section_secondary'],
    seo: { title: 'Otra página', description: 'Información secundaria.', index: false, follow: true },
  });
  input.document.nodes.section_secondary = {
    id: 'section_secondary',
    type: 'section',
    version: 1,
    props: { layout: 'stack', columns: 1, semantic_tag: 'main' },
    children: ['faq_secondary'],
  };
  input.document.nodes.faq_secondary = {
    id: 'faq_secondary',
    type: 'faq',
    version: 1,
    props: { question: '¿Pregunta de otra página?', answer: 'Solo debe estar en su propia página.' },
    children: [],
  };
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /<details[^>]*cc-faq[^>]*><summary>¿Qué incluye la primera visita\?<\/summary><p>Valoración y un plan claro &amp; personalizado\.<\/p><\/details>/);
  const homeFaq = artifact.pages.find((page) => page.path === '/').json_ld['@graph'].find((entry) => entry['@type'] === 'FAQPage');
  const secondaryFaq = artifact.pages.find((page) => page.path === '/otra-pagina/').json_ld['@graph'].find((entry) => entry['@type'] === 'FAQPage');
  assert.deepEqual(homeFaq.mainEntity.map((entry) => entry.name), ['¿Qué incluye la primera visita?']);
  assert.deepEqual(secondaryFaq.mainEntity.map((entry) => entry.name), ['¿Pregunta de otra página?']);
});

test('Testimonio se renderiza como bloque semántico seguro y publicable', () => {
  const input = fixture();
  const primarySection = Object.values(input.document.nodes).find((node) => node.type === 'section');
  input.document.nodes.testimonial_primary = {
    id: 'testimonial_primary',
    type: 'testimonial',
    version: 1,
    props: {
      quote: 'Texto provisional',
      attribution: 'Paciente provisional',
      role: '',
      rating: 5,
      source_label: 'Google',
    },
    children: [],
    binding_ids: [
      'testimonial_quote_binding',
      'testimonial_attribution_binding',
      'testimonial_role_binding',
    ],
  };
  input.document.bindings.testimonial_quote_binding = {
    target_node_id: 'testimonial_primary',
    target_prop: 'quote',
    source: 'content_entry',
    source_id: 'testimonial_content_entry',
    field: 'quote',
  };
  input.document.bindings.testimonial_attribution_binding = {
    target_node_id: 'testimonial_primary',
    target_prop: 'attribution',
    source: 'content_entry',
    source_id: 'testimonial_content_entry',
    field: 'display_name',
  };
  input.document.bindings.testimonial_role_binding = {
    target_node_id: 'testimonial_primary',
    target_prop: 'role',
    source: 'content_entry',
    source_id: 'testimonial_content_entry',
    field: 'role',
  };
  input.contentSnapshot.content_entries.testimonial_content_entry = {
    id: 'testimonial_content_entry',
    fields: {
      quote: 'Trato rápido, cercano & buen resultado.',
      display_name: 'María & familia',
      role: 'Primera visita',
    },
  };
  primarySection.children.push('testimonial_primary');

  const artifact = compileWebArtifact(input);
  const stylesheetPath = Object.keys(artifact.files).find((path) => path.startsWith('assets/styles.'));
  assert.match(artifact.files['index.html'], /<figure[^>]*cc-testimonial[^>]*>/);
  assert.match(artifact.files['index.html'], /<blockquote class="cc-testimonial-quote">Trato rápido, cercano &amp; buen resultado\.<\/blockquote>/);
  assert.match(artifact.files['index.html'], /<strong>María &amp; familia<\/strong><span>Primera visita<\/span><span class="cc-testimonial-source">Google<\/span>/);
  assert.match(artifact.files['index.html'], /aria-label="5 de 5 estrellas">★★★★★/);
  assert.match(artifact.files[stylesheetPath], /\.cc-testimonial\{/);
});

test('Schema configurable por página solo usa presets seguros y puede omitir FAQPage', () => {
  const input = fixture();
  const primarySection = Object.values(input.document.nodes).find((node) => node.type === 'section');
  input.document.pages[0].seo.schema = {
    page_type: 'medical_web_page',
    include_faq: false,
  };
  input.document.nodes.faq_schema_config = {
    id: 'faq_schema_config',
    type: 'faq',
    version: 1,
    props: { question: '¿Publicar como FAQ?', answer: 'No en esta página.' },
    children: [],
  };
  primarySection.children.push('faq_schema_config');

  const artifact = compileWebArtifact(input);
  const graph = artifact.pages[0].json_ld['@graph'];
  assert.equal(graph.find((entry) => entry['@id']?.endsWith('#webpage'))['@type'], 'MedicalWebPage');
  assert.equal(graph.some((entry) => entry['@type'] === 'FAQPage'), false);
  assert.match(artifact.files['index.html'], /¿Publicar como FAQ\?/);
  assert.doesNotMatch(artifact.files['index.html'], /LocalBusiness<script>/);
});

test('renderiza globals una vez y los incluye en SEO, Schema e intake de cada página efectiva', () => {
  const input = fixture();
  const pageForm = Object.values(input.document.nodes).find((node) => node.type === 'intake_form');
  input.document.pages.push({
    id: 'page_global_secondary',
    title: 'Segunda página',
    slug: 'segunda',
    root_node_ids: ['section_global_secondary'],
    seo: { title: 'Segunda página', description: 'Contenido de la segunda página.', index: false, follow: true },
  });
  input.document.nodes.section_global_secondary = {
    id: 'section_global_secondary',
    type: 'section',
    version: 1,
    props: { layout: 'stack', columns: 1, semantic_tag: 'main' },
    children: ['heading_global_secondary'],
  };
  input.document.nodes.heading_global_secondary = {
    id: 'heading_global_secondary',
    type: 'heading',
    version: 1,
    props: { text: 'Contenido secundario', level: 1 },
    children: [],
  };
  input.document.globals = {
    header_node_id: 'global_header',
    footer_node_id: 'global_footer',
  };
  input.document.nodes.global_header = {
    id: 'global_header',
    type: 'section',
    version: 1,
    props: { layout: 'row', columns: 2, semantic_tag: 'main' },
    children: ['global_brand', 'global_image'],
  };
  input.document.nodes.global_brand = {
    id: 'global_brand',
    type: 'heading',
    version: 1,
    props: { text: 'Nombre provisional', level: 1 },
    children: [],
    binding_ids: ['global_brand_binding'],
  };
  input.document.bindings.global_brand_binding = {
    target_node_id: 'global_brand',
    target_prop: 'text',
    source: 'clinic',
    source_id: '66',
    field: 'name',
  };
  input.contentSnapshot.live_bindings = [{
    source: 'clinic',
    source_id: '66',
    field: 'name',
    resolver: 'clinic_public_v1',
    implicit_scope: false,
  }];
  input.document.nodes.global_image = {
    id: 'global_image',
    type: 'image',
    version: 1,
    props: {
      asset_id: 'global_logo_asset',
      alt: 'Logotipo de la clínica',
      decorative: false,
      loading: 'eager',
      fit: 'contain',
      aspect_ratio: 'auto',
    },
    children: [],
  };
  input.contentSnapshot.media_assets.global_logo_asset = {
    variants: [{
      key: 'original',
      url: 'https://media.clinicaclick.com/web/global-logo.webp',
      width: 320,
      height: 120,
    }],
  };
  input.document.nodes.global_footer = {
    id: 'global_footer',
    type: 'section',
    version: 1,
    props: { layout: 'stack', columns: 1, semantic_tag: 'header' },
    children: ['global_footer_text', 'global_faq', 'global_form'],
  };
  input.document.nodes.global_footer_text = {
    id: 'global_footer_text',
    type: 'text',
    version: 1,
    props: { text: 'Aviso legal y contacto' },
    children: [],
  };
  input.document.nodes.global_faq = {
    id: 'global_faq',
    type: 'faq',
    version: 1,
    props: { question: '¿Cómo contacto con la clínica?', answer: 'Puedes utilizar el formulario de esta página.' },
    children: [],
  };
  input.document.nodes.global_form = {
    ...structuredClone(pageForm),
    id: 'global_form',
  };

  const artifact = compileWebArtifact(input);
  const html = artifact.files['index.html'];
  const secondaryHtml = artifact.files['segunda/index.html'];
  const headerStart = html.indexOf('<header id="cc-global_header"');
  const pageStart = html.indexOf(`id="cc-${input.document.pages[0].root_node_ids[0]}"`);
  const footerStart = html.indexOf('<footer id="cc-global_footer"');

  assert.ok(headerStart >= 0 && headerStart < pageStart && pageStart < footerStart);
  assert.equal((html.match(/id="cc-global_header"/g) || []).length, 1);
  assert.equal((html.match(/id="cc-global_footer"/g) || []).length, 1);
  assert.equal((secondaryHtml.match(/id="cc-global_header"/g) || []).length, 1);
  assert.equal((secondaryHtml.match(/id="cc-global_footer"/g) || []).length, 1);
  assert.match(html, /<header id="cc-global_header" data-cc-global="header" class="cc-node cc-section cc-site-header/);
  assert.match(html, /<footer id="cc-global_footer" data-cc-global="footer" class="cc-node cc-section cc-site-footer/);
  assert.doesNotMatch(html, /<main id="cc-global_header"/);
  assert.doesNotMatch(html, /<header id="cc-global_footer"/);
  assert.match(html, /Clínica Dental Centro/);
  assert.match(html, /src="https:\/\/media\.clinicaclick\.com\/web\/global-logo\.webp"/);
  assert.equal((html.match(/<h1\b/g) || []).length, 2);
  assert.equal((secondaryHtml.match(/<h1\b/g) || []).length, 2);
  assert.equal(artifact.pages[0].seo_audit.h1_count, 2);
  assert.equal(artifact.pages[1].seo_audit.h1_count, 2);
  for (const page of artifact.pages) {
    assert.ok(page.seo_audit.warnings.some((warning) => (
      warning.code === 'seo_h1_count' && warning.value === 2
    )));
  }
  for (const page of artifact.pages) {
    const faq = page.json_ld['@graph'].find((entry) => entry['@type'] === 'FAQPage');
    assert.deepEqual(faq.mainEntity.map((entry) => entry.name), ['¿Cómo contacto con la clínica?']);
  }
  assert.ok(Object.hasOwn(artifact.manifest.intake_forms, pageForm.id));
  assert.equal(artifact.manifest.intake_forms.global_form.scope, 'global');
  assert.deepEqual(
    Object.keys(artifact.manifest.intake_forms.global_form.page_contracts).sort(),
    input.document.pages.map((page) => page.id).sort()
  );
  assert.match(html, new RegExp(`name="web_page_id" value="${input.document.pages[0].id}"`));
  assert.match(secondaryHtml, /name="web_page_id" value="page_global_secondary"/);
});

test('renderer actual honra tokens, responsive, fuentes e imagen focal en CSS de producción', () => {
  const input = fixture();
  const section = Object.values(input.document.nodes).find((node) => node.type === 'section');
  section.props.layout = 'grid';
  section.props.columns = 4;
  section.style_tokens = {
    background: 'brand',
    foreground: 'inverse',
    content_width: 'wide',
    spacing_top: '2xl',
    spacing_bottom: 'xs',
    gap: 'xl',
    radius: 'full',
    shadow: 'lg',
    align: 'center',
  };
  section.responsive = {
    desktop: { columns: 4, gap: 'xl', align: 'end' },
    tablet: { columns: 2, spacing_top: 'lg', spacing_bottom: 'sm', gap: 'md', align: 'center' },
    mobile: { columns: 1, visible: false, spacing_top: 'xs', spacing_bottom: 'none', gap: 'sm', align: 'stretch' },
  };
  input.document.design_system.tokens.font_heading = 'source_sans_3';
  input.document.design_system.tokens.font_body = 'manrope';
  input.document.nodes.image_focal = {
    id: 'image_focal',
    type: 'image',
    version: 1,
    props: {
      asset_id: 'asset_focal',
      alt: 'Recepción de la clínica',
      decorative: false,
      loading: 'lazy',
      fit: 'contain',
      aspect_ratio: '21:9',
      focal_x: 37,
      focal_y: 62,
      caption: 'Recepción',
    },
    children: [],
    style_tokens: { background: 'accent', radius: 'xl', shadow: 'md', content_width: 'narrow' },
  };
  section.children.push('image_focal');
  input.contentSnapshot.media_assets.asset_focal = {
    variants: [{
      key: 'original',
      url: 'https://media.clinicaclick.com/web/asset-focal.webp',
      width: 2100,
      height: 900,
    }],
  };
  const artifact = compileWebArtifact(input);
  const cssPath = Object.keys(artifact.files).find((path) => path.endsWith('.css'));
  const css = artifact.files[cssPath];
  const html = artifact.files['index.html'];
  assert.equal(artifact.manifest.renderer_version, 'clinicaclick-web-renderer/1.16.0');
  assert.match(html, /cc-layout-grid cc-cols-4[^"\n]*cc-bg-brand[^"\n]*cc-width-wide[^"\n]*cc-pt-2xl[^"\n]*cc-radius-full[^"\n]*cc-shadow-lg[^"\n]*cc-mobile-cols-1/);
  assert.match(html, /cc-fit-contain cc-aspect-21-9 cc-focal-37-62/);
  assert.match(html, /<div class="cc-image-frame"><img[^>]*width="2100" height="900">/);
  assert.match(css, /--cc-font-heading:ui-sans-serif,system-ui/);
  assert.match(css, /--cc-font-body:ui-sans-serif,system-ui/);
  assert.doesNotMatch(css, /(?:Manrope|Source Sans|Inter),/);
  assert.match(css, /\.cc-node\.cc-bg-brand\{background:var\(--cc-primary\)\}/);
  assert.match(css, /\.cc-node\.cc-fg-inverse,\.cc-node\.cc-tone-inverse\{color:#fff\}/);
  assert.doesNotMatch(css, /,\.cc-tone-inverse\{color:#fff\}/);
  assert.match(css, /\.cc-node\.cc-fg-muted,\.cc-node\.cc-tone-muted\{color:#5f6b7f\}/);
  assert.match(css, /\.cc-node\.cc-radius-full\{border-radius:9999px\}/);
  assert.match(css, /\.cc-node\.cc-tablet-pt-lg\{padding-top:var\(--cc-lg\)\}/);
  assert.match(css, /\.cc-section\.cc-tablet-cols-2>.cc-container\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.cc-node\.cc-hide-mobile\{display:none!important\}/);
  assert.match(css, /\.cc-aspect-21-9 \.cc-image-frame\{aspect-ratio:21\/9\}/);
  assert.match(css, /\.cc-focal-37-62 img\{object-position:37% 62%\}/);
});

test('el contrato de formularios queda firmado en manifest y usa fallback no-JS', () => {
  const input = fixture();
  const formId = Object.values(input.document.nodes).find((node) => node.type === 'intake_form')?.id;
  const artifact = compileWebArtifact(input);
  const actualFormId = Object.keys(artifact.manifest.intake_forms)[0];
  assert.equal(actualFormId, formId);
  assert.equal(artifact.manifest.intake_forms[actualFormId].page_path, '/');
  assert.deepEqual(artifact.manifest.page_routes, {
    [input.document.pages[0].id]: { page_path: '/', template_type: 'standard' },
  });
  assert.match(artifact.files['index.html'], new RegExp(`data-cc-web-project-id="${input.project.id}"`));
  assert.match(artifact.files['index.html'], new RegExp(`data-cc-web-revision-id="${input.revisionId}"`));
  assert.match(artifact.files['index.html'], /data-cc-web-page-template="standard"/);
  assert.match(artifact.files['index.html'], /data-cc-web-base-path="\/"/);
  assert.match(artifact.files['index.html'], /action="\/api\/intake\/web" method="post" enctype="application\/x-www-form-urlencoded"/);
  assert.match(artifact.files['index.html'], /name="_cc_company"/);
  assert.match(artifact.files['index.html'], /data-cc-native-intake="true"/);
  assert.match(artifact.files['index.html'], /href="https:\/\/example\.test\/privacidad\/"[^>]*>Consultar política de privacidad<\/a>/);
  assert.equal(artifact.manifest.site_configuration.consent.privacy_policy_version, '2026-07');
  assert.match(artifact.files['index.html'], new RegExp(`id="cc-${actualFormId}-success"`));
  assert.match(artifact.files['index.html'], new RegExp(`id="cc-${actualFormId}-error"`));
  assert.doesNotMatch(artifact.files['index.html'], /name="external_source"/);
});

test('el tipo de plantilla de página se propaga al manifest y al HTML público', () => {
  const input = fixture();
  input.document.pages[0].template_type = 'post';
  const artifact = compileWebArtifact(input);
  assert.deepEqual(artifact.manifest.page_routes[input.document.pages[0].id], {
    page_path: '/',
    template_type: 'post',
  });
  assert.match(artifact.files['index.html'], /data-cc-web-page-template="post"/);
});

test('producción bloquea drift entre revisión, IntakeConfig y toggles del runtime', () => {
  const runtime = {
    measurement: {
      enabled: true,
      scope_type: 'clinic',
      scope_id: 66,
      api_url: 'https://crm.clinicaclick.com',
      loader_path: '/assets/loader.js',
      hmac_key: '0123456789abcdef0123456789abcdef',
      consent_mode_enabled: true,
      consent_provider: 'clinicaclick',
      chat_enabled: false,
      whatsapp_enabled: false,
      phone_enabled: false,
    },
  };
  const coherent = fixture({
    environment: 'production',
    intakeEndpoint: '/_clinicaclick/intake',
    trustedRuntime: runtime,
  });
  coherent.document.integrations.intake_config_id = '12';
  coherent.contentSnapshot.intake_config = {
    id: '12',
    scope: { type: 'clinic', id: 66, inherited: false },
  };
  assert.doesNotThrow(() => compileWebArtifact(coherent));

  const staleToggle = structuredClone(coherent);
  staleToggle.document.integrations.chat_enabled = true;
  assert.throws(
    () => compileWebArtifact(staleToggle),
    (error) => error.code === 'web_artifact_integration_runtime_drift' && error.details?.field === 'chat_enabled'
  );

  const staleIntake = structuredClone(coherent);
  staleIntake.contentSnapshot.intake_config.id = '13';
  assert.throws(
    () => compileWebArtifact(staleIntake),
    (error) => error.code === 'web_artifact_intake_config_unresolved'
      || error.code === 'web_artifact_intake_config_drift'
  );

  const unsafeLegal = fixture();
  unsafeLegal.document.consent.privacy_policy_url = 'https://127.0.0.1/private';
  assert.throws(
    () => compileWebArtifact(unsafeLegal),
    (error) => error.code === 'web_artifact_privacy_url_invalid'
  );
});

test('producción incrusta exactamente el runtime de medición confiable y preview lo ignora', () => {
  const measurement = {
    measurement: {
      enabled: true,
      scope_type: 'clinic',
      scope_id: 66,
      api_url: 'https://crm.clinicaclick.com',
      loader_path: '/assets/loader.js',
      hmac_key: '0123456789abcdef0123456789abcdef',
      consent_mode_enabled: true,
      consent_provider: 'clinicaclick',
    },
  };
  const productionInput = fixture({
    environment: 'production',
    intakeEndpoint: '/_clinicaclick/intake',
    trustedRuntime: measurement,
  });
  productionInput.document.integrations.intake_config_id = '12';
  productionInput.contentSnapshot.intake_config = {
    id: '12',
    scope: { type: 'clinic', id: 66, inherited: false },
  };
  const production = compileWebArtifact(productionInput);
  const html = production.files['index.html'];
  assert.equal((html.match(/<script src=/g) || []).length, 1);
  assert.match(html, /src="https:\/\/crm\.clinicaclick\.com\/assets\/loader\.js"/);
  assert.match(html, /data-clinic-id="66"/);
  assert.match(html, /data-event-bridge-url="\/_clinicaclick\/events"/);
  assert.match(html, new RegExp(`data-web-project-id="${productionInput.project.id}"`));
  assert.match(html, new RegExp(`data-web-revision-id="${productionInput.revisionId}"`));
  assert.match(html, new RegExp(`data-web-page-id="${productionInput.document.pages[0].id}"`));
  assert.doesNotMatch(html, /data-hmac-key|0123456789abcdef0123456789abcdef/);
  assert.match(html, /data-consent-mode-enabled="true"/);
  assert.match(production.manifest.headers['content-security-policy'], /script-src[^;]*https:\/\/crm\.clinicaclick\.com/);
  assert.match(production.manifest.headers['content-security-policy'], /connect-src[^;]*https:\/\/crm\.clinicaclick\.com/);
  assert.match(production.manifest.headers['content-security-policy'], /img-src[^;]*https:\/\/crm\.clinicaclick\.com[^;]*data:/);
  assert.match(production.manifest.headers['content-security-policy'], /style-src 'self' 'unsafe-inline'/);
  assert.match(html, /https:\/\/media\.clinicaclick\.com https:\/\/crm\.clinicaclick\.com data:/);
  assert.match(html, /style-src &#39;self&#39; &#39;unsafe-inline&#39;/);
  assert.doesNotMatch(JSON.stringify(production), /0123456789abcdef0123456789abcdef/);

  const preview = compileWebArtifact(fixture({ trustedRuntime: measurement }));
  assert.doesNotMatch(preview.files['index.html'], /assets\/loader\.js/);
  assert.doesNotMatch(preview.manifest.headers['content-security-policy'], /unsafe-inline/);
  assert.doesNotMatch(preview.manifest.headers['content-security-policy'], /img-src[^;]*crm\.clinicaclick\.com/);
  assert.notEqual(preview.artifact_hash, production.artifact_hash);
});
