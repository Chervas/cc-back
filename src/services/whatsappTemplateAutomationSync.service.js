'use strict';

const db = require('../../models');
const {
  buildWhatsappTemplateVariableContract,
  normalizeNamedBindings,
  normalizePositionalBindings,
  buildNamedBindingsFromPositional,
  buildPositionalBindingsFromNamed,
} = require('../lib/whatsapp-template-contract');

const { AutomationFlowTemplateV2, WhatsappTemplateCatalog } = db;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nodeUsesTemplate(node, { templateId, templateName, catalogTemplateId }) {
  if (!node || String(node.type || '').toLowerCase() !== 'action/send_whatsapp') return false;
  const config = isObject(node.config) ? node.config : {};
  const nodeTemplateId = cleanString(config.template_id);
  const nodeTemplateName = cleanString(config.template_name).toLowerCase();
  const nodeCatalogTemplateId = Number(config.catalog_template_id);
  const nodeFallbackTemplateId = cleanString(config.fallback_template_id);
  const nodeFallbackTemplateName = cleanString(config.fallback_template_name).toLowerCase();
  const nodeFallbackCatalogTemplateId = Number(config.fallback_catalog_template_id);
  return (
    (templateId && nodeTemplateId === String(templateId))
    || (!!templateName && !!nodeTemplateName && nodeTemplateName === String(templateName).trim().toLowerCase())
    || (Number.isFinite(nodeCatalogTemplateId) && nodeCatalogTemplateId > 0 && nodeCatalogTemplateId === Number(catalogTemplateId))
    || (templateId && nodeFallbackTemplateId === String(templateId))
    || (!!templateName && !!nodeFallbackTemplateName && nodeFallbackTemplateName === String(templateName).trim().toLowerCase())
    || (Number.isFinite(nodeFallbackCatalogTemplateId) && nodeFallbackCatalogTemplateId > 0 && nodeFallbackCatalogTemplateId === Number(catalogTemplateId))
  );
}

async function recomposeAutomationsUsingTemplate({ templateInstance, logger = console }) {
  if (!templateInstance) {
    return { success: false, error: 'template_instance_required' };
  }

  const templateJson = templateInstance.toJSON ? templateInstance.toJSON() : templateInstance;
  if (!templateJson.catalog && Number(templateJson.catalog_template_id)) {
    const catalog = await WhatsappTemplateCatalog.findByPk(Number(templateJson.catalog_template_id), {
      attributes: ['id', 'variables'],
      raw: true,
    });
    if (catalog) {
      templateJson.catalog = catalog;
    }
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
      const usesPrimaryTemplate = (
        (templateId && cleanString(config.template_id) === String(templateId))
        || (!!templateName && cleanString(config.template_name).toLowerCase() === String(templateName).trim().toLowerCase())
        || (Number.isFinite(Number(config.catalog_template_id)) && Number(config.catalog_template_id) === Number(catalogTemplateId))
      );
      const usesFallbackTemplate = (
        (templateId && cleanString(config.fallback_template_id) === String(templateId))
        || (!!templateName && cleanString(config.fallback_template_name).toLowerCase() === String(templateName).trim().toLowerCase())
        || (Number.isFinite(Number(config.fallback_catalog_template_id)) && Number(config.fallback_catalog_template_id) === Number(catalogTemplateId))
      );

      const namedBindings = usesPrimaryTemplate
        ? (Object.keys(normalizeNamedBindings(config.variables_named)).length
          ? normalizeNamedBindings(config.variables_named)
          : buildNamedBindingsFromPositional(config.variables, templateVariables))
        : normalizeNamedBindings(config.variables_named);
      const positionalBindings = usesPrimaryTemplate
        ? buildPositionalBindingsFromNamed(namedBindings, config.variables, templateVariables)
        : normalizePositionalBindings(config.variables);
      const fallbackNamedBindings = usesFallbackTemplate
        ? (Object.keys(normalizeNamedBindings(config.fallback_variables_named)).length
          ? normalizeNamedBindings(config.fallback_variables_named)
          : buildNamedBindingsFromPositional(config.fallback_variables, templateVariables))
        : normalizeNamedBindings(config.fallback_variables_named);
      const fallbackPositionalBindings = usesFallbackTemplate
        ? buildPositionalBindingsFromNamed(
          fallbackNamedBindings,
          config.fallback_variables,
          templateVariables
        )
        : normalizePositionalBindings(config.fallback_variables);

      const nextConfig = {
        ...config,
        template_id: usesPrimaryTemplate && Number.isFinite(templateId) && templateId > 0
          ? String(templateId)
          : config.template_id,
        template_name: usesPrimaryTemplate
          ? (templateName || config.template_name || '')
          : (config.template_name || ''),
        catalog_template_id: usesPrimaryTemplate && Number.isFinite(catalogTemplateId) && catalogTemplateId > 0
          ? catalogTemplateId
          : (config.catalog_template_id || null),
        variables_named: namedBindings,
        variables: positionalBindings,
        fallback_template_id: usesFallbackTemplate && Number.isFinite(templateId) && templateId > 0
          ? String(templateId)
          : (config.fallback_template_id || ''),
        fallback_template_name: usesFallbackTemplate
          ? (templateName || config.fallback_template_name || '')
          : (config.fallback_template_name || ''),
        fallback_catalog_template_id: usesFallbackTemplate && Number.isFinite(catalogTemplateId) && catalogTemplateId > 0
          ? catalogTemplateId
          : (config.fallback_catalog_template_id || null),
        fallback_variables_named: fallbackNamedBindings,
        fallback_variables: fallbackPositionalBindings,
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
  recomposeAutomationsUsingTemplate,
};
