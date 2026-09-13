'use strict';
const assert = require('node:assert/strict'); const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  models.GoogleConnection = require('../../../models/googleconnection')(sql, D);
  await models.GoogleConnection.sync();
  await require('../../../migrations/20260913020000-create-google-oauth-broker-flows').up(qi, D);
  models.GoogleOAuthBrokerBinding = require('../../../models/googleoauthbrokerbinding')(sql, D);
  const G = models.GoogleConnection; const B = models.GoogleOAuthBrokerBinding;
  const { createGoogleLegacyCredentials } = require('../../services/googleLegacyCredentials.service');
  const create = () => createGoogleLegacyCredentials({ connectionModel: G, bindingModel: B });
  const service = create(); let fullReads = 0;
  G.addHook('beforeFind', 'count_credentials', options => { if (options.attributes?.includes('accessToken')) fullReads++; });
  const row = (id, subject = 'fictitious-subject-' + id) => G.create({ id, googleUserId: subject,
    accessToken: 'FICTITIOUS_ACCESS_' + id, refreshToken: 'FICTITIOUS_REFRESH_' + id, expiresAt: new Date('2099-01-01') });
  const mark = (id, subject = 'fictitious-subject-' + id) => B.create({ google_connection_id: id, google_user_id: subject,
    connection_ref: 'connection:qa-' + id, asset_ref: 'gbp:123:' + id, clinica_id: 71, scope_key: 'clinic:71', policy_version: 'google-oauth-pinned-v1' });
  await row(81); await row(82, 'fictitious-subject-81');
  const legacy = await service.load(81); assert.equal(legacy.accessToken, 'FICTITIOUS_ACCESS_81');
  await service.saveRefresh(legacy, { accessToken: 'FICTITIOUS_NEW_81', expiresAt: new Date('2099-02-01') });
  assert.equal((await G.findByPk(81)).accessToken, 'FICTITIOUS_NEW_81');
  report.checks.push('Actual Sequelize GoogleConnection SELECT and conditional UPDATE work for an unmarked exact identity');
  await mark(81); const before = fullReads;
  for (const id of [81, 82]) await assert.rejects(service.load(id), { code: 'google_oauth_legacy_closed' });
  assert.equal(fullReads, before);
  report.checks.push('ID and duplicate subject are excluded with metadata-only reads and no credential hydration');
  await G.destroy({ where: { id: 81 } }); await row(81, 'recreated-subject');
  await assert.rejects(create().load(81), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(create().load(82), { code: 'google_oauth_legacy_closed' });
  report.checks.push('Independent markers survive connection deletion/recreation and service reconstruction');
  await row(83); let beforeSelect = true;
  G.addHook('beforeFind', 'race_select', async options => {
    if (beforeSelect && options.attributes?.includes('accessToken')) { beforeSelect = false; await mark(83); }
  });
  await assert.rejects(service.load(83), { code: 'google_oauth_legacy_closed' });
  G.removeHook('beforeFind', 'race_select');
  report.checks.push('NOT EXISTS inside the actual credential SELECT excludes a marker committed after the metadata check');
  await row(84); const cached = await service.load(84);
  G.addHook('beforeBulkUpdate', 'race_update', async () => { await mark(84); });
  await assert.rejects(service.saveRefresh(cached, { accessToken: 'FICTITIOUS_MUST_NOT_WRITE', expiresAt: new Date('2099-02-01') }), { code: 'google_oauth_legacy_closed' });
  G.removeHook('beforeBulkUpdate', 'race_update');
  assert.equal((await G.findByPk(84)).accessToken, 'FICTITIOUS_ACCESS_84');
  report.checks.push('Conditional SQL UPDATE refuses a marker committed immediately before execution; refresh response is not persisted');
  await row(85); const responseRow = await service.load(85); let sends = 0;
  await assert.rejects(service.request(responseRow, async () => { sends++; await mark(85); return { data: 'FICTITIOUS_RESPONSE' }; }), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(create().request(responseRow, async () => sends++), { code: 'google_oauth_legacy_closed' }); assert.equal(sends, 1);
  report.checks.push('Response after a concurrent marker is discarded; cached requests and new service instances cannot send again');
  await row(86); const changed = await service.load(86);
  await G.update({ googleUserId: 'different-subject' }, { where: { id: 86 } });
  await assert.rejects(service.request(changed, () => assert.fail('Changed identity cannot send')), { code: 'google_connection_changed' });
  await assert.rejects(service.saveRefresh(changed, { accessToken: 'FICTITIOUS_MUST_NOT_WRITE', expiresAt: new Date() }), { code: 'google_connection_changed' });
  report.checks.push('Reassignment of the same SQL ID excludes stale identity reads and writes');
  await qi.renameTable('GoogleOAuthBrokerBindings', 'OfflineHiddenOAuthBindings');
  await assert.rejects(create().load(86), { message: 'google_credentials_unavailable', code: 'google_credentials_unavailable' });
  await qi.renameTable('OfflineHiddenOAuthBindings', 'GoogleOAuthBrokerBindings');
  report.checks.push('Missing migration fails closed with a fixed error, with no fallback to tokens');
}).catch(() => { process.exitCode = 1; });
