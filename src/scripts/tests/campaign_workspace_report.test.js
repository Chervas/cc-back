'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reportPeriod, visibleCampaigns, leadCampaign, aggregateReport, freshObservation, withFreshGoogleCampaignStates } = require('../../services/campaignWorkspaceReport.service');
const { externalCampaignIdentityKey } = require('../../services/externalCampaignAssignmentTargets.service');

const now = new Date('2026-09-10T10:00:00Z');
const period = reportPeriod(7, now);
const identity = { provider: 'google_ads', customer_id: '1234567890', campaign_id: '100' };
const inventory = [{ ...identity, campaign_name: 'Primera visita', status: 'ENABLED' }];
const owner = { provider: 'google_ads', accountId: '1234567890', clinicId: 1, groupId: null };
const visible = (overrides = {}) => visibleCampaigns({ scope: { clinicIds: [1], groupId: null }, mappings: [owner], assignments: [], inventory, ...overrides });
const campaign = () => visible()[0];
const lead = (id, more = {}) => ({ id, clinica_id: 1, source: 'google_ads', channel: 'paid',
  google_ads_customer_id: '1234567890', google_ads_campaign_id: '100', created_at: '2026-09-08T10:00:00Z', ...more });
const fact = (more = {}) => ({ ...identity, date: '2026-09-09', spend: 10, segment: ['1', 'SEARCH', 'MOBILE'], providerConversions: 999, updatedAt: now, ...more });
const report = (more = {}) => aggregateReport({ campaigns: visible().map(c => ({ ...c, currency: 'EUR' })), period, now, ...more });

test('newer Google metric observations correct stale campaign status without granting reception or changing identity', () => {
  const original = { ...campaign(), status: 'PAUSED', paused: true, lastSeenAt: '2026-08-12T03:20:00Z', destinationComplete: false };
  const metric = { customerId: original.account_id, campaignId: original.campaign_id, campaignStatus: 'ENABLED', updated_at: now };
  const [updated] = withFreshGoogleCampaignStates([original], [metric], now);
  assert.equal(updated.status, 'ENABLED'); assert.equal(updated.paused, false);
  assert.equal(updated.id, original.id); assert.equal(updated.clinicId, original.clinicId);
  assert.equal(updated.destinationComplete, false); assert.equal(original.status, 'PAUSED');
});

test('old, future, foreign, conflicting or incomplete metric states never become a verified active campaign', () => {
  const original = { ...campaign(), status: 'PAUSED', paused: true, lastSeenAt: '2026-09-09T10:00:00Z' };
  const metric = { customerId: original.account_id, campaignId: original.campaign_id, campaignStatus: 'ENABLED', updated_at: now };
  for (const patch of [{ updated_at: '2026-09-08T00:00:00Z' }, { updated_at: new Date(+now + 1) }, { updated_at: null },
    { updated_at: original.lastSeenAt }, { customerId: '9999999999' }, { campaignId: '999' }, { campaignStatus: undefined }]) {
    assert.equal(withFreshGoogleCampaignStates([original], [{ ...metric, ...patch }], now)[0], original);
  }
  const [conflict] = withFreshGoogleCampaignStates([original], [metric, { ...metric, campaignStatus: 'PAUSED' }], now);
  assert.equal(conflict.status, 'UNKNOWN');
  const meta = { ...original, provider: 'meta_ads' };
  assert.equal(withFreshGoogleCampaignStates([meta], [metric], now)[0], meta);
});

