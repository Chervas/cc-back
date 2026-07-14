'use strict';

const BASE_TEMPLATE_NAME = 'clinicaclick_recordatorio_mismo_dia_primera_visita';
const VARIANT_TEMPLATE_NAME = 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil';
const VARIANT_DISPLAY_NAME = 'Recordatorio mismo día 8:00 (primera visita - clínica con difícil acceso)';
const IMAGE_SAMPLE_URL = 'https://media.clinicaclick.com/templates/reviews/team-example.jpg';
const TRIGGER_TYPE = 'appointment_reminder_window';

const TEMPLATE_BODY = [
  'Hola {{1}}, tenemos todo preparado para recibirte hoy a las {{2}}.',
  '',
  'Estamos en {{3}}',
  '',
  'Te dejo un enlace con la ubicación: {{4}}',
  '',
  '¿Sabes llegar? ¿Necesitas alguna indicación? Para facilitarte te dejo más indicaciones:',
  '',
  '{{5}}',
  '',
  // Meta no admite que el BODY termine en una variable: este cierre fijo es
  // parte del contrato operativo y evita un rechazo de validacion.
  'Si necesitas ayuda, respóndenos por aquí.',
].join('\n');

const TEMPLATE_VARIABLES = [
  {
    position: 1,
    name: 'nombre_paciente',
    example: 'María',
    description: 'Nombre del paciente',
  },
  {
    position: 2,
    name: 'hora_cita',
    example: '10:30',
    description: 'Hora de la cita programada',
  },
  {
    position: 3,
    name: 'direccion_clinica',
    example: 'Calle Mayor 123, Madrid',
    description: 'Dirección completa de la clínica',
  },
  {
    position: 4,
    name: 'url_como_llegar_clinica',
    example: 'https://www.google.com/maps/dir/?api=1&destination=Clinica',
    description: 'Enlace de Google Maps con indicaciones para llegar a la clínica',
  },
  {
    position: 5,
    name: 'indicaciones_acceso_clinica',
    example: 'Entra por el pasaje lateral junto a la farmacia y sube a la primera planta.',
    description: 'Indicaciones adicionales para encontrar el acceso de la clínica',
  },
];

const TEMPLATE_COMPONENTS = [
  {
    type: 'HEADER',
    format: 'IMAGE',
    example: {
      header_handle: [IMAGE_SAMPLE_URL],
    },
  },
  {
    type: 'BODY',
    text: TEMPLATE_BODY,
    example: {
      body_text: [[
        'María',
        '10:30',
        'Calle Mayor 123, Madrid',
        'https://www.google.com/maps/dir/?api=1&destination=Clinica',
        'Entra por el pasaje lateral junto a la farmacia y sube a la primera planta.',
      ]],
    },
  },
];

const VARIANT_NODE_CONFIG = {
  enabled: true,
  template_name: VARIANT_TEMPLATE_NAME,
  catalog_template_id: null,
  require_current_catalog_body: true,
  appointment_types: ['primera_sin_trat', 'primera_con_trat'],
  image_url: '{{clinica.access_guidance_image_url}}',
  variables_named: {
    nombre_paciente: '{{paciente.nombre}}',
    hora_cita: '{{cita.hora}}',
    direccion_clinica: '{{clinica.direccion}}',
    url_como_llegar_clinica: '{{clinica.url_como_llegar}}',
    indicaciones_acceso_clinica: '{{clinica.indicaciones_acceso}}',
  },
};

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function pickExistingColumns(payload, tableDefinition) {
  return Object.entries(payload).reduce((result, [key, value]) => {
    if (tableDefinition[key]) result[key] = value;
    return result;
  }, {});
}

async function findCatalogId(queryInterface, name, transaction = null) {
  const rows = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    }
  );
  return rows[0]?.id || null;
}

async function insertCatalogTemplate(queryInterface, now, transaction) {
  const existingId = await findCatalogId(queryInterface, VARIANT_TEMPLATE_NAME, transaction);
  if (existingId) {
    throw new Error('access_guidance_catalog_template_already_exists');
  }
  const tableDefinition = await queryInterface.describeTable('WhatsappTemplateCatalog');
  const payload = pickExistingColumns({
    display_name: VARIANT_DISPLAY_NAME,
    category: 'UTILITY',
    body_text: TEMPLATE_BODY,
    variables: JSON.stringify(TEMPLATE_VARIABLES),
    components: JSON.stringify(TEMPLATE_COMPONENTS),
    is_generic: true,
    is_active: true,
    propagation_state: null,
    updated_at: now,
  }, tableDefinition);

  await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
    name: VARIANT_TEMPLATE_NAME,
    ...payload,
    created_at: now,
  }], { transaction });
  return findCatalogId(queryInterface, VARIANT_TEMPLATE_NAME, transaction);
}

