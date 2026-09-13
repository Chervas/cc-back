'use strict';
const { schema } = require('./contracts'); const { fail } = require('./errors');
const PROVIDER = 'google_business_profile'; const PREFIX = 'google.business_profile.';
const METRICS = Object.freeze(['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'BUSINESS_DIRECTION_REQUESTS',
  'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_CONVERSATIONS', 'BUSINESS_BOOKINGS']);
const READ_MASK = 'name,title,storeCode,phoneNumbers,categories,storefrontAddress,latlng,websiteUri,metadata,openInfo,regularHours,specialHours,moreHours,serviceArea,serviceItems,labels';
const OPERATIONS = Object.freeze(['metrics.read.v1', 'reviews.read.v1', 'posts.read.v1', 'media.read.v1', 'details.read.v1', 'verification.read.v1'].map(v => PREFIX + v));
const date = v => typeof v === 'string' && /^20\d\d-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const empty = schema({}); const paged = schema({ pageToken: { type: ['string', 'null'], maxLength: 4096 } });
const ranged = schema({ startDate: { type: 'string' }, endDate: { type: 'string' } });
function validate(operation, payload) {
  if (!OPERATIONS.includes(operation)) fail('operation_denied');
  if (operation === PREFIX + 'metrics.read.v1') {
    ranged(payload);
    if (!date(payload.startDate) || !date(payload.endDate) || payload.endDate < payload.startDate
      || Date.parse(payload.endDate) - Date.parse(payload.startDate) > 365 * 86400000) fail('invalid_request');
  } else if (['reviews', 'posts', 'media'].some(v => operation === PREFIX + v + '.read.v1')) paged(payload); else empty(payload);
  return payload;
}
function asset(value) {
  const match = typeof value === 'string' && /^gbp:([1-9]\d{0,29}):([1-9]\d{0,29})$/.exec(value);
  if (!match) fail('scope_denied');
  return { accountId: match[1], locationId: match[2], parent: `accounts/${match[1]}/locations/${match[2]}`, location: `locations/${match[2]}` };
}
// Shapes select documented fields; unknown provider fields never become raw_payload.
const S = 'string', N = 'number', B = 'boolean';
const googleDate = { year: N, month: N, day: N }; const time = { hours: N, minutes: N, seconds: N, nanos: N };
const category = { name: S, displayName: S };
const period = { openDay: S, openTime: time, closeDay: S, closeTime: time };
const money = { currencyCode: S, units: S, nanos: N };
const media = { name: S, mediaFormat: S, googleUrl: S, thumbnailUrl: S, sourceUrl: S, description: S, createTime: S,
  locationAssociation: { category: S }, dimensions: { widthPixels: N, heightPixels: N }, insights: { viewCount: S },
  attribution: { profileName: S, profilePhotoUrl: S, takedownUrl: S } };
