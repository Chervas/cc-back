'use strict';
const { Op, literal } = require('sequelize');

const CODES = new Set(['google_oauth_legacy_closed', 'google_connection_missing',
  'google_connection_changed', 'google_credentials_unavailable']);
const fail = code => { throw Object.assign(Error(code), { code, httpStatus: 409 }); };
const safe = error => CODES.has(error?.code) ? error.code : 'google_credentials_unavailable';
function idOf(value) {
  if (!/^[1-9]\d{0,9}$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) fail('google_connection_missing');
  return Number(value);
}
// Static SQL only. Apply the exclusion in the very statement that selects or
// updates credentials, so a marker committed after the metadata check wins.
function exclusion(table) {
  return literal(['GoogleOAuthBrokerBindings', 'SearchConsoleBrokerBindings'].map(registry =>
    'NOT EXISTS (SELECT 1 FROM `' + registry + '` AS `legacy_guard` WHERE '
    + '`legacy_guard`.`google_connection_id` = `' + table + '`.`id` OR '
    + '`legacy_guard`.`google_user_id` = `' + table + '`.`googleUserId`)').join(' AND '));
}
function createGoogleLegacyCredentials({ connectionModel, bindingModel, searchConsoleModel }) {
  const captured = connection => {
    if (typeof connection?.googleUserId !== 'string' || !connection.googleUserId) fail('google_connection_changed');
    return check(connection.id, connection.googleUserId);
  };
  async function check(connectionId, expectedSubject) {
    const id = idOf(connectionId);
    const row = await connectionModel.findByPk(id, { attributes: ['id', 'googleUserId'], raw: true, logging: false });
    // An independent marker also closes a deleted/recreated connection ID.
    for (const registry of [bindingModel, searchConsoleModel]) {
      if (await registry.findOne({ attributes: ['google_user_id'], where: { [Op.or]: [
        { google_connection_id: id }, ...(typeof row?.googleUserId === 'string' ? [{ google_user_id: row.googleUserId }] : []),
      ] }, raw: true, logging: false })) fail('google_oauth_legacy_closed');
    }
    if (!row) fail('google_connection_missing');
    if (typeof row.googleUserId !== 'string' || !row.googleUserId || row.googleUserId === 'unknown'
      || Number(row.id) !== id || expectedSubject !== undefined && row.googleUserId !== expectedSubject) fail('google_connection_changed');
    return row;
  }
  const guarded = fn => async (...args) => {
    try { return await fn(...args); } catch (error) { fail(safe(error)); }
  };
  const service = {
    assert: guarded(async connection => { await captured(connection); }),
    load: guarded(async connectionId => {
      const metadata = await check(connectionId);
      const connection = await connectionModel.findOne({ attributes: ['id', 'googleUserId', 'accessToken', 'refreshToken', 'expiresAt'],
        where: { id: metadata.id, googleUserId: metadata.googleUserId, [Op.and]: exclusion('GoogleConnection') }, logging: false });
      if (!connection) { await check(metadata.id, metadata.googleUserId); fail('google_connection_changed'); }
      await check(connection.id, connection.googleUserId);
      return connection;
    }),
    saveRefresh: guarded(async (connection, values) => {
      await captured(connection);
      if (typeof values?.accessToken !== 'string' || !values.accessToken || !(values.expiresAt instanceof Date)
        || !Number.isFinite(values.expiresAt.getTime())) fail('google_credentials_unavailable');
      const [updated] = await connectionModel.update({ accessToken: values.accessToken, expiresAt: values.expiresAt }, {
        where: { id: idOf(connection.id), googleUserId: connection.googleUserId, [Op.and]: exclusion('GoogleConnections') }, logging: false,
      });
      if (updated !== 1) { await check(connection.id, connection.googleUserId); fail('google_connection_changed'); }
      await check(connection.id, connection.googleUserId);
    }),
    request: guarded(async (connection, send) => {
      await captured(connection);
      const response = await send();
      await check(connection.id, connection.googleUserId);
      return response;
    }),
  };
  return service;
}
let singleton;
function instance() {
  const models = require('../../models');
  return singleton ||= createGoogleLegacyCredentials({ connectionModel: models.GoogleConnection, bindingModel: models.GoogleOAuthBrokerBinding,
    searchConsoleModel: models.SearchConsoleBrokerBinding });
}
module.exports = { createGoogleLegacyCredentials, safe,
  ...Object.fromEntries(['assert', 'load', 'saveRefresh', 'request'].map(name => [name, (...args) => instance()[name](...args)])),
};
