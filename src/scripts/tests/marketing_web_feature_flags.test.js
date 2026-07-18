'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  assertWebPublishingChannelEnabled,
  assertWebPublishingEnabled,
  assertWebScopeEnabled,
  disabledScopeKeys,
  enabledScopeKeys,
  publishingScopeKeys,
  webEditorEnabled,
  webPublishingAvailability,
  webPublishingCapabilities,
  webPublishingChannelAvailability,
  webPublishingEnabled,
} = require('../../lib/marketingWebFeatureFlags');

const original = {
  editor: process.env.MARKETING_WEB_EDITOR_ENABLED,
  publishing: process.env.MARKETING_WEB_PUBLISHING_ENABLED,
  disabledScopes: process.env.MARKETING_WEB_DISABLED_SCOPES,
  enabledScopes: process.env.MARKETING_WEB_ENABLED_SCOPES,
  publishingScopes: process.env.MARKETING_WEB_PUBLISHING_SCOPES,
  wordpressChannel: process.env.MARKETING_WEB_WORDPRESS_CHANNEL_ENABLED,
  hostedChannel: process.env.MARKETING_WEB_HOSTED_CHANNEL_ENABLED,
  customDomainChannel: process.env.MARKETING_WEB_CUSTOM_DOMAIN_CHANNEL_ENABLED,
  apiBase: process.env.MARKETING_WEB_API_BASE_URL,
  bootstrapKey: process.env.MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY,
  signingPrivate: process.env.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM,
  signingPublic: process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM,
  artifactMode: process.env.MARKETING_WEB_ARTIFACT_STORE_MODE,
  hostedDomain: process.env.MARKETING_WEB_HOSTED_DOMAIN,
  hostedMode: process.env.MARKETING_WEB_HOSTED_MODE,
  hostingRoot: process.env.MARKETING_WEB_HOSTING_ROOT,
  customProvider: process.env.MARKETING_WEB_CUSTOM_HOSTNAME_PROVIDER,
  customTarget: process.env.MARKETING_WEB_CUSTOM_DOMAIN_TARGET,
};