const SHAPES = {
  reviews: { reviews: [{ name: S, reviewId: S, reviewer: { displayName: S, profilePhotoUrl: S, isAnonymous: B },
    starRating: S, comment: S, createTime: S, updateTime: S, reviewState: S, reviewReply: { comment: S, updateTime: S } }], averageRating: N, totalReviewCount: N },
  posts: { localPosts: [{ name: S, languageCode: S, summary: S, topicType: S, state: S, visibilityState: S, createTime: S, updateTime: S,
    callToAction: { actionType: S, url: S }, media: [media], event: { title: S, schedule: { startDate: googleDate, startTime: time, endDate: googleDate, endTime: time } },
    offer: { couponCode: S, redeemOnlineUrl: S, termsConditions: S }, searchUrl: S }] },
  media: { mediaItems: [media] },
  details: { name: S, title: S, storeCode: S, phoneNumbers: { primaryPhone: S, additionalPhones: [S] },
    categories: { primaryCategory: category, additionalCategories: [category] },
    storefrontAddress: { regionCode: S, languageCode: S, postalCode: S, sortingCode: S, administrativeArea: S, locality: S, sublocality: S, addressLines: [S], recipients: [S], organization: S },
    latlng: { latitude: N, longitude: N }, websiteUri: S,
    metadata: { hasVoiceOfMerchant: B, placeId: S, mapsUri: S, newReviewUri: S, duplicateLocation: S, canDelete: B, canOperateLocalPost: B, canModifyServiceList: B,
      hasGoogleUpdated: B, hasPendingEdits: B, canHaveFoodMenus: B, verificationState: S, suspensionReasons: [S] },
    openInfo: { status: S, canReopen: B, openingDate: googleDate }, regularHours: { periods: [period] },
    specialHours: { specialHourPeriods: [{ startDate: googleDate, endDate: googleDate, openTime: time, closeTime: time, closed: B }] },
    moreHours: [{ hoursTypeId: S, periods: [period] }], serviceArea: { businessType: S, regionCode: S, places: { placeInfos: [{ placeName: S, placeId: S }] } },
    serviceItems: [{ structuredServiceItem: { serviceTypeId: S, description: S }, freeFormServiceItem: { category: S, label: { displayName: S, languageCode: S, description: S } }, price: money }], labels: [S] },
  verification: { hasVoiceOfMerchant: B, hasBusinessAuthority: B, waitForVoiceOfMerchant: {}, verify: { hasPendingVerification: B }, resolveOwnershipConflict: {}, complyWithGuidelines: { recommendationReason: S } },
  metrics: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: S, dailySubEntityType: { dayOfWeek: S, timeOfDay: time },
    timeSeries: { datedValues: [{ date: googleDate, value: S }] } }] }] },
};
function select(value, shape) {
  if (value === null) return null;
  if (typeof shape === 'string') {
    if (typeof value !== shape || shape === N && !Number.isFinite(value) || shape === S && Buffer.byteLength(value) > 8192) fail('provider_failed');
    return value;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length > 400) fail('provider_failed'); return value.map(v => select(v, shape[0]));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provider_failed');
  return Object.fromEntries(Object.keys(shape).filter(k => Object.hasOwn(value, k)).map(k => [k, select(value[k], shape[k])]));
}
function project(operation, raw, resource, payload = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error) fail('provider_failed');
  const family = operation.slice(PREFIX.length).split('.')[0]; const value = select(raw, SHAPES[family]);
  for (const [key, child] of [['reviews', 'reviews'], ['localPosts', 'localPosts'], ['mediaItems', 'media']]) {
    const rows = value[key]; if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > (key === 'reviews' ? 50 : 100)) fail('provider_failed');
    for (const item of rows) {
      if (!item || !item.name && !(key === 'reviews' && typeof item.reviewId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(item.reviewId))) fail('provider_failed');
      // Preserve the legacy cache key when Google supplies reviewId without name.
      if (!item.name && key === 'reviews') continue;
      if (!item.name.startsWith(`${resource.parent}/${child}/`) || !/^[A-Za-z0-9_-]{1,256}$/.test(item.name.slice(`${resource.parent}/${child}/`.length))) fail('scope_denied');
    }
  }
  if (value.totalReviewCount !== undefined && (!Number.isSafeInteger(value.totalReviewCount) || value.totalReviewCount < 0)) fail('provider_failed');
  if (family === 'details' && value.name !== resource.location) fail('scope_denied');
  if (family === 'metrics') for (const group of value.multiDailyMetricTimeSeries || []) for (const series of group.dailyMetricTimeSeries || []) {
    if (!METRICS.includes(series.dailyMetric)) fail('provider_failed');
    for (const point of series.timeSeries?.datedValues || []) {
      if (!point?.date || !Number.isInteger(point.date.year) || !Number.isInteger(point.date.month) || !Number.isInteger(point.date.day)) fail('provider_failed');
      const day = `${point.date.year}-${String(point.date.month).padStart(2, '0')}-${String(point.date.day).padStart(2, '0')}`;
      if (!date(day) || payload.startDate && day < payload.startDate || payload.endDate && day > payload.endDate) fail('provider_failed');
      if (point.value !== undefined && (typeof point.value !== 'string' || !/^\d{1,19}$/.test(point.value)
        || BigInt(point.value) > BigInt(Number.MAX_SAFE_INTEGER))) fail('provider_failed');
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 786432) fail('provider_failed');
  return value;
}
module.exports = { PROVIDER, PREFIX, OPERATIONS, METRICS, READ_MASK, validate, asset, project };
