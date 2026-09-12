'use strict';
const { createHmac, timingSafeEqual } = require('node:crypto');
const { exact, fail } = require('./reader-protocol'); const { UUID } = require('./event');
const ACTIONS = ['auth.sign_in', 'auth.token_sign_in', 'auth.unlock', 'session.issued', 'session.renewed', 'session.revoked', 'session.expired', 'audit.records.read',
  ...require('./access-policy-contract').PERMISSION_ACTIONS];
function criteriaFor(v) {
  exact(v, ['from', 'to', 'action', 'userId']);
  const date = value => typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (!date(v.from) || !date(v.to) || v.to < v.from || Date.parse(v.to) - Date.parse(v.from) > 30 * 86400000
    || !(v.action === null || ACTIONS.includes(v.action)) || !(v.userId === null || typeof v.userId === 'string' && /^[1-9]\d{0,9}$/.test(v.userId))) fail();
  return { from: v.from, to: v.to, action: v.action, userId: v.userId };
}
const stamp = v => typeof v === 'string' && /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function cursorCodec(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail();
  const digest = raw => createHmac('sha256', key).update('audit-view-cursor-v1\0').update(raw).digest();
  return {
    seal(value) { const raw = Buffer.from(JSON.stringify(value)).toString('base64url'); return raw + '.' + digest(raw).toString('base64url'); },
    open(token, actorId, sessionRef, criteria, now) {
      if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) fail();
      const [raw, mac] = token.split('.'); if (!timingSafeEqual(Buffer.from(mac, 'base64url'), digest(raw))) fail();
      let v; try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { fail(); }
      exact(v, ['actorId', 'sessionRef', 'criteria', 'snapshot', 'expiresAt', 'lastAt', 'lastId']);
      if (v.actorId !== actorId || v.sessionRef !== sessionRef || !stamp(v.snapshot) || !stamp(v.lastAt)
        || typeof v.lastId !== 'string' || !UUID.test(v.lastId) || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= now
        || v.expiresAt > now + 600000 || JSON.stringify(criteriaFor(v.criteria)) !== JSON.stringify(criteria)) fail();
      return v;
    },
  };
}
module.exports = { criteriaFor, cursorCodec, ACTIONS, stamp };
