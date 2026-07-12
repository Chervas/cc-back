'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  extractGoogleLeadIdentity,
  normalizeGoogleCampaignId,
  resolveGoogleAdsCampaignId,
  resolveGoogleLeadRoute,
  selectUnambiguousAccount,
} = require('../../lib/google-lead-routing');
const { matchClinicByPageUrl } = require('../../lib/intake-page-clinic');

function accountModel(rows, calls = []) {
  return {
    async findAll(options) {
      calls.push(options);
      return rows;
    },
  };
}

function assignmentModel(row, calls = []) {
  return {
    async findOne(options) {
      calls.push(options);
      return row;
    },
  };
}

async function run() {
  assert.equal(normalizeGoogleCampaignId('21316904358'), '21316904358');
  assert.equal(normalizeGoogleCampaignId('21316x904358'), null, 'Campaign ids must be digits only');
  assert.equal(normalizeGoogleCampaignId('1'.repeat(33)), null, 'Campaign ids must fit persisted fields');
  assert.equal(resolveGoogleAdsCampaignId({
    ccCandidates: ['21316904358'],
    canonicalCandidates: ['11111111111'],
    gadCandidates: ['22222222222'],
    urls: ['https://www.propdental.es/?cc_gads_campaign_id=33333333333&gad_campaignid=44444444444'],
  }), '21316904358', 'Explicit cc_gads attribution has highest priority');
  assert.equal(resolveGoogleAdsCampaignId({
    canonicalCandidates: ['11111111111'],
    urls: ['https://www.propdental.es/?cc_gads_campaign_id=21316904358&gad_campaignid=44444444444'],
  }), '21316904358', 'A cc_gads URL suffix must win over legacy/canonical fallbacks');
  assert.equal(resolveGoogleAdsCampaignId({
    urls: ['https://www.propdental.es/?gad_campaignid=21316904358'],
  }), '21316904358', 'Google gad_campaignid must be recovered from the landing URL');
  assert.equal(resolveGoogleAdsCampaignId({
    urls: ['https://www.propdental.es/?gad_campaignid=21316904358x'],
  }), null, 'Malformed query values must not become routing keys');

  assert.deepEqual(extractGoogleLeadIdentity({
    account_id: '599-235-6722',
    external_campaign_id: 21193562335,
  }), {
    customerId: '5992356722',
    campaignId: '21193562335',
  });
  assert.deepEqual(extractGoogleLeadIdentity({
    payload: { customerId: '185-121-5478', campaign_id: '21794207214' },
  }), {
    customerId: '1851215478',
    campaignId: '21794207214',
  });
  assert.deepEqual(extractGoogleLeadIdentity({
    customer_id: '185-121-5478',
    page_url: 'https://www.propdental.es/?gclid=click&gad_campaignid=21316904358',
  }), {
    customerId: '1851215478',
    campaignId: '21316904358',
  });
  assert.deepEqual(extractGoogleLeadIdentity({
    attribution: {
      cc_gads_customer_id: '599-235-6722',
      google_ads_campaign_id: '23925478530',
    },
  }), {
    customerId: '5992356722',
    campaignId: '23925478530',
  });
  assert.deepEqual(extractGoogleLeadIdentity({
    google_ads_customer_id: '185-121-5478',
    cc_gads_campaign_id: '21316904358',
  }), {
    customerId: '1851215478',
    campaignId: '21316904358',
  });

  const groupAccount = {
    id: 11,
    assignmentScope: 'group',
    grupoClinicaId: 5,
    clinicaId: 36,
    customerId: '1851215478',
  };
  const groupCalls = [];
  const groupRoute = await resolveGoogleLeadRoute({
    body: { customer_id: '185-121-5478' },
    accountModel: accountModel([groupAccount], groupCalls),
    assignmentModel: assignmentModel(null),
  });
  assert.equal(groupCalls[0].where.customerId, '1851215478');
  assert.equal(groupRoute.matched, true);
  assert.equal(groupRoute.groupId, 5);
  assert.equal(groupRoute.clinicId, null, 'A representative clinic on a group account must be ignored');
  assert.equal(groupRoute.preserveGroupScope, true);

  const clinics = [
    {
      id_clinica: 36,
      estado_clinica: 1,
      url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-francia/',
    },
    {
      id_clinica: 56,
      estado_clinica: 1,
      url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-sant-marti/',
    },
  ];
  assert.equal(matchClinicByPageUrl(
    'https://www.propdental.es/clinicas-dentales/clinica-dental-sant-marti/?gclid=qa',
    clinics,
  )?.id_clinica, 56, 'Page URL must refine a Google group scope without using its representative clinic');

  const clinicRoute = await resolveGoogleLeadRoute({
    body: { customer_id: '8494168589' },
    accountModel: accountModel([{
      id: 18,
      assignmentScope: 'clinic',
      clinicaId: 62,
      grupoClinicaId: null,
      customerId: '8494168589',
    }]),
    assignmentModel: assignmentModel(null),
  });
  assert.equal(clinicRoute.clinicId, 62);
  assert.equal(clinicRoute.groupId, null);
  assert.equal(clinicRoute.matchSource, 'google_ads_customer');
  assert.equal(clinicRoute.preserveGroupScope, false);

  const assignmentCalls = [];
  const campaignRoute = await resolveGoogleLeadRoute({
    body: {
      account_id: '599-235-6722',
      external_campaign_id: '21193562335',
    },
    accountModel: accountModel([{
      id: 12,
      assignmentScope: 'group',
      clinicaId: 58,
      grupoClinicaId: 5,
      customerId: '5992356722',
    }]),
    assignmentModel: assignmentModel({
      provider: 'google_ads',
      customer_id: '5992356722',
      campaign_id: '21193562335',
      grupo_clinica_id: 5,
      clinica_id: 56,
      status: 'active',
      match_kind: 'alias',
    }, assignmentCalls),
  });
  assert.deepEqual(assignmentCalls[0].where, {
    provider: 'google_ads',
    customer_id: '5992356722',
    campaign_id: '21193562335',
    status: 'active',
  });
  assert.equal(campaignRoute.clinicId, 56);
  assert.equal(campaignRoute.groupId, 5);
  assert.equal(campaignRoute.matchSource, 'google_ads_campaign');
  assert.equal(campaignRoute.matchValue, '5992356722:21193562335');
  assert.equal(campaignRoute.preserveGroupScope, false);

  const urlCampaignCalls = [];
  const urlCampaignRoute = await resolveGoogleLeadRoute({
    body: {
      customer_id: '185-121-5478',
      page_url: 'https://www.propdental.es/?gclid=click&gad_campaignid=21316904358',
    },
    accountModel: accountModel([groupAccount]),
    assignmentModel: assignmentModel({
      provider: 'google_ads',
      customer_id: '1851215478',
      campaign_id: '21316904358',
      grupo_clinica_id: 5,
      clinica_id: 56,
      status: 'active',
    }, urlCampaignCalls),
  });
  assert.equal(urlCampaignCalls[0].where.campaign_id, '21316904358');
  assert.equal(urlCampaignRoute.clinicId, 56);

  const wrongGroupRoute = await resolveGoogleLeadRoute({
    body: { customer_id: '5992356722', campaign_id: '21193562335' },
    accountModel: accountModel([{ ...groupAccount, customerId: '5992356722' }]),
    assignmentModel: assignmentModel({
      customer_id: '5992356722',
      campaign_id: '21193562335',
      grupo_clinica_id: 99,
      clinica_id: 56,
      status: 'active',
    }),
  });
  assert.equal(wrongGroupRoute.clinicId, null);
  assert.equal(wrongGroupRoute.groupId, 5);
  assert.equal(wrongGroupRoute.preserveGroupScope, true);

  assert.equal(selectUnambiguousAccount([
    { id: 18, assignmentScope: 'clinic', clinicaId: 62 },
    { id: 19, assignmentScope: 'group', grupoClinicaId: 28, clinicaId: 1 },
  ]), null, 'A customer mapped to different scopes is ambiguous without scope context');
  assert.equal(selectUnambiguousAccount([
    { id: 18, assignmentScope: 'clinic', clinicaId: 62 },
    { id: 19, assignmentScope: 'group', grupoClinicaId: 28, clinicaId: 1 },
  ], { currentGroupId: 28 })?.id, 19);

  const controllerSource = fs.readFileSync(
    path.join(__dirname, '../../controllers/intake.controller.js'),
    'utf8',
  );
  const googleResolutionIndex = controllerSource.indexOf('await resolveGoogleLeadRoute({');
  const pageResolutionIndex = controllerSource.indexOf(
    'await resolveClinicByPageUrlWithinGroup(',
    googleResolutionIndex,
  );
  const fallbackIndex = controllerSource.indexOf(
    '&& !preserveGoogleGroupScope',
    pageResolutionIndex,
  );
  assert.ok(googleResolutionIndex > 0 && pageResolutionIndex > googleResolutionIndex,
    'Google group scope must be known before page URL routing');
  assert.ok(fallbackIndex > pageResolutionIndex,
    'Implicit group fallback must not consume unresolved Google group leads');
  assert.match(controllerSource, /clinic_match_source:\s*clinicMatchSource\s*\|\|\s*null/,
    'The attribution audit must retain the resolved clinic routing source');
  assert.match(controllerSource, /clinic_match_value:\s*clinicMatchValue\s*\|\|\s*null/,
    'The attribution audit must retain the resolved clinic routing value');
  assert.match(controllerSource, /const googleAdsCampaignIdValue = resolveGoogleAdsCampaignId\(/,
    'Lead intake must persist the strict campaign fallback');

  const webEventsSource = fs.readFileSync(
    path.join(__dirname, '../../services/webEvents.service.js'),
    'utf8',
  );
  assert.match(webEventsSource, /const googleIdentity = extractGoogleLeadIdentity\(/,
    'Web events must use the same strict campaign fallback');

  console.log('google_lead_routing.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
