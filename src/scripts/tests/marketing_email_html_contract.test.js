'use strict';

const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const marketing = require('../../services/marketingEmail.service');
const templates = require('../../services/emailTemplates.service');
const html = require('../../services/marketingEmailHtml.service');
const dispatch = require('../../services/marketingEmailDispatch.service');
const delivery = require('../../services/emailDelivery.service');
const provider = require('../../services/emailProvider.service');
const bulk = require('../../services/marketingBulkSends.service');
const scope = { scope: 'clinic', clinicIds: [21] };
const draft = (source, extra = {}) => ({ name: 'HTML de prueba', subject: 'Hola {{nombre}}', preheader: 'Novedades para {{nombre}}', design: { content_mode: 'html', html_source: source }, ...extra });

test('draft previews reject non-text variable contexts without rendering or touching storage', () => {
  for (const variables of [{ nombre: { toString: 'invalid' } }, { nombre: ['Ana'] }, { nombre: 22 }, { 'constructor': 'invalid' }]) {
    assert.throws(() => marketing.previewTemplate({ ...draft('<p>Hola {{nombre}}</p>'), variables }),
      { code: 'email_preview_variables_invalid', status: 400 });
  }
});

test('flat preview token values preserve case, hyphens, numeric and nested paths with HTML escaping', () => {
  const variables = { PROMO: 'ESPECIAL', 'promo-code': 'Á & B', 'contact.ciudad': 'Málaga', 'contact.1': '<img src=x onerror=bad()>', '2': 'Dos' };
  const before = JSON.stringify(variables);
  const result = marketing.previewTemplate(draft('<p>{{PROMO}} {{promo-code}} {{contact.ciudad}} {{contact.1}} {{2}} {{nombre}}</p>', { subject: 'Hola', variables }));
  assert.deepEqual(result.missing_variables, []);
  assert.match(result.html, /ESPECIAL Á &amp; B Málaga &lt;img/);
  assert.doesNotMatch(result.html, /<img src=x/);
  assert.match(result.text, /ESPECIAL Á & B Málaga <img src=x onerror=bad\(\)> Dos Ana/);
  assert.equal(JSON.stringify(variables), before);
});

test('preview token maps reject prototype segments, nested input and scalar/path collisions without side effects', () => {
  const forbidden = [
    { 'contact.__proto__.polluted': 'yes' }, { 'contact.constructor.polluted': 'yes' },
    { 'contact.prototype.polluted': 'yes' }, { '__proto__.polluted': 'yes' },
    { 'contact': { ciudad: 'Madrid' } }, { 'contact..ciudad': 'Madrid' },
    { contact: 'Madrid', 'contact.ciudad': 'Madrid' },
    { 'contact.ciudad': 'Madrid', contact: 'Madrid' }, { 'nombre.apellido': 'García' },
  ];
  for (const variables of forbidden) {
    assert.throws(() => marketing.previewTemplate(draft('<p>Hola</p>', { variables })), { code: 'email_preview_variables_invalid', status: 400 });
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('preview token map enforces the exact serialized 16 KiB UTF-8 boundary', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ promo: '' }), 'utf8');
  const value = 'x'.repeat(16 * 1024 - overhead);
  const result = marketing.previewTemplate(draft('<p>{{promo}}</p>', { variables: { promo: value } }));
  assert.match(result.text, new RegExp('^' + 'x'.repeat(20)));
  assert.throws(() => marketing.previewTemplate(draft('<p>Hola</p>', { variables: { promo: value + 'x' } })), { code: 'email_preview_variables_too_large', status: 400 });
});

test('preview care dates share delivery formatting and explicit empty dates retain their missing state', () => {
  const source = '<p>{{fecha_ultima_cita_asistida}}</p>';
  for (const date of ['2026-11-10T22:30:00Z', '10-11-2026', '10 de noviembre de 2026']) {
    const result = marketing.previewTemplate(draft(source, { variables: { fecha_ultima_cita_asistida: date } }));
    assert.match(result.html, /10\/11\/2026/);
    assert.deepEqual(result.missing_variables, []);
  }
  const cleared = marketing.previewTemplate(draft(source, { variables: { fecha_ultima_cita_asistida: '' } }));
  assert.deepEqual(cleared.missing_variables, ['fecha_ultima_cita_asistida']);
  assert.doesNotMatch(cleared.html, /10\/11\/2026/);
});