test('period uses complete Madrid days with an equal previous window', () => {
  assert.equal(period.start, '2026-09-03'); assert.equal(period.end, '2026-09-09');
  assert.equal(period.previousStart, '2026-08-27'); assert.equal(period.previousEnd, '2026-09-02');
  assert.equal(period.from.toISOString(), '2026-08-26T22:00:00.000Z');
  assert.equal(period.until.toISOString(), '2026-09-09T22:00:00.000Z');
  assert.throws(() => reportPeriod(180, now), /invalid_period/);
});
test('period crosses DST by calendar day, not a fixed UTC midnight', () => {
  const spring = reportPeriod(7, new Date('2026-03-30T10:00:00Z'));
  assert.equal(spring.until.toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(spring.from.toISOString(), '2026-03-15T23:00:00.000Z');
  const autumn = reportPeriod(7, new Date('2026-10-26T10:00:00Z'));
  assert.equal(autumn.until.toISOString(), '2026-10-25T23:00:00.000Z');
});
test('exclusive account includes a new campaign without a second local campaign', () => {
  assert.equal(campaign().assigned, true); assert.equal(campaign().clinicId, 1);
});
test('Meta destination failure is projected without internal lease identifiers and cannot retain a complete proof', () => {
  const base = { provider: 'meta_ads', customer_id: '20', campaign_id: '30', campaign_name: 'First visit',
    destination_detection: { version: 1, source: 'workspace_meta_graph', kind: 'web', complete: true,
      checked_at: now.toISOString(), urls: ['https://clinic.example/'], check_status: 'failed',
      check_error: 'workspace_meta_permissions_required', check_id: 'private-run' } };
  const options = { mappings: [{ provider: 'meta_ads', accountId: '20', clinicId: 1, groupId: null }], inventory: [base] };
  const [value] = visible(options);
  assert.equal(value.destinationComplete, false); assert.equal(value.destination, 'web');
  assert.deepEqual(value.destinationCheck, { status: 'failed', error: 'workspace_meta_permissions_required' });
  assert.doesNotMatch(JSON.stringify(value), /private-run/);
  base.destination_detection.check_error = 'private-error';
  assert.equal(visible(options)[0].destinationCheck.error, 'workspace_meta_unavailable');
});
test('shared account without a reviewed assignment cannot leak into a clinic', () => {
  assert.deepEqual(visible({ mappings: [owner, { ...owner, clinicId: 2 }] }), []);
});
test('reviewed owner beats an exclusive account mapping and archival hides the campaign', () => {
  assert.deepEqual(visible({ assignments: [{ ...identity, clinica_id: 2, status: 'active' }] }), []);
  assert.deepEqual(visible({ assignments: [{ ...identity, clinica_id: 1, status: 'archived' }] }), []);
});
test('conflicting duplicate assignments fail closed', () => {
  assert.deepEqual(visible({ assignments: [{ ...identity, clinica_id: 1, status: 'active' }, { ...identity, clinica_id: 2, status: 'active' }] }), []);
});
test('full group can inspect unassigned campaigns without attributing them to every clinic', () => {
  const rows = visible({ scope: { clinicIds: [1, 2], groupId: 5 }, mappings: [{ ...owner, clinicId: null, groupId: 5 }] });
  assert.equal(rows[0].assigned, false); assert.equal(rows[0].clinicId, null);
  const result = report({ campaigns: rows });
  assert.equal(result.rows[0].current.leads, null); assert.equal(result.rows[0].current.appointments, null);
  assert.equal(result.current.leads, null); assert.equal(result.previous.leads, null);
});
test('clinic can see reviewed campaigns from its group account but not unassigned siblings', () => {
  const input = { scope: { clinicIds: [1], groupId: null, memberGroupIds: [5] }, mappings: [{ ...owner, clinicId: null, groupId: 5 }] };
  assert.deepEqual(visible(input), []);
  assert.equal(visible({ ...input, assignments: [{ ...identity, clinica_id: 1, status: 'active' }] }).length, 1);
});
test('canonical account identity defeats misleading UTMs', () => {
  assert.equal(leadCampaign(lead(1, { google_ads_customer_id: '999', utm_campaign: 'Primera visita' }), visible()), null);
  assert.equal(leadCampaign(lead(1, { google_ads_customer_id: '123-456-7890' }), visible()), campaign().id);
});
test('same campaign id in two accounts does not merge attribution', () => {
  const second = { ...campaign(), account_id: '999', customer_id: '999', id: externalCampaignIdentityKey({ ...identity, customer_id: '999' }) };
  assert.equal(leadCampaign(lead(1), [campaign(), second]), campaign().id);
  assert.equal(leadCampaign(lead(1, { google_ads_customer_id: null, utm_campaign: '100' }), [campaign(), second]), null);
});
test('scope rejects a lead belonging to another clinic', () => assert.equal(leadCampaign(lead(1, { clinica_id: 2 }), visible()), null));
test('paid web contacts with saved Google campaign IDs count without requiring UTMs or a second campaign', () => {
  for (const source of ['web', 'call_click']) {
    const contact = lead(1, { source, utm_source: null, utm_campaign: null });
    assert.equal(leadCampaign(contact, visible()), campaign().id);
    assert.equal(leadCampaign({ ...contact, google_ads_customer_id: '123-456-7890' }, visible()), campaign().id);
    const result = report({ leads: [contact, contact], appointments: [{ id_cita: 1, clinica_id: 1,
      lead_intake_id: 1, created_at: '2026-09-08T11:00:00Z', estado: 'pendiente' }] });
    assert.equal(result.current.leads, 1); assert.equal(result.current.appointments, 1);
    assert.equal(result.current.spend, null);
    assert.equal(result.rows[0].adAttribution.unattributed.current.leads, 1);
    assert.equal(require('../../services/leadAdvertisingIdentity.service').canonicalLeadAdvertisingIdentity(contact), null);
  }
});
test('saved web campaign IDs do not override clinic ownership, paid status, conflicts or malformed identity', () => {
  const contact = lead(1, { source: 'web', utm_source: 'google', utm_campaign: 'Primera visita' });
  for (const patch of [{ clinica_id: 2 }, { google_ads_customer_id: '9999999999' }, { google_ads_campaign_id: '101' },
    { google_ads_customer_id: '123a4567890' }, { google_ads_customer_id: '1234567890abc' },
    { google_ads_campaign_id: '100 OR 1=1' }, { google_ads_campaign_id: null }, { google_ads_customer_id: null },
    { channel: 'organic' }, { channel: 'unknown' }, { channel: null }, { advertising_identity_conflict: true }]) {
    assert.equal(leadCampaign({ ...contact, ...patch }, visible()), null, JSON.stringify(patch));
  }
  const shared = { ...campaign(), clinicId: null, assigned: false };
  assert.equal(leadCampaign(contact, [shared]), null);
});
test('spend deduplicates account snapshots but retains actual device segments', () => {
  const result = report({ facts: [fact(), fact(), fact({ segment: ['1', 'SEARCH', 'DESKTOP'], spend: 20 })] });
  assert.equal(result.current.spend, 30);
});
test('CRM leads do not come from platform conversions and count each intake once', () => {
  const result = report({ facts: [fact()], leads: [lead(1), lead(1), lead(2)] });
  assert.equal(result.current.leads, 2); assert.equal(result.current.providerConversions, 999);
  assert.equal(result.daily.reduce((total, day) => total + day.leads, 0), 2);
});
test('appointment status on a lead never fabricates a real appointment', () => {
  assert.equal(report({ leads: [lead(1, { status_lead: 'citado' })] }).current.appointments, 0);
});
test('linked appointments are dated by booking, deduplicated, clinic safe and exclude cancellations', () => {
  const appointment = { id_cita: 1, clinica_id: 1, lead_intake_id: 1, created_at: '2026-09-08T10:00:00Z', estado: 'pendiente' };
  const result = report({ leads: [lead(1, { created_at: '2026-01-01T12:00:00Z' })], appointments: [appointment, appointment,
    { ...appointment, id_cita: 2, estado: 'cancelada' }, { ...appointment, id_cita: 3, clinica_id: 2 },
    { ...appointment, id_cita: 4, es_provisional: true }] });
  assert.equal(result.current.leads, 0); assert.equal(result.current.appointments, 1);
});
test('missing spend and missing budget attribution remain null, never plausible zeroes', () => {
  const result = report(); assert.equal(result.current.spend, null); assert.equal(result.current.accepted, null);
  assert.equal(result.previous.accepted, null);
});
test('missing ad-level CRM identity stays in the unattributed remainder, not platform conversions', () => {
  const result = report({ leads: [lead(1)], ads: [{ ...fact(), id: '1', title: 'Anuncio', status: 'ENABLED' }] });
  assert.equal(result.rows[0].ads[0].current.leads, 0);
  assert.equal(result.rows[0].adAttribution.unattributed.current.leads, 1);
  assert.equal(result.rows[0].ads[0].currentCpl, null);
  assert.equal(result.rows[0].ads[0].lowestCost, false);
});
test('inventory-only ads remain visible without inventing spend or conversions', () => {
  const result = report({ ads: [{ ...identity, id: '1', title: 'Rechazado', status: 'DISAPPROVED', updatedAt: now, inventory: true }] });
  assert.equal(result.rows[0].ads.length, 1);
  assert.equal(result.rows[0].ads[0].rejected, true);
  assert.equal(result.rows[0].ads[0].current.spend, null);
  assert.equal(result.rows[0].ads[0].previous.spend, null);
});
test('inventory and metric rows merge once and retain the freshest ad status', () => {
  const result = report({ ads: [
    { ...identity, id: '1', title: 'Rechazado', status: 'DISAPPROVED', updatedAt: now, inventory: true },
    { ...fact(), id: '1', title: 'Anuncio', status: 'ENABLED', updatedAt: '2026-09-08', spend: 12 },
  ] });
  assert.equal(result.rows[0].ads.length, 1); assert.equal(result.rows[0].ads[0].current.spend, 12);
  assert.equal(result.rows[0].ads[0].rejected, true); assert.equal(result.rows[0].ads[0].active, false);
});
test('stale performance cannot be green despite enough leads', () => {
  const leads = Array.from({ length: 20 }, (_, i) => lead(i, { created_at: i < 10 ? '2026-09-01T10:00:00Z' : '2026-09-09T10:00:00Z' }));
  const result = report({ leads, facts: [fact({ updatedAt: '2026-08-01' }), fact({ date: '2026-09-01', updatedAt: '2026-08-01' })] });
  assert.equal(result.rows[0].performance, 'insufficient');
});
test('metric freshness is finite, not future-dated, and expires at 36 hours', () => {
  for (const value of [null, '', 'invalid', new Date(+now + 1), new Date(+now - 36 * 3600000)]) assert.equal(freshObservation(value, now), false);
  for (const value of [now, new Date(+now - 36 * 3600000 + 1)]) assert.equal(freshObservation(value, now), true);
});
test('backfilling an old metric date cannot refresh the latest campaign day', () => {
  const leads = Array.from({ length: 20 }, (_, i) => lead(i, { created_at: i < 10 ? '2026-09-01T10:00:00Z' : '2026-09-09T10:00:00Z' }));
  const facts = [fact({ updatedAt: '2026-09-08T00:00:00Z' }), fact({ date: '2026-09-01', updatedAt: now })];
  for (const order of [facts, [...facts].reverse()]) {
    const result = report({ leads, facts: order }).rows[0];
    assert.equal(result.coverage.latestMetricDate, period.end);
    assert.equal(result.coverage.updatedAt, '2026-09-08T00:00:00Z');
    assert.equal(result.performance, 'insufficient'); assert.equal(result.current.spend, 10);
  }
});
test('latest-day segments keep the oldest observation, and missing or future dates cannot be hidden', () => {
  const stale = '2026-09-08T00:00:00Z';
  for (const updatedAt of [stale, null, 'invalid', new Date(+now + 1)]) {
    const facts = [fact(), fact({ segment: ['1', 'SEARCH', 'DESKTOP'], updatedAt })];
    for (const order of [facts, [...facts].reverse()]) {
      const row = report({ facts: order }).rows[0];
      assert.equal(row.coverage.updatedAt, updatedAt === stale ? stale : null);
      assert.equal(freshObservation(row.coverage.updatedAt, now), false); assert.equal(row.current.spend, 20);
    }
  }
});
test('a valid newer metric day supersedes missing observations of older dates', () => {
  const facts = [fact({ date: '2026-09-08', updatedAt: null }), fact()];
  for (const order of [facts, [...facts].reverse()]) {
    const row = report({ facts: order }).rows[0];
    assert.equal(row.coverage.updatedAt, now); assert.equal(row.coverage.latestMetricDate, period.end);
    assert.equal(freshObservation(row.coverage.updatedAt, now), true);
  }
});
test('different or unknown currencies never produce a misleading combined investment', () => {
  const second = { ...campaign(), currency: 'USD', id: externalCampaignIdentityKey({ ...identity, campaign_id: '101' }), campaign_id: '101' };
  const result = report({ campaigns: [{ ...campaign(), currency: 'EUR' }, second], facts: [fact(), fact({ campaign_id: '101' })] });
  assert.equal(result.currency, null); assert.equal(result.current.spend, null);
  assert.equal(result.rows[0].current.spend, 10);
});
