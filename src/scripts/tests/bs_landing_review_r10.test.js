'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createReviewComponents } = require('../../lib/webLandingReviewComponents');
const { buildReadOnlyWebPreview } = require('../../lib/webLandingReviewPreview');
const { reviewBsLandingDocument, specification } = require('../bs-landings-review-r10');
const { assertValidWebDocument } = require('../../lib/webDocument');

function fixture(key) {
  const plan = specification.plans[key], nodes = {};
  const add = (id, type, props, children = []) => {
    nodes[id] = { id, type, version: 1, props, children };
    return id;
  };
  const section = (id, children = []) => add(id, 'section', { layout: 'stack', columns: 1 }, children);
  const image = (id, alt) => add(id, 'image', { asset_id: 'fixture_asset_original', alt, decorative: false, loading: 'lazy' });
  const button = (id, action = 'intake_form_anchor') => add(id, 'button', { label: 'Solicitar información', action, target: action === 'whatsapp' ? '+34930000000' : 'form_contact', variant: 'primary' });
  const title = add('fixture_title', 'heading', { text: 'Página de prueba', level: 1 });
  const message = section('fixture_message', [title, add('fixture_intro', 'text', { text: 'Contenido ficticio.' }), button('fixture_main_cta')]);
  const heroRow = section('fixture_hero_row', [message, image('fixture_hero_photo', 'Foto de referencia')]);
  section(plan.anchors.hero, [heroRow]);
  section(plan.anchors.offers);
  const roots = [plan.anchors.hero, plan.anchors.offers];
  if (plan.anchors.team) { section(plan.anchors.team); roots.push(plan.anchors.team); }
  if (plan.anchors.gallery) {
    section(plan.anchors.gallery, [image('fixture_reception', 'Clínica recepción'), image('fixture_waiting', 'Clínica espera'), image('fixture_room', 'Clínica cabina')]);
    roots.push(plan.anchors.gallery);
  }
  const fields = [
    { id: 'fixture_first_name', name: 'first_name', type: 'text', label: 'Nombre', required: true },
    { id: 'fixture_phone', name: 'phone', type: 'tel', label: 'Teléfono', required: true },
    ...(plan.offers.length > 1 ? [{ id: 'fixture_interest', name: 'interest', type: 'select', label: 'Interés', required: true, options: plan.offers.map(offer => ({ label: offer.name, value: offer.id })) }] : []),
    { id: 'fixture_privacy', name: 'privacy_consent', type: 'checkbox', label: 'Acepto la política de privacidad.', required: true },
  ];
  add('form_contact', 'intake_form', { title: 'Información', description: 'Formulario ficticio.', form_key: 'fixture_contact', fields, submit_label: 'Solicitar', success_message: 'Solicitud recibida.' });
  section('fixture_footer', ['form_contact', button('fixture_contact_cta', 'whatsapp')]);
  section('fixture_header', [image('fixture_logo', 'Logo'), button('fixture_header_cta')]);
  const document = {
    schema_version: 1,
    design_system: { brand: 'clinicaclick', tokens: { color_primary: '#5B5BF7', color_secondary: '#181D35', color_accent: '#22C3A6', color_surface: '#FFFFFF', color_text: '#181D35', font_heading: 'system', font_body: 'system', radius: 'lg', spacing_density: 'comfortable' } },
    pages: [{ id: 'fixture_page', title: 'Prueba', slug: 'inicio', root_node_ids: roots, seo: { title: 'Prueba', description: 'Conoce BS 28.', canonical_url: null, social_asset_id: null, index: false, follow: false } }],
    globals: { header_node_id: 'fixture_header', footer_node_id: 'fixture_footer' }, nodes, bindings: {},
    seo: { indexing: 'noindex', title_suffix: '', default_social_asset_id: null },
    consent: { provider: 'external_cmp', preview_mode: true, privacy_policy_url: 'https://example.test/privacidad', privacy_policy_version: 'fixture-1', privacy_consent_text: 'Texto de prueba.' },
    integrations: { intake_config_id: null, chat_enabled: false, whatsapp_enabled: false, phone_enabled: false },
  };
  const names = new Set(['LOGO-MEDICAL', 'LOGO-CAPILAR', 'IMG-048', ...(plan.hero_images || []), ...plan.offers.flatMap(offer => offer.images || [])]);
  const assets = Object.fromEntries([...names].map(name => [name, { id: `fixture_asset_${name.replaceAll('-', '_')}`, width: 628, height: 240 }]));
  assertValidWebDocument(document);
  return { document, assets };
}

