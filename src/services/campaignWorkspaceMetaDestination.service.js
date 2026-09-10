'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { campaignIncluded, settingScope } = require('./campaignWorkspaceSettings.service');

const graphId = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const revision = value => crypto.createHash('sha256').update(JSON.stringify(value || null)).digest('hex');
const query = transaction => ({ raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const mappingScopeKey = row => row.assignmentScope === 'group' ? `group:${row.grupoClinicaId}` : `clinic:${row.clinicaId}`;

function campaignReference(input, refresh = false) {
  const keys = ['account_id', 'campaign_id', ...(refresh ? ['revision'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
    || !graphId(input.account_id) || !graphId(input.campaign_id)
    || refresh && (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision))) fail('invalid_meta_preparation', 400);
  return { provider: 'meta_ads', account_id: input.account_id, campaign_id: input.campaign_id };
}

function webUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || /(^|\.)(facebook\.com|instagram\.com|fb\.com|fb\.me|m\.me|wa\.me|whatsapp\.com)$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function creativeDestinations(ad) {
  const creative = ad.creative || {};
  const spec = creative.object_story_spec || {};
  const blocks = [spec.link_data, spec.video_data, spec.template_data].filter(Boolean);
  const calls = [creative.call_to_action, ...blocks.flatMap(block => [block.call_to_action,
    ...(Array.isArray(block.child_attachments) ? block.child_attachments.map(child => child.call_to_action) : [])])].filter(Boolean);
  const forms = [...new Set(calls.map(call => graphId(call.value?.lead_gen_form_id)).filter(Boolean))];
  const pageId = graphId(spec.page_id) || graphId(creative.actor_id);
  // A native form's CTA can also contain a website link. That link is not another reception destination.
  if (forms.length) return { forms: forms.map(formId => ({ form_id: formId, page_id: pageId, ad_ids: [ad.id] })), urls: [], known: true };
  const unsupported = /^(WHATSAPP_MESSAGE|MESSAGE_PAGE|CALL|CALL_NOW|CALL_ME|AUDIO_CALL|VIDEO_CALL|INSTALL_APP|USE_APP|GET_DIRECTIONS|OPEN_INSTANT_APP)$/;
  if (calls.some(call => unsupported.test(call.type || ''))
    || unsupported.test(creative.call_to_action_type || '')) return { forms: [], urls: [], known: false };
  const candidates = [creative.link_url, ...calls.map(call => call.value?.link), ...blocks.flatMap(block => [block.link,
    ...(Array.isArray(block.child_attachments) ? block.child_attachments.map(child => child.link) : [])]),
  ...(Array.isArray(creative.asset_feed_spec?.link_urls) ? creative.asset_feed_spec.link_urls.map(link => link.website_url) : [])].filter(Boolean);
  const urls = [...new Set(candidates.map(webUrl).filter(Boolean))];
  return { forms: [], urls, known: urls.length > 0 && candidates.every(value => !!webUrl(value)) };
}

function detectDestinations(ads, complete, now = new Date()) {
  const forms = new Map(); const urls = new Set(); let unknown = 0;
  for (const ad of ads) {
    const found = creativeDestinations(ad);
    if (!found.known) unknown++;
    found.urls.forEach(url => urls.add(url));
    for (const form of found.forms) {
      const old = forms.get(form.form_id);
      if (old && old.page_id && form.page_id && old.page_id !== form.page_id) { unknown++; continue; }
      forms.set(form.form_id, { ...form, page_id: form.page_id || old?.page_id || null,
        ad_ids: [...new Set([...(old?.ad_ids || []), ...form.ad_ids])] });
    }
  }
  const checked = complete && ads.length > 0 && unknown === 0;
  return { version: 1, source: 'workspace_meta_graph', kind: checked
    ? forms.size && urls.size ? 'mixed' : forms.size ? 'lead_form' : 'web' : 'unknown',
  complete: checked, checked_at: now.toISOString(), ad_count: ads.length, unknown_ad_count: unknown,
  forms: [...forms.values()], urls: [...urls] };
}

function providerError(error) {
  if (error.code?.startsWith('workspace_meta_')) return error;
  const code = Number(error.response?.data?.error?.code);
  return Object.assign(new Error('Meta check failed'), { status: 409,
    code: /^META_RATE_LIMIT/.test(error.code || '') || [4, 17, 613].includes(code) ? 'workspace_meta_rate_limited'
      : [10, 190, 200].includes(code) ? 'workspace_meta_permissions_required' : 'workspace_meta_unavailable' });
}

async function graphList(path, fields, token, read, maxPages = 20) {
  const rows = []; const seen = new Set(); let after;
  for (let page = 0; page < maxPages; page++) {
    const response = await read(path, { accessToken: token, params: { fields, limit: 100, ...(after ? { after } : {}) },
      timeout: 15000, source: 'campaign_workspace', operation: 'meta_destination_check' });
    const data = response.data;
    if (!Array.isArray(data?.data) || data.error) fail('workspace_meta_unavailable');
    rows.push(...data.data);
    if (!data.paging?.next) return { rows, complete: true };
    // Never follow provider-supplied URLs with a credential. Keep the original endpoint and only use its cursor.
    after = data.paging?.cursors?.after;
    if (typeof after !== 'string' || !after || after.length > 4096 || seen.has(after)) return { rows, complete: false };
    seen.add(after);
  }
  return { rows, complete: false };
}

async function metaCampaignContext({ models, scope, reference, loadInventory, transaction = null, now = new Date() }) {
  const owner = settingScope(scope);
  if (transaction) {
    const record = await (scope.groupId ? models.GrupoClinica : models.Clinica).findByPk(owner.scope_id, query(transaction));
    if (!record) fail('scope_not_found', 404);
    if (scope.groupId) {
      const members = await models.Clinica.findAll({ where: { grupoClinicaId: scope.groupId }, attributes: ['id_clinica'], ...query(transaction) });
      if (members.some(row => !scope.clinicIds.includes(Number(row.id_clinica)))) fail('workspace_scope_changed');
    }
  }
  const inventory = await loadInventory({ models, scope, transaction });
  const campaign = inventory.campaigns.find(row => row.provider === 'meta_ads'
    && row.account_id === reference.account_id && row.campaign_id === reference.campaign_id);
  const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, ...query(transaction) });
  if (!campaign || !campaignIncluded(campaign, setting)) fail('workspace_campaign_not_in_scope', 403);
  if (!campaign.assigned) fail('workspace_clinic_assignment_required');
  const clinic = inventory.selectedClinics.find(row => Number(row.id_clinica) === campaign.clinicId);
  if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica)) fail('workspace_clinic_inactive');
  const mappings = await models.ClinicMetaAsset.findAll({ where: { isActive: true, assetType: 'ad_account',
    metaAssetId: { [Op.in]: [reference.account_id, `act_${reference.account_id}`] }, [Op.or]: [
      { assignmentScope: 'clinic', clinicaId: campaign.clinicId },
      ...(clinic.grupoClinicaId ? [{ assignmentScope: 'group', grupoClinicaId: clinic.grupoClinicaId }] : []),
    ] }, ...query(transaction) });
  const assignments = mappings.length ? await models.MetaConnectionAssignment.findAll({ where: { status: 'active',
    scopeKey: { [Op.in]: mappings.map(mappingScopeKey) } }, ...query(transaction) }) : [];
  const authorized = mappings.filter(row => assignments.some(assignment => assignment.scopeKey === mappingScopeKey(row)
    && Number(assignment.metaConnectionId) === Number(row.metaConnectionId)));
  const preferred = authorized.filter(row => row.assignmentScope === owner.scope_type
    && Number(owner.scope_type === 'group' ? row.grupoClinicaId : row.clinicaId) === owner.scope_id);
  const eligible = preferred.length ? preferred : authorized;
  if (!eligible.length) fail('workspace_meta_permissions_required');
  if (new Set(eligible.map(row => Number(row.metaConnectionId))).size !== 1) fail('workspace_meta_connection_ambiguous');
  const connection = await models.MetaConnection.findByPk(eligible[0].metaConnectionId, query(transaction));
  if (!connection?.accessToken || connection.expiresAt && +new Date(connection.expiresAt) <= +now) fail('workspace_meta_permissions_required');
  const cached = await models.ExternalCampaignInventory.findAll({ where: { provider: 'meta_ads',
    customer_id: { [Op.in]: [reference.account_id, `act_${reference.account_id}`] }, campaign_id: reference.campaign_id }, ...query(transaction) });
  if (cached.length > 1) fail('workspace_meta_inventory_ambiguous');
  return { campaign, connection, setting, cached: cached[0] || null, revision: revision(cached[0]?.destination_detection) };
}

