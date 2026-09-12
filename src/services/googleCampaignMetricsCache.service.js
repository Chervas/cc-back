'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { daysBetween } = require('./googleAdCache.service');
const { formatDateLocal } = require('../lib/availability-calendar');
const { buildClinicMatcher } = require('../lib/clinicAttribution');

const API_VERSION = 'v24';
const MAX_ROWS = 100000;
const TIMEOUT_MS = 90000;
const RESOURCE_FIELDS = ['customer.id', 'campaign.id', 'campaign.name', 'campaign.status',
  'campaign.serving_status', 'campaign.primary_status', 'campaign.primary_status_reasons'];
const METRICS = ['impressions', 'clicks', 'cost_micros', 'conversions', 'conversions_value',
  'all_conversions', 'all_conversions_value', 'interactions'];
const OWNER_FIELDS = ['id', 'customerId', 'googleConnectionId', 'assignmentScope', 'clinicaId',
  'grupoClinicaId', 'isActive', 'loginCustomerId', 'managerCustomerId'];
const fail = suffix => { throw Object.assign(new Error(`google_campaign_cache_${suffix}`), { code: `google_campaign_cache_${suffix}` }); };
const id = value => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, size) => typeof value === 'string' ? value.slice(0, size) : null;
const camel = value => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

function owner(account) {
  const result = Object.fromEntries(OWNER_FIELDS.map(key => [key, account[key] ?? null]));
  result.customerId = String(result.customerId || '').replace(/-/g, '');
  if (!/^\d{10}$/.test(result.customerId) || !Number.isSafeInteger(result.id) || result.id < 1
    || !Number.isSafeInteger(result.googleConnectionId) || !result.isActive
    || !['clinic', 'group'].includes(result.assignmentScope)) fail('invalid_account');
  if (result.assignmentScope === 'group' ? !Number.isSafeInteger(result.grupoClinicaId) : !Number.isSafeInteger(result.clinicaId)) fail('invalid_account');
  result.isActive = true;
  return result;
}

function metric(value, integer) {
  if (value === undefined || value === null) return 0; // Selected protobuf zero fields may be omitted.
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value))) fail('invalid_metric');
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER || integer && !Number.isSafeInteger(result)) fail('invalid_metric');
  return result;
}

function campaign(row, customerId) {
  if (row.customer?.id !== customerId || !id(row.campaign?.id)) fail('scope_mismatch');
  const value = row.campaign;
  if (!['ENABLED', 'PAUSED', 'REMOVED'].includes(value.status)) fail('invalid_inventory');
  const reasons = value.primaryStatusReasons ?? value.primary_status_reasons ?? [];
  if (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== 'string')) fail('invalid_inventory');
  return { campaignId: value.id, campaignName: text(value.name, 256), campaignStatus: value.status,
    campaignServingStatus: text(value.servingStatus ?? value.serving_status, 64),
    campaignPrimaryStatus: text(value.primaryStatus ?? value.primary_status, 64),
    campaignPrimaryStatusReasons: JSON.stringify(reasons) };
}

function normalizeMetrics(rows, inventory, customerId, days, byGroup) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail('incomplete');
  const seen = new Set();
  return rows.map(row => {
    const resource = campaign(row, customerId); const saved = inventory.get(resource.campaignId);
    if (!saved) fail('inventory_changed');
    if (saved.campaignStatus !== resource.campaignStatus) fail('inventory_changed');
    const segments = row.segments || {}; const date = segments.date;
    if (!days.includes(date)) fail('date_outside_window');
    const group = row.adGroup || row.ad_group || {};
    if (byGroup && !id(group.id)) fail('invalid_group');
    const network = segments.adNetworkType ?? segments.ad_network_type;
    if (typeof network !== 'string' || !network || network.length > 64
      || typeof segments.device !== 'string' || !segments.device || segments.device.length > 64) fail('invalid_segment');
    const values = row.metrics;
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail('invalid_metric');
    const metrics = Object.fromEntries(METRICS.map(key => [camel(key), metric(values[camel(key)] ?? values[key],
      ['impressions', 'clicks', 'cost_micros', 'interactions'].includes(key))]));
    const result = { ...saved, adGroupId: byGroup ? group.id : '', adGroupName: byGroup ? text(group.name, 256) : null,
      date, network, device: segments.device, ...metrics };
    const key = JSON.stringify([result.campaignId, result.adGroupId, date, network, result.device]);
    if (seen.has(key)) fail('duplicate_metrics');
    seen.add(key); return result;
  });
}

