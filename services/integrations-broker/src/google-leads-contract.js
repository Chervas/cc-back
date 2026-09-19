'use strict';
const { fail } = require('./errors');
const LOOKBACK_DAYS = 7, MAX_ROWS = 10000;
const CONTACT_FIELDS = new Set(['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE_NUMBER']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const day = time => new Date(time).toISOString().slice(0, 10);
function validateWindow(payload, now) {
  if (!date(payload.sinceDate) || !Number.isFinite(now)
    || payload.sinceDate < day(now - LOOKBACK_DAYS * 86400000) || payload.sinceDate > day(now)) fail('invalid_request');
}
function query(payload) {
  if (!date(payload.sinceDate)) fail('invalid_request');
  return 'SELECT customer.id, lead_form_submission_data.id, lead_form_submission_data.resource_name, '
    + 'lead_form_submission_data.asset, lead_form_submission_data.campaign, lead_form_submission_data.ad_group, '
    + 'lead_form_submission_data.ad_group_ad, lead_form_submission_data.gclid, '
    + 'lead_form_submission_data.submission_date_time, lead_form_submission_data.lead_form_submission_fields '
    + `FROM lead_form_submission_data WHERE lead_form_submission_data.submission_date_time >= '${payload.sinceDate}' `
    + `ORDER BY lead_form_submission_data.submission_date_time ASC, lead_form_submission_data.id ASC LIMIT ${MAX_ROWS + 1}`;
}
// Contact errors are per-lead, as in the existing CRM importer. A null list
// keeps that row explicitly invalid without transmitting arbitrary answers or
// making unrelated valid contacts disappear behind a page-level failure.
function contactFields(fields) {
  if (!Array.isArray(fields) || fields.length > 100) return null;
  const values = new Map();
  for (const field of fields) {
    if (!plain(field)) return null;
    if (!CONTACT_FIELDS.has(field.fieldType)) continue;
    const value = field.fieldValue;
    if (typeof value !== 'string' || value.length > 4096 || Buffer.byteLength(value) > 16384
      || /[\x00-\x1f]/.test(value) || values.has(field.fieldType) && values.get(field.fieldType) !== value.trim()) return null;
    values.set(field.fieldType, value.trim());
  }
  return [...values].map(([fieldType, fieldValue]) => ({ fieldType, fieldValue }));
}
function project(row, payload, account) {
  const data = row.leadFormSubmissionData, customerId = account.customerId;
  if (!plain(data) || typeof data.id !== 'string' || !data.id || data.id.length > 1024
    || /[\s\x00-\x1f]/.test(data.id) || data.resourceName !== `customers/${customerId}/leadFormSubmissionData/${data.id}`) fail('provider_failed');
  const resourceId = (value, collection) => {
    const prefix = `customers/${customerId}/${collection}/`;
    const id = typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : '';
    if (!/^[1-9][0-9]{0,31}$/.test(id)) fail('provider_failed'); return id;
  };
  resourceId(data.asset, 'assets'); resourceId(data.campaign, 'campaigns');
  const rawTime = data.submissionDateTime;
  if (typeof rawTime !== 'string' || !/^20\d\d-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(rawTime)
    || !date(rawTime.slice(0, 10)) || !Number.isFinite(Date.parse(rawTime)) || rawTime.slice(0, 10) < payload.sinceDate) fail('provider_failed');
  const adGroup = data.adGroup || null, adGroupAd = data.adGroupAd || null;
  const groupId = adGroup ? resourceId(adGroup, 'adGroups') : null;
  if (adGroupAd) {
    const prefix = `customers/${customerId}/adGroupAds/`;
    const ids = typeof adGroupAd === 'string' && adGroupAd.startsWith(prefix) ? adGroupAd.slice(prefix.length).split('~') : [];
    if (ids.length !== 2 || ids.some(id => !/^[1-9][0-9]{0,31}$/.test(id)) || groupId && groupId !== ids[0]) fail('provider_failed');
  }
  const gclid = typeof data.gclid === 'string' && data.gclid.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(data.gclid) ? data.gclid || null : null;
  return { customer: { id: customerId }, leadFormSubmissionData: { id: data.id, resourceName: data.resourceName,
    asset: data.asset, campaign: data.campaign, adGroup, adGroupAd, gclid, submissionDateTime: rawTime,
    leadFormSubmissionFields: contactFields(data.leadFormSubmissionFields) } };
}
module.exports = { LOOKBACK_DAYS, MAX_ROWS, date, validateWindow, query, project };
