'use strict';

const db = require('../../models');
const {
  buildWhatsappTemplateVariableContract,
  normalizeNamedBindings,
  normalizePositionalBindings,
  buildNamedBindingsFromPositional,
  buildPositionalBindingsFromNamed,
  buildEffectiveNamedBindings,
} = require('../lib/whatsapp-template-contract');

const { AutomationFlowTemplateV2, WhatsappTemplateCatalog } = db;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTemplateId(value) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nodeUsesTemplate(node, { templateId, templateName, catalogTemplateId }) {
  if (!node || String(node.type || '').toLowerCase() !== 'action/send_whatsapp') return false;
  const config = isObject(node.config) ? node.config : {};
  const nodeTemplateId = normalizeTemplateId(config.template_id);
  const nodeTemplateName = cleanString(config.template_name).toLowerCase();
  const nodeCatalogTemplateId = Number(config.catalog_template_id);
  const nodeFallbackTemplateId = normalizeTemplateId(config.fallback_template_id);
  const nodeFallbackTemplateName = cleanString(config.fallback_template_name).toLowerCase();
  const nodeFallbackCatalogTemplateId = Number(config.fallback_catalog_template_id);
  const accessVariant = isObject(config.access_guidance_variant)
    ? config.access_guidance_variant
    : {};
  const variantTemplateId = normalizeTemplateId(accessVariant.template_id);
  const variantTemplateName = cleanString(accessVariant.template_name).toLowerCase();
  const variantCatalogTemplateId = Number(accessVariant.catalog_template_id);
  return (
    (templateId && nodeTemplateId === String(templateId))
    || (!!templateName && !!nodeTemplateName && nodeTemplateName === String(templateName).trim().toLowerCase())
    || (Number.isFinite(nodeCatalogTemplateId) && nodeCatalogTemplateId > 0 && nodeCatalogTemplateId === Number(catalogTemplateId))
    || (templateId && nodeFallbackTemplateId === String(templateId))
    || (!!templateName && !!nodeFallbackTemplateName && nodeFallbackTemplateName === String(templateName).trim().toLowerCase())
    || (Number.isFinite(nodeFallbackCatalogTemplateId) && nodeFallbackCatalogTemplateId > 0 && nodeFallbackCatalogTemplateId === Number(catalogTemplateId))
    || (templateId && variantTemplateId === String(templateId))
    || (!!templateName && !!variantTemplateName && variantTemplateName === String(templateName).trim().toLowerCase())
    || (Number.isFinite(variantCatalogTemplateId) && variantCatalogTemplateId > 0 && variantCatalogTemplateId === Number(catalogTemplateId))
  );
}

