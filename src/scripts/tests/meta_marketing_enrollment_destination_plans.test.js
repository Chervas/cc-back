'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalize } = require('../../services/metaMarketingEnrollmentDestinations.service');

const refs = [
  { kind: 'ad_account', assetRef: 'meta-ad_account:301' },
  { kind: 'ad_account', assetRef: 'meta-ad_account:302' },
  { kind: 'facebook_page', assetRef: 'meta-facebook_page:401' },
];
const rows = [
  { clinicId: 71, assignments: { facebook_page: null, ad_account: 'meta-ad_account:302' } },
  { clinicId: 59, assignments: { ad_account: 'meta-ad_account:301', facebook_page: 'meta-facebook_page:401' } },
];
const plan = { version: 1, rows };

test('destinations preserve explicit empties and multiple approved assets of one kind in canonical order', () => {
  assert.equal(JSON.stringify(normalize(plan, [59, 71], refs)), JSON.stringify({
    version: 1,
    rows: [
      rows[1],
      { clinicId: 71, assignments: { ad_account: 'meta-ad_account:302', facebook_page: null } },
    ],
  }));
});

test('group destinations reject incomplete, duplicate and out-of-scope cells', () => {
  for (const mutate of [
    value => { value.version = 2; },
    value => { value.rows.pop(); },
    value => { value.rows[0].clinicId = 59; },
    value => { value.rows[0].clinicId = 79; },
    value => { delete value.rows[0].assignments.facebook_page; },
    value => { value.rows[0].assignments.facebook_page = false; },
    value => { value.rows[0].assignments.ad_account = 'meta-facebook_page:401'; },
    value => { value.rows[0].assignments.ad_account = 'meta-ad_account:303'; },
    value => { value.rows[0].assignments.instagram_business = null; },
    value => { value.rows[0].additionalId = 59; },
  ]) {
    const value = structuredClone(plan);
    mutate(value);
    assert.throws(() => normalize(value, [59, 71], refs), { code: 'meta_enrollment_invalid', httpStatus: 400 });
  }
});