function reconcile(campaignRows, groupRows) {
  const key = row => JSON.stringify([row.campaignId, row.date, row.network, row.device]);
  const groups = new Map();
  for (const row of groupRows) { const k = key(row); const list = groups.get(k) || []; list.push(row); groups.set(k, list); }
  const rows = [];
  for (const row of campaignRows) {
    const list = groups.get(key(row));
    if (!list) { rows.push(row); continue; }
    for (const field of METRICS.map(camel)) {
      const total = list.reduce((sum, item) => sum + item[field], 0);
      const tolerance = ['conversions', 'conversionsValue', 'allConversions', 'allConversionsValue'].includes(field) ? 0.000001 * list.length : 0;
      if (!Number.isFinite(total) || Math.abs(total - row[field]) > tolerance) fail('unreconciled');
    }
    rows.push(...list); groups.delete(key(row));
  }
  if (groups.size) fail('unreconciled');
  return rows;
}

async function collectGoogleCampaignMetrics({ account, accessToken, loginCustomerId, start, end,
  now = () => new Date(), clock = Date.now, read = require('../lib/googleAdsSearchRows').googleAdsSearchRows }) {
  const identity = owner(account); const days = daysBetween(start, end);
  if (days.length > 62) fail('invalid_window');
  const observedAt = new Date(Math.floor(+now() / 1000) * 1000).toISOString();
  const deadline = clock() + TIMEOUT_MS;
  const search = async (query, limit) => {
    const remaining = deadline - clock();
    if (remaining <= 0) fail('timeout');
    const rows = await read({ customerId: identity.customerId, accessToken, loginCustomerId, apiVersion: API_VERSION,
      query: `${query} LIMIT ${limit + 1}`, maxPages: 12, timeoutMs: remaining });
    if (clock() >= deadline) fail('timeout');
    if (!Array.isArray(rows) || rows.length > limit) fail('incomplete');
    return rows;
  };
  const metadata = await search('SELECT customer.id, customer.manager, customer.currency_code, customer.time_zone FROM customer', 1);
  const customer = metadata[0]?.customer;
  if (metadata.length !== 1 || customer?.id !== identity.customerId || customer.manager !== false
    || !/^[A-Z]{3}$/.test(customer.currencyCode || '') || !customer.timeZone) fail('invalid_account');
  let today;
  try { today = formatDateLocal(now(), customer.timeZone); } catch { fail('invalid_timezone'); }
  if (days.at(-1) >= today) fail('open_day');
  const inventoryRows = await search(`SELECT ${RESOURCE_FIELDS.join(', ')} FROM campaign
    WHERE campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED')`, 5000);
  const inventory = new Map();
  for (const row of inventoryRows) {
    const item = campaign(row, identity.customerId);
    if (inventory.has(item.campaignId)) fail('duplicate_inventory');
    inventory.set(item.campaignId, item);
  }
  const rows = [];
  for (let offset = 0; offset < days.length; offset += 15) {
    const dates = days.slice(offset, offset + 15);
    const fields = [...RESOURCE_FIELDS, 'segments.date', 'segments.ad_network_type', 'segments.device', ...METRICS.map(key => `metrics.${key}`)];
    const where = `WHERE segments.date BETWEEN '${dates[0]}' AND '${dates.at(-1)}' AND campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED')`;
    const campaignRows = normalizeMetrics(await search(`SELECT ${fields.join(', ')} FROM campaign ${where}`, MAX_ROWS), inventory, identity.customerId, dates, false);
    const groupRows = normalizeMetrics(await search(`SELECT ${[...fields, 'ad_group.id', 'ad_group.name'].join(', ')} FROM ad_group ${where}
      AND ad_group.status IN ('ENABLED', 'PAUSED', 'REMOVED')`, MAX_ROWS), inventory, identity.customerId, dates, true);
    rows.push(...reconcile(campaignRows, groupRows));
    if (rows.length > MAX_ROWS) fail('incomplete');
  }
  // A complete segmented query omits days where all selected metrics are zero.
  // Keep one explicit coverage row so a quiet campaign is not confused with a failed refresh.
  const present = new Set(rows.map(row => `${row.campaignId}:${row.date}`));
  for (const item of inventory.values()) for (const date of days) if (!present.has(`${item.campaignId}:${date}`)) {
    rows.push({ ...item, adGroupId: '', adGroupName: null, date, network: '', device: '',
      ...Object.fromEntries(METRICS.map(key => [camel(key), 0])) });
  }
  if (rows.length > MAX_ROWS || formatDateLocal(now(), customer.timeZone) !== today || clock() >= deadline) fail('incomplete');
  const snapshot = { schemaVersion: 1, apiVersion: API_VERSION, account: identity, start: days[0], end: days.at(-1),
    observedAt, currency: customer.currencyCode, timeZone: customer.timeZone, inventory: [...inventory.values()], rows };
  return { ...snapshot, fingerprint: digest(snapshot) };
}

