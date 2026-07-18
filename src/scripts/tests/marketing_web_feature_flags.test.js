'use strict';

const assert = require('node:assert/strict');
const {
  assertWebPublishingEnabled,
  assertWebScopeEnabled,
  disabledScopeKeys,
  enabledScopeKeys,
  webEditorEnabled,
  webPublishingEnabled,
} = require('../../lib/marketingWebFeatureFlags');

const original = {
  editor: process.env.MARKETING_WEB_EDITOR_ENABLED,
  publishing: process.env.MARKETING_WEB_PUBLISHING_ENABLED,
  disabledScopes: process.env.MARKETING_WEB_DISABLED_SCOPES,
  enabledScopes: process.env.MARKETING_WEB_ENABLED_SCOPES,
};

try {
  delete process.env.MARKETING_WEB_EDITOR_ENABLED;
  delete process.env.MARKETING_WEB_PUBLISHING_ENABLED;
  delete process.env.MARKETING_WEB_DISABLED_SCOPES;
  delete process.env.MARKETING_WEB_ENABLED_SCOPES;
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
}