async function refreshMetaCampaignDestinations({ models, scope, input, loadInventory, now = new Date(), read }) {
  const reference = campaignReference(input, true);
  const context = await metaCampaignContext({ models, scope, reference, loadInventory, now });
  if (context.revision !== input.revision) fail('workspace_meta_check_conflict');
  const sourceRead = read || require('../lib/metaClient').metaGet;
  const deadline = Date.now() + 45000;
  const graphRead = (path, options) => {
    const remaining = deadline - Date.now();
    if (remaining < 1000) fail('workspace_meta_check_timeout');
    return sourceRead(path, { ...options, timeout: Math.min(10000, remaining), maxRetries: 0 });
  };
  let detection;
  try {
    const list = await graphList(`${reference.campaign_id}/ads`,
      'id,account_id,campaign_id,effective_status,creative{actor_id,object_story_spec,link_url,call_to_action,call_to_action_type,asset_feed_spec}',
      context.connection.accessToken, graphRead);
    if (list.rows.some(row => !graphId(row.id) || row.account_id !== reference.account_id || row.campaign_id !== reference.campaign_id)) {
      fail('workspace_meta_identity_mismatch');
    }
    const unique = new Map();
    for (const row of list.rows) {
      if (unique.has(row.id) && JSON.stringify(unique.get(row.id)) !== JSON.stringify(row)) fail('workspace_meta_identity_mismatch');
      unique.set(row.id, row);
    }
    detection = detectDestinations([...unique.values()].filter(row => !/^(DELETED|ARCHIVED)$/.test(row.effective_status || '')), list.complete, now);
    // Only form metadata is inspected here; neither contact answers nor test leads are requested.
    for (const form of detection.forms) {
      try {
        const response = await graphRead(form.form_id, { accessToken: context.connection.accessToken,
          params: { fields: 'id,name,page_id,status' }, timeout: 15000, source: 'campaign_workspace', operation: 'meta_form_check' });
        const data = response.data;
        if (data?.id !== form.form_id || !graphId(data?.page_id) || form.page_id && form.page_id !== data.page_id) fail('workspace_meta_identity_mismatch');
        form.page_id = data.page_id; form.name = typeof data.name === 'string' ? data.name.slice(0, 255) : null;
        form.status = typeof data.status === 'string' ? data.status.slice(0, 32) : null; form.metadata_accessible = true;
      } catch (error) {
        if (error.code === 'workspace_meta_identity_mismatch') throw error;
        form.metadata_accessible = false; form.check_error = providerError(error).code;
        if (['workspace_meta_rate_limited', 'workspace_meta_check_timeout'].includes(form.check_error)) break;
      }
    }
  } catch (error) { throw providerError(error); }
  try { await models.sequelize.transaction(async transaction => {
    const latest = await metaCampaignContext({ models, scope, reference, loadInventory, transaction, now: new Date() });
    if (latest.revision !== context.revision || Number(latest.connection.id) !== Number(context.connection.id)
      || latest.campaign.clinicId !== context.campaign.clinicId || revision(latest.setting) !== revision(context.setting)) fail('workspace_meta_check_conflict');
    // Update only the destination cache. No campaign, asset assignment, subscription or advertising setting changes.
    if (latest.cached) await models.ExternalCampaignInventory.update({ destination_detection: detection }, {
      where: { id: latest.cached.id }, transaction,
    });
    else await models.ExternalCampaignInventory.create({ provider: 'meta_ads', customer_id: reference.account_id,
      campaign_id: reference.campaign_id, campaign_name: latest.campaign.name, account_name: latest.campaign.accountName,
      status: latest.campaign.status, source: 'provider_sync', destination_detection: detection,
      last_seen_at: latest.campaign.lastSeenAt || now }, { transaction });
  }); } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') fail('workspace_meta_check_conflict');
    throw error;
  }
  return { success: true };
}

module.exports = { graphId, revision, campaignReference, webUrl, creativeDestinations, detectDestinations, graphList,
  metaCampaignContext, refreshMetaCampaignDestinations };