try {
  delete process.env.MARKETING_WEB_EDITOR_ENABLED;
  delete process.env.MARKETING_WEB_PUBLISHING_ENABLED;
  delete process.env.MARKETING_WEB_DISABLED_SCOPES;
  delete process.env.MARKETING_WEB_ENABLED_SCOPES;
  delete process.env.MARKETING_WEB_PUBLISHING_SCOPES;
  delete process.env.MARKETING_WEB_WORDPRESS_CHANNEL_ENABLED;
  delete process.env.MARKETING_WEB_HOSTED_CHANNEL_ENABLED;
  delete process.env.MARKETING_WEB_CUSTOM_DOMAIN_CHANNEL_ENABLED;
  delete process.env.MARKETING_WEB_API_BASE_URL;
  delete process.env.MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY;
  delete process.env.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM;
  delete process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM;
  delete process.env.MARKETING_WEB_ARTIFACT_STORE_MODE;
  delete process.env.MARKETING_WEB_HOSTED_DOMAIN;
  delete process.env.MARKETING_WEB_HOSTED_MODE;
  delete process.env.MARKETING_WEB_HOSTING_ROOT;
  delete process.env.MARKETING_WEB_CUSTOM_HOSTNAME_PROVIDER;
  delete process.env.MARKETING_WEB_CUSTOM_DOMAIN_TARGET;
  assert.equal(webEditorEnabled(), false);
  assert.equal(webPublishingEnabled(), false);
  assert.throws(
    () => assertWebScopeEnabled({ type: 'clinic', id: 66 }),
    (error) => error.code === 'web_editor_disabled' && error.status === 503
  );
  process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';
  assert.equal(enabledScopeKeys(), null);
  assert.equal(assertWebScopeEnabled({ type: 'clinic', id: 66 }), true);
  assert.throws(
    () => assertWebPublishingEnabled({ type: 'clinic', id: 66 }),
    (error) => error.code === 'web_publishing_disabled' && error.status === 503
  );

  process.env.MARKETING_WEB_ENABLED_SCOPES = 'clinic:66, group:4';
  assert.deepEqual([...enabledScopeKeys()].sort(), ['clinic:66', 'group:4']);
  assert.equal(assertWebScopeEnabled({ type: 'clinic', id: 66 }), true);
  assert.equal(assertWebScopeEnabled({ type: 'group', id: 4 }), true);
  assert.throws(
    () => assertWebScopeEnabled({ type: 'clinic', id: 67 }),
    (error) => error.code === 'web_editor_disabled'
      && error.details.rollout_reason === 'scope_not_enabled'
  );

  process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'true';
  process.env.MARKETING_WEB_PUBLISHING_SCOPES = 'group:4';
  assert.deepEqual([...publishingScopeKeys()], ['group:4']);
  assert.deepEqual(webPublishingAvailability({ type: 'group', id: 4 }), {
    available: true,
    reason: null,
  });
  assert.deepEqual(webPublishingAvailability({ type: 'clinic', id: 66 }), {
    available: false,
    reason: 'scope_not_enabled',
  });
  assert.equal(assertWebPublishingEnabled({ type: 'group', id: 4 }), true);
  assert.deepEqual(webPublishingCapabilities({ type: 'group', id: 4 }), {
    publishing_available: false,
    publishing_unavailable_reason: 'no_operational_channels',
    publishing_rollout_available: true,
    publishing_rollout_unavailable_reason: null,
    publishing_channels: {
      clinicaclick_hosted: { available: false, unavailable_reason: 'channel_not_enabled' },
      wordpress: { available: false, unavailable_reason: 'channel_not_configured' },
      custom_domain: { available: false, unavailable_reason: 'channel_not_enabled' },
    },
  });
  assert.throws(
    () => assertWebPublishingChannelEnabled({ type: 'group', id: 4 }, 'clinicaclick_hosted'),
    (error) => error.code === 'web_publishing_channel_disabled'
      && error.details.channel === 'clinicaclick_hosted'
      && error.details.rollout_reason === 'channel_not_enabled'
  );

  process.env.MARKETING_WEB_API_BASE_URL = 'https://crm.clinicaclick.com';
  process.env.MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY = 'b'.repeat(32);
  const signingKeys = crypto.generateKeyPairSync('ed25519');
  process.env.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM = signingKeys.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM = signingKeys.publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  process.env.MARKETING_WEB_ARTIFACT_STORE_MODE = 'authenticated_db';
  assert.deepEqual(webPublishingChannelAvailability({ type: 'group', id: 4 }, 'wordpress'), {
    available: true,
    reason: null,
  });
  process.env.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM = process.env.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM.replace(/\n/g, '\\n');
  process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM = process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM.replace(/\n/g, '\\n');
  assert.deepEqual(webPublishingChannelAvailability({ type: 'group', id: 4 }, 'wordpress'), {
    available: true,
    reason: null,
  });
  process.env.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM = signingKeys.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM = signingKeys.publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  assert.equal(assertWebPublishingChannelEnabled({ type: 'group', id: 4 }, 'wordpress'), true);
  assert.deepEqual(webPublishingCapabilities({ type: 'group', id: 4 }), {
    publishing_available: true,
    publishing_unavailable_reason: null,
    publishing_rollout_available: true,
    publishing_rollout_unavailable_reason: null,
    publishing_channels: {
      clinicaclick_hosted: { available: false, unavailable_reason: 'channel_not_enabled' },
      wordpress: { available: true, unavailable_reason: null },
      custom_domain: { available: false, unavailable_reason: 'channel_not_enabled' },
    },
  });
  process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM = crypto.generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  assert.deepEqual(webPublishingChannelAvailability({ type: 'group', id: 4 }, 'wordpress'), {
    available: false,
    reason: 'channel_not_configured',
  });
  process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM = signingKeys.publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  process.env.MARKETING_WEB_WORDPRESS_CHANNEL_ENABLED = 'false';
  assert.deepEqual(webPublishingChannelAvailability({ type: 'group', id: 4 }, 'wordpress'), {
    available: false,
    reason: 'channel_not_enabled',
  });
  delete process.env.MARKETING_WEB_WORDPRESS_CHANNEL_ENABLED;

  process.env.MARKETING_WEB_HOSTED_DOMAIN = 'sites.clinicaclick.com';
  process.env.MARKETING_WEB_HOSTED_MODE = 'path';
  process.env.MARKETING_WEB_HOSTING_ROOT = '/var/lib/clinicaclick-web-hosting';
  process.env.MARKETING_WEB_HOSTED_CHANNEL_ENABLED = 'true';
  assert.deepEqual(webPublishingChannelAvailability({ type: 'group', id: 4 }, 'clinicaclick_hosted'), {
    available: true,
    reason: null,
  });
  process.env.MARKETING_WEB_CUSTOM_HOSTNAME_PROVIDER = 'manual';
  process.env.MARKETING_WEB_CUSTOM_DOMAIN_TARGET = 'sites.clinicaclick.com';
  process.env.MARKETING_WEB_CUSTOM_DOMAIN_CHANNEL_ENABLED = 'true';
  assert.deepEqual(webPublishingChannelAvailability({ type: 'group', id: 4 }, 'custom_domain'), {
    available: true,
    reason: null,
  });
  assert.throws(
    () => assertWebPublishingEnabled({ type: 'clinic', id: 66 }),
    (error) => error.code === 'web_publishing_disabled'
      && error.details.rollout_reason === 'scope_not_enabled'
  );
  process.env.MARKETING_WEB_PUBLISHING_SCOPES = 'group:4,';
  assert.throws(
    () => assertWebPublishingEnabled({ type: 'group', id: 4 }),
    (error) => error.code === 'marketing_web_invalid_publishing_scopes'
  );
  delete process.env.MARKETING_WEB_PUBLISHING_SCOPES;
  process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'false';

  process.env.MARKETING_WEB_DISABLED_SCOPES = 'clinic:66, group:9';
  assert.deepEqual([...disabledScopeKeys()].sort(), ['clinic:66', 'group:9']);
  assert.throws(
    () => assertWebScopeEnabled({ type: 'clinic', id: 66 }),
    (error) => error.code === 'web_editor_disabled'
      && error.details.scope_id === 66
      && error.details.rollout_reason === 'disabled_scope'
  );
  assert.equal(assertWebScopeEnabled({ type: 'group', id: 4 }), true);

  process.env.MARKETING_WEB_ENABLED_SCOPES = 'clinic:66, invalid, group:0';
  assert.throws(
    () => enabledScopeKeys(),
    (error) => error.code === 'marketing_web_invalid_enabled_scopes'
      && error.details.invalid_entries.length === 2
  );
  process.env.MARKETING_WEB_ENABLED_SCOPES = 'clinic:66,';
  assert.throws(
    () => assertWebScopeEnabled({ type: 'clinic', id: 66 }),
    (error) => error.code === 'marketing_web_invalid_enabled_scopes'
  );
  process.env.MARKETING_WEB_ENABLED_SCOPES = '';

  process.env.MARKETING_WEB_DISABLED_SCOPES = 'clinic:66, invalid, clinic:0';
  assert.throws(
    () => disabledScopeKeys(),
    (error) => error.code === 'marketing_web_invalid_disabled_scopes'
      && error.details.invalid_entries.length === 2
  );
  process.env.MARKETING_WEB_DISABLED_SCOPES = '';

  process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'flase';
  assert.throws(
    () => webPublishingEnabled(),
    (error) => error.code === 'marketing_web_invalid_feature_flag'
  );
  process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'false';

  process.env.MARKETING_WEB_EDITOR_ENABLED = 'false';
  assert.equal(webEditorEnabled(), false);
  assert.throws(() => assertWebScopeEnabled({ type: 'group', id: 9 }), /desactivado temporalmente/);

  console.log('marketing web feature flags: ok');
} finally {
  if (original.editor === undefined) delete process.env.MARKETING_WEB_EDITOR_ENABLED;
  else process.env.MARKETING_WEB_EDITOR_ENABLED = original.editor;
  if (original.publishing === undefined) delete process.env.MARKETING_WEB_PUBLISHING_ENABLED;
  else process.env.MARKETING_WEB_PUBLISHING_ENABLED = original.publishing;
  if (original.disabledScopes === undefined) delete process.env.MARKETING_WEB_DISABLED_SCOPES;
  else process.env.MARKETING_WEB_DISABLED_SCOPES = original.disabledScopes;
  if (original.enabledScopes === undefined) delete process.env.MARKETING_WEB_ENABLED_SCOPES;
  else process.env.MARKETING_WEB_ENABLED_SCOPES = original.enabledScopes;
  if (original.publishingScopes === undefined) delete process.env.MARKETING_WEB_PUBLISHING_SCOPES;
  else process.env.MARKETING_WEB_PUBLISHING_SCOPES = original.publishingScopes;
  for (const [key, name] of [
    ['wordpressChannel', 'MARKETING_WEB_WORDPRESS_CHANNEL_ENABLED'],
    ['hostedChannel', 'MARKETING_WEB_HOSTED_CHANNEL_ENABLED'],
    ['customDomainChannel', 'MARKETING_WEB_CUSTOM_DOMAIN_CHANNEL_ENABLED'],
    ['apiBase', 'MARKETING_WEB_API_BASE_URL'],
    ['bootstrapKey', 'MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY'],
    ['signingPrivate', 'MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM'],
    ['signingPublic', 'MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM'],
    ['artifactMode', 'MARKETING_WEB_ARTIFACT_STORE_MODE'],
    ['hostedDomain', 'MARKETING_WEB_HOSTED_DOMAIN'],
    ['hostedMode', 'MARKETING_WEB_HOSTED_MODE'],
    ['hostingRoot', 'MARKETING_WEB_HOSTING_ROOT'],
    ['customProvider', 'MARKETING_WEB_CUSTOM_HOSTNAME_PROVIDER'],
    ['customTarget', 'MARKETING_WEB_CUSTOM_DOMAIN_TARGET'],
  ]) {
    if (original[key] === undefined) delete process.env[name];
    else process.env[name] = original[key];
  }
}
