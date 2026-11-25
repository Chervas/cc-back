'use strict';

const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const {
  resolveLeadMarketingOrigin,
  resolveLeadContactMethod,
  buildMarketingOriginWhere,
  buildLeadCreatedDescription,
  buildLeadAttributionView,
} = require('../../lib/lead-attribution-view');

assert.equal(resolveLeadMarketingOrigin({ source: 'web', gclid: 'gclid-real' }), 'google_ads');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', google_ads_campaign_id: '21323256887' }), 'google_ads');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', fbclid: 'fbclid-real' }), 'meta_ads');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', utm_source: 'google', utm_medium: 'organic' }), 'seo');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', channel: 'organic' }), 'web');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', utm_medium: ' Email ', utm_source: ' boletin ' }), 'email');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', utm_medium: ' EMAIL ', utm_source: ' Envios_Masivos ' }), 'bulk_email');
assert.equal(resolveLeadMarketingOrigin({ source: 'whatsapp', utm_medium: 'email', utm_source: 'envios_masivos' }), 'bulk_email');
assert.equal(resolveLeadMarketingOrigin({ source: 'call_click', utm_medium: 'email' }), 'email');
assert.equal(resolveLeadMarketingOrigin({ source: 'whatsapp', utm_source: 'envios_masivos' }), 'whatsapp');
assert.equal(resolveLeadMarketingOrigin({ source: 'web', utm_medium: 'email', gclid: 'confirmed-ad-click' }), 'google_ads');
assert.equal(resolveLeadMarketingOrigin({ source: 'meta_ads', utm_medium: 'email' }), 'meta_ads');

assert.equal(resolveLeadContactMethod({ source: 'web', source_detail: 'tel_modal' }), 'web_phone');
assert.equal(resolveLeadContactMethod({ source: 'web', source_detail: 'chatbot' }), 'web_chat');
assert.equal(resolveLeadContactMethod({ source: 'web', source_detail: 'web_form' }), 'web_form');
assert.equal(resolveLeadContactMethod({ source: 'meta_ads', source_detail: 'leadgen_form:123' }), 'platform_form');
assert.equal(resolveLeadContactMethod({ source: 'whatsapp', utm_medium: 'email' }), 'whatsapp');

const googleWhere = buildMarketingOriginWhere('google_ads', Op);
assert.ok(Array.isArray(googleWhere[Op.or]));
assert.ok(googleWhere[Op.or].some((condition) => condition.gclid));
const webWhere = buildMarketingOriginWhere('web', Op);
assert.equal(webWhere[Op.and].length, 1);
assert.deepEqual(Object.fromEntries(Object.entries(webWhere)), {
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

const createdDescription = buildLeadCreatedDescription({
  source: 'web',
  source_detail: 'tel_modal',
  gclid: 'gclid-real',
  telefono: '+34600000000',
  page_url: 'https://www.propdental.es/pedir-hora/',
});
assert.match(createdDescription, /^Contacto: Teléfono de la web$/m);
assert.match(createdDescription, /^Origen: Google Ads$/m);
assert.match(createdDescription, /^Página de entrada: https:\/\/www\.propdental\.es\/pedir-hora\/$/m);
assert.doesNotMatch(createdDescription, /Origen: web por teléfono/);
assert.match(buildLeadCreatedDescription({ source: 'whatsapp', utm_source: 'envios_masivos', utm_medium: 'email' }),
  /^Contacto: WhatsApp\nOrigen: Envío masivo$/);

console.log('lead_attribution_view.test.js OK');