test('incomplete editor blocks keep a safe draft preview without becoming saveable content', async () => {
  const body = { name: 'En edición', subject: 'Hola', design: { blocks: [
    { type: 'heading', text: 'Contenido que ya está completo' },
    { type: 'image', url: '', alt: 'Imagen pendiente' },
    { type: 'button', text: 'Abrir', url: '' },
  ] } };
  const before = JSON.stringify(body);
  const preview = marketing.previewTemplate(body);
  assert.match(preview.html, /Contenido que ya está completo/);
  assert.doesNotMatch(preview.html, /src=""/);
  assert.equal(preview.warnings.length, 1);
  assert.equal(JSON.stringify(body), before);
  await assert.rejects(marketing.saveTemplate(scope, body, 1), { code: 'email_template_url_invalid' });
});

test('an empty HTML editor shows instructions without changing or accepting its empty source', async () => {
  const body = draft('');
  assert.match(marketing.previewTemplate(body).html, /Pega el código HTML/);
  assert.equal(body.design.html_source, '');
  await assert.rejects(marketing.saveTemplate(scope, body, 1), { code: 'email_template_html_required' });
});

test('campaign test overrides require the current subject and honor the stored preheader length', () => {
  const list = { id: 1, scope_type: 'clinic', clinica_id: 21, criteria: { email_subject: 'Anterior' } };
  assert.throws(() => dispatch.__testing.testConfiguration(list, { email_subject: '' }), { code: 'email_subject_required', status: 400 });
  assert.throws(() => dispatch.__testing.testConfiguration(list, { email_preheader: 'a'.repeat(256) }), { code: 'email_template_preheader_too_long', status: 400 });
  assert.equal(list.criteria.email_subject, 'Anterior');
});

test('HTML save, load, update and duplicate retain original source code while compiling only sanitized markup', async t => {
  let row;
  const writes = [];
  t.mock.method(db.MarketingEmailTemplate, 'create', async values => {
    writes.push(values);
    row = { id: 71, version: 1, ...values, async update(next) { Object.assign(this, next); } };
    return row;
  });
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async ({ where }) => {
    assert.equal(where.scope_key, 'clinic:21');
    return row;
  });
  const originalSource = '<p style="color:#123456" onclick="bad()">Hola {{nombre}}</p><script>bad()</script>';
  const saved = await marketing.saveTemplate(scope, draft(originalSource), 1);
  assert.equal(saved.design.content_mode, 'html');
  assert.equal(saved.design.html_source, originalSource);
  assert.doesNotMatch(saved.rendered_html, /script|onclick/);
  assert.equal(saved.rendered_text, 'Hola {{nombre}}');
  const loaded = await marketing.getTemplate(scope, saved.id);
  assert.deepEqual(loaded.design, saved.design);
  const updated = await marketing.saveTemplate(scope, draft('<table><tr><td>Nuevo {{nombre}}</td></tr></table>'), 1, saved.id);
  assert.equal(updated.version, 2);
  const copied = await marketing.duplicateTemplate(scope, saved.id, {}, 1);
  assert.deepEqual(copied.design, updated.design);
  assert.equal(writes[1].catalog_template_id, null);
  assert.equal(writes[1].origin, 'custom');
  assert.equal(writes[1].version, 1);
});

test('legacy block designs keep their existing JSON contract and compile through the same final composer', async t => {
  t.mock.method(db.MarketingEmailTemplate, 'create', async values => ({ id: 72, ...values }));
  const saved = await marketing.saveTemplate(scope, { name: 'Bloques', subject: 'Hola', preheader: 'Una sola vista previa', design: marketing.DEFAULT_DESIGN }, 1);
  assert.deepEqual(saved.design, { ...marketing.DEFAULT_DESIGN, blocks: marketing.DEFAULT_DESIGN.blocks.map(block => block.url ? { ...block, url: new URL(block.url).toString() } : block) });
  assert.equal(Object.hasOwn(saved.design, 'content_mode'), false);
  const preview = marketing.previewTemplate({ subject: 'Hola', preheader: saved.preheader, design: saved.design });
  assert.equal((preview.html.match(/Una sola vista previa/g) || []).length, 1);
  assert.equal((preview.html.match(/data-email-preheader=/g) || []).length, 1);
  assert.equal((preview.html.match(/data-email-footer=/g) || []).length, 1);
});

