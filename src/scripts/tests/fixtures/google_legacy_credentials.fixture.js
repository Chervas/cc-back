'use strict';
const assert = require('node:assert/strict'); const { Op } = require('sequelize');
const { createGoogleLegacyCredentials, safe } = require('../../../services/googleLegacyCredentials.service');
function credentialsFixture() {
  const state = { markers: [], rows: new Map(), loads: 0, updates: 0, tokenReads: 0, provider: [], logs: [], failMetadata: false };
  const blocked = row => state.markers.some(b => Number(b.google_connection_id) === row?.id || b.google_user_id === row?.googleUserId);
  function add(id = 81, googleUserId = 'fictitious-subject') {
    const row = { id, googleUserId, expiresAt: new Date('2099-01-01') };
    for (const key of ['accessToken', 'refreshToken']) Object.defineProperty(row, key, { configurable: true,
      get: () => { state.tokenReads++; return 'FICTITIOUS_' + key + '_' + id; } });
    state.rows.set(id, row); return row;
  }
  const connectionModel = {
    findByPk: async (id, options) => {
      assert.deepEqual(Array.from(options.attributes), ['id', 'googleUserId']);
      if (state.failMetadata) throw Object.assign(Error('FICTITIOUS_SQL_SECRET'), { code: 'FICTITIOUS_SQL_CODE' });
      const row = state.rows.get(id); return row && { id, googleUserId: row.googleUserId };
    },
    findOne: async options => {
      assert.match(options.where[Op.and].val, /NOT EXISTS/); await state.beforeLoad?.();
      const row = state.rows.get(options.where.id);
      if (!row || row.googleUserId !== options.where.googleUserId || blocked(row)) return null;
      state.loads++; return row;
    },
    update: async (values, options) => {
      assert.match(options.where[Op.and].val, /NOT EXISTS/); await state.beforeUpdate?.();
      const row = state.rows.get(options.where.id);
      if (!row || row.googleUserId !== options.where.googleUserId || blocked(row)) return [0];
      state.updates++; Object.defineProperty(row, 'accessToken', { value: values.accessToken, configurable: true }); row.expiresAt = values.expiresAt;
      return [1];
    },
  };
  const bindingModel = { findOne: async options => state.markers.find(row => (options.where[Op.or] || [options.where])
    .some(clause => Object.entries(clause).every(([k, v]) => row[k] === v))) || null };
  const create = () => ({ ...createGoogleLegacyCredentials({ connectionModel, bindingModel }), safe });
  add();
  return { state, add, create, credentials: create(), mark: (id = 81, subject = 'fictitious-subject') => state.markers.push({ google_connection_id: id, google_user_id: subject }) };
}
module.exports = { credentialsFixture };