for (const key of Object.keys(specification.plans)) {
  test(`${key}: valid, repeatable native draft; preserves protected integrations and original input`, () => {
    const input = fixture(key), before = structuredClone(input.document);
    const result = reviewBsLandingDocument({ key, ...input });
    assert.deepEqual(input.document, before);
    assertValidWebDocument(result.document);
    assert.deepEqual(result.document.integrations, before.integrations);
    assert.deepEqual(result.document.consent, before.consent);
    assert.deepEqual(result.document.bindings, before.bindings);
    assert.deepEqual(reviewBsLandingDocument({ key, document: result.document, assets: input.assets }).document, result.document);
    assert.equal(result.review.allowed_for_publication, false);
    assert.equal(result.review.patient_cases_enabled, false);
    assert.equal(result.review.patient_testimonials_enabled, false);
    assert.equal(Object.values(result.document.nodes).some(node => ['testimonial', 'gallery'].includes(node.type)), false);
    assert.equal(Object.values(result.document.nodes).some(node => node.type === 'button' && node.props.action === 'whatsapp'), false);
    // The visual editor treats structural containers more strictly than a
    // generic content group. Keep generated content valid in that hierarchy.
    for (const node of Object.values(result.document.nodes)) {
      if (node.type === 'section' && node.props.structure_role === 'container') {
        assert(node.children.every(id => result.document.nodes[id].props.structure_role === 'row'));
      }
    }
    const nativeOptions = result.document.nodes.form_contact.props.fields.find(field => field.name === 'interest')?.options || [];
    for (const context of result.contact_context) {
      assert.equal(result.document.nodes[context.button_node_id].props.target, context.form_node_id);
      assert.equal(context.native_interest_field, nativeOptions.some(option => option.value === context.value));
      if (!specification.plans[key].horizontal_offer) {
        const card = result.document.nodes[`r10_${key.replaceAll('-', '_')}_${context.value}_card`];
        assert.equal(card.props.pin_last_child, true);
        assert.equal(card.children.at(-1), context.button_node_id);
      }
    }
  });
}

test('price composite strikes only a named reference amount, with an independent brand-colored current amount', () => {
  const document = { nodes: {} }, c = createReviewComponents(document, 'fixture');
  c.price('price', { reference_label: '4 citas por separado:', reference_amount: '460 €', amount: '129 €', quantity: '4 citas · 1 zona' });
  assert.equal(document.nodes.fixture_price_reference_label.props.decoration, undefined);
  assert.equal(document.nodes.fixture_price_reference_amount.props.decoration, 'line_through');
  assert.equal(document.nodes.fixture_price_amount.props.tone, 'brand');
  assert.equal(document.nodes.fixture_price_amount.props.text, '129 €');
  assert.throws(() => c.price('bad', { reference_amount: '460 €', amount: '129 €' }), /meaning_required/);
  c.price('finance', { amount: '84,41 €/mes*', cash_price: 'Desde 4.390 € al contado' });
  assert.equal(document.nodes.fixture_finance_cash.props.decoration, undefined);
});

