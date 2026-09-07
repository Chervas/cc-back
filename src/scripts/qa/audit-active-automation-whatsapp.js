'use strict';

const db = require('../../../models');
const { Op } = require('sequelize');
const {
  resolveWhatsappRouting,
  selectWhatsappPhoneAsset,
} = require('../../lib/whatsapp-channel-role');
const whatsappAccountHealthService = require('../../services/whatsappAccountHealth.service');

function clean(value) {
  return String(value ?? '').trim();
}

function toId(value) {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isActive(value) {
  return value === true || value === 1 || value === '1';
}

function collectTemplateReferences(flow, node) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const references = [];
  const templateUsage = clean(config.template_usage).toLowerCase();
  const purpose = ['solicitud_resena', 'resena', 'review_request', 'reviews'].includes(templateUsage)
    ? 'review_requests'
    : ['lead_auto_reply', 'lead_primera_visita'].includes(templateUsage)
      ? 'lead_first_contact'
      : null;
  const add = (branch, templateId, catalogTemplateId, options = {}) => {
    const id = toId(templateId);
    if (!id) return;
    references.push({
      flow_id: flow.id,
      flow: flow.name || flow.template_key,
      template_key: flow.template_key,
      flow_version: flow.version,
      clinic_id: flow.clinic_id || null,
      node_id: node.id,
      branch,
      template_id: id,
      expected_catalog_template_id: toId(catalogTemplateId),
      expected_locale: clean(options.locale) || null,
      require_current_catalog_body: options.requireCurrentCatalogBody === true,
      routing_purpose: purpose,
    });
  };

  add('base', config.template_id, config.catalog_template_id, {
    locale: config.language_code,
    requireCurrentCatalogBody: config.require_current_catalog_body,
  });
  add('fallback', config.fallback_template_id, config.fallback_catalog_template_id, {
    locale: config.fallback_language_code || config.language_code,
    requireCurrentCatalogBody: config.fallback_require_current_catalog_body,
  });
  const variants = config.language_routing?.variants;
  if (variants && typeof variants === 'object') {
    for (const [locale, variant] of Object.entries(variants)) {
      add(`language:${locale}`, variant?.template_id, variant?.catalog_template_id, {
        locale: variant?.language_code || locale,
        requireCurrentCatalogBody: variant?.require_current_catalog_body,
      });
    }
  }
  return references;
}

function summarizeRecentFailure(message) {
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const providerError = Array.isArray(metadata.wa_error) ? metadata.wa_error[0] : null;
  return {
    message_id: message.id,
    created_at: message.createdAt,
    source: metadata.source || metadata.kind || 'unknown',
    flow: metadata.flow_name || null,
    clinic_id: metadata.clinic_id || null,
    template_id: toId(metadata.template_id),
    template_name: metadata.template_name || null,
    code: providerError?.code || metadata.error || metadata.flow_error || 'unknown',
    reason: providerError?.error_data?.details || providerError?.message || null,
  };
}

function normalizeLocale(value) {
  const normalized = clean(value).replace('-', '_').toLowerCase();
  if (!normalized) return '';
  if (normalized.startsWith('ca')) return 'ca';
  if (normalized.startsWith('en')) return 'en';
  return 'es';
}

function extractBody(components) {
  const source = typeof components === 'string'
    ? (() => {
        try { return JSON.parse(components); } catch (_error) { return []; }
      })()
    : components;
  const body = (Array.isArray(source) ? source : []).find((component) => clean(component?.type).toLowerCase() === 'body');
  return clean(body?.text);
}

function senderForReference(reference, assetsByClinic, assetsByGroup, clinicGroups) {
  if (!reference.clinic_id) return null;
  const groupId = clinicGroups.get(Number(reference.clinic_id)) || null;
  return selectWhatsappPhoneAsset({
    clinicAssets: assetsByClinic.get(Number(reference.clinic_id)) || [],
    groupAssets: groupId ? assetsByGroup.get(Number(groupId)) || [] : [],
    purpose: reference.routing_purpose,
    summarizeHealth: (asset) => whatsappAccountHealthService.summarizeAssetHealth(asset),
  });
}