async function recomposeAutomationsUsingTemplate({ templateInstance, logger = console }) {
  if (!templateInstance) {
    return { success: false, error: 'template_instance_required' };
  }

  const templateJson = templateInstance.toJSON ? templateInstance.toJSON() : templateInstance;
  if (!templateJson.catalog && Number(templateJson.catalog_template_id)) {
    const catalog = await WhatsappTemplateCatalog.findByPk(Number(templateJson.catalog_template_id), {
      attributes: ['id', 'variables', 'locale'],
      raw: true,
    });
    if (catalog) {
      templateJson.catalog = catalog;
    }
  }
  const catalogLocale = cleanString(templateJson?.catalog?.locale).toLowerCase().split(/[-_]/)[0] || 'es';
  if (catalogLocale !== 'es') {
    // Las variantes ca/en se resuelven por catalog_template_id dentro de
    // language_routing. Antes del rollout no deben sustituir referencias base
    // españolas por compartir el mismo nombre técnico en Meta.
    return {
      success: true,
      skipped: true,
      reason: 'localized_variant_resolved_at_runtime',
      template_id: Number(templateJson.id) || null,
      catalog_template_id: Number(templateJson.catalog_template_id) || null,
      template_versions_touched: 0,
      nodes_touched: 0,
    };
  }
  const templateVariables = buildWhatsappTemplateVariableContract(templateJson);
  const templateId = Number(templateJson.id);
  const templateName = cleanString(templateJson.name);
  const catalogTemplateId = Number(templateJson.catalog_template_id);

  const templates = await AutomationFlowTemplateV2.findAll({
    attributes: ['id', 'public_id', 'name', 'version', 'nodes', 'published_at', 'is_active'],
    order: [['id', 'ASC']],
  });

  let templateVersionsTouched = 0;
  let nodesTouched = 0;

  for (const flowTemplate of templates) {
    const nodes = Array.isArray(flowTemplate.nodes) ? flowTemplate.nodes : [];
    let changed = false;
    const nextNodes = nodes.map((node) => {
      if (!nodeUsesTemplate(node, { templateId, templateName, catalogTemplateId })) {
        return node;
      }

      const config = isObject(node.config) ? node.config : {};
      const primaryMatchesReference = (
        (templateId && normalizeTemplateId(config.template_id) === String(templateId))
        || (!!templateName && cleanString(config.template_name).toLowerCase() === String(templateName).trim().toLowerCase())
      );
      const primaryMatchesCatalog = Number.isFinite(catalogTemplateId) && catalogTemplateId > 0
        && Number.isFinite(Number(config.catalog_template_id))
        && Number(config.catalog_template_id) === Number(catalogTemplateId);
      const usesPrimaryTemplate = primaryMatchesReference || primaryMatchesCatalog;
      const fallbackMatchesReference = (
        (templateId && normalizeTemplateId(config.fallback_template_id) === String(templateId))
        || (!!templateName && cleanString(config.fallback_template_name).toLowerCase() === String(templateName).trim().toLowerCase())
      );
      const fallbackMatchesCatalog = Number.isFinite(catalogTemplateId) && catalogTemplateId > 0
        && Number.isFinite(Number(config.fallback_catalog_template_id))
        && Number(config.fallback_catalog_template_id) === Number(catalogTemplateId);
      const usesFallbackTemplate = fallbackMatchesReference || fallbackMatchesCatalog;
      const accessGuidanceVariant = isObject(config.access_guidance_variant)
        ? config.access_guidance_variant
        : null;
      const accessGuidanceMatchesReference = !!accessGuidanceVariant && (
        (templateId && normalizeTemplateId(accessGuidanceVariant.template_id) === String(templateId))
        || (!!templateName && cleanString(accessGuidanceVariant.template_name).toLowerCase() === String(templateName).trim().toLowerCase())
      );
      const accessGuidanceMatchesCatalog = !!accessGuidanceVariant
        && Number.isFinite(catalogTemplateId)
        && catalogTemplateId > 0
        && Number.isFinite(Number(accessGuidanceVariant.catalog_template_id))
        && Number(accessGuidanceVariant.catalog_template_id) === Number(catalogTemplateId);
      const usesAccessGuidanceVariant = accessGuidanceMatchesReference || accessGuidanceMatchesCatalog;

      // Once semantic bindings exist, they are the source of truth. Reusing
      // legacy positions after a catalog contract adds or reorders variables
      // can silently bind an old value to a different meaning.
      const primaryNamedSource = normalizeNamedBindings(config.variables_named);
      const primaryLegacySource = Object.keys(primaryNamedSource).length
        ? {}
        : config.variables;
      const fallbackNamedSource = normalizeNamedBindings(config.fallback_variables_named);
      const fallbackLegacySource = Object.keys(fallbackNamedSource).length
        ? {}
        : config.fallback_variables;
      const accessGuidanceNamedSource = normalizeNamedBindings(accessGuidanceVariant?.variables_named);
      const accessGuidanceLegacySource = Object.keys(accessGuidanceNamedSource).length
        ? {}
        : accessGuidanceVariant?.variables;

      const namedBindings = usesPrimaryTemplate
        ? buildEffectiveNamedBindings(
          primaryNamedSource,
          primaryLegacySource,
          templateVariables
        )
        : primaryNamedSource;
      const positionalBindings = usesPrimaryTemplate
        ? buildPositionalBindingsFromNamed(namedBindings, primaryLegacySource, templateVariables)
        : normalizePositionalBindings(config.variables);
      const fallbackNamedBindings = usesFallbackTemplate
        ? buildEffectiveNamedBindings(
          fallbackNamedSource,
          fallbackLegacySource,
          templateVariables
        )
        : fallbackNamedSource;
      const fallbackPositionalBindings = usesFallbackTemplate
        ? buildPositionalBindingsFromNamed(
          fallbackNamedBindings,
          fallbackLegacySource,
          templateVariables
        )
        : normalizePositionalBindings(config.fallback_variables);
      const accessGuidanceNamedBindings = usesAccessGuidanceVariant
        ? buildEffectiveNamedBindings(
          accessGuidanceNamedSource,
          accessGuidanceLegacySource,
          templateVariables
        )
        : accessGuidanceNamedSource;
      const accessGuidancePositionalBindings = usesAccessGuidanceVariant
        ? buildPositionalBindingsFromNamed(
          accessGuidanceNamedBindings,
          accessGuidanceLegacySource,
          templateVariables
        )
        : normalizePositionalBindings(accessGuidanceVariant?.variables);
      const nextAccessGuidanceVariant = accessGuidanceVariant
        ? {
            ...accessGuidanceVariant,
            template_id: accessGuidanceMatchesReference && Number.isFinite(templateId) && templateId > 0
              ? String(templateId)
              : (accessGuidanceVariant.template_id || ''),
            template_name: accessGuidanceMatchesReference
              ? (templateName || accessGuidanceVariant.template_name || '')
              : (accessGuidanceVariant.template_name || ''),
            catalog_template_id: usesAccessGuidanceVariant && Number.isFinite(catalogTemplateId) && catalogTemplateId > 0
              ? catalogTemplateId
              : (accessGuidanceVariant.catalog_template_id || null),
            variables_named: accessGuidanceNamedBindings,
            variables: accessGuidancePositionalBindings,
          }
        : null;

      const nextConfig = {
        ...config,
        template_id: primaryMatchesReference && Number.isFinite(templateId) && templateId > 0
          ? String(templateId)
          : config.template_id,
        template_name: primaryMatchesReference
          ? (templateName || config.template_name || '')
          : (config.template_name || ''),
        catalog_template_id: usesPrimaryTemplate && Number.isFinite(catalogTemplateId) && catalogTemplateId > 0
          ? catalogTemplateId
          : (config.catalog_template_id || null),
        variables_named: namedBindings,
        variables: positionalBindings,
        fallback_template_id: fallbackMatchesReference && Number.isFinite(templateId) && templateId > 0
          ? String(templateId)
          : (config.fallback_template_id || ''),
        fallback_template_name: fallbackMatchesReference
          ? (templateName || config.fallback_template_name || '')
          : (config.fallback_template_name || ''),
        fallback_catalog_template_id: usesFallbackTemplate && Number.isFinite(catalogTemplateId) && catalogTemplateId > 0
          ? catalogTemplateId
          : (config.fallback_catalog_template_id || null),
        fallback_variables_named: fallbackNamedBindings,
        fallback_variables: fallbackPositionalBindings,
        ...(nextAccessGuidanceVariant
          ? { access_guidance_variant: nextAccessGuidanceVariant }
          : {}),
      };

      if (JSON.stringify(nextConfig) !== JSON.stringify(config)) {
        changed = true;
        nodesTouched += 1;
        return {
          ...node,
          config: nextConfig,
        };
      }
      return node;
    });

    if (!changed) continue;

    flowTemplate.nodes = nextNodes;
    await flowTemplate.save();
    templateVersionsTouched += 1;
  }

  logger.info?.('Recompuestas automatizaciones ligadas a plantilla WhatsApp', {
    templateId,
    templateName,
    catalogTemplateId: Number.isFinite(catalogTemplateId) ? catalogTemplateId : null,
    templateVersionsTouched,
    nodesTouched,
  });

  return {
    success: true,
    template_id: templateId,
    template_name: templateName,
    catalog_template_id: Number.isFinite(catalogTemplateId) ? catalogTemplateId : null,
    template_versions_touched: templateVersionsTouched,
    nodes_touched: nodesTouched,
  };
}

module.exports = {
  nodeUsesTemplate,
  recomposeAutomationsUsingTemplate,
};
