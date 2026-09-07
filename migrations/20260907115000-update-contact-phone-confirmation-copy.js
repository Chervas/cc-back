'use strict';

const COPY_BY_CATALOG_ID = Object.freeze({
  25: Object.freeze({
    catalog: 'Perdona por escribirte de nuevo {{1}} 😅, sé que acabamos de hablar, pero mandamos este mensaje para confirmar que el teléfono de contacto es correcto. ¿Nos confirmas que lo es? Así luego podemos recordarte tu cita el día de antes 🙏🙏',
    manual: 'Perdona por escribirte de nuevo {{paciente.nombre}} 😅, sé que acabamos de hablar, pero mandamos este mensaje para confirmar que el teléfono de contacto es correcto. ¿Nos confirmas que lo es? Así luego podemos recordarte tu cita el día de antes 🙏🙏',
  }),
  88: Object.freeze({
    catalog: 'Perdona per escriure’t de nou {{1}} 😅, sé que acabem de parlar, però enviem aquest missatge per confirmar que el telèfon de contacte és correcte. Ens confirmes que ho és? Així després et podrem recordar la cita el dia abans 🙏🙏',
    manual: 'Perdona per escriure’t de nou {{paciente.nombre}} 😅, sé que acabem de parlar, però enviem aquest missatge per confirmar que el telèfon de contacte és correcte. Ens confirmes que ho és? Així després et podrem recordar la cita el dia abans 🙏🙏',
  }),
  89: Object.freeze({
    catalog: 'Sorry to write to you again {{1}} 😅. I know we just spoke, but we are sending this message to confirm that the contact phone number is correct. Could you confirm that it is? That way we can remind you about your appointment the day before 🙏🙏',
    manual: 'Sorry to write to you again {{paciente.nombre}} 😅. I know we just spoke, but we are sending this message to confirm that the contact phone number is correct. Could you confirm that it is? That way we can remind you about your appointment the day before 🙏🙏',
  }),
});

const TARGET_CATALOG_IDS = new Set(Object.keys(COPY_BY_CATALOG_ID).map(Number));
const TARGET_FAMILY = 'clinicaclick_confirmacion_datos_cita_48_sin_respuesta';

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch (_error) {
    return fallback;
  }
}

function toCatalogId(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getCatalogId(config) {
  return toCatalogId(config?.fallback_catalog_template_id)
    || toCatalogId(config?.catalog_template_id);
}

function updateBodyComponent(components, bodyText) {
  const parsed = parseJson(components, []);
  if (!Array.isArray(parsed) || !parsed.length) {
    return [{ type: 'BODY', text: bodyText }];
  }

  let foundBody = false;
  const updated = parsed.map((component) => {
    if (String(component?.type || '').trim().toUpperCase() !== 'BODY') return component;
    foundBody = true;
    return { ...component, text: bodyText };
  });
  return foundBody ? updated : [...updated, { type: 'BODY', text: bodyText }];
}

function updateSendNodeConfig(config) {
  const next = { ...(config || {}) };
  let changed = false;
  const baseCopy = COPY_BY_CATALOG_ID[getCatalogId(next)];
  if (baseCopy && next.manual_message_text !== baseCopy.manual) {
    next.manual_message_text = baseCopy.manual;
    changed = true;
  }

  const routing = next.language_routing && typeof next.language_routing === 'object'
    ? { ...next.language_routing }
    : null;
  const variants = routing?.variants && typeof routing.variants === 'object' && !Array.isArray(routing.variants)
    ? { ...routing.variants }
    : null;

  if (variants) {
    for (const [locale, variant] of Object.entries(variants)) {
      if (!variant || typeof variant !== 'object') continue;
      const copy = COPY_BY_CATALOG_ID[getCatalogId(variant)];
      if (!copy || variant.manual_message_text === copy.manual) continue;
      variants[locale] = { ...variant, manual_message_text: copy.manual };
      changed = true;
    }
    if (changed) {
      routing.variants = variants;
      next.language_routing = routing;
    }
  }

  return { config: next, changed };
}

function updateAutomationNodes(nodes) {
  let changed = false;
  const updated = (Array.isArray(nodes) ? nodes : []).map((node) => {
    if (!node || String(node.type || '').trim() !== 'action/send_whatsapp') return node;
    const result = updateSendNodeConfig(node.config);
    if (!result.changed) return node;
    changed = true;
    return { ...node, config: result.config };
  });
  return { nodes: updated, changed };
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const ids = [...TARGET_CATALOG_IDS];
      const catalogs = await queryInterface.sequelize.query(
        `SELECT id, components
           FROM WhatsappTemplateCatalog
          WHERE id IN (:ids)
          FOR UPDATE`,
        {
          replacements: { ids },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );

      for (const catalog of catalogs) {
        const copy = COPY_BY_CATALOG_ID[Number(catalog.id)];
        if (!copy) continue;
        await queryInterface.sequelize.query(
          `UPDATE WhatsappTemplateCatalog
              SET body_text = :bodyText,
                  components = :components,
                  propagation_state = NULL,
                  last_propagated_at = NULL,
                  updated_at = NOW()
            WHERE id = :id`,
          {
            replacements: {
              id: Number(catalog.id),
              bodyText: copy.catalog,
              components: JSON.stringify(updateBodyComponent(catalog.components, copy.catalog)),
            },
            transaction,
          },
        );
      }

      const templates = await queryInterface.sequelize.query(
        `SELECT id, nodes
           FROM AutomationFlowTemplatesV2
          WHERE is_active = 1
            AND CAST(nodes AS CHAR) LIKE :familyMatch
          FOR UPDATE`,
        {
          replacements: { familyMatch: `%${TARGET_FAMILY}%` },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );

      for (const template of templates) {
        const result = updateAutomationNodes(parseJson(template.nodes, []));
        if (!result.changed) continue;
        await queryInterface.sequelize.query(
          `UPDATE AutomationFlowTemplatesV2
              SET nodes = :nodes,
                  updated_at = NOW()
            WHERE id = :id`,
          {
            replacements: {
              id: Number(template.id),
              nodes: JSON.stringify(result.nodes),
            },
            transaction,
          },
        );
      }
    });
  },

  async down() {
    // Meta versions are append-only; reverting would reintroduce misleading copy.
  },

  _test: {
    COPY_BY_CATALOG_ID,
    TARGET_CATALOG_IDS,
    TARGET_FAMILY,
    updateAutomationNodes,
    updateBodyComponent,
    updateSendNodeConfig,
  },
};
