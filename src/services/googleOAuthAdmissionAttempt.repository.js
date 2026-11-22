'use strict';

const C = require('./googleOAuthAdmissionAttempt.contract');
const plain = value => value?.get ? value.get({ plain: true }) : value;
const closed = error => C.problem(error?.status === 401 ? 'google_oauth_admission_session_required'
  : error?.status === 403 ? 'google_oauth_admission_forbidden' : error?.status === 409 ? 'google_oauth_admission_attempt_conflict'
    : error?.code === 'google_oauth_admission_attempt_invalid' ? error.code : 'google_oauth_admission_attempt_unavailable',
error?.status === 401 ? 401 : error?.status === 403 ? 403 : error?.status === 409 ? 409
  : error?.code === 'google_oauth_admission_attempt_invalid' ? 400 : 503);

/** Local intent storage only. No default models, provider, credentials or authorization fallback. */
function createGoogleOAuthAdmissionAttempts({ model, sequelize, authorize, publicationModel, now = () => new Date() } = {}) {
  if (!model || typeof model.findByPk !== 'function' || typeof model.create !== 'function'
    || typeof sequelize?.transaction !== 'function' || typeof authorize !== 'function' || typeof now !== 'function'
    || publicationModel !== undefined && typeof publicationModel?.findByPk !== 'function') {
    throw C.problem('google_oauth_admission_attempt_unavailable', 503);
  }
  const options = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, logging: false });
  const stored = value => {
    try { return C.record(plain(value)); }
    catch { throw C.problem('google_oauth_admission_attempt_unavailable', 503); }
  };
  async function check(context, transaction) {
    C.assertLive(context, now());
    if (await authorize(context, { transaction }) !== true) throw C.problem('google_oauth_admission_forbidden', 403);
    C.assertLive(context, now());
  }
  async function transaction(input, work) {
    try {
      // Clone/freeze before the first await, including the clinic set. The
      // supplied authorizer must independently verify this original authority.
      const context = C.input(input);
      return await sequelize.transaction(async sql => {
        if (!sql?.LOCK?.UPDATE || sql.finished) throw C.problem('google_oauth_admission_attempt_unavailable', 503);
        await check(context, sql);
        let result = await work(context, sql);
        await check(context, sql);
        // A slow final authority check cannot release a still-prepared DTO
        // after the local attempt deadline. Expiry is itself durable history.
        if (result.state === 'prepared' && Date.parse(result.expiresAt) <= C.clock(now())) {
          const { instance, row } = await load(context, sql);
          result = { ...result, ...(await save(instance, row, C.expire(row, now()), sql)) };
        }
        return result;
      });
    } catch (error) { throw closed(error); }
  }
  async function load(context, sql) {
    const instance = await model.findByPk(context.attemptId, options(sql));
    if (!instance) throw C.problem('google_oauth_admission_attempt_conflict', 409);
    return { instance, row: C.assertBound(stored(instance), context) };
  }
  async function save(instance, previous, next, sql) {
    if (next.changed) {
      await instance.update({ state: next.row.state, revision: next.row.revision,
        updated_at: next.row.updated_at, completed_at: next.row.completed_at }, options(sql));
      const readback = stored(instance);
      if (readback.binding_digest !== previous.binding_digest || JSON.stringify(readback) !== JSON.stringify(next.row)) {
        throw C.problem('google_oauth_admission_attempt_unavailable', 503);
      }
    }
    return C.dto(next.row);
  }
  return {
    prepare: input => transaction(input, async (context, sql) => {
      const existing = await model.findByPk(context.attemptId, options(sql));
      if (existing) {
        const row = C.assertBound(stored(existing), context), next = C.expire(row, now());
        return { ...(await save(existing, row, next, sql)), replayed: true };
      }
      const row = C.prepare(context, now());
      const created = await model.create(row, { transaction: sql, logging: false });
      if (JSON.stringify(stored(created)) !== JSON.stringify(row)) throw C.problem('google_oauth_admission_attempt_unavailable', 503);
      return { ...C.dto(row), replayed: false };
    }),
    read: input => transaction(input, async (context, sql) => {
      const { instance, row } = await load(context, sql);
      return save(instance, row, C.expire(row, now()), sql);
    }),
    cancel(input, command) {
      if (!C.exact(command, ['expectedRevision'])) return Promise.reject(C.problem());
      return transaction(input, async (context, sql) => {
        const { instance, row } = await load(context, sql);
        // Both paths lock the attempt before looking up its publication.
        // A committed authorization must survive dismissal of its mapper.
        const published = await publicationModel?.findByPk(context.attemptId, {
          ...options(sql), attributes: ['attempt_id'],
        });
        if (published) throw C.problem('google_oauth_admission_attempt_conflict', 409);
        const next = C.cancel(row, command.expectedRevision, now());
        return { ...(await save(instance, row, next, sql)), replayed: next.replayed };
      });
    },
  };
}

module.exports = { createGoogleOAuthAdmissionAttempts };
