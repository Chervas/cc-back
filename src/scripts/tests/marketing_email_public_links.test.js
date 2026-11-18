'use strict';

const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../../lib/marketingEmailPublicLinks');
const marketing = require('../../services/marketingEmail.service');
const templates = require('../../services/emailTemplates.service');
const dispatch = require('../../services/marketingEmailDispatch.service');
const delivery = require('../../services/emailDelivery.service');
const provider = require('../../services/emailProvider.service');
const jobs = require('../../services/jobRequests.service');

function env(t) {
  const previous = process.env.EMAIL_DATA_ENCRYPTION_KEY;
  process.env.EMAIL_DATA_ENCRYPTION_KEY = 'offline-email-public-links-key-only';
  t.after(() => { if (previous === undefined) delete process.env.EMAIL_DATA_ENCRYPTION_KEY; else process.env.EMAIL_DATA_ENCRYPTION_KEY = previous; });
}

test('capabilities are opaque, purpose-bound, tamper resistant and expire independently of permanent unsubscribe', t => {
  env(t);
  const generated = links.messageLinks({ publicId: 'em_11111111-2222-4333-8444-555555555555', recipientHash: 'a'.repeat(64), scopeKey: 'group:7', unsubscribeUrl: 'https://example.test/email/baja?token=permanent', now: 1000 });
  const token = new URL(generated.browser_view_url).searchParams.get('token');
  assert.doesNotMatch(token, /group|11111111|aaaaaa|@/);
  const claims = links.readCapability(token, 'browser', { now: 1001 });
  assert.equal(claims.s, 'group:7');
  assert.throws(() => links.readCapability(token, 'preferences', { now: 1001 }), { code: 'marketing_email_link_invalid' });
  assert.throws(() => links.readCapability(token.slice(0, -8) + 'ABCDEFGH', 'browser', { now: 1001 }), { code: 'marketing_email_link_invalid' });
  assert.throws(() => links.readCapability(token, 'browser', { now: generated.expires_at }), { code: 'marketing_email_link_invalid' });
  assert.equal(generated.unsubscribe_url, 'https://example.test/email/baja?token=permanent');
});

test('signed snapshots survive JSON key normalization and reject content changes', t => {
  env(t);
  const snapshot = links.sealSnapshot({ publicId: 'em_11111111-2222-4333-8444-555555555555', recipientHash: 'b'.repeat(64), scopeKey: 'clinic:21', expiresAt: Date.now() + 10000, rendered: { subject: 'Hola', html: '<p>Original</p>', text: 'Original' } });
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
  reordered.rendered = { text: 'Original', html: '<p>Original</p>', subject: 'Hola' };
  assert.equal(links.readSnapshot(reordered).rendered.text, 'Original');
  assert.deepEqual(templates.renderMarketingCampaign({ marketing_email_snapshot: reordered }), snapshot.rendered);
  reordered.rendered.html = '<p>Cambio</p>';
  assert.throws(() => templates.renderMarketingCampaign({ marketing_email_snapshot: reordered }), { code: 'marketing_email_link_invalid' });
});

test('new preview supplies reserved URLs and adds only missing usable system anchors', () => {
  const input = { name: 'Prueba', subject: 'Hola {{nombre}}', design: { content_mode: 'html', html_source: '<p>Hola {{nombre}}</p><a href="{{UNSUBSCRIBE_URL}}">Baja propia</a><a href="{{preferences_url}}">Preferencias propias</a><a href="{{BROWSER_VIEW_URL}}">Versión web</a>', show_clinicaclick_branding: false } };
  const preview = marketing.previewTemplate(input);
  assert.deepEqual(preview.missing_variables, []);
  for (const url of Object.values(links.PREVIEW_LINKS)) {
    assert.equal(preview.html.split(`href="${url.replace(/&/g, '&amp;')}"`).length - 1, 1);
  }
  assert.doesNotMatch(preview.html, /data-email-browser-view|data-email-footer/);
  const invalid = marketing.previewTemplate({ ...input, design: { content_mode: 'html', html_source: '<a href="https://other.example/baja">Baja ajena</a><a href="javascript:bad()">Preferencias</a>' } });
  assert.match(invalid.html, /data-email-browser-view/);
  assert.match(invalid.html, /Dejar de recibir estas comunicaciones/);
  assert.match(invalid.html, /Preferencias de email/);
  const missing = marketing.previewTemplate({ ...input, design: { content_mode: 'html', html_source: '<p>{{custom_required}}</p>' } });
  assert.deepEqual(missing.missing_variables, ['custom_required']);
});

