'use strict';

const assert = require('node:assert/strict');
const {
  resolveLeadMarketingOrigin,
  resolveLeadContactMethod,
  buildMarketingOriginWhere,
  buildLeadAttributionView,
} = require('../../lib/lead-attribution-view');

assert.equal(resolveLeadMarketingOrigin({ source: 'web', gclid: 'gclid-real' }), 'google_ads');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', google_ads_campaign_id: '21323256887' }), 'google_ads');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', fbclid: 'fbclid-real' }), 'meta_ads');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', utm_source: 'google', utm_medium: 'organic' }), 'seo');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', channel: 'organic' }), 'web');

assert.equal(resolveLeadContactMethod({ source: 'web', source_detail: 'tel_modal' }), 'web_phone');
assert.equal(resolveLeadContactMethod({ source: 'web', source_detail: 'chatbot' }), 'web_chat');
assert.equal(resolveLeadContactMethod({ source: 'web', source_detail: 'web_form' }), 'web_form');
assert.equal(resolveLeadContactMethod({ source: 'meta_ads', source_detail: 'leadgen_form:123' }), 'platform_form');

const Op = { or: Symbol('or'), ne: Symbol('ne') };
const googleWhere = buildMarketingOriginWhere('google_ads', Op);
assert.ok(Array.isArray(googleWhere[Op.or]));
assert.ok(googleWhere[Op.or].some((condition) => condition.gclid));
assert.deepEqual(buildMarketingOriginWhere('web', Op), {
  source: 'web',
  gclid: null,
  gbraid: null,
  wbraid: null,
  google_ads_customer_id: null,
  google_ads_campaign_id: null,
  fbclid: null,
  ttclid: null,
});

assert.deepEqual(
  buildLeadAttributionView(
    {
      id: 7193,
      source: 'web',
      source_detail: 'tel_modal',
      gclid: 'gclid-real',
      google_ads_customer_id: '1851215478',
      google_ads_campaign_id: '21323256887',
      campana_id: null,
    },
    {
      provider: 'google_ads',
      customer_id: '1851215478',
      campaign_id: '21323256887',
      campaign_name: 'PROPDENTAL Pmax local SANT MARTI',
    }
  ),
  {
    id: 7193,
    source: 'web',
    source_detail: 'tel_modal',
    gclid: 'gclid-real',
    google_ads_customer_id: '1851215478',
    google_ads_campaign_id: '21323256887',
    campana_id: null,
    contact_method: 'web_phone',
    marketing_origin: 'google_ads',
    marketing_campaign: {
      provider: 'google_ads',
      customer_id: '1851215478',
      external_id: '21323256887',
      name: 'PROPDENTAL Pmax local SANT MARTI',
      resolution: 'external_inventory',
    },
  }
);

console.log('lead_attribution_view.test.js OK');
