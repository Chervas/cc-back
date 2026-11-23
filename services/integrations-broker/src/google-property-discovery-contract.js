'use strict';
const { createHash } = require('node:crypto');
const { schema } = require('./contracts'); const { fail } = require('./errors');
const validate = schema({});
const SC_OPERATION = 'google.search_console.discovery.read.v1';
const GA_OPERATION = 'google.analytics.discovery.read.v1';
const GA_ADMISSION_PROOF = 'google.analytics.admission.verify.v1';
const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const account = value => typeof value === 'string' && /^accounts\/[1-9]\d{0,19}$/.test(value);
function projectSC(raw, siteUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error || raw.siteUrl !== siteUrl
    || !['siteOwner', 'siteFullUser', 'siteRestrictedUser'].includes(raw.permissionLevel)) fail('provider_failed');
  return { siteUrl, permissionLevel: raw.permissionLevel };
}
function projectGA(raw, propertyName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error || raw.name !== propertyName
    || typeof raw.displayName !== 'string' || !raw.displayName.trim() || raw.displayName.length > 100 || /[\x00-\x1f\x7f]/.test(raw.displayName)
    || !account(raw.account) || typeof raw.parent !== 'string' || !/^(accounts|properties)\/[1-9]\d{0,19}$/.test(raw.parent)
    || !['PROPERTY_TYPE_ORDINARY', 'PROPERTY_TYPE_SUBPROPERTY', 'PROPERTY_TYPE_ROLLUP'].includes(raw.propertyType)
    || raw.deleteTime !== undefined || raw.expireTime !== undefined) fail('provider_failed');
  return { name: propertyName, displayName: raw.displayName, propertyType: raw.propertyType, parent: raw.parent, account: raw.account };
}
function projectFirstGA(raw, propertyName) {
  const property = projectGA(raw, propertyName);
  const displayName = property.displayName.replace(/[\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim();
  return { ...property, displayName:displayName || propertyName };
}
function firstAnalyticsSubjectDigest(subject) {
  if (typeof subject !== 'string' || subject === 'unknown' || !/^[A-Za-z0-9._-]{1,128}$/.test(subject)) fail('scope_denied');
  return createHash('sha256').update(JSON.stringify(['clinicaclick/google-first-analytics-subject/1',subject])).digest('hex');
}
module.exports = { validate, SC_OPERATION, GA_OPERATION, GA_ADMISSION_PROOF, GA_SCOPE, projectSC, projectGA, projectFirstGA, firstAnalyticsSubjectDigest };
