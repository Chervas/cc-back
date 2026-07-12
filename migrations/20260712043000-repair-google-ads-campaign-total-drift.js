'use strict';

const MIGRATION_ID = '20260712043000';

function parseCount(rows, field) {
  const value = Number(rows?.[0]?.[field] ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${MIGRATION_ID}: invalid ${field} count`);
  }
  return value;
}

async function readLegacySnapshot(sequelize, transaction) {
  const [rows] = await sequelize.query(`
    SELECT
      COUNT(*) AS legacy_rows,
      COALESCE(SUM(CASE WHEN EXISTS (
        SELECT 1
        FROM GoogleAdsInsightsDaily AS normalized
        WHERE normalized.campaignId = legacy.campaignId
          AND normalized.date = legacy.date
          AND normalized.clinicGoogleAdsAccountId = legacy.clinicGoogleAdsAccountId
          AND normalized.adGroupId IS NULL
          AND normalized.network = 'CAMPAIGN_TOTAL'
          AND normalized.device = 'CAMPAIGN_TOTAL'
      ) THEN 1 ELSE 0 END), 0) AS duplicate_rows
    FROM GoogleAdsInsightsDaily AS legacy
    WHERE legacy.adGroupId IS NULL
      AND legacy.network IS NULL
      AND legacy.device IS NULL
  `, { transaction });

  const legacyRows = parseCount(rows, 'legacy_rows');
  const duplicateRows = parseCount(rows, 'duplicate_rows');
  if (duplicateRows > legacyRows) {
    throw new Error(`${MIGRATION_ID}: duplicate rows exceed legacy rows`);
  }

  return {
    legacyRows,
    duplicateRows,
    normalizeRows: legacyRows - duplicateRows,
  };
}

async function readAffectedRows(sequelize, transaction) {
  const [rows] = await sequelize.query('SELECT ROW_COUNT() AS affected_rows', { transaction });
  return parseCount(rows, 'affected_rows');
}

async function readDuplicateGroups(sequelize, transaction) {
  const [rows] = await sequelize.query(`
    SELECT COUNT(*) AS duplicate_groups
    FROM (
      SELECT
        campaignId,
        date,
        clinicGoogleAdsAccountId,
        COALESCE(adGroupId, '__CAMPAIGN__') AS ad_group_key,
        COALESCE(network, '__UNSPECIFIED__') AS network_key,
        COALESCE(device, '__UNSPECIFIED__') AS device_key
      FROM GoogleAdsInsightsDaily
      GROUP BY
        campaignId,
        date,
        clinicGoogleAdsAccountId,
        ad_group_key,
        network_key,
        device_key
      HAVING COUNT(*) > 1
    ) AS duplicate_dimensions
  `, { transaction });
  return parseCount(rows, 'duplicate_groups');
}

async function readReviewedAttributionPending(sequelize, transaction) {
  const [rows] = await sequelize.query(`
    SELECT COUNT(*) AS pending_rows
    FROM GoogleAdsInsightsDaily AS insights
    INNER JOIN ExternalCampaignAssignments AS assignment
      ON assignment.provider = 'google_ads'
     AND assignment.customer_id = insights.customerId
     AND assignment.campaign_id = insights.campaignId
     AND assignment.status = 'active'
    WHERE NOT (insights.clinicaId <=> assignment.clinica_id)
       OR NOT (insights.grupoClinicaId <=> assignment.grupo_clinica_id)
       OR NOT (insights.clinicMatchSource <=> 'reviewed_campaign')
       OR NOT (insights.clinicMatchValue <=> assignment.match_kind)
  `, { transaction });
  return parseCount(rows, 'pending_rows');
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // The original normalization migration could finish while a process that
    // had loaded the previous runtime was still alive. That process could then
    // recreate campaign-level fallback rows with NULL dimensions. Repeat the
    // repair transactionally so every environment converges after its runtime
    // is upgraded, including environments where there is nothing left to do.
    await sequelize.transaction(async (transaction) => {
      const before = await readLegacySnapshot(sequelize, transaction);

      await sequelize.query(`
        DELETE legacy
        FROM GoogleAdsInsightsDaily AS legacy
        INNER JOIN GoogleAdsInsightsDaily AS normalized
          ON normalized.campaignId = legacy.campaignId
         AND normalized.date = legacy.date
         AND normalized.clinicGoogleAdsAccountId = legacy.clinicGoogleAdsAccountId
         AND normalized.adGroupId IS NULL
         AND normalized.network = 'CAMPAIGN_TOTAL'
         AND normalized.device = 'CAMPAIGN_TOTAL'
        WHERE legacy.adGroupId IS NULL
          AND legacy.network IS NULL
          AND legacy.device IS NULL
      `, { transaction });
      const deletedRows = await readAffectedRows(sequelize, transaction);
      if (deletedRows !== before.duplicateRows) {
        throw new Error(
          `${MIGRATION_ID}: expected to delete ${before.duplicateRows} duplicate legacy rows, deleted ${deletedRows}`
        );
      }

      await sequelize.query(`
        UPDATE GoogleAdsInsightsDaily
        SET network = 'CAMPAIGN_TOTAL', device = 'CAMPAIGN_TOTAL'
        WHERE adGroupId IS NULL AND network IS NULL AND device IS NULL
      `, { transaction });
      const normalizedRows = await readAffectedRows(sequelize, transaction);
      if (normalizedRows !== before.normalizeRows) {
        throw new Error(
          `${MIGRATION_ID}: expected to normalize ${before.normalizeRows} legacy rows, normalized ${normalizedRows}`
        );
      }

      // Human-reviewed assignments remain the canonical attribution for both
      // historical and newly repaired insight rows.
      await sequelize.query(`
        UPDATE GoogleAdsInsightsDaily AS insights
        INNER JOIN ExternalCampaignAssignments AS assignment
          ON assignment.provider = 'google_ads'
         AND assignment.customer_id = insights.customerId
         AND assignment.campaign_id = insights.campaignId
         AND assignment.status = 'active'
        SET insights.clinicaId = assignment.clinica_id,
            insights.grupoClinicaId = assignment.grupo_clinica_id,
            insights.clinicMatchSource = 'reviewed_campaign',
            insights.clinicMatchValue = assignment.match_kind
      `, { transaction });
      const attributedRows = await readAffectedRows(sequelize, transaction);

      const after = await readLegacySnapshot(sequelize, transaction);
      const duplicateGroups = await readDuplicateGroups(sequelize, transaction);
      const pendingAttribution = await readReviewedAttributionPending(sequelize, transaction);

      if (after.legacyRows !== 0 || after.duplicateRows !== 0) {
        throw new Error(`${MIGRATION_ID}: legacy campaign totals remain after repair`);
      }
      if (duplicateGroups !== 0) {
        throw new Error(`${MIGRATION_ID}: ${duplicateGroups} duplicate insight dimension groups remain`);
      }
      if (pendingAttribution !== 0) {
        throw new Error(`${MIGRATION_ID}: ${pendingAttribution} reviewed attribution rows remain stale`);
      }

      console.log(
        `${MIGRATION_ID}: repaired Google Ads totals `
        + `(legacy=${before.legacyRows}, deleted=${deletedRows}, normalized=${normalizedRows}, `
        + `attribution_updates=${attributedRows})`
      );
    });
  },

  async down() {
    // Data cleanup is deliberately irreversible: recreating duplicate legacy
    // totals or reverting reviewed attribution would corrupt reporting.
  },
};