test('HTML catalog edits increment versions and duplicate into an independent inactive catalog entry', async t => {
  const row = { id: 9, public_id: 'etc_html', version: 3, is_active: true, async update(values) { Object.assign(this, values); } };
  let duplicate;
  t.mock.method(db.MarketingEmailTemplateCatalog, 'findOne', async () => row);
  t.mock.method(db.MarketingEmailTemplateCatalog, 'create', async values => { duplicate = { id: 10, ...values }; return duplicate; });
  const updated = await marketing.saveCatalogTemplate(draft('<table><tr><td>Hola {{nombre}}</td></tr></table>'), 1, row.public_id);
  assert.equal(updated.version, 4);
  assert.equal(updated.design.content_mode, 'html');
  const copied = await marketing.duplicateCatalogTemplate(row.public_id, 1);
  assert.deepEqual(copied.design, updated.design);
  assert.equal(copied.version, 1);
  assert.equal(copied.is_active, false);
  assert.equal(duplicate.rendered_html, row.rendered_html);
});

test('saving and reopening both content modes preserves original Unicode HTML code, blocks and palette', async t => {
  let row;
  t.mock.method(db.MarketingEmailTemplate, 'create', async values => {
    row = { id: 73, version: 1, ...values, async update(next) { Object.assign(this, next); } };
    return row;
  });
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async () => row);
  const originalSource = '\n<!doctype html><!-- Código á, ñ, 東京 🦷 -->\n<html><head><style>.test{color:red}</style></head><body><table><tr><td>HTML {{html_only}}</td></tr></table><script>bad()</script></body></html>\n';
  const blocks = [{ type: 'heading', text: 'Borrador de bloques {{blocks_only}}' }, { type: 'button', text: 'Visitar', url: 'https://example.test/visitar' }];
  const first = await marketing.saveTemplate(scope, draft(originalSource, { subject: 'Hola', design: { content_mode: 'html', html_source: originalSource, blocks, header_color: '#112233', footer_color: '#445566', logo_url: 'https://cdn.example.test/logo.png' } }), 1);
  assert.equal(first.design.html_source, originalSource);
  assert.deepEqual(first.design.blocks, blocks);
  assert.equal(first.design.header_color, '#112233');
  assert.equal(first.design.footer_color, '#445566');
  assert.equal(first.design.logo_url, 'https://cdn.example.test/logo.png');
  assert.doesNotMatch(first.rendered_html, /<script|bad\(\)|Borrador de bloques|Código á/);
  assert.match(first.rendered_html, /\.cc-email-imported \.cc-e-test\{color:red\}/);
  const htmlPreview = marketing.previewTemplate({ subject: 'Hola', design: first.design });
  assert.deepEqual(htmlPreview.missing_variables, ['html_only']);
  assert.ok(htmlPreview.warnings.length);
  const reopened = await marketing.getTemplate(scope, first.id);
  const inBlocks = await marketing.saveTemplate(scope, { name: 'Bloques', subject: 'Hola', design: { ...reopened.design, content_mode: 'blocks' } }, 1, first.id);
  assert.equal(inBlocks.design.html_source, originalSource);
  assert.deepEqual(inBlocks.design.blocks, first.design.blocks);
  assert.match(inBlocks.rendered_html, /Borrador de bloques/);
  assert.doesNotMatch(inBlocks.rendered_html, /HTML \{\{html_only\}\}/);
  const blockPreview = marketing.previewTemplate({ subject: 'Hola', design: inBlocks.design });
  assert.deepEqual(blockPreview.missing_variables, ['blocks_only']);
  const inHtmlAgain = await marketing.saveTemplate(scope, { name: 'HTML', subject: 'Hola', design: { ...inBlocks.design, content_mode: 'html' } }, 1, first.id);
  assert.equal(inHtmlAgain.design.html_source, originalSource);
  assert.deepEqual(inHtmlAgain.design.blocks, first.design.blocks);
  assert.equal(inHtmlAgain.design.header_color, '#112233');
});