test('test-send freezes final per-message content atomically, reuses scope opt-out and preserves original on dedupe', async t => {
  env(t);
  const tx = { id: 'offline-public-links' };
  const list = { id: 100, scope_type: 'clinic', clinica_id: 21, email_template_id: 31, email_sender_identity_id: 41, criteria: {} };
  const item = { id: 9, clinica_id: 21, name: 'Ana Ejemplo', email: 'sample@example.test' };
  const template = { id: 31, version: 2, name: 'Prueba', subject: 'Hola {{nombre}}', design: { content_mode: 'html', html_source: '<p>Hola {{nombre}}</p><a href="{{UNSUBSCRIBE_URL}}">Baja</a><a href="{{BROWSER_VIEW_URL}}">Web</a><a href="{{PREFERENCES_URL}}">Preferencias</a>', show_clinicaclick_branding: false }, rendered_html: '<p>OBSOLETO</p>', rendered_text: 'OBSOLETO' };
  t.mock.method(db.sequelize, 'transaction', async callback => callback(tx));
  t.mock.method(provider, 'publicConfig', () => ({ provider: 'mock', enabled: true, marketingEnabled: true }));
  t.mock.method(provider, 'getConfig', () => ({ provider: 'mock', defaultFrom: 'sender@example.test', defaultReplyTo: 'sender@example.test' }));
  t.mock.method(provider, 'mapStreamToConfigurationSet', () => null);
  t.mock.method(db.EmailSenderIdentity, 'findOne', async () => ({ id: 41, status: 'active', verification_status: 'verified', email: 'sender@example.test', display_name: 'Equipo', domain: { verification_status: 'verified', dkim_status: 'verified' } }));
  t.mock.method(db.MarketingEmailTemplate, 'findOne', async () => template);
  t.mock.method(db.MarketingPatientListItem, 'count', async () => 1);
  t.mock.method(db.MarketingPatientListItem, 'findOne', async () => item);
  t.mock.method(db.Clinica, 'findByPk', async () => ({ nombre_clinica: 'Clínica Ejemplo' }));
  const bulkKey = require.resolve('../../services/marketingBulkSends.service');
  const previous = require.cache[bulkKey];
  require.cache[bulkKey] = { id: bulkKey, filename: bulkKey, loaded: true, exports: { assertReviewRequestCommunicationAllowed: async () => ({ review: false }) } };
  t.after(() => { if (previous) require.cache[bulkKey] = previous; else delete require.cache[bulkKey]; });
  let optout;
  t.mock.method(db.MarketingEmailUnsubscribe, 'findOrCreate', async ({ defaults }) => {
    optout = { ...defaults, status: 'active', async update(value) { Object.assign(this, value); } };
    return [optout, true];
  });
  let stored;
  t.mock.method(db.EmailMessage, 'findOne', async ({ where }) => stored && (where.dedupe_key || where.public_id === stored.public_id) ? stored : null);
  t.mock.method(db.EmailMessage, 'findOrCreate', async ({ defaults, transaction }) => {
    assert.equal(transaction, tx);
    assert.ok(defaults.template_context.marketing_email_snapshot, 'snapshot persisted with outbox before enqueue');
    stored = { id: 10, ...defaults, async update(value) { Object.assign(this, value); } };
    return [stored, true];
  });
  t.mock.method(jobs, 'enqueueUniqueJobRequest', async (_input, { transaction }) => {
    assert.equal(transaction, tx);
    assert.ok(stored.template_context.marketing_email_snapshot);
    return { job: { id: 8 }, created: true };
  });
  await dispatch.sendTest(list, { to: 'qa@example.test', item_id: 9 });
  const snapshot = links.readSnapshot(stored.template_context.marketing_email_snapshot);
  assert.match(snapshot.rendered.html, /Hola Ana/);
  assert.doesNotMatch(snapshot.rendered.html, /OBSOLETO|\{\{|example\.test\/api\/email/);
  assert.equal(snapshot.recipient_hash, delivery.hashEmail('qa@example.test'));
  assert.equal(optout.email_hash, delivery.hashEmail('qa@example.test'), 'test opt-out targets test address, not sample contact');
  assert.equal(optout.item_id, null, 'test opt-out cannot mark sample contact');
  const browserToken = new URL(stored.template_context.browser_view_url).searchParams.get('token');
  assert.equal(await marketing.browserView(browserToken), snapshot.rendered.html);
  template.design.html_source = '<p>Contenido modificado después</p>';
  assert.deepEqual(templates.renderMarketingCampaign(stored.template_context), snapshot.rendered);
  let callbackCount = 0;
  const dedupe = await delivery.queueEmail({ stream: 'marketing', templateKey: 'marketing.campaign', marketingConsent: true, recipientEmail: 'qa@example.test', dedupeKey: stored.dedupe_key, templateContext: { unsubscribe_url: stored.template_context.unsubscribe_url } }, { prepareTemplateContext: async () => { callbackCount++; throw new Error('must not execute'); } });
  assert.equal(dedupe.created, false);
  assert.equal(callbackCount, 0);
  const preferenceToken = new URL(stored.template_context.preferences_url).searchParams.get('token');
  let suppression;
  t.mock.method(db.EmailSuppression, 'findOne', async () => suppression);
  t.mock.method(db.EmailSuppression, 'findOrCreate', async ({ where, defaults }) => { suppression = { ...where, ...defaults }; return [suppression, true]; });
  t.mock.method(db.MarketingEmailUnsubscribe, 'findOne', async () => optout);
  assert.deepEqual(await marketing.preferenceStatus(preferenceToken), { success: true, scope_label: 'Clínica Ejemplo', status: 'enabled', can_unsubscribe: true });
  await assert.rejects(marketing.updatePreferences(preferenceToken, 'subscribe'), { code: 'marketing_email_preference_action_invalid' });
  const result = await marketing.updatePreferences(preferenceToken, 'unsubscribe');
  assert.equal(result.status, 'unsubscribed');
  assert.equal(suppression.scope, 'clinic:21');
  assert.equal(suppression.email_hash, delivery.hashEmail('qa@example.test'));
  assert.equal((await marketing.updatePreferences(preferenceToken, 'unsubscribe')).status, 'unsubscribed');
  await assert.rejects(marketing.preferenceStatus(browserToken), { code: 'marketing_email_link_invalid' });
  stored.recipient_hash = delivery.hashEmail('someone-else@example.test');
  await assert.rejects(marketing.browserView(browserToken), { code: 'marketing_email_link_invalid' });
});

test('browser controller serves only the frozen HTML with script, indexing, caching and referrer protections', async t => {
  const controller = require('../../controllers/marketingEmail.controller');
  const headers = {};
  const res = { statusCode: 200, set(name, value) { headers[name] = value; return this; }, type(value) { this.contentType = value; return this; }, send(value) { this.body = value; return this; }, status(value) { this.statusCode = value; return this; } };
  t.mock.method(marketing, 'browserView', async () => '<p>Snapshot inmutable</p>');
  await controller.browserView({ query: { token: 'opaque-test' } }, res);
  assert.equal(res.body, '<p>Snapshot inmutable</p>');
  assert.match(headers['Content-Security-Policy'], /script-src 'none'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Cache-Control'], /no-store/);
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['X-Robots-Tag'], /noindex/);
  t.mock.method(marketing, 'browserView', async () => { throw Object.assign(new Error('contains-private-detail'), { status: 404 }); });
  await controller.browserView({ query: { token: 'invalid' } }, res);
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(res.body, /private-detail|invalid|opaque-test/);
});

test('preference status honors group/global delivery suppression without offering reactivation', async t => {
  env(t);
  const publicId = 'em_11111111-2222-4333-8444-555555555555';
  const recipientHash = delivery.hashEmail('qa@example.test');
  const generated = links.messageLinks({ publicId, recipientHash, scopeKey: 'group:7', unsubscribeUrl: 'https://example.test/email/baja?token=unrelated' });
  const snapshot = links.sealSnapshot({ publicId, recipientHash, scopeKey: 'group:7', scopeLabel: 'Grupo Ejemplo', expiresAt: generated.expires_at, rendered: { subject: 'Hola', html: '<p>Hola</p>', text: 'Hola' } });
  t.mock.method(db.EmailMessage, 'findOne', async () => ({ public_id: publicId, recipient_hash: recipientHash, clinica_id: 21, metadata: { grupo_clinica_id: 7 }, template_context: { ...generated, marketing_email_snapshot: snapshot } }));
  t.mock.method(db.EmailSuppression, 'findOne', async ({ where }) => {
    const scopes = Object.getOwnPropertySymbols(where.scope).map(key => where.scope[key]).flat();
    assert.deepEqual(scopes, ['global', 'clinic:21', 'group:7']);
    return { reason: 'bounce' };
  });
  t.mock.method(db.MarketingEmailUnsubscribe, 'findOne', async () => ({ email_hash: recipientHash, scope_key: 'group:7', status: 'active' }));
  const token = new URL(generated.preferences_url).searchParams.get('token');
  assert.deepEqual(await marketing.preferenceStatus(token), { success: true, scope_label: 'Grupo Ejemplo', status: 'suppressed', can_unsubscribe: true });
  await assert.rejects(marketing.updatePreferences(token, 'subscribe'), { code: 'marketing_email_preference_action_invalid' });
});

test('a failed per-message preparation creates neither an outbox row nor a delivery job', async t => {
  env(t);
  t.mock.method(db.sequelize, 'transaction', async callback => callback({ id: 'offline' }));
  t.mock.method(db.EmailMessage, 'findOne', async () => null);
  t.mock.method(provider, 'getConfig', () => ({ provider: 'mock' }));
  await assert.rejects(delivery.queueEmail({ stream: 'marketing', templateKey: 'marketing.campaign', marketingConsent: true, recipientEmail: 'qa@example.test', templateContext: { unsubscribe_url: 'https://example.test/email/baja' } }, { prepareTemplateContext: async () => { throw Object.assign(new Error('render failed'), { code: 'render_failed' }); } }), { code: 'render_failed' });
  // Unmocked database/job writes throw in this fixture, so either write would
  // replace render_failed and fail the assertion above.
});