function validateSnapshot(value, account, now) {
  const { fingerprint, ...snapshot } = value || {};
  if (snapshot.schemaVersion !== 1 || snapshot.apiVersion !== API_VERSION || fingerprint !== digest(snapshot)
    || digest(snapshot.account) !== digest(owner(account)) || !Array.isArray(snapshot.rows)
    || snapshot.rows.length > MAX_ROWS || !Array.isArray(snapshot.inventory)
    || !Number.isFinite(+new Date(snapshot.observedAt)) || +new Date(snapshot.observedAt) > +now
    || +now - +new Date(snapshot.observedAt) > 300000) fail('invalid_snapshot');
  const days = daysBetween(snapshot.start, snapshot.end);
  if (days.length > 62 || snapshot.end >= formatDateLocal(now, snapshot.timeZone)) fail('invalid_snapshot');
  const inventory = new Set(snapshot.inventory.map(row => row.campaignId)); const keys = new Set(); const covered = new Set();
  for (const row of snapshot.rows) {
    if (!inventory.has(row.campaignId) || !days.includes(row.date) || row.adGroupId !== '' && !id(row.adGroupId)) fail('invalid_snapshot');
    const key = JSON.stringify([row.campaignId, row.adGroupId, row.date, row.network, row.device]);
    if (keys.has(key)) fail('invalid_snapshot');
    keys.add(key); covered.add(`${row.campaignId}:${row.date}`);
    for (const field of METRICS) metric(row[camel(field)], ['impressions', 'clicks', 'cost_micros', 'interactions'].includes(field));
  }
  if ([...inventory].some(id => days.some(date => !covered.has(`${id}:${date}`)))) fail('invalid_snapshot');
  return snapshot;
}

