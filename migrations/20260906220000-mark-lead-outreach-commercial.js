'use strict';

const BASE_TEMPLATE_KEY = 'lead_auto_reply_system';
const BASE_PUBLIC_ID = 'flw_lead_auto_reply_system';
const CATALOG_NAME = 'auto_bienvenida_lead';
const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'mark_lead_outreach_commercial_20260906';
const LEAD_FAMILIES = [
  'clinicaclick_lead_primera_visita_programar',
  'clinicaclick_lead_primera_visita_con_llamada',
];

const BUTTONS_COMPONENT = {
  type: 'BUTTONS',
  buttons: [
    { type: 'QUICK_REPLY', text: 'Quiero una cita' },
    { type: 'QUICK_REPLY', text: 'Ya no estoy interesado' },
  ],
};

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch (_error) {
    return fallback;
  }
}

function withLeadButtons(value) {
  const components = parseJson(value, []);
  const withoutButtons = components.filter((component) => (
    String(component?.type || '').toUpperCase() !== 'BUTTONS'
  ));
  return [...withoutButtons, BUTTONS_COMPONENT];
}

function markLeadNodesCommercial(value) {
  return parseJson(value, []).map((node) => {
    if (String(node?.type || '').toLowerCase() !== 'action/send_whatsapp') return node;
    const usage = String(node?.config?.template_usage || '').trim().toLowerCase();
    if (!['lead_auto_reply', 'lead_primera_visita'].includes(usage)) return node;
    return {
      ...node,
      config: {
        ...(node.config || {}),
        communication_scope: 'marketing',
      },
    };
  });
}

function pickExistingColumns(payload, definition) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => definition[key]));
}

