'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildGoogleDestinationDetections,
  diagnoseGoogleCampaignMeasurement,
  normalizeDestinationUrl,
} = require('../../lib/googleAdsCampaignMeasurementDiagnosis');

function main() {
  const backendRoot = path.resolve(__dirname, '../../..');
  const modelSource = fs.readFileSync(path.join(backendRoot, 'models/googleadsinsightsdaily.js'), 'utf8');
  const syncSource = fs.readFileSync(path.join(backendRoot, 'src/jobs/sync.jobs.js'), 'utf8');
  const reportSource = fs.readFileSync(path.join(backendRoot, 'src/controllers/marketingReports.controller.js'), 'utf8');
  const migrationSource = fs.readFileSync(
    path.join(backendRoot, 'migrations/20260717134000-add-google-ads-all-conversions.js'),
    'utf8'
  );
  assert.match(modelSource, /allConversions/);
  assert.match(syncSource, /metrics\.all_conversions/);
  assert.match(syncSource, /allConversions: Number/);
  assert.match(reportSource, /providerAllConversions: row\.allConversions/);
  assert.match(reportSource, /otherClinicCrmLeads/);
  assert.match(reportSource, /crmLeads,/);
  assert.match(syncSource, /options\.customerIds/);
  assert.match(migrationSource, /GoogleAdsInsightsDaily/);

  assert.equal(
    normalizeDestinationUrl('https://www.propdental.es/hospitalet/{ignore}?sem&gclid=secret'),
    'https://www.propdental.es/hospitalet/'
  );

  const detections = buildGoogleDestinationDetections({
    checkedAt: new Date('2026-07-17T10:00:00.000Z'),
    campaignRows: [{
      campaign: {
        id: '21319497065',
        name: 'PROPDENTAL Pmax Local HOSPITALET',
        advertisingChannelType: 'PERFORMANCE_MAX',
        urlExpansionOptOut: false,
        finalUrlSuffix: 'sem&cc_gads_customer_id=1851215478&cc_gads_campaign_id={campaignid}',
      },
    }],
    landingRows: [
      {
        campaign: { id: '21319497065' },
        landingPageView: {
          unexpandedFinalUrl: 'https://www.propdental.es/clinicas-dentales/clinica-dental-hospitalet/{ignore}?sem',
        },
        metrics: { clicks: '18' },
      },
      {
        campaign: { id: '21319497065' },
        landingPageView: {
          unexpandedFinalUrl: 'https://www.propdental.es/implantes-dentales/{ignore}?sem',
        },
        metrics: { clicks: '3' },
      },
    ],
  });
  const pmax = detections.get('21319497065');
  assert.equal(pmax.status, 'observed');
  assert.equal(pmax.primary_url, 'https://www.propdental.es/clinicas-dentales/clinica-dental-hospitalet/');
  assert.deepEqual(pmax.domains, ['propdental.es']);
  assert.equal(pmax.url_expansion_enabled, true);
  assert.equal(pmax.expanded_beyond_primary, true);
  assert.equal(pmax.clinicaclick_attribution_suffix, true);

  const covered = diagnoseGoogleCampaignMeasurement({
    spend: 46.61,
    providerConversions: 0,
    destinationDetection: pmax,
    measuredDomains: ['propdental.es'],
  });
  assert.equal(covered.state, 'covered_no_conversions');
  assert.equal(covered.severity, 'info');
  assert.equal(covered.alert, undefined);
  assert.match(covered.notice, /Destino cubierto/);
  assert.equal(
    covered.primary_destination_url,
    'https://www.propdental.es/clinicas-dentales/clinica-dental-hospitalet/'
  );
  assert.equal(covered.observed_destination_count, 2);
  assert.equal(covered.recommendations[0].code, 'pmax_url_expansion_broad');

  const secondaryConversions = diagnoseGoogleCampaignMeasurement({
    spend: 46.61,
    providerConversions: 0,
    providerAllConversions: 3,
    destinationDetection: pmax,
    measuredDomains: ['propdental.es'],
  });
  assert.equal(secondaryConversions.state, 'secondary_conversions_only');
  assert.equal(secondaryConversions.severity, 'info');
  assert.equal(secondaryConversions.alert, undefined);
  assert.match(secondaryConversions.notice, /Todas las conversiones/);

  const missingRuntime = diagnoseGoogleCampaignMeasurement({
    spend: 30,
    providerConversions: 0,
    destinationDetection: pmax,
    measuredDomains: ['otra-web.example'],
  });
  assert.equal(missingRuntime.state, 'destination_not_covered');
  assert.equal(missingRuntime.severity, 'critical');
  assert.deepEqual(missingRuntime.uncovered_domains, ['propdental.es']);

  const importGap = diagnoseGoogleCampaignMeasurement({
    spend: 30,
    providerConversions: 0,
    scopedCrmLeads: 2,
    destinationDetection: pmax,
    measuredDomains: ['propdental.es'],
  });
  assert.equal(importGap.state, 'provider_conversion_gap');
  assert.match(importGap.alert, /ClinicaClick ha atribuido 2 leads/);

  const crossClinic = diagnoseGoogleCampaignMeasurement({
    spend: 30,
    providerConversions: 0,
    otherClinicCrmLeads: 1,
    destinationDetection: pmax,
    measuredDomains: ['propdental.es'],
  });
  assert.equal(crossClinic.state, 'cross_clinic_attribution');
  assert.match(crossClinic.alert, /otra clínica del grupo/);

  console.log('✅ google_ads_campaign_measurement_diagnosis.test.js passed');
}

main();