async function campaignMetricAttribution({ models, account, assignments, clinics, rows, transaction, observedAt, useGroupAttribution }) {
  const groupId = account.grupoClinicaId || clinics.find(row => row.id_clinica === account.clinicaId)?.grupoClinicaId;
  const group = useGroupAttribution && groupId ? await models.GrupoClinica.findByPk(groupId, {
    attributes: ['id_grupo', 'ads_assignment_mode', 'ads_assignment_delimiter'], raw: true, transaction, lock: transaction.LOCK.UPDATE,
  }) : null;
  const automatic = String(group?.ads_assignment_mode || '').toLowerCase() === 'automatic';
  const matcher = automatic ? buildClinicMatcher(clinics, { delimiter: group.ads_assignment_delimiter || '**', requireDelimiter: true }) : null;
  const reviewed = new Map();
  for (const decision of assignments) {
    const list = reviewed.get(decision.campaign_id) || []; list.push(decision); reviewed.set(decision.campaign_id, list);
  }
  const matches = new Map();
  const allowed = new Set(clinics.map(row => row.id_clinica));
  const customerId = String(account.customerId).replace(/-/g, '');
  const issueWhere = (level, entityId) => ({ provider: 'google', customer_id: customerId, entity_level: level, entity_id: entityId });
  async function resolveIssue(level, entityId, clinicaId) {
    if (automatic) await models.AdAttributionIssue.update({ status: 'resolved', resolved_at: observedAt, clinica_id: clinicaId },
      { where: issueWhere(level, entityId), transaction });
  }
  async function match(row, level) {
    const entityId = level === 'campaign' ? row.campaignId : row.adGroupId;
    const key = `${level}:${entityId}`;
    if (matches.has(key)) return matches.get(key);
    const value = matcher.matchFromText(level === 'campaign' ? row.campaignName || '' : row.adGroupName || '', { level });
    const result = value.match ? { clinicaId: value.match.clinic.id, source: level, matchValue: value.match.token?.raw || null } : null;
    if (result) {
      if (!allowed.has(result.clinicaId)) fail('assignment_outside_scope');
      await resolveIssue(level, entityId, result.clinicaId);
    } else if (value.tokens?.length || value.candidates?.length) {
      const payload = { ...issueWhere(level, entityId), campaign_id: row.campaignId, campaign_name: row.campaignName,
        adset_name: row.adGroupName, grupo_clinica_id: groupId, clinica_id: null, status: 'open', last_seen_at: observedAt, resolved_at: null,
        detected_tokens: value.tokens?.map(token => token.raw) || null,
        match_candidates: value.candidates?.map(item => ({ clinicId: item.clinic?.id || null,
          clinicName: item.clinic?.displayName || null, token: item.token?.raw || null })) || null };
      const [issue, created] = await models.AdAttributionIssue.findOrCreate({ where: issueWhere(level, entityId), defaults: payload, transaction });
      if (!created) await issue.update(payload, { transaction });
    }
    matches.set(key, result); return result;
  }
  const result = new Map(); const resolved = new Set();
  for (const row of rows) {
    const key = `${row.campaignId}:${row.adGroupId}`;
    if (result.has(key)) continue;
    const decisions = reviewed.get(row.campaignId) || [];
    let choice;
    if (decisions.length) {
      const decision = decisions.length === 1 ? decisions[0] : null;
      choice = decision?.status === 'active' ? { clinicaId: decision.clinica_id, source: 'reviewed_campaign', matchValue: decision.match_kind || 'manual' }
        : { clinicaId: null, source: decision?.status === 'archived' ? 'reviewed_campaign_archived' : 'group-manual', matchValue: null };
      if (choice.clinicaId && !resolved.has(row.campaignId)) {
        await resolveIssue('campaign', row.campaignId, choice.clinicaId); resolved.add(row.campaignId);
      }
    } else if (automatic) {
      choice = row.adGroupId ? await match(row, 'ad_group') : null;
      if (!choice) choice = await match(row, 'campaign');
    } else if (account.assignmentScope === 'clinic') {
      choice = { clinicaId: account.clinicaId, source: 'manual', matchValue: null };
    }
    result.set(key, choice || { clinicaId: null, source: 'group-manual', matchValue: null });
  }
  return result;
}

