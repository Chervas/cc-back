'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../../services/metaCapi.service.js');
const realRequire = createRequire(filename);

function fixture(decision) {
  const posts = []; const checks = []; const output = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: output, exports: output.exports, console,
    process: { env: { META_PIXEL_ID: 'global-pixel', META_CAPI_TOKEN: 'global-token' } }, require: name => {
      if (name === 'axios') return { post: async (...args) => { posts.push(args); return { data: { events_received: 1 } }; } };
      if (name === './campaignWorkspaceSignalPolicy.service') return { resolveWorkspaceSignalPolicy: async input => { checks.push(input); return decision; } };
      if (name === './metaWorkspaceSignalDelivery.service') return { sendWorkspaceMetaSignal: async input => {
        posts.push([`scoped/${input.pixelId}/events`, input, { params: { access_token: input.accessToken } }]);
        return { sent: true, status: 'accepted' };
      } };
      return realRequire(name);
    } }, { filename });
  return { ...output.exports, posts, checks };
}

test('Meta sends nothing when the workspace authorization has been revoked', async () => {
  const f = fixture({ applicable: true, allowed: false, reason: 'workspace_signals_disabled' });
  const result = await f.sendMetaEvent({ eventName: 'Lead', adAccountId: 'act_123', campaignId: '7', advertisingConsent: true, pixelId: '456', accessToken: 'scoped' });
  assert.equal(result.reason, 'workspace_signals_disabled'); assert.equal(f.posts.length, 0);
  assert.equal(f.checks[0].provider, 'meta_ads'); assert.equal(f.checks[0].accountId, 'act_123');
});
test('workspace approval is not a substitute for a visitor advertising grant', async () => {
  const f = fixture({ applicable: true, allowed: true });
  const result = await f.sendMetaEvent({ eventName: 'Lead', advertisingConsent: null, pixelId: '456', accessToken: 'scoped' });
  assert.equal(result.reason, 'consent_not_granted'); assert.equal(f.posts.length, 0);
});
test('new workspaces do not fall back to a global destination when their own pixel is missing', async () => {
  const f = fixture({ applicable: true, allowed: true });
  const result = await f.sendMetaEvent({ eventName: 'Lead', advertisingConsent: true, accessToken: 'scoped' });
  assert.equal(result.reason, 'workspace_meta_destination_required'); assert.equal(f.posts.length, 0);
});
test('scoped destinations and explicit authorization reach only the selected pixel', async () => {
  const f = fixture({ applicable: true, allowed: true });
  await f.sendMetaEvent({ eventName: 'Lead', eventId: 'test', advertisingConsent: true, pixelId: '456', accessToken: 'scoped', userData: {} });
  assert.equal(f.posts.length, 1); assert.match(f.posts[0][0], /\/456\/events$/);
  assert.equal(f.posts[0][2].params.access_token, 'scoped');
});
test('unmigrated configurations retain their existing transport contract', async () => {
  const f = fixture({ applicable: false, allowed: true });
  await f.sendMetaEvent({ eventName: 'ViewContent', userData: {} });
  assert.equal(f.posts.length, 1); assert.match(f.posts[0][0], /\/global-pixel\/events$/);
});
test('independent web events also cannot fall back to global credentials in a migrated workspace', async () => {
  const f = fixture({ applicable: false, allowed: true });
  const result = await f.sendMetaEvent({ eventName: 'ViewContent', userData: {}, signalPolicyRecord: { config: { campaigns: { workspace_policy: {} } } } });
  assert.equal(result.reason, 'workspace_meta_destination_required'); assert.equal(f.posts.length, 0);
});
test('website and advertiser authorizations are both forwarded to the policy resolver', async () => {
  const f = fixture({ applicable: true, allowed: false, reason: 'workspace_signals_disabled' });
  const web = { assignment_scope: 'clinic', clinic_id: 1, config: { campaigns: { workspace_policy: {} } } };
  const advertiser = { assignment_scope: 'group', group_id: 28, config: {} };
  const result = await f.sendMetaEvent({ eventName: 'Lead', webPolicyRecord: web, signalPolicyRecord: advertiser });
  assert.equal(result.reason, 'workspace_signals_disabled'); assert.equal(f.posts.length, 0);
  assert.equal(f.checks[0].records[0], web); assert.equal(f.checks[0].records[1], advertiser);
});

test('the intake runtime cannot disguise a global token as a scoped workspace token', async () => {
  const controller = fs.readFileSync(path.resolve(__dirname, '../../controllers/intake.controller.js'), 'utf8');
  const start = controller.indexOf('const resolveMetaCapiRuntimeConfig =');
  const end = controller.indexOf('\n};', start) + 3;
  assert.ok(start >= 0 && end > start);
  for (const scenario of [
    { workspace: true, token: null, expected: null },
    { workspace: true, token: 'own-token', expected: 'own-token' },
    { workspace: false, token: null, expected: 'global-token' },
    { workspace: false, webWorkspace: true, token: null, expected: null },
  ]) {
    const sandbox = { result: null, process: { env: { META_CAPI_TOKEN: 'global-token' } },
      cleanString: value => value || null, parseInteger: value => Number(value) || null,
      resolveEffectiveTrackingFromRecords: () => ({ meta_ads: { config_source: 'group', connection_id: 9, ad_account_id: '123', pixel_id: '456' } }),
      MetaConnection: { findByPk: async () => scenario.token ? { accessToken: scenario.token } : null },
    };
    vm.runInNewContext(controller.slice(start, end) + '\nresult = resolveMetaCapiRuntimeConfig;', sandbox);
    const groupCfg = { assignment_scope: 'group', group_id: 28, config: { campaigns: scenario.workspace ? { workspace_policy: { schema_version: 1 } } : {} } };
    const selectedRecord = scenario.webWorkspace ? { assignment_scope: 'clinic', clinic_id: 1, config: { campaigns: { workspace_policy: {} } } } : null;
    const runtime = await sandbox.result({ groupId: 28, groupCfg, selectedRecord });
    assert.equal(runtime.accessToken, scenario.expected);
    assert.equal(runtime.signalPolicyRecord, groupCfg);
  }
});
