'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkspaceHealth } = require('../../services/campaignWorkspaceHealth.service');
const now = new Date('2026-09-10T10:00:00Z');
const row = (id, extra = {}) => ({ campaign: { id, name: `Campaign ${id}`, assigned: true, paused: false, status: 'ACTIVE', destination: 'web', currency: 'EUR' },
  current: { spend: 200, leads: 10 }, previous: { spend: 100, leads: 10 }, ads: [], receptionReady: false, performance: 'insufficient',
  coverage: { updatedAt: null, latestMetricDate: null, recentSpend: 0, recentLeads: 0 }, ...extra });
const health = (rows, evidence = new Map()) => buildWorkspaceHealth({ rows, period: { end: '2026-09-09' } }, evidence, now);
test('health always exposes the six approved blocks in the same order', () => {
  assert.deepEqual(health([]).healthBlocks.map(block => block.id), ['no-leads', 'cost', 'delivery', 'reception', 'privacy', 'signals']);
});
test('uncertain adjustments stay in existing health blocks, even after a campaign pauses', () => {
  const result = health([row('1', { campaign: { ...row('1').campaign, paused: true } }), row('2')], new Map([
    ['1', { optimization: [{ id: 'run-1', action: 'pause_underperforming_ads', actionLabel: 'Pausa de anuncio' }] }],
    ['2', { optimization: [{ id: 'run-2', action: 'adjust_bids', actionLabel: 'Ajuste de puja' }] }],
  ]));
  assert.equal(result.healthBlocks.length, 6); assert.equal(result.affectedCount, 2);
  assert.equal(result.healthBlocks.find(block => block.id === 'delivery').tone, 'warning');
  assert.equal(result.healthBlocks.find(block => block.id === 'cost').tone, 'warning');
  assert.deepEqual(result.findings.map(finding => finding.optimizationRunId), ['run-1', 'run-2']);
  assert.ok(result.findings.every(finding => finding.technical && finding.source.includes('Optimiza')));
});
test('unknown checks and mere authorization never become green', () => {
  const result = health([row('1')], new Map([['1', { signals: { authorized: true } }]]));
  assert.ok(result.healthBlocks.every(block => block.tone === 'neutral'));
  assert.equal(result.healthBlocks.find(block => block.id === 'signals').status, 'Sin comprobar');
});
test('configured forms without a recent lead stay neutral and are not counted as affected campaigns', () => {
  const result = health([row('1'), row('2')], new Map(['1', '2'].map(id => [id, { reception: {
    checked: true, ready: false, configured: true, state: 'pending_confirmation',
  } }])));
  const block = result.healthBlocks.find(item => item.id === 'reception');
  assert.equal(block.tone, 'neutral'); assert.equal(block.status, 'Pendiente de recepción');
  assert.equal(result.affectedCount, 0); assert.equal(result.findings.length, 0);
  assert.ok(result.rows.every(item => item.receptionReady === false));
  assert.equal(block.checks.find(item => item.label === 'Pendientes de recibir').value, '2');
});
test('an expired reception check is missing coverage, not a proven outage', () => {
  const result = health([row('1')], new Map([['1', { reception: { checked: true, ready: false, state: 'unverified' } }]]));
  const block = result.healthBlocks.find(item => item.id === 'reception');
  assert.equal(block.status, 'Sin comprobar'); assert.equal(block.tone, 'neutral'); assert.equal(result.findings.length, 0);
});
test('a newer Meta permissions failure overrides receipts for native, web and mixed campaigns without deleting results', () => {
  const rows = ['native', 'web', 'mixed'].map((destination, index) => row(String(index), {
    receptionReady: true, campaign: { ...row(String(index)).campaign, provider: 'meta_ads', account_id: '20', destination,
      destinationCheck: { status: 'failed', error: 'workspace_meta_permissions_required' } },
  }));
  const evidence = new Map(rows.map(item => [item.campaign.id, { reception: { checked: true, ready: true, state: 'verified' } }]));
  const result = health(rows, evidence);
  assert.equal(result.healthBlocks.find(block => block.id === 'reception').tone, 'critical');
  assert.equal(result.findings.length, 1); assert.equal(result.affectedCount, 3);
  assert.ok(result.rows.every(item => item.receptionReady === false && item.current.leads === 10));
  assert.ok([...evidence.values()].every(item => item.reception.ready === true));
});
test('a pending or transiently failed Meta check cannot be green but is not evidence of an outage', () => {
  for (const check of [{ status: 'checking', error: null }, { status: 'failed', error: 'workspace_meta_unavailable' }]) {
    const item = row('1', { receptionReady: true, campaign: { ...row('1').campaign, provider: 'meta_ads', destinationCheck: check } });
    const result = health([item], new Map([['1', { reception: { checked: true, ready: true, state: 'verified' } }]]));
    assert.equal(result.rows[0].receptionReady, false);
    assert.equal(result.healthBlocks.find(block => block.id === 'reception').tone, 'neutral');
    assert.equal(result.findings.length, 0);
  }
});
test('shared technical failure is one finding affecting two campaigns', () => {
  const check = { privacy: { checked: true, ready: false, detail: 'Expired verification', key: 'intake:5' } };
  const result = health([row('1'), row('2')], new Map([['1', check], ['2', check]]));
  assert.equal(result.findings.length, 1); assert.equal(result.affectedCount, 2);
  assert.deepEqual(result.findings[0].campaignIds, ['1', '2']);
});
test('partial coverage remains neutral when checked campaigns are healthy', () => {
  const result = health([row('1'), row('2')], new Map([['1', { privacy: { checked: true, ready: true } }]]));
  const block = result.healthBlocks.find(block => block.id === 'privacy');
  assert.equal(block.status, 'Datos parciales'); assert.equal(block.tone, 'neutral');
});
test('a paused campaign is excluded from recent-performance alarms', () => {
  const result = health([row('1', { campaign: { ...row('1').campaign, paused: true },
    performance: 'attention', coverage: { updatedAt: now, latestMetricDate: '2026-09-09', recentSpend: 40, recentLeads: 0 } })]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.healthBlocks.find(block => block.id === 'no-leads').status, 'No aplica');
});
test('native-only campaigns do not require a web consent installation', () => {
  const result = health([row('1', { campaign: { ...row('1').campaign, destination: 'native' } })]);
  assert.equal(result.healthBlocks.find(block => block.id === 'privacy').status, 'No aplica');
});
test('fresh spend and no CRM leads produces an evidence-based finding, not an automatic mutation', () => {
  const result = health([row('1', { coverage: { updatedAt: now, latestMetricDate: '2026-09-09', recentSpend: 40, recentLeads: 0 } })]);
  assert.equal(result.findings[0].category, 'no-leads');
  assert.match(result.findings[0].detail, /40/);
  assert.equal(result.findings[0].technical, false);
});
test('stale delivery observations cannot label an account healthy', () => {
  const result = health([row('1', { ads: [{ lastSeenAt: '2026-08-01', rejected: false }] })]);
  assert.equal(result.healthBlocks.find(block => block.id === 'delivery').status, 'Sin comprobar');
});
test('active campaigns whose synchronized ads are all paused need delivery review, not an OK', () => {
  const result = health([row('1', { ads: [
    { lastSeenAt: now, status: 'PAUSED', active: false, rejected: false, title: 'First ad' },
    { lastSeenAt: now, status: 'ADSET_PAUSED', active: false, rejected: false, title: 'Second ad' },
  ] })]);
  const block = result.healthBlocks.find(item => item.id === 'delivery');
  assert.equal(block.tone, 'warning'); assert.equal(block.status, '1 campaña afectada');
  assert.equal(block.coverage, 'Comprobadas: 1 de 1 campañas');
  assert.equal(block.findings.length, 1);
  assert.match(block.findings[0].title, /no están activos/);
  assert.match(block.findings[0].detail, /2 anuncios/);
  assert.equal(result.affectedCount, 1);
});
test('one active ad and deliberately paused alternatives do not create a delivery incident', () => {
  const result = health([row('1', { ads: ['ENABLED', 'PAUSED', 'ARCHIVED'].map(status => ({
    lastSeenAt: now, status, rejected: false,
  })) })]);
  const block = result.healthBlocks.find(item => item.id === 'delivery');
  assert.equal(block.status, 'OK'); assert.equal(block.tone, 'good'); assert.equal(block.findings.length, 0);
});
test('unknown campaign status does not prove that its paused ads should be active', () => {
  const result = health([row('1', { campaign: { ...row('1').campaign, status: 'UNKNOWN' },
    ads: [{ lastSeenAt: now, status: 'PAUSED', rejected: false }] })]);
  const block = result.healthBlocks.find(item => item.id === 'delivery');
  assert.equal(block.status, 'Sin comprobar'); assert.equal(block.tone, 'neutral'); assert.equal(block.findings.length, 0);
});
test('fresh timestamps with unknown, missing or inconsistent delivery states never mean healthy', () => {
  for (const status of [undefined, 'UNKNOWN', 'UNSPECIFIED', 'UNRECOGNIZED_PROVIDER_STATE']) {
    const result = health([row('1', { ads: [{ lastSeenAt: now, status, active: false, rejected: false }] })]);
    const block = result.healthBlocks.find(item => item.id === 'delivery');
    assert.equal(block.status, 'Sin comprobar'); assert.equal(block.tone, 'neutral'); assert.equal(block.findings.length, 0);
  }
  const partial = health([row('1', { ads: ['ACTIVE', 'UNKNOWN'].map(status => ({ lastSeenAt: now, status, rejected: false })) })]);
  assert.notEqual(partial.healthBlocks.find(item => item.id === 'delivery').tone, 'good');
});
test('a fresh rejected ad remains visible even when another ad has an outdated state', () => {
  const result = health([row('1', { ads: [
    { lastSeenAt: now, status: 'DISAPPROVED', rejected: true, title: 'Rejected ad' },
    { lastSeenAt: '2026-08-01', status: 'ACTIVE', rejected: false, title: 'Outdated ad' },
  ] })]);
  const block = result.healthBlocks.find(item => item.id === 'delivery');
  assert.equal(block.tone, 'critical'); assert.equal(block.findings.length, 1);
  assert.match(block.findings[0].title, /rechazado/); assert.match(block.findings[0].detail, /Rejected ad/);
  assert.equal(block.coverage, 'Comprobadas: 0 de 1 campañas');
});
test('billing, review and processing states are actionable without being described as rejected ads', () => {
  for (const status of ['PENDING_REVIEW', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_BILLING_INFO']) {
    const result = health([row('1', { ads: [{ lastSeenAt: now, status, active: false, rejected: false }] })]);
    const block = result.healthBlocks.find(item => item.id === 'delivery');
    assert.equal(block.tone, 'warning'); assert.equal(block.findings.length, 1);
    assert.doesNotMatch(block.findings[0].title, /rechazado/);
  }
});
test('group delivery findings aggregate by campaign without adding blocks or hiding missing coverage', () => {
  const result = health([
    row('1', { ads: [{ lastSeenAt: now, status: 'PAUSED', rejected: false }] }),
    row('2', { ads: [{ lastSeenAt: now, status: 'IN_PROCESS', rejected: false }] }),
    row('3', { ads: [{ lastSeenAt: now, status: 'UNKNOWN', rejected: false }] }),
    row('4', { campaign: { ...row('4').campaign, paused: true }, ads: [{ lastSeenAt: now, status: 'PAUSED', rejected: false }] }),
  ]);
  const block = result.healthBlocks.find(item => item.id === 'delivery');
  assert.equal(result.healthBlocks.length, 6); assert.equal(block.status, '2 campañas afectadas');
  assert.equal(block.coverage, 'Comprobadas: 2 de 3 campañas');
  assert.deepEqual(block.campaignIds, ['1', '2']); assert.equal(result.affectedCount, 2);
});
test('future or invalid observations cannot make campaign health green or trigger a performance alarm', () => {
  for (const updatedAt of [null, 'invalid', new Date(+now + 1), new Date(+now - 36 * 3600000)]) {
    const result = health([row('1', { performance: 'attention',
      coverage: { updatedAt, latestMetricDate: '2026-09-09', recentSpend: 40, recentLeads: 0 },
      ads: [{ lastSeenAt: updatedAt, rejected: true, title: 'Unverified ad' }] })]);
    for (const id of ['no-leads', 'cost', 'delivery']) {
      const block = result.healthBlocks.find(item => item.id === id);
      assert.equal(block.tone, 'neutral'); assert.equal(block.status, id === 'cost' ? 'Sin comparativa' : 'Sin comprobar');
    }
    assert.equal(result.findings.length, 0); assert.equal(result.rows[0].current.leads, 10);
  }
});
test('a group with one future-dated campaign has partial coverage, not an all-clear', () => {
  const rows = [now, new Date(+now + 1)].map((updatedAt, i) => row(String(i), { performance: 'stable',
    coverage: { updatedAt, latestMetricDate: '2026-09-09', recentSpend: 40, recentLeads: 1 },
    ads: [{ lastSeenAt: updatedAt, status: 'ACTIVE', rejected: false }] }));
  const result = health(rows);
  for (const id of ['no-leads', 'cost', 'delivery']) {
    const block = result.healthBlocks.find(item => item.id === id);
    assert.equal(block.tone, 'neutral'); assert.equal(block.status, 'Datos parciales');
    assert.equal(block.coverage, 'Comprobadas: 1 de 2 campañas');
  }
});
