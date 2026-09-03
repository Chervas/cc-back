'use strict';

const {
  markCanonicalBenignAcknowledgementExit,
} = require('../src/lib/automation-intent-migration');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'close_benign_appointment_acknowledgements_v1';
const MESSAGE_RECEIVED_PUBLIC_ID = 'flw_message_received_after_hours';

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function pickExistingColumns(payload, definition) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => definition[key]));
}

async function loadTemplateRows(queryInterface, transaction) {
  return queryInterface.sequelize.query(
    `
      SELECT id, public_id, template_key, version, engine_version, name, description,
             trigger_type, trigger_config, is_active, is_system, clinic_id, group_id,
             entry_node_id, nodes, published_at, published_by, created_by
      FROM AutomationFlowTemplatesV2
      WHERE engine_version = 'v2'
      ORDER BY public_id ASC, version DESC, id DESC
      FOR UPDATE
    `,
    { type: queryInterface.sequelize.QueryTypes.SELECT, transaction },
  );
}

function groupByPublicId(rows) {
  const families = new Map();
  for (const row of rows) {
    if (!families.has(row.public_id)) families.set(row.public_id, []);
    families.get(row.public_id).push(row);
  }
  return families;
}

async function readSnapshot(queryInterface, transaction) {
  const rows = await queryInterface.sequelize.query(
    `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
    {
      replacements: { snapshotKey: SNAPSHOT_KEY },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  return parseJson(rows[0]?.payload, null);
}

async function saveSnapshot(queryInterface, payload, now, transaction) {
  await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
    snapshot_key: SNAPSHOT_KEY,
    payload: JSON.stringify(payload),
    created_at: now,
    updated_at: now,
  }], { transaction });
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const now = new Date();
      const existingSnapshot = await readSnapshot(queryInterface, transaction);
      if (Array.isArray(existingSnapshot)) {
        for (const item of existingSnapshot) {
          const newerActive = await queryInterface.sequelize.query(
            `
              SELECT id FROM AutomationFlowTemplatesV2
              WHERE public_id = :publicId AND is_active = 1 AND version > :version
              LIMIT 1
            `,
            {
              replacements: { publicId: item.public_id, version: item.version },
              type: queryInterface.sequelize.QueryTypes.SELECT,
              transaction,
            },
          );
          if (newerActive[0] || !item.preserved_active) continue;
          await queryInterface.bulkUpdate(
            'AutomationFlowTemplatesV2',
            { is_active: false, updated_at: now },
            { id: item.previous_id },
            { transaction },
          );
          await queryInterface.bulkUpdate(
            'AutomationFlowTemplatesV2',
            { is_active: true, updated_at: now },
            { public_id: item.public_id, version: item.version },
            { transaction },
          );
        }
        return;
      }

      const rows = await loadTemplateRows(queryInterface, transaction);
      const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
      const previousJobsAutoStart = process.env.JOBS_AUTO_START;
      process.env.JOBS_AUTO_START = 'false';
      let validateFlowPayloadForInternalUse;
      try {
        ({ validateFlowPayloadForInternalUse } = require('../src/controllers/automationsV2.controller'));
      } finally {
        if (previousJobsAutoStart === undefined) delete process.env.JOBS_AUTO_START;
        else process.env.JOBS_AUTO_START = previousJobsAutoStart;
      }

      const candidates = [];
      for (const familyRows of groupByPublicId(rows).values()) {
        const latestPublished = familyRows.find((row) => row.published_at) || null;
        if (!latestPublished) continue;
        const patched = markCanonicalBenignAcknowledgementExit(
          parseJson(latestPublished.nodes, []),
          { includeUnmarked: latestPublished.public_id === MESSAGE_RECEIVED_PUBLIC_ID },
        );
        if (!patched.changed) continue;

        const validation = await validateFlowPayloadForInternalUse({
          entry_node_id: latestPublished.entry_node_id,
          trigger_type: latestPublished.trigger_type,
          nodes: patched.nodes,
        });
        if (!validation.ok) {
          const codes = Array.from(new Set(
            validation.errors.map((error) => String(error?.code || 'invalid_flow')),
          ));
          throw new Error(
            `benign_acknowledgement_exit_validation_failed:${latestPublished.public_id}:${codes.join(',')}`,
          );
        }

        candidates.push({
          source: latestPublished,
          nodes: patched.nodes,
          patched: patched.patched,
          version: Math.max(...familyRows.map((row) => Number(row.version) || 0)) + 1,
        });
      }

      await saveSnapshot(queryInterface, candidates.map((candidate) => ({
        public_id: candidate.source.public_id,
        previous_id: Number(candidate.source.id),
        version: candidate.version,
        preserved_active: Number(candidate.source.is_active) === 1,
        patched_nodes: candidate.patched,
      })), now, transaction);

      for (const candidate of candidates) {
        const source = candidate.source;
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
          version: candidate.version,
          engine_version: source.engine_version || 'v2',
          name: source.name,
          description: source.description,
          trigger_type: source.trigger_type,
          trigger_config: JSON.stringify(parseJson(source.trigger_config, null)),
          is_active: Number(source.is_active) === 1,
          is_system: Number(source.is_system) === 1,
          clinic_id: source.clinic_id,
          group_id: source.group_id,
          entry_node_id: source.entry_node_id,
          nodes: JSON.stringify(candidate.nodes),
          published_at: now,
          published_by: source.published_by || source.created_by,
          created_by: source.created_by,
          created_at: now,
          updated_at: now,
        }, definition)], { transaction });
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshot = await readSnapshot(queryInterface, transaction);
      if (!Array.isArray(snapshot)) return;
      const now = new Date();
      for (const item of snapshot) {
        const newerActive = await queryInterface.sequelize.query(
          `
            SELECT id FROM AutomationFlowTemplatesV2
            WHERE public_id = :publicId AND is_active = 1 AND version > :version
            LIMIT 1
          `,
          {
            replacements: { publicId: item.public_id, version: item.version },
            type: queryInterface.sequelize.QueryTypes.SELECT,
            transaction,
          },
        );
        if (newerActive[0]) continue;
        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { is_active: false, updated_at: now },
          { public_id: item.public_id, version: item.version },
          { transaction },
        );
        if (item.preserved_active) {
          await queryInterface.bulkUpdate(
            'AutomationFlowTemplatesV2',
            { is_active: true, updated_at: now },
            { id: item.previous_id },
            { transaction },
          );
        }
      }
    });
  },

  __test: {
    MESSAGE_RECEIVED_PUBLIC_ID,
    SNAPSHOT_KEY,
    groupByPublicId,
    parseJson,
  },
};