function isBaseReminderNode(node, baseCatalogId) {
  if (node?.type !== 'action/send_whatsapp' || !node.config) return false;
  const templateName = String(node.config.template_name || '').trim();
  const catalogTemplateId = Number.parseInt(String(node.config.catalog_template_id || ''), 10);
  return templateName === BASE_TEMPLATE_NAME
    || (!!baseCatalogId && catalogTemplateId === Number(baseCatalogId));
}

async function updateCurrentReminderNodes(
  queryInterface,
  variantCatalogId,
  {
    remove = false,
    transaction = null,
    effectiveTemplateIds = [],
    effectiveTemplateNames = [],
  } = {}
) {
  const baseCatalogId = await findCatalogId(queryInterface, BASE_TEMPLATE_NAME, transaction);
  const rows = await queryInterface.sequelize.query(
    `
      SELECT id, nodes
      FROM AutomationFlowTemplatesV2
      WHERE trigger_type = :triggerType
        ${remove ? '' : 'AND is_active = 1'}
    `,
    {
      replacements: { triggerType: TRIGGER_TYPE },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    }
  );

  for (const row of rows) {
    const nodes = parseJson(row.nodes, []);
    if (!Array.isArray(nodes)) continue;
    let changed = false;
    const nextNodes = nodes.map((node) => {
      if (!isBaseReminderNode(node, baseCatalogId)) return node;
      const nextConfig = { ...node.config };
      if (remove) {
        const currentVariant = nextConfig.access_guidance_variant;
        const currentVariantName = String(currentVariant?.template_name || '').trim();
        const currentVariantCatalogId = Number.parseInt(String(currentVariant?.catalog_template_id || ''), 10);
        const currentVariantTemplateId = Number.parseInt(String(currentVariant?.template_id || ''), 10);
        const belongsToVariant = currentVariant
          && (
            currentVariantName === VARIANT_TEMPLATE_NAME
            || currentVariantName.startsWith(`${VARIANT_TEMPLATE_NAME}_v`)
            || effectiveTemplateNames.includes(currentVariantName)
            || currentVariantCatalogId === Number(variantCatalogId)
            || effectiveTemplateIds.includes(currentVariantTemplateId)
          );
        if (!belongsToVariant) return node;
        delete nextConfig.access_guidance_variant;
      } else {
        if (nextConfig.access_guidance_variant) {
          throw new Error(`access_guidance_variant_already_configured:${row.id}:${node.id || 'unknown'}`);
        }
        nextConfig.access_guidance_variant = {
          ...VARIANT_NODE_CONFIG,
          catalog_template_id: variantCatalogId || null,
        };
      }
      changed = true;
      return { ...node, config: nextConfig };
    });

    if (changed) {
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(nextNodes), updated_at: new Date() },
        { id: row.id },
        { transaction }
      );
    }
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const now = new Date();
      const variantCatalogId = await insertCatalogTemplate(queryInterface, now, transaction);
      await updateCurrentReminderNodes(queryInterface, variantCatalogId, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const variantCatalogId = await findCatalogId(
        queryInterface,
        VARIANT_TEMPLATE_NAME,
        transaction
      );
      if (!variantCatalogId) return;
      const effectiveTemplates = await queryInterface.sequelize.query(
        `
          SELECT id, name
          FROM WhatsappTemplates
          WHERE catalog_template_id = :variantCatalogId
             OR name = :variantName
             OR name LIKE :versionedVariantName
        `,
        {
          replacements: {
            variantCatalogId,
            variantName: VARIANT_TEMPLATE_NAME,
            versionedVariantName: `${VARIANT_TEMPLATE_NAME}_v%`,
          },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        }
      );
      await updateCurrentReminderNodes(queryInterface, variantCatalogId, {
        remove: true,
        transaction,
        effectiveTemplateIds: effectiveTemplates.map((template) => Number(template.id)),
        effectiveTemplateNames: effectiveTemplates.map((template) => String(template.name || '')),
      });
      const effectiveTemplateIds = effectiveTemplates.map((template) => Number(template.id));
      if (effectiveTemplateIds.length) {
        await queryInterface.bulkUpdate(
          'WhatsappTemplates',
          { is_active: false, updatedAt: new Date() },
          { id: effectiveTemplateIds },
          { transaction }
        );
      }
      await queryInterface.bulkDelete(
        'WhatsappTemplateCatalog',
        { id: variantCatalogId },
        { transaction }
      );
    });
  },
};