test('HTML mode retains bounded incomplete inactive blocks as inert draft data and validates them on activation', async t => {
  t.mock.method(db.MarketingEmailTemplate, 'create', async values => ({ id: 74, ...values }));
  const design = {
    content_mode: 'html', html_source: '<p>Contenido HTML activo</p>',
    blocks: [
      { type: 'heading', text: '', html: '<script>bad()</script>', onclick: 'bad()' },
      { type: 'image', url: 'https://', alt: 'a'.repeat(200), style: 'position:fixed' },
      { type: 'button', text: ' ', url: '' },
      { type: 'text', text: 'x'.repeat(6000) },
      { type: 'text', text: 'Inactivo {{inactive_variable}}' },
      ...Array.from({ length: 17 }, () => ({ type: 'divider', url: 'javascript:bad()' })),
    ],
  };
  const saved = await marketing.saveTemplate(scope, { name: 'HTML', subject: 'Hola', design }, 1);
  assert.equal(saved.design.blocks.length, 20);
  assert.deepEqual(saved.design.blocks[0], { type: 'heading', text: '' });
  assert.deepEqual(saved.design.blocks[1], { type: 'image', url: 'https://', alt: 'a'.repeat(160) });
  assert.deepEqual(saved.design.blocks[2], { type: 'button', text: '', url: null });
  assert.equal(saved.design.blocks[3].text.length, 5000);
  assert.deepEqual(saved.design.blocks[5], { type: 'divider' });
  assert.doesNotMatch(saved.rendered_html, /inactive_variable|javascript:|onclick|<script/);
  const preview = marketing.previewTemplate({ subject: 'Hola', design: saved.design });
  assert.deepEqual(preview.missing_variables, []);
  assert.doesNotMatch(preview.html, /inactive_variable|https:\/\/"/);
  await assert.rejects(marketing.saveTemplate(scope, { name: 'Bloques', subject: 'Hola', design: { ...saved.design, content_mode: 'blocks' } }, 1), { code: 'email_template_block_text_required', status: 400 });
  await assert.rejects(marketing.saveTemplate(scope, { name: 'HTML', subject: 'Hola', design: { ...design, blocks: [{ type: 'image', url: 'javascript:bad()' }] } }, 1), { code: 'email_template_url_invalid', status: 400 });
});

test('inactive HTML code may be empty or unsafe editor data but never enters block rendering', async t => {
  t.mock.method(db.MarketingEmailTemplate, 'create', async values => ({ id: 75, ...values }));
  const payload = { name: 'Bloques', subject: 'Hola', design: { ...marketing.DEFAULT_DESIGN, html_source: '' } };
  const empty = await marketing.saveTemplate(scope, payload, 1);
  assert.equal(empty.design.html_source, '');
  const rawCode = '<!-- Código original ñ --><script>ARCHIVED_SCRIPT()</script><p>HTML inactivo {{archived_variable}}</p>';
  const archived = await marketing.saveTemplate(scope, { ...payload, design: { ...payload.design, html_source: rawCode } }, 1);
  assert.equal(archived.design.html_source, rawCode);
  assert.doesNotMatch(archived.rendered_html, /ARCHIVED_SCRIPT|archived_variable|HTML inactivo/);
  const preview = marketing.previewTemplate({ subject: 'Hola', design: archived.design });
  assert.deepEqual(preview.missing_variables, []);
  assert.doesNotMatch(preview.html, /ARCHIVED_SCRIPT|archived_variable|HTML inactivo/);
  await assert.rejects(marketing.saveTemplate(scope, { ...payload, design: { ...payload.design, html_source: 'é'.repeat(50 * 1024) } }, 1), { code: 'email_template_html_too_large', status: 400 });
});

test('email HTML retains tables, safe inline CSS, accented text and remote HTTPS images without fetching them', () => {
  const source = '<!doctype html><html><head><title>Oculto</title></head><body style="background-color:#fafafa"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#ffffff"><tr><td width="600" style="padding:20px 24px;font:700 14px/1.5 Arial,sans-serif;color:#123456"><img src="https://cdn.example.test/banner.png?x=1&amp;y=2" alt="Clínica &amp; equipo" width="600" style="display:block;width:100%;height:auto;border:0">Novedades &amp; atención</td></tr></table></body></html>';
  const sourceHtml = html.compileHtmlSource(source);
  assert.match(sourceHtml, /<table role="presentation" width="100%" cellpadding="0" cellspacing="0"/);
  assert.match(sourceHtml, /max-width:600px/);
  assert.match(sourceHtml, /border-collapse:collapse;background:#ffffff/);
  assert.match(sourceHtml, /padding:20px 24px;font:700 14px\/1.5 Arial,sans-serif;color:#123456/);
  assert.match(sourceHtml, /src="https:\/\/cdn\.example\.test\/banner\.png\?x=1&amp;y=2"/);
  assert.match(sourceHtml, /background-color:#fafafa/);
  const text = html.textFromHtml(sourceHtml);
  assert.match(text, /Clínica & equipo/);
  assert.match(text, /Novedades & atención/);
  assert.doesNotMatch(text, /Oculto/);
});

test('parser sanitizer rejects executable markup, unsafe URL schemes, CSS URLs and style variables', () => {
  const source = '<script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.test">x</iframe><svg><a href="javascript:bad()">x</a></svg><form action="https://evil.test"><input name="secret"></form><p id="x" onclick="bad()" style="color:#123456;background-image:url(https://evil.test);background:url(javascript:bad());width:expression(bad());position:fixed;--secret:red;color:var(--secret);font-size:{{size}}">Visible</p><a href="jav&#0000097;script:alert(1)">Bad</a><a href="//evil.test">Relative</a><a href="https://user:pass@evil.test">Credentials</a><img src="data:image/svg+xml,evil" onerror="bad()"><img src="http://example.test/a.png"><a href="https://safe.example.test/path">Safe</a>';
  const clean = html.compileHtmlSource(source);
  assert.doesNotMatch(clean, /<(?:script|iframe|svg|form|input)|\sonclick=|\sonerror=|\sid=|javascript:|data:|http:|href="\/\/|user:pass|url\(|expression\(|position:|--secret|var\(|\{\{size\}\}/i);
  assert.match(clean, /<style>\.cc-email-imported\{display:none\}/);
  assert.match(clean, /href="https:\/\/safe\.example\.test\/path"/);
  assert.match(clean, /Visible/);
});

test('URL and attribute variables are escaped and revalidated after substitution', () => {
  const source = '<p title="{{nombre}}">Hola {{nombre}}</p><a href="{{ url }}">Enlace</a><img src="{{ image }}" alt="{{nombre}}"><a href="https://example.test/?name={{nombre}}">Fijo</a>';
  const unsafe = marketing.previewTemplate(draft(source, { subject: 'Hola', variables: { nombre: '\"><img src=x onerror=bad()>', url: 'javascript:alert(1)', image: 'data:image/svg+xml,bad' } }));
  assert.doesNotMatch(unsafe.html, /href="javascript:|src="data:|<img src=x|<img[^>]+\sonerror=/);
  assert.match(unsafe.html, /&lt;img/);
  const safe = marketing.previewTemplate(draft(source, { subject: 'Hola', variables: { nombre: 'Ana & Luis', url: 'https://example.test/link?a=1&b=2', image: 'https://cdn.example.test/a.png' } }));
  assert.match(safe.html, /href="https:\/\/example\.test\/link\?a=1&amp;b=2"/);
  assert.match(safe.html, /src="https:\/\/cdn\.example\.test\/a\.png"/);
  assert.match(safe.html, /Ana &amp; Luis/);
});

test('telephone destinations survive HTML and block previews only as direct dial links', () => {
  const source = '<img src="tel:+34910000000"><a href="TEL:+34910000000">Llamar</a>'
    + '<a href="tel:+34910000000?x=1">Consulta</a><a href="tel:%2B34910000000">Codificado</a>'
    + '<a href="{{destino}}">Teléfono variable</a>';
  const input = draft(source, { subject: 'Contacto', variables: { destino: 'tel:910000001' } });
  const rendered = marketing.previewTemplate(input);
  assert.equal((rendered.html.match(/href="tel:/g) || []).length, 2);
  assert.match(rendered.html, /href="tel:\+34910000000"[^>]*>Llamar/);
  assert.match(rendered.html, /href="tel:910000001"[^>]*>Teléfono variable/);
  assert.match(rendered.text, /Llamar \(tel:\+34910000000\)/);
  assert.doesNotMatch(rendered.html, /src="tel:|href="tel:[^"]*\?|href="tel:%|href="tel:[^"]+"[^>]*target=/);
  assert.equal(require('../../lib/marketing-email-engagement').staticLinks(rendered.html).has('tel:+34910000000'), false);

  const blocks = { name: 'Prueba', subject: 'Contacto', design: { blocks: [{ type: 'button', text: 'Llamar', url: 'tel:+34910000000' }] } };
  const button = marketing.previewTemplate(blocks);
  assert.match(button.html, /href="tel:\+34910000000"/);
  assert.match(button.text, /tel:\+34910000000/);
  const invalidImage = { ...blocks, design: { blocks: [{ type: 'image', url: 'tel:+34910000000' }] } };
  assert.throws(() => marketing.previewTemplate(invalidImage), { code: 'email_template_url_invalid' });
});

test('mandatory visible footer survives forged hidden footer text and incomplete source markup', () => {
  const preview = marketing.previewTemplate(draft('<div style="display:none">Dejar de recibir estas comunicaciones</div><div style="position:fixed;z-index:9999"><table><tr><td>Hola {{nombre}}', { subject: 'Hola', preheader: 'Preheader único' }));
  assert.equal((preview.html.match(/Dejar de recibir estas comunicaciones/g) || []).length, 1);
  assert.equal((preview.html.match(/data-email-footer=/g) || []).length, 1);
  assert.equal((preview.html.match(/Preheader único/g) || []).length, 1);
  assert.match(preview.html, /<\/td><\/tr><\/table>(?:<\/div>)+<table data-email-footer="unsubscribe"/);
  assert.match(preview.html, /href="https:\/\/example\.test\/email\/baja"/);
  assert.match(preview.text, /Dejar de recibir estas comunicaciones: https:\/\/example\.test\/email\/baja/);
});

test('draft previews use sample values, report unknown variables and do not touch storage or providers', () => {
  // The model and offline runtime fixtures reject every unconfigured SQL/socket call.
  const preview = marketing.previewTemplate({ design: { content_mode: 'html', html_source: '<p>{{nombre_paciente}} de {{nombre_clinica}} {{custom.missing}}</p>' } });
  assert.match(preview.html, /Ana de Clínica Ejemplo/);
  assert.deepEqual(preview.missing_variables, ['custom.missing']);
  assert.ok(preview.warnings.length);
  assert.throws(() => marketing.previewTemplate({ design: { content_mode: 'bogus' } }), { code: 'email_template_content_mode_invalid', status: 400 });
});

test('HTML limits account for UTF-8 input and the final combined HTML/text transport budget', () => {
  assert.throws(() => html.compileHtmlSource(`<p>${'é'.repeat(50 * 1024)}</p>`), { code: 'email_template_html_too_large', status: 400 });
  assert.throws(() => templates.renderMarketingCampaign({ subject: 'Hola', body_html: `<p>${'x'.repeat(130 * 1024)}</p>`, body_text: 'x'.repeat(130 * 1024), unsubscribe_url: 'https://example.test/email/baja' }), { code: 'email_template_content_too_large', status: 400 });
});

function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}
function freshController(t, canRead) {
  const access = require('../../lib/marketingScopeAccess');
  const calls = [];
  t.mock.method(access, 'hasMarketingClinicScopeAccess', async options => { calls.push(options); return canRead; });
  const key = require.resolve('../../controllers/marketingEmail.controller');
  delete require.cache[key];
  t.after(() => { delete require.cache[key]; });
  return { controller: require(key), calls };
}

test('scoped preview requires read authorization and denies cross-scope callers without saving', async t => {
  const { controller, calls } = freshController(t, false);
  const res = response();
  await controller.previewTemplate({ userData: { userId: 55 }, body: { clinic_id: 21, ...draft('<p>Hola</p>') }, query: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls[0].access, 'read');
  assert.deepEqual(calls[0].clinicIds, [21]);
});

test('read-authorized preview and global-admin catalog preview run with no writes', async t => {
  const { controller, calls } = freshController(t, true);
  const res = response();
  await controller.previewTemplate({ userData: { userId: 55 }, body: { scope: '21', ...draft('<p>Hola</p>') }, query: {} }, res);
  assert.equal(res.body.success, true);
  assert.equal(calls[0].access, 'read');
  const denied = response();
  await controller.previewCatalogTemplate({ userData: { userId: 55 }, body: draft('<p>Hola</p>') }, denied);
  assert.equal(denied.statusCode, 403);
  const allowed = response();
  await controller.previewCatalogTemplate({ userData: { userId: 1 }, body: draft('<p>Hola</p>') }, allowed);
  assert.equal(allowed.body.success, true);
  assert.deepEqual(Object.keys(allowed.body.preview).sort(), ['html', 'missing_variables', 'text', 'warnings']);
});

test('test-send validates draft template/sender in the stored scope and composes exactly the preview without persisting overrides', async t => {
  const list = Object.freeze({ id: 91, scope_type: 'clinic', clinica_id: 21, email_template_id: 1, email_sender_identity_id: 2, criteria: Object.freeze({ email_subject: 'Asunto guardado', email_preheader: 'Preheader guardado' }) });
  const template = { id: 31, version: 4, subject: 'Asunto de plantilla', preheader: 'Preheader de plantilla', design: { content_mode: 'html', html_source: '<p>Hola {{nombre}}</p>', show_clinicaclick_branding: false }, rendered_text: 'Hola {{nombre}}' };
  template.rendered_html = marketing.renderTemplateDocument({ subject: template.subject, design: template.design });
  const sender = { id: 41, status: 'active', verification_status: 'verified', email: 'equipo@example.test', display_name: 'Equipo', domain: { verification_status: 'verified', dkim_status: 'verified' } };
  t.mock.method(provider, 'publicConfig', () => ({ provider: 'mock', enabled: true, marketingEnabled: true }));
  t.mock.method(db.EmailSenderIdentity, 'findOne', async ({ where }) => { assert.deepEqual(where, { id: 41, scope_key: 'clinic:21' }); return sender; });
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async ({ where }) => { assert.deepEqual(where, { id: 31, scope_key: 'clinic:21', status: 'ready' }); return template; });
  t.mock.method(db.MarketingPatientListItem, 'count', async () => 1);
  t.mock.method(db.MarketingPatientListItem, 'findOne', async ({ where }) => { assert.equal(where.list_id, 91); return { id: 5, clinica_id: 21, name: 'Ana García', email: 'ana@example.test' }; });
  t.mock.method(db.Clinica, 'findByPk', async () => ({ nombre_clinica: 'Clínica Ejemplo' }));
  t.mock.method(marketing, 'issueUnsubscribe', async () => 'https://example.test/email/baja');
  const bulkKey = require.resolve('../../services/marketingBulkSends.service');
  const previous = require.cache[bulkKey];
  require.cache[bulkKey] = { id: bulkKey, filename: bulkKey, loaded: true, exports: { assertReviewRequestCommunicationAllowed: async () => ({ review: false }) } };
  t.after(() => { if (previous) require.cache[bulkKey] = previous; else delete require.cache[bulkKey]; });
  let queued;
  t.mock.method(delivery, 'queueEmail', async input => { queued = input; return { emailMessage: { public_id: 'em_test', status: 'queued' } }; });
  await dispatch.sendTest(list, { to: 'qa@example.test', email_template_id: 31, email_sender_identity_id: 41, email_subject: 'Actual {{nombre}}', email_preheader: 'Actual previo {{nombre}}' });
  assert.equal(queued.subjectKey, 'marketing.template.31');
  assert.equal(queued.templateContext.subject, 'Actual Ana');
  assert.equal(queued.templateContext.preheader, 'Actual previo Ana');
  assert.equal(list.email_template_id, 1);
  assert.equal(list.criteria.email_subject, 'Asunto guardado');
  const preview = marketing.previewTemplate(draft(template.design.html_source, { subject: 'Actual {{nombre}}', preheader: 'Actual previo {{nombre}}', design: template.design }));
  assert.deepEqual(templates.renderMarketingCampaign(queued.templateContext), { subject: 'Actual Ana', html: preview.html, text: preview.text });
});

test('test overrides reject invalid IDs and cannot change stored campaign scope', async () => {
  const list = { id: 91, clinica_id: 21, criteria: {} };
  assert.throws(() => dispatch.__testing.testConfiguration(list, { email_template_id: -1 }), { code: 'marketing_email_test_asset_invalid', status: 400 });
  const isolated = dispatch.__testing.testConfiguration(list, { clinic_id: 22, scope: 'group:999', email_template_id: 31 });
  assert.equal(isolated.clinica_id, 21);
  assert.equal(list.email_template_id, undefined);
});

function campaignStorage(t) {
  let list;
  let items = [];
  const events = [];
  t.mock.method(db.sequelize, 'transaction', async callback => callback({ id: 'offline' }));
  t.mock.method(db.MarketingPatientList, 'create', async value => {
    list = { id: 92, ...value, async update(next) { Object.assign(this, next); return this; }, async reload() { return this; } };
    return list;
  });
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => list);
  t.mock.method(db.MarketingPatientList, 'update', async value => { Object.assign(list, value); return [1]; });
  t.mock.method(db.MarketingPatientListItem, 'findAll', async () => items);
  t.mock.method(db.MarketingPatientListItem, 'count', async () => items.length);
  t.mock.method(db.MarketingPatientContactEvent, 'create', async value => { events.push(value.event_type); return value; });
  t.mock.method(db.Clinica, 'findByPk', async () => null);
  const template = { id: 31, version: 1, subject: 'Hola', preheader: 'Preheader legado', design: { content_mode: 'html', html_source: '<p>Hola {{nombre}}</p>', show_clinicaclick_branding: false }, rendered_text: 'Hola {{nombre}}' };
  template.rendered_html = marketing.renderTemplateDocument({ subject: template.subject, design: template.design });
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async () => template);
  t.mock.method(db.EmailSenderIdentity, 'findOne', async () => ({ id: 41, status: 'active', verification_status: 'verified', email: 'equipo@example.test', display_name: 'Equipo', domain: { verification_status: 'verified', dkim_status: 'verified' } }));
  return { get list() { return list; }, template, events, setItems(value) { items = value; } };
}

test('persisted campaign create/update/prepare preserve explicit empty preheaders through the actual dispatch renderer', async t => {
  const stored = campaignStorage(t);
  const payload = { name: 'Campaña de prueba', channels: ['email'], template_usage: 'notificacion', email_template_id: 31, email_sender_identity_id: 41, email_subject: 'Hola', email_preheader: '' };
  const created = await bulk.createCampaign(scope, payload, 1);
  assert.equal(created.campaign.criteria.email_preheader, '');
  await bulk.updateCampaign(scope, stored.list.id, { email_preheader: 'Anterior' }, 1);
  assert.equal(stored.list.criteria.email_preheader, 'Anterior');
  await bulk.updateCampaign(scope, stored.list.id, { email_preheader: '' }, 1);
  assert.equal(stored.list.criteria.email_preheader, '');
  await bulk.prepareCampaign(scope, stored.list.id, {}, 1);
  assert.equal(stored.list.criteria.email_preheader, '');
  await bulk.prepareCampaign(scope, stored.list.id, { email_preheader: 'Guardado' }, 1);
  await bulk.prepareCampaign(scope, stored.list.id, { email_preheader: '' }, 1);
  assert.equal(stored.list.criteria.email_preheader, '');
  assert.ok(stored.events.includes('mass_campaign_created'));
  assert.ok(stored.events.includes('mass_campaign_updated'));
  assert.ok(stored.events.includes('mass_campaign_prepared'));
  const item = { id: 5, list_id: stored.list.id, name: 'Ana García', clinica_id: 21, email: 'ana@example.test', status: 'ready', selected: true, channel_status: {}, async update(next) { Object.assign(this, next); return this; } };
  stored.setItems([item]);
  t.mock.method(provider, 'publicConfig', () => ({ provider: 'mock', enabled: true, marketingEnabled: true }));
  t.mock.method(delivery, 'findActiveSuppression', async () => null);
  t.mock.method(marketing, 'issueUnsubscribe', async () => 'https://example.test/email/baja');
  t.mock.method(bulk, 'assertReviewRequestCommunicationAllowed', async () => ({ review: false }));
  let sent;
  t.mock.method(delivery, 'queueEmail', async input => {
    sent = templates.renderMarketingCampaign(input.templateContext);
    return { emailMessage: { id: 1, status: 'queued' } };
  });
  await dispatch.runDispatchJob({ list_id: stored.list.id });
  assert.ok(sent, 'real dispatch must have rendered the queued message');
  assert.doesNotMatch(sent.html, /data-email-preheader|Preheader legado|Anterior|Guardado/);
  const preview = marketing.previewTemplate({ subject: payload.email_subject, preheader: '', design: stored.template.design });
  assert.equal(sent.html, preview.html);
  assert.equal(sent.text, preview.text);
});

test('missing and legacy-null campaign preheaders retain template fallback while explicit camelCase clears persist', async t => {
  const stored = campaignStorage(t);
  await bulk.createCampaign(scope, { name: 'Campaña antigua', channels: ['email'], template_usage: 'notificacion', email_template_id: 31, email_sender_identity_id: 41 }, 1);
  assert.equal(stored.list.criteria.email_preheader, null);
  await bulk.updateCampaign(scope, stored.list.id, { emailPreheader: '  Vista guardada  ' }, 1);
  assert.equal(stored.list.criteria.email_preheader, 'Vista guardada');
  await bulk.updateCampaign(scope, stored.list.id, {}, 1);
  await bulk.prepareCampaign(scope, stored.list.id, {}, 1);
  assert.equal(stored.list.criteria.email_preheader, 'Vista guardada');
  await bulk.prepareCampaign(scope, stored.list.id, { emailPreheader: '  ' }, 1);
  assert.equal(stored.list.criteria.email_preheader, '');
  await bulk.updateCampaign(scope, stored.list.id, { email_preheader: null }, 1);
  await bulk.prepareCampaign(scope, stored.list.id, {}, 1);
  assert.equal(stored.list.criteria.email_preheader, null);
});