async function persistGoogleCampaignMetrics({ models, account, snapshot: value, now = () => new Date(), beforeReplace, useGroupAttribution = false }) {
  const currentTime = typeof now === 'function' ? now : () => now;
  const snapshot = validateSnapshot(value, account, currentTime()); const customerId = snapshot.account.customerId;
  const customerIds = [customerId, `${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6)}`];
  return models.sequelize.transaction(async transaction => {
    const current = await models.ClinicGoogleAdsAccount.findAll({ where: { customerId: { [Op.in]: customerIds } },
      order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    const selected = current.find(row => row.id === account.id);
    if (!selected || digest(owner(selected)) !== digest(snapshot.account)) fail('account_changed');
    if (selected.currencyCode && selected.currencyCode !== snapshot.currency || selected.timeZone && selected.timeZone !== snapshot.timeZone) fail('account_changed');
    // Replacing account metrics must not cross another group's ownership or credential.
    if (current.filter(row => row.isActive).some(row => {
      if (row.googleConnectionId !== selected.googleConnectionId) return true;
      return selected.assignmentScope === 'group' ? row.grupoClinicaId !== selected.grupoClinicaId
        : row.assignmentScope !== 'clinic' || row.clinicaId !== selected.clinicaId;
    })) fail('account_shared_outside_scope');
    const grants = await models.GoogleConnectionAssignment.findAll({ where: { assignmentScope: selected.assignmentScope,
      ...(selected.assignmentScope === 'group' ? { grupoClinicaId: selected.grupoClinicaId } : { clinicaId: selected.clinicaId }) },
    attributes: ['googleConnectionId', 'status'], raw: true, transaction, lock: transaction.LOCK.UPDATE });
    if (grants.length !== 1 || grants[0].googleConnectionId !== selected.googleConnectionId || grants[0].status !== 'active') fail('grant_changed');
    const where = { customerId: { [Op.in]: customerIds }, date: { [Op.between]: [snapshot.start, snapshot.end] } };
    const latest = await models.GoogleAdsInsightsDaily.findOne({ where, attributes: ['updated_at'], order: [['updated_at', 'DESC']], raw: true, transaction });
    if (latest && +new Date(latest.updated_at) >= +new Date(snapshot.observedAt)) return { skipped: true, reason: 'newer_snapshot', rows: 0 };
    const assignments = await models.ExternalCampaignAssignment.findAll({ where: { provider: 'google_ads', customer_id: { [Op.in]: customerIds } },
      raw: true, transaction, lock: transaction.LOCK.UPDATE });
    const clinics = await models.Clinica.findAll({ where: selected.assignmentScope === 'group'
      ? { grupoClinicaId: selected.grupoClinicaId } : { id_clinica: selected.clinicaId },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'], raw: true, transaction, lock: transaction.LOCK.UPDATE });
    const allowed = new Set(clinics.map(row => row.id_clinica));
    if (!allowed.size || assignments.some(row => row.status === 'active' && !allowed.has(row.clinica_id))) fail('assignment_outside_scope');
    const attribution = await campaignMetricAttribution({ models, account: selected, assignments, clinics, rows: snapshot.rows,
      transaction, observedAt: snapshot.observedAt, useGroupAttribution });
    const rows = snapshot.rows.map(row => {
      const choice = attribution.get(`${row.campaignId}:${row.adGroupId}`);
      const { interactions, ...fields } = row;
      return { ...fields, clinicGoogleAdsAccountId: selected.id, customerId, clinicaId: choice.clinicaId, grupoClinicaId: selected.grupoClinicaId,
        clinicMatchSource: choice.source, clinicMatchValue: choice.matchValue, ctr: row.impressions ? row.clicks / row.impressions : 0,
        averageCpcMicros: row.clicks ? Math.round(row.costMicros / row.clicks) : 0,
        averageCpmMicros: row.impressions ? Math.round(row.costMicros / row.impressions * 1000) : 0,
        averageCostMicros: interactions ? Math.round(row.costMicros / interactions) : 0,
        conversionsFromInteractionsRate: interactions ? row.conversions / interactions : 0,
        created_at: snapshot.observedAt, updated_at: snapshot.observedAt };
    });
    if (beforeReplace) await beforeReplace({ where, transaction });
    validateSnapshot(value, selected, currentTime());
    await models.GoogleAdsInsightsDaily.destroy({ where, transaction });
    for (let offset = 0; offset < rows.length; offset += 500) await models.GoogleAdsInsightsDaily.bulkCreate(rows.slice(offset, offset + 500), { transaction });
    return { skipped: false, rows: rows.length, campaigns: snapshot.inventory.length, start: snapshot.start, end: snapshot.end,
      observedAt: snapshot.observedAt, fingerprint: value.fingerprint };
  });
}

module.exports = { API_VERSION, collectGoogleCampaignMetrics, persistGoogleCampaignMetrics, validateSnapshot };
