'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const {
  compileWebArtifact,
  escapeHtml,
  safePublicButtonUrl,
} = require('../../lib/webArtifactCompiler');

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
  assert.match(first.files['index.html'], /http-equiv="Content-Security-Policy"/);
  assert.match(first.files['index.html'], /href="https:\/\/implantes\.sites\.clinicaclick\.com\/assets\/styles\./);
  assert.doesNotMatch(first.files['index.html'], /on(?:click|load|error)=/i);
  const stylesheet = Object.entries(first.files).find(([name]) => name.startsWith('assets/styles.'))?.[1];
  assert.match(stylesheet, /\.cc-section\.cc-bg-brand \.cc-button-primary\{background:var\(--cc-surface\);color:var\(--cc-primary\)\}/);
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

test('producción fija el envío de formularios al puente same-origin', () => {
  const input = fixture({ environment: 'production', intakeEndpoint: '/_clinicaclick/intake' });
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /action="\/_clinicaclick\/intake"/);
  assert.throws(
    () => compileWebArtifact(fixture({ environment: 'production', intakeEndpoint: '/api/intake/web' })),
    (error) => error.code === 'web_artifact_intake_endpoint_invalid'
  );
});

test('escapa todo texto editorial y nunca lo convierte en markup', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  const input = fixture();
  const text = Object.values(input.document.nodes).find((node) => node.type === 'text');
  text.props.text = 'Tratamiento seguro & claro';
  const artifact = compileWebArtifact(input);
  assert.match(artifact.files['index.html'], /Tratamiento seguro &amp; claro/);
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

test('FAQ se renderiza como disclosure seguro y su schema solo alcanza la página visible', () => {
  const input = fixture();
  const primarySection = Object.values(input.document.nodes).find((node) => node.type === 'section');
  input.document.nodes.faq_primary = {
    id: 'faq_primary',
    type: 'faq',
    version: 1,
    props: { question: '¿Qué incluye la primera visita?', answer: 'Valoración y un plan claro & personalizado.' },
    children: [],
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

test('renderer 1.2 honra tokens, responsive, fuentes e imagen focal en CSS de producción', () => {
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
  assert.equal(artifact.manifest.renderer_version, 'clinicaclick-web-renderer/1.2.1');
  assert.match(html, /cc-layout-grid cc-cols-4[^"\n]*cc-bg-brand[^"\n]*cc-width-wide[^"\n]*cc-pt-2xl[^"\n]*cc-radius-full[^"\n]*cc-shadow-lg[^"\n]*cc-mobile-cols-1/);
  assert.match(html, /cc-fit-contain cc-aspect-21-9 cc-focal-37-62/);
  assert.match(html, /<div class="cc-image-frame"><img[^>]*width="2100" height="900">/);
  assert.match(css, /--cc-font-heading:"Source Sans 3",Inter/);
  assert.match(css, /--cc-font-body:Manrope,Inter/);
  assert.match(css, /\.cc-node\.cc-bg-brand\{background:var\(--cc-primary\)\}/);
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
    [input.document.pages[0].id]: { page_path: '/' },
  });
  assert.match(artifact.files['index.html'], new RegExp(`data-cc-web-project-id="${input.project.id}"`));
  assert.match(artifact.files['index.html'], new RegExp(`data-cc-web-revision-id="${input.revisionId}"`));
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