test('commercial exceptions: no historical itinerary, no old Pepper finance and no disguised capilar packages', () => {
  const body = specification.plans.c03;
  assert.equal(body.offers[0].name, 'Programa BS 28');
  assert.equal(body.offers[1].reference_amount, '920 €');
  assert.doesNotMatch(JSON.stringify(body), /cuarta cita|3\/6\/9|1\/5\/10/);
  for (const key of ['c01-pro', 'c01-bf']) {
    assert.deepEqual(specification.plans[key].offers, []);
    assert.equal(specification.plans[key].capilar_hold, true);
  }
  assert.equal(specification.plans['c01-bf'].bf_not_ready, true);
  const finance = specification.plans['c01-inj'].offers[0];
  assert.equal(finance.amount, 'Desde 84,41 €/mes*');
  assert.equal(finance.finance_example, specification.finance_legal_copy);
  for (const value of ['2.700 €', '33,75 €', '3.038,76 €', '4.728,76 €', 'TAE 8,129 %']) assert(finance.finance_example.includes(value));
  assert.doesNotMatch(JSON.stringify(specification.plans), /Pepper|95 €\/mes/);
});

test('mobile clinic mosaic keeps the two secondary images side by side, independently of the offer grid', () => {
  const result = reviewBsLandingDocument({ key: 'c02', ...fixture('c02') });
  const nodes = result.document.nodes;
  assert.equal(nodes.r10_c02_gallery_secondary.responsive.mobile.columns, 2);
  assert.equal(nodes.r10_c02_gallery_waiting_mobile.props.frame_width, 163);
  assert.equal(nodes.r10_c02_gallery_waiting_mobile.props.frame_height, 220);
  assert.equal(nodes.r10_c02_gallery_main_mobile.props.frame_width, 342);
  assert.equal(nodes.r10_c02_gallery_main_mobile.props.frame_height, 250);
  assert.equal(nodes.r10_c02_offer_row_0.responsive.mobile.columns, 1);
});

test('rejects unknown projects and indexed input rather than broadening a review into a publication', () => {
  assert.throws(() => reviewBsLandingDocument({ key: 'unknown', ...fixture('c03') }), /not_allowed/);
  const input = fixture('c03'); input.document.seo.indexing = 'index';
  assert.throws(() => reviewBsLandingDocument({ key: 'c03', ...input }));
});

test('read-only preview removes executable provider code, native posts and hidden IDs; pins its local UI script with SRI/CSP', () => {
  const artifact = { manifest: { base_url: 'https://preview.example.test/old/' }, files: {
    'index.html': '<html><head><meta http-equiv="Content-Security-Policy" content="old"><meta name="robots" content="index,follow"></head><body><script src="https://tracker.example.test/provider.js"></script><form id="cc-form_contact" action="/_clinicaclick/intake" method="post"><input type="hidden" name="web_project_id" value="private_id"><select name="interest"><option value="lips">Labios</option></select><input name="phone"><button type="submit">Solicitar</button></form></body></html>',
    'assets/provider.js': 'throw Error("provider must not be served");',
    'secondary/index.html': '<html><head><meta http-equiv="Content-Security-Policy" content="old"><meta name="robots" content="index"></head><body><form action="/_clinicaclick/intake"><button type="submit">Solicitar</button></form></body></html>',
  } };
  const result = buildReadOnlyWebPreview({ artifact, baseUrl: 'https://preview.example.test/new/', overviewUrl: 'https://preview.example.test/', mediaUrl: key => key, contactContext: [{ button_node_id: 'offer_cta', form_node_id: 'form_contact', value: 'lips', label: 'Labios' }] });
  const html = result.files['index.html'];
  assert.doesNotMatch(html, /<form\b|name="phone"|private_id|tracker\.example|type="submit"|\/_clinicaclick/);
  assert.match(html, /noindex,nofollow,noarchive/);
  assert.match(html, /data-preview-field="interest" disabled/);
  assert.equal(result.files['assets/provider.js'], undefined);
  assert.doesNotMatch(result.files['secondary/index.html'], /<form\b|type="submit"|\/_clinicaclick/);
  assert.match(result.csp, /connect-src 'none'/);
  assert.match(result.csp, /form-action 'none'/);
  const script = result.files[result.contact_script];
  const hash = crypto.createHash('sha256').update(script).digest('base64');
  assert(html.includes(`integrity="sha256-${hash}"`));
  assert(result.csp.includes(`script-src 'sha256-${hash}'`));
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|innerHTML/);
});
