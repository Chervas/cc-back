'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const diagnostics = require('../../lib/intake-web-diagnostics');
const { inspectSnippetRuntime } = require('../../lib/intake-snippet-runtime');
const { configuredClinicIds } = require('../../lib/intake-page-clinic');
const { detectExternalCookieProviders } = require('../../lib/intake-cookie-notice');
const { detectLegacyJoinChat } = require('../../lib/intake-legacy-chat');
const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/intake.controller.js'), 'utf8');
const handler = source.slice(source.indexOf('exports.verifySnippetInstalled ='), source.indexOf('// ===========================\n// Eventos genéricos', source.indexOf('exports.verifySnippetInstalled =')));
const loader = '<script src="https://crm.clinicaclick.com/assets/loader.js" data-group-id="5" data-event-bridge-url="/_clinicaclick/events"></script>';

// Execute the actual route body with all I/O supplied as doubles. Never import
// the controller's application graph (DB, workers, providers).
async function verify({ html = loader, bypassHtml, allowed = true, query = {}, failHttp = false, recent = false } = {}) {
  let reads = 0;
  const requests = [];
  const record = { group_id: 5, assignment_scope: 'group', domains: ['example.test', 'other.test'], hmac_key: 'private-test-key', config: { locations: [{ id: 19 }, { id: 56 }] } };
  const Op = { in: Symbol('in'), between: Symbol('between'), or: Symbol('or') };
  const db = {
    WebWordpressInstallation: { findAll: async () => { reads++; return [{ siteUrl: 'https://example.test', status: 'connected', pluginVersion: '2.0.0-alpha.11', lastSeenAt: new Date() }]; } },
    WebEvent: { max: async (_column, { where }) => {
      reads++;
      assert.equal(where.group_id, 5);
      assert.deepEqual(where[Op.or][1].clinic_id[Op.in], [19, 56]);
      return recent ? new Date(Date.now() - 1000) : null;
    } },
  };
  const context = {
    exports: {}, URL, Date, console: { warn() {} }, db, Op, configuredClinicIds,
    ...diagnostics, readDiagnosticAttribute: diagnostics.attribute,
    asyncHandler: (fn) => fn,
    parseInteger: (v) => v == null ? null : Number(v),
    normalizeDomain: (v) => String(v).toLowerCase().replace(/^www\./, ''),
    stripWww: (v) => v.replace(/^www\./, ''),
    isDomainAllowed: (domains, host) => domains.includes(host.replace(/^www\./, '')),
    requireIntakeConfigScopeAccess: async (_req, res) => { if (!allowed) res.status(403).json({ error: 'scope_forbidden' }); return allowed; },
    resolveSharedWebGroupConfigForClinic: async () => ({ record, groupId: 5 }),
    IntakeConfig: { findOne: async () => record },
    detectExternalCookieProviders, detectLegacyJoinChat, inspectSnippetRuntime,
    cookieNoticeProviderMatches: () => false,
    buildVerificationConfigHash: () => 'fixture-hash',
    issueVerificationAttestation: () => ({ token: 'test-proof', expiresAt: '2026-10-28T12:15:00Z' }),
    resolveSafeHttpTarget: async (url) => ({ url, hostname: new URL(url).hostname, httpAgent: { destroy() {} }, httpsAgent: { destroy() {} } }),
    axios: { get: async (url) => {
      requests.push(url);
      const parsed = new URL(url);
      assert.ok(['example.test', 'www.example.test', 'crm.clinicaclick.com'].includes(parsed.hostname), 'no provider HTTP');
      if (failHttp) throw new Error('offline fixture');
      if (parsed.pathname.endsWith('loader.js')) return { status: 200, data: "var RUNTIME_VERSION='3.4.9'; var RUNTIME_FILE='intake.js';" };
      if (parsed.pathname.endsWith('intake.js')) return { status: 200, data: "// ClinicaClick Intake Snippet v3.4.9\nconsent_mode_enabled; consent_provider; external_cmp_provider; cmplz_has_consent; cmplz_set_consent; gtag('consent', 'default', {});" };
      return { status: 200, data: parsed.searchParams.has('cc_cache_bust') ? (bypassHtml ?? html) : html };
    } },
  };
  vm.runInNewContext(handler, context);
  const response = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await context.exports.verifySnippetInstalled({ query: { domain: 'example.test', group_id: '5', ...query } }, response);
  return { ...response, reads, requests };
}

test('route installed: static capabilities and received events remain independent', async () => {
  const { body, code } = await verify({ recent: true });
  assert.equal(code, 200);
  assert.equal(body.installed, true);
  assert.equal(body.runtime_compatible, true);
  assert.equal(body.diagnostics.activity.status, 'received');
  assert.equal(body.diagnostics.runtime.execution, 'not_verified');
  assert.equal(body.security_transport, 'same_origin_server_bridge');
  assert.equal(body.verification_attestation, 'test-proof');
  assert.doesNotMatch(JSON.stringify(body), /private-test-key/);
});

test('route rejects ID prefix, own-asset spoofing and inert HTML snippets', async () => {
  for (const html of [loader.replace('data-group-id="5"', 'data-group-id="56"'), loader.replace('crm.clinicaclick.com', 'www.googletagmanager.com'), `<!--${loader}-->`]) {
    const { body } = await verify({ html });
    assert.equal(body.installed, false);
    assert.equal(body.diagnostics.installation.scope_matches, false);
    assert.equal(body.verification_attestation, undefined);
  }
});

test('route cache bypass never upgrades normal page diagnostics', async () => {
  const { body } = await verify({ html: '<html>old theme</html>', bypassHtml: loader });
  assert.equal(body.cache_stale, true);
  assert.equal(body.installed, false);
  assert.equal(body.diagnostics.installation.status, 'cache_stale');
  assert.equal(body.diagnostics.installation.loader_visible, false);
  assert.equal(body.diagnostics.runtime.status, 'unverified');
  assert.equal(body.verification_attestation, undefined);
});

test('route unreachable retains independent plugin and activity evidence', async () => {
  const { body, code } = await verify({ failHttp: true, recent: true });
  assert.equal(code, 502);
  assert.equal(body.diagnostics.page_status, 'unreachable');
  assert.equal(body.diagnostics.plugin.status, 'connected');
  assert.equal(body.diagnostics.activity.status, 'received');
  assert.equal(body.diagnostics.installation.status, 'unverified');
});

test('route authorization and domain checks run before evidence reads or HTTP', async () => {
  for (const options of [{ allowed: false }, { query: { url: 'https://other.test/' } }, { query: { domain: 'forbidden.test' } }]) {
    const result = await verify(options);
    assert.ok([400, 403].includes(result.code));
    assert.equal(result.reads, 0);
    assert.equal(result.requests.length, 0);
  }
});

test('runtime compatibility remains visible when secure transport is missing', async () => {
  const { body } = await verify({ html: loader.replace(' data-event-bridge-url="/_clinicaclick/events"', '') });
  assert.equal(body.installed, false);
  assert.equal(body.diagnostics.installation.transport_configured, false);
  assert.equal(body.diagnostics.runtime.status, 'compatible');
  assert.equal(body.diagnostics.activity.status, 'no_recent_activity');
});
