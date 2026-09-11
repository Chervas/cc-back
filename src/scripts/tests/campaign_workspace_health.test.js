'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkspaceHealth } = require('../../services/campaignWorkspaceHealth.service');
const now = new Date('2026-09-10T10:00:00Z');
const row = (id, extra = {}) => ({ campaign: { id, name: `Campaign ${id}`, assigned: true, paused: false, destination: 'web', currency: 'EUR' },
  current: { spend: 200, leads: 10 }, previous: { spend: 100, leads: 10 }, ads: [], receptionReady: false, performance: 'insufficient',
  coverage: { updatedAt: null, latestMetricDate: null, recentSpend: 0, recentLeads: 0 }, ...extra });
const health = (rows, evidence = new Map()) => buildWorkspaceHealth({ rows, period: { end: '2026-09-09' } }, evidence, now);
test('health always exposes the six approved blocks in the same order', () => {
  assert.deepEqual(health([]).healthBlocks.map(block => block.id), ['no-leads', 'cost', 'delivery', 'reception', 'privacy', 'signals']);
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