async function versionManagedLeadFlows(queryInterface, now, transaction) {
  const clinicTemplatePrefix = `${BASE_TEMPLATE_KEY}__clinic_`;
  const rows = await queryInterface.sequelize.query(
    `
      SELECT id, public_id, template_key, version, engine_version, name, description,
             trigger_type, trigger_config, is_active, is_system, clinic_id, group_id,
             entry_node_id, nodes, published_at, published_by, created_by
      FROM AutomationFlowTemplatesV2
      WHERE published_at IS NOT NULL
        AND (
          template_key = :baseTemplateKey
          OR LEFT(template_key, CHAR_LENGTH(:clinicTemplatePrefix)) = :clinicTemplatePrefix
          OR JSON_UNQUOTE(JSON_EXTRACT(trigger_config, '$.managed_feature')) = 'lead_auto_reply'
        )
      ORDER BY public_id ASC, version DESC, id DESC
      FOR UPDATE
    `,
    {
      replacements: {
        baseTemplateKey: BASE_TEMPLATE_KEY,
        clinicTemplatePrefix,
      },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  const latestByPublicId = new Map();
  for (const row of rows) {
    if (!latestByPublicId.has(row.public_id)) latestByPublicId.set(row.public_id, row);
  }
  const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  const inserted = [];

  for (const source of latestByPublicId.values()) {
    const currentNodes = parseJson(source.nodes, []);
    const nodes = markLeadNodesCommercial(currentNodes);
    const triggerConfig = {
      ...(parseJson(source.trigger_config, {}) || {}),
      communication_scope: 'marketing',
    };
    const alreadyCommercial = JSON.stringify(nodes) === JSON.stringify(currentNodes)
      && parseJson(source.trigger_config, {})?.communication_scope === 'marketing';
    if (alreadyCommercial) continue;

    const maxVersion = Math.max(
      ...rows.filter((row) => row.public_id === source.public_id).map((row) => Number(row.version) || 0),
    );
    const nextVersion = maxVersion + 1;
    if (Number(source.is_active) === 1) {
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: false, updated_at: now },
        { id: source.id },
        { transaction },
      );
    }
    await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [pickExistingColumns({
      public_id: source.public_id,
      template_key: source.template_key,
      version: nextVersion,
      engine_version: source.engine_version || 'v2',
      name: source.name,
      description: source.description,
      trigger_type: source.trigger_type,
      trigger_config: JSON.stringify(triggerConfig),
      is_active: Number(source.is_active) === 1,
      is_system: Number(source.is_system) === 1,
      clinic_id: source.clinic_id,
      group_id: source.group_id,
      entry_node_id: source.entry_node_id,
      nodes: JSON.stringify(nodes),
      published_at: now,
      published_by: source.published_by || source.created_by,
      created_by: source.created_by || 1,
      created_at: now,
      updated_at: now,
    }, definition)], { transaction });
    const insertedRows = await queryInterface.sequelize.query(
      `SELECT id FROM AutomationFlowTemplatesV2
        WHERE public_id = :publicId AND version = :version
        LIMIT 1`,
      {
        replacements: { publicId: source.public_id, version: nextVersion },
        type: queryInterface.sequelize.QueryTypes.SELECT,
        transaction,
      },
    );
    if (!insertedRows[0]?.id) throw new Error('lead_commercial_flow_version_insert_failed');
    inserted.push({
      id: Number(insertedRows[0].id),
      public_id: source.public_id,
      previous_id: Number(source.id),
      previous_was_active: Number(source.is_active) === 1,
      version: nextVersion,
    });
  }
  return inserted;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existingSnapshots = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE}
          WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existingSnapshots.length) return;

      const now = new Date();
      const catalogs = await queryInterface.sequelize.query(
        `SELECT id, family_key, category, components, propagation_state, last_propagated_at
         FROM WhatsappTemplateCatalog
         WHERE family_key IN (:families) AND locale = 'es'
         FOR UPDATE`,
        {
          replacements: { families: LEAD_FAMILIES },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const foundFamilies = new Set(catalogs.map((catalog) => catalog.family_key));
      const missingFamilies = LEAD_FAMILIES.filter((family) => !foundFamilies.has(family));
      if (missingFamilies.length) {
        throw new Error(`lead_commercial_catalogs_missing:${missingFamilies.join(',')}`);
      }

      const automationCatalogRows = await queryInterface.sequelize.query(
        `SELECT id, template_key, template_version
           FROM AutomationFlowCatalog
          WHERE name = :name
          LIMIT 1
          FOR UPDATE`,
        {
          replacements: { name: CATALOG_NAME },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const automationCatalog = automationCatalogRows[0] || null;
      const inserted = await versionManagedLeadFlows(queryInterface, now, transaction);

      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({
          catalogs: catalogs.map((catalog) => ({
            id: Number(catalog.id),
            category: catalog.category,
            components: parseJson(catalog.components, []),
            propagation_state: catalog.propagation_state,
            last_propagated_at: catalog.last_propagated_at,
          })),
          automation_catalog: automationCatalog ? {
            id: Number(automationCatalog.id),
            template_key: automationCatalog.template_key,
            template_version: automationCatalog.template_version,
          } : null,
          inserted,
        }),
        created_at: now,
        updated_at: now,
      }], { transaction });

      for (const catalog of catalogs) {
        await queryInterface.bulkUpdate('WhatsappTemplateCatalog', {
          category: 'MARKETING',
          components: JSON.stringify(withLeadButtons(catalog.components)),
          propagation_state: null,
          last_propagated_at: null,
          updated_at: now,
        }, { id: catalog.id }, { transaction });
      }

      const systemVersion = inserted.find((item) => item.public_id === BASE_PUBLIC_ID)?.version;
      if (systemVersion) {
        await queryInterface.bulkUpdate('AutomationFlowCatalog', {
          template_key: BASE_TEMPLATE_KEY,
          template_version: systemVersion,
          updated_at: now,
        }, { name: CATALOG_NAME }, { transaction });
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const now = new Date();
      const snapshotRows = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE}
          WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshot = parseJson(snapshotRows[0]?.payload, null);
      if (!snapshot) return;

      for (const item of snapshot.inserted || []) {
        const rows = await queryInterface.sequelize.query(
          `SELECT template.id,
                  (SELECT COUNT(*) FROM FlowExecutionsV2 execution
                    WHERE execution.template_version_id = template.id) AS execution_count,
                  (SELECT COUNT(*) FROM AutomationFlowTemplatesV2 newer
                    WHERE newer.public_id = template.public_id
                      AND newer.version > template.version) AS newer_count
             FROM AutomationFlowTemplatesV2 template
            WHERE template.id = :id
            FOR UPDATE`,
          {
            replacements: { id: Number(item.id) },
            type: queryInterface.sequelize.QueryTypes.SELECT,
            transaction,
          },
        );
        const inserted = rows[0];
        if (!inserted) throw new Error('lead_commercial_flow_version_missing');
        if (Number(inserted.execution_count) > 0 || Number(inserted.newer_count) > 0) {
          throw new Error('lead_commercial_flow_versions_no_longer_reversible');
        }
      }

      for (const catalog of snapshot.catalogs || []) {
        await queryInterface.bulkUpdate('WhatsappTemplateCatalog', {
          category: catalog.category,
          components: JSON.stringify(catalog.components || []),
          propagation_state: null,
          last_propagated_at: null,
          updated_at: now,
        }, { id: catalog.id }, { transaction });
      }

      if (snapshot.automation_catalog?.id) {
        await queryInterface.bulkUpdate('AutomationFlowCatalog', {
          template_key: snapshot.automation_catalog.template_key,
          template_version: snapshot.automation_catalog.template_version,
          updated_at: now,
        }, { id: Number(snapshot.automation_catalog.id) }, { transaction });
      }

      for (const item of snapshot.inserted || []) {
        await queryInterface.bulkDelete(
          'AutomationFlowTemplatesV2',
          { id: Number(item.id) },
          { transaction },
        );
        if (item.previous_was_active) {
          await queryInterface.bulkUpdate(
            'AutomationFlowTemplatesV2',
            { is_active: true, updated_at: now },
            { id: Number(item.previous_id) },
            { transaction },
          );
        }
      }
      await queryInterface.bulkDelete(
        SNAPSHOT_TABLE,
        { snapshot_key: SNAPSHOT_KEY },
        { transaction },
      );
    });
  },

  __testing: {
    markLeadNodesCommercial,
    withLeadButtons,
    SNAPSHOT_KEY,
  },
};