async function run() {
  const hoursArg = process.argv.find((value) => value.startsWith('--hours='));
  const hours = Math.max(1, Number.parseInt(hoursArg?.split('=')[1] || '48', 10) || 48);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const flows = await db.AutomationFlowTemplateV2.findAll({
    where: {
      is_active: true,
      published_at: { [Op.ne]: null },
    },
    attributes: [
      'id',
      'template_key',
      'version',
      'name',
      'clinic_id',
      'group_id',
      'is_system',
      'nodes',
    ],
    raw: true,
  });

  const references = [];
  let sendNodeCount = 0;
  let dynamicSendNodeCount = 0;
  for (const flow of flows) {
    for (const node of Array.isArray(flow.nodes) ? flow.nodes : []) {
      if (clean(node?.type) !== 'action/send_whatsapp') continue;
      sendNodeCount += 1;
      const nodeReferences = collectTemplateReferences(flow, node);
      if (!nodeReferences.length) dynamicSendNodeCount += 1;
      references.push(...nodeReferences);
    }
  }

  const templateIds = Array.from(new Set(references.map((reference) => reference.template_id)));
  const catalogIds = Array.from(new Set(references
    .map((reference) => reference.expected_catalog_template_id)
    .filter(Boolean)));
  const allCandidateTemplateIds = templateIds;
  const templates = (allCandidateTemplateIds.length || catalogIds.length)
    ? await db.WhatsappTemplate.findAll({
        where: {
          [Op.or]: [
            ...(allCandidateTemplateIds.length ? [{ id: { [Op.in]: allCandidateTemplateIds } }] : []),
            ...(catalogIds.length ? [{ catalog_template_id: { [Op.in]: catalogIds } }] : []),
          ],
        },
        attributes: [
          'id',
          'clinic_id',
          'waba_id',
          'name',
          'language',
          'status',
          'is_active',
          'catalog_template_id',
          'components',
          'superseded_by_template_id',
          'retired_at',
        ],
        raw: true,
      })
    : [];
  const templatesById = new Map(templates.map((template) => [Number(template.id), template]));
  const templatesByCatalogId = new Map();
  for (const template of templates) {
    const catalogId = toId(template.catalog_template_id);
    if (!catalogId) continue;
    templatesByCatalogId.set(catalogId, [...(templatesByCatalogId.get(catalogId) || []), template]);
  }
  const catalogs = catalogIds.length
    ? await db.WhatsappTemplateCatalog.findAll({
        where: { id: { [Op.in]: catalogIds } },
        attributes: ['id', 'locale', 'body_text', 'is_active'],
        raw: true,
      })
    : [];
  const catalogsById = new Map(catalogs.map((catalog) => [Number(catalog.id), catalog]));
  const clinicIds = Array.from(new Set(references.map((reference) => Number(reference.clinic_id)).filter(Boolean)));
  const clinics = clinicIds.length
    ? await db.Clinica.findAll({
        where: { id_clinica: { [Op.in]: clinicIds } },
        attributes: ['id_clinica', 'grupoClinicaId'],
        raw: true,
      })
    : [];
  const clinicGroups = new Map(clinics.map((clinic) => [Number(clinic.id_clinica), Number(clinic.grupoClinicaId) || null]));
  const phoneAssets = await db.ClinicMetaAsset.findAll({
    where: { assetType: 'whatsapp_phone_number', isActive: true },
    raw: true,
  });
  const assetsByClinic = new Map();
  const assetsByGroup = new Map();
  for (const asset of phoneAssets) {
    if (asset.assignmentScope === 'clinic' && asset.clinicaId) {
      const clinicId = Number(asset.clinicaId);
      assetsByClinic.set(clinicId, [...(assetsByClinic.get(clinicId) || []), asset]);
    }
    if (asset.assignmentScope === 'group' && asset.grupoClinicaId) {
      const groupId = Number(asset.grupoClinicaId);
      assetsByGroup.set(groupId, [...(assetsByGroup.get(groupId) || []), asset]);
    }
  }

  const issues = [];
  let disconnectedReferenceCount = 0;
  let dynamicScopeReferenceCount = 0;
  let unavailableSenderReferenceCount = 0;
  const unavailableSenders = new Map();
  for (const reference of references) {
    const template = templatesById.get(reference.template_id);
    if (!template && !reference.expected_catalog_template_id) {
      issues.push({ type: 'missing_template', ...reference });
      continue;
    }
    if (!reference.clinic_id) {
      dynamicScopeReferenceCount += 1;
      continue;
    }
    const sender = senderForReference(reference, assetsByClinic, assetsByGroup, clinicGroups);
    if (!sender?.wabaId || !sender?.phoneNumberId || !sender?.waAccessToken) {
      disconnectedReferenceCount += 1;
      continue;
    }
    const senderHealth = whatsappAccountHealthService.summarizeAssetHealth(sender);
    if (sender.routing_unavailable === true || senderHealth.can_send === false) {
      unavailableSenderReferenceCount += 1;
      unavailableSenders.set(Number(sender.id), {
        sender_asset_id: Number(sender.id),
        sender_role: resolveWhatsappRouting(sender).role,
        sender_waba_id: sender.wabaId,
        health_state: senderHealth.state || senderHealth.base_state || null,
        reason_code: senderHealth.reason_code || senderHealth.blocking_reason_code || null,
      });
      continue;
    }

    if (reference.expected_catalog_template_id) {
      const catalog = catalogsById.get(reference.expected_catalog_template_id) || null;
      const expectedLocale = normalizeLocale(reference.expected_locale || catalog?.locale);
      const candidates = templatesByCatalogId.get(reference.expected_catalog_template_id) || [];
      const compatible = candidates.filter((candidate) => {
        if (!isActive(candidate.is_active) || clean(candidate.status).toUpperCase() !== 'APPROVED') return false;
        if (candidate.clinic_id && Number(candidate.clinic_id) !== Number(reference.clinic_id)) return false;
        if (candidate.waba_id && clean(candidate.waba_id) !== clean(sender.wabaId)) return false;
        if (expectedLocale && normalizeLocale(candidate.language) !== expectedLocale) return false;
        if (reference.require_current_catalog_body && catalog?.body_text) {
          return extractBody(candidate.components) === clean(catalog.body_text);
        }
        return true;
      });
      if (!compatible.length) {
        issues.push({
          type: 'catalog_template_unavailable_for_sender',
          ...reference,
          sender_asset_id: sender.id,
          sender_waba_id: sender.wabaId,
        });
      }
      continue;
    }

    if (!isActive(template.is_active) || clean(template.status).toUpperCase() !== 'APPROVED') {
      issues.push({
        type: 'template_not_sendable',
        ...reference,
        status: template.status,
        is_active: template.is_active,
        template_name: template.name,
      });
    }
    if (
      reference.clinic_id
      && template.clinic_id
      && Number(reference.clinic_id) !== Number(template.clinic_id)
    ) {
      issues.push({
        type: 'cross_clinic_template_reference',
        ...reference,
        template_name: template.name,
        template_clinic_id: Number(template.clinic_id),
      });
    }
  }

  const recentFailedMessages = await db.Message.findAll({
    where: {
      direction: 'outbound',
      status: 'failed',
      createdAt: { [Op.gte]: since },
    },
    attributes: ['id', 'metadata', 'createdAt'],
    order: [['id', 'DESC']],
    raw: true,
  });

  const recentFailedNodes = await db.FlowExecutionLogV2.findAll({
    where: {
      status: 'failed',
      node_type: 'action/send_whatsapp',
      created_at: { [Op.gte]: since },
    },
    attributes: ['id', 'flow_execution_id', 'node_id', 'error_message', 'created_at'],
    order: [['id', 'DESC']],
    raw: true,
  });

  const issueCounts = issues.reduce((result, issue) => {
    result[issue.type] = (result[issue.type] || 0) + 1;
    return result;
  }, {});
  const report = {
    audited_at: new Date().toISOString(),
    window_hours: hours,
    active_published_flows: flows.length,
    send_whatsapp_nodes: sendNodeCount,
    explicit_template_references: references.length,
    dynamic_template_nodes: dynamicSendNodeCount,
    unique_templates_referenced: templateIds.length,
    disconnected_references_skipped: disconnectedReferenceCount,
    dynamic_scope_references_skipped: dynamicScopeReferenceCount,
    unavailable_sender_references_skipped: unavailableSenderReferenceCount,
    unavailable_senders: Array.from(unavailableSenders.values()),
    issue_counts: issueCounts,
    issues,
    recent_failed_messages: recentFailedMessages.map(summarizeRecentFailure),
    recent_failed_send_nodes: recentFailedNodes,
  };

  console.log(JSON.stringify(report, null, 2));
  if (issues.length) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close().catch(() => null);
  });
