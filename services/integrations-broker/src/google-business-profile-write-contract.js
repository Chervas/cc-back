'use strict';
const { createHash } = require('node:crypto');
const { schema, ref } = require('./contracts');
const { canonical } = require('./canonical');
const { fail } = require('./errors');
const reads = require('./google-business-profile-contract');
const PROVIDER = reads.PROVIDER;
const COHORT = 'google-business-profile-write-v1';
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/business.manage']);
const OPERATIONS = Object.freeze(Object.fromEntries([
  ['replyUpdate', 'review.reply.update'], ['replyDelete', 'review.reply.delete'],
  ['photo', 'photo.publish'], ['hours', 'special_hours.update'], ['status', 'mutation.status'],
].map(([key, suffix]) => [key, reads.PREFIX + suffix + '.v1'])));
const CATEGORIES = Object.freeze(['ADDITIONAL', 'COVER', 'PROFILE', 'LOGO', 'EXTERIOR', 'INTERIOR', 'PRODUCT', 'AT_WORK', 'TEAMS']);
const PUBLIC_ORIGIN = 'https://media.clinicaclick.com';
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const day = { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' };
const clock = { type: ['string', 'null'], pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' };
const reviewId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,256}$' };
const bindingSchema = object({ locations: { type: 'array', minItems: 1, maxItems: 1000, items: object({
  assetRef: ref, tenantRef: { type: 'string', pattern: '^clinic:[1-9][0-9]{0,9}$' },
  allowReviewReplies: { type: 'boolean' }, allowPhotos: { type: 'boolean' }, allowSpecialHours: { type: 'boolean' },
  publicMediaClinicIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true,
    items: { type: 'integer', minimum: 1, maximum: 2147483647 } },
}, ['assetRef', 'tenantRef', 'allowReviewReplies', 'allowPhotos', 'allowSpecialHours']) } });
const bindingCheck = schema({ value: bindingSchema });
const checks = {
  replyUpdate: schema({ operationId: uuid, reviewId, comment: { type: 'string', minLength: 1, maxLength: 4096 } }),
  replyDelete: schema({ operationId: uuid, reviewId }),
  photo: schema({ operationId: uuid, sourceUrl: { type: 'string', maxLength: 2048 }, category: { enum: CATEGORIES },
    description: { type: ['string', 'null'], maxLength: 1024 } }),
  hours: schema({ operationId: uuid, periods: { type: 'array', maxItems: 80, items: object({
    kind: { enum: ['open', 'closed'] }, startDate: day, endDate: day, openTime: clock, closeTime: clock,
  }) } }),
  status: schema({ operationId: uuid }),
};
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function date(value) {
  const at = Date.parse(value);
  if (!Number.isFinite(at) || value < '0001-01-01' || new Date(at).toISOString().slice(0, 10) !== value) fail('invalid_request');
  return at;
}
const googleDate = value => { const [year, month, day] = value.split('-').map(Number); return { year, month, day }; };
const googleTime = value => { const [hours, minutes] = value.split(':').map(Number); return { hours, minutes }; };
function expandPeriods(periods) {
  const result = [], days = new Map();
  for (const period of periods) {
    const start = date(period.startDate), end = date(period.endDate);
    if (end < start || (end - start) / 86400000 + result.length >= 730
      || period.kind === 'closed' && (period.openTime !== null || period.closeTime !== null)
      || period.kind === 'open' && (!period.openTime || !period.closeTime || period.closeTime <= period.openTime)) fail('invalid_request');
    for (let at = start; at <= end; at += 86400000) {
      const prior = days.get(at) || [];
      if (prior.some(p => p.kind === 'closed' || period.kind === 'closed'
        || period.openTime < p.closeTime && period.closeTime > p.openTime)) fail('invalid_request');
      prior.push(period); days.set(at, prior);
      const d = googleDate(new Date(at).toISOString().slice(0, 10));
      result.push({ startDate: d, endDate: d, ...(period.kind === 'closed' ? { closed: true }
        : { openTime: googleTime(period.openTime), closeTime: googleTime(period.closeTime) }) });
    }
  }
  return result;
}
function validate(kind, payload) {
  if (!Object.hasOwn(checks, kind)) fail('operation_denied'); checks[kind](payload);
  if (kind === 'replyUpdate' && (!payload.comment.trim() || payload.comment.length > 4096)) fail('invalid_request');
  if (kind === 'photo' && payload.category === 'COVER' && payload.description !== null) fail('invalid_request');
  if (kind === 'hours') expandPeriods(payload.periods);
  return payload;
}
function validateBinding(binding) {
  bindingCheck({ value: binding.googleBusinessProfileWrites });
  if (binding.provider !== PROVIDER) fail('invalid_request');
  const seen = new Set();
  for (const row of binding.googleBusinessProfileWrites.locations) {
    reads.asset(row.assetRef);
    const key = row.assetRef + ':' + row.tenantRef;
    if (seen.has(key) || !row.allowReviewReplies && !row.allowPhotos && !row.allowSpecialHours
      || row.publicMediaClinicIds && !row.allowPhotos) fail('invalid_request'); seen.add(key);
  }
}
function resource(binding, assetRef, tenantRef, kind, payload) {
  const target = reads.asset(assetRef);
  const policy = binding.googleBusinessProfileWrites?.locations.find(row => row.assetRef === assetRef && row.tenantRef === tenantRef);
  if (!policy || ['replyUpdate', 'replyDelete'].includes(kind) && !policy.allowReviewReplies
    || kind === 'photo' && !policy.allowPhotos || kind === 'hours' && !policy.allowSpecialHours) fail('scope_denied');
  if (kind === 'photo') {
    // Only our public marketing objects for this clinic. No signed URL, caller
    // host, clinical path, redirects, binary upload or broker-side download.
    const prefix = `${PUBLIC_ORIGIN}/marketing/clinic-`;
    const match = payload.sourceUrl.startsWith(prefix) && /^([1-9][0-9]{0,9})\/[0-9]{4}\/(?:0[1-9]|1[0-2])\/(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:jpg|jpeg|png|webp)$/.exec(payload.sourceUrl.slice(prefix.length));
    // A shared location may publish the requesting clinic's public asset, but
    // only after that clinic is explicitly admitted in the location policy.
    if (!match || ![Number(tenantRef.slice(7)), ...(policy.publicMediaClinicIds || [])].includes(Number(match[1]))) fail('scope_denied');
  }
  return { ...target, policy };
}
function scopeDigest(binding, target, principal) {
  return hash({ connectionRef: binding.connectionRef, secretArn: binding.secretArn, clientSecretArn: binding.clientSecretArn,
    subject: binding.oauth?.subject || null, target, principal: { id: principal.id, keyId: principal.keyId, publicKey: principal.publicKey } });
}
function lockKeys(target, kind, payload) {
  // Location IDs are global, even if two connections/account IDs can manage it.
  const base = `locations/${target.locationId}/`;
  if (kind === 'hours') return [base + 'specialHours'];
  if (kind !== 'photo') return [base + 'reviews/' + payload.reviewId];
  return [base + 'media/' + hash(payload.sourceUrl),
    ...(['COVER', 'PROFILE', 'LOGO'].includes(payload.category) ? [base + 'media-slot/' + (payload.category === 'LOGO' ? 'PROFILE' : payload.category)] : [])];
}
const text = (v, limit = 8192) => typeof v === 'string' && Buffer.byteLength(v) <= limit;
function project(kind, raw, target, payload = {}) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || raw.error) fail('provider_failed');
  if (kind === 'replyDelete') { if (Object.keys(raw).length) fail('provider_failed'); return {}; }
  if (kind === 'replyUpdate') {
    if (!text(raw.comment, 16384) || !raw.comment.trim() || raw.comment.length > 4096
      || raw.updateTime !== undefined && (!text(raw.updateTime, 64) || !Number.isFinite(Date.parse(raw.updateTime)))) fail('provider_failed');
    return { comment: raw.comment, ...(raw.updateTime !== undefined ? { updateTime: raw.updateTime } : {}) };
  }
  if (kind === 'photo') {
    const value = reads.project(reads.PREFIX + 'media.read.v1', { mediaItems: [raw] }, target).mediaItems[0];
    if (!value.name || value.mediaFormat !== undefined && value.mediaFormat !== 'PHOTO'
      || value.locationAssociation?.category !== undefined && !CATEGORIES.includes(value.locationAssociation.category)) fail('provider_failed');
    for (const key of ['googleUrl', 'thumbnailUrl', 'sourceUrl']) if (value[key] !== undefined) {
      let url; try { url = new URL(value[key]); } catch { fail('provider_failed'); }
      if (url.protocol !== 'https:' || url.username || url.password) fail('provider_failed');
    }
    // PROFILE/LOGO may return a Google sourceUrl, /media/profile, epoch time and
    // no dimensions. Keep the original public object in the caller's journal.
    return value;
  }
  if (raw.name !== target.location) fail('scope_denied');
  if (raw.specialHours !== undefined && (!raw.specialHours || Object.getPrototypeOf(raw.specialHours) !== Object.prototype)) fail('provider_failed');
  const periods = raw.specialHours?.specialHourPeriods ?? [];
  if (!Array.isArray(periods) || periods.length > 730 || !periods.length && payload.periods?.length
    || Buffer.byteLength(JSON.stringify(periods)) > 196608) fail('provider_failed');
  const dayValue = value => {
    if (!value || !['year', 'month', 'day'].every(key => Number.isInteger(value[key]))) fail('provider_failed');
    const iso = `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
    if (value.year < 1 || value.year > 9999 || !Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) fail('provider_failed');
    return Date.parse(iso);
  };
  const clockValue = (value, close) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provider_failed');
    const { hours = 0, minutes = 0, seconds = 0, nanos = 0 } = value;
    if (![hours, minutes, seconds, nanos].every(Number.isInteger) || hours < 0 || hours > (close ? 24 : 23)
      || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59 || nanos < 0 || nanos > 999999999
      || hours === 24 && (minutes || seconds || nanos)) fail('provider_failed');
    return hours * 3600000 + minutes * 60000 + seconds * 1000 + nanos / 1000000;
  };
  for (const period of periods) {
    if (!period || typeof period !== 'object' || Array.isArray(period)
      || period.closed !== undefined && typeof period.closed !== 'boolean') fail('provider_failed');
    const start = dayValue(period.startDate), end = period.endDate === undefined ? start : dayValue(period.endDate);
    if (end < start || end - start > 86400000) fail('provider_failed');
    if (period.closed !== true && end + clockValue(period.closeTime, true) <= start + clockValue(period.openTime, false)) fail('provider_failed');
  }
  // Reuse the closed read projection in bounded slices (read pages cap at 400).
  const projected = [];
  for (let i = 0; i < periods.length; i += 400) {
    projected.push(...reads.project(reads.PREFIX + 'details.read.v1', {
      name: raw.name, specialHours: { specialHourPeriods: periods.slice(i, i + 400) },
    }, target).specialHours.specialHourPeriods);
  }
  return { name: raw.name, specialHours: { specialHourPeriods: projected } };
}
module.exports = { PROVIDER, COHORT, SCOPES, OPERATIONS, CATEGORIES, PUBLIC_ORIGIN, bindingSchema,
  validate, validateBinding, expandPeriods, resource, scopeDigest, lockKeys, project, hash };
