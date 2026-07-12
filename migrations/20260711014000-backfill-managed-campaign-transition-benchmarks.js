'use strict';

const MIGRATION_ID = '20260711014000';

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clean(value, max = 255) {
  const result = String(value ?? '').trim();
  return result ? result.slice(0, max) : null;
}

function benchmarkCampaigns(payload) {
  const refs = [];
  const seen = new Set();
  for (const target of Array.isArray(payload.external_targets) ? payload.external_targets : []) {
    for (const campaign of Array.isArray(target?.campaigns) ? target.campaigns : []) {
      const provider = ['google_ads', 'meta_ads'].includes(String(campaign?.provider || '').trim())
        ? String(campaign.provider).trim()
        : null;
      const externalCampaignId = clean(campaign?.external_campaign_id, 128);
      if (!provider || !externalCampaignId) continue;
      const accountId = clean(campaign?.account_id, 128);
      const key = `${provider}:${accountId || ''}:${externalCampaignId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        provider,
        account_id: accountId,
        external_campaign_id: externalCampaignId,
        name: clean(campaign?.name),
        status: clean(campaign?.status, 32),
        target_kind: clean(target?.kind, 32) || 'generic',
        treatment_id: positiveInt(target?.treatment_id),
      });
    }
  }
  return refs;
}

function isConnectOnlyNewPatients(row) {
  const payload = objectValue(row?.solicitud);
  return payload.kind === 'marketing_strategy'
    && String(payload.objective_id || '').trim().toLowerCase() === 'new_patients'
    && String(payload.mode_snapshot || payload.mode || '').trim().toLowerCase() === 'connect_only';
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [campaigns] = await sequelize.query(`
      SELECT id, strategy_campaign_id, campaign_request_id, clinica_id,
             platform_refs, review_config
      FROM ManagedCampaigns
      WHERE strategy_campaign_id IS NOT NULL
    `);

    for (const campaign of campaigns) {
      const platformRefs = objectValue(campaign.platform_refs);
      const reviewConfig = objectValue(campaign.review_config);
      const existingTransition = objectValue(reviewConfig.transition);
      const [requests] = await sequelize.query(`
        SELECT id, campaign_id, clinica_id, solicitud, created_at, updated_at
        FROM CampaignRequests
        WHERE campaign_id = :campaignId AND clinica_id = :clinicId
        ORDER BY updated_at DESC, id DESC
      `, {
        replacements: {
          campaignId: campaign.strategy_campaign_id,
          clinicId: campaign.clinica_id,
        },
      });
      const frozenSourceRequestId = existingTransition.benchmark_preserved === true
        ? positiveInt(existingTransition.source_campaign_request_id)
        : null;
      const currentSourceRequestId = positiveInt(campaign.campaign_request_id);
      const frozenSource = frozenSourceRequestId
        ? requests.find((row) => positiveInt(row.id) === frozenSourceRequestId && isConnectOnlyNewPatients(row))
        : null;
      const currentSource = currentSourceRequestId
        ? requests.find((row) => positiveInt(row.id) === currentSourceRequestId && isConnectOnlyNewPatients(row))
        : null;
      const source = frozenSource || currentSource || requests.find(isConnectOnlyNewPatients);
      if (!source) continue;

      const payload = objectValue(source.solicitud);
      const refs = benchmarkCampaigns(payload);
      const capturedAt = source.updated_at || source.created_at || new Date();
      const benchmarkRefsAlreadyPresent = Array.isArray(platformRefs.benchmark_external_campaigns);
      const benchmarkRefsAdded = existingTransition.benchmark_preserved !== true
        && !benchmarkRefsAlreadyPresent;
      const sourceRequestId = positiveInt(source.id);
      const campaignRequestRelinked = existingTransition.benchmark_preserved === true
        && currentSourceRequestId !== sourceRequestId;

      const nextPlatformRefs = {
        ...platformRefs,
        ...(benchmarkRefsAdded ? { benchmark_external_campaigns: refs } : {}),
      };
      const nextReviewConfig = {
        ...reviewConfig,
        transition: existingTransition.benchmark_preserved === true
          ? {
              ...existingTransition,
              ...(campaignRequestRelinked
                && existingTransition.campaign_request_relinked_by !== MIGRATION_ID
                ? {
                    campaign_request_relinked_by: MIGRATION_ID,
                    campaign_request_relink_previous_id: currentSourceRequestId,
                  }
                : {}),
            }
          : {
              source_mode: 'connect_only',
              source_status: clean(payload.status, 32) || 'unknown',
              benchmark_preserved: true,
              benchmark_campaign_count: refs.length,
              benchmark_captured_at: new Date(capturedAt).toISOString(),
              source_strategy_updated_at: source.updated_at || source.created_at || null,
              source_strategy_campaign_id: positiveInt(source.campaign_id),
              source_campaign_request_id: positiveInt(source.id),
              previous_campaign_request_id: positiveInt(campaign.campaign_request_id),
              ...(benchmarkRefsAdded ? { benchmark_refs_added_by: MIGRATION_ID } : {}),
              backfilled_by: MIGRATION_ID,
            },
      };

      await sequelize.query(`
        UPDATE ManagedCampaigns
        SET campaign_request_id = :requestId,
            platform_refs = :platformRefs,
            review_config = :reviewConfig
        WHERE id = :id
      `, {
        replacements: {
          id: campaign.id,
          requestId: source.id,
          platformRefs: JSON.stringify(nextPlatformRefs),
          reviewConfig: JSON.stringify(nextReviewConfig),
        },
      });
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [campaigns] = await sequelize.query(`
      SELECT id, campaign_request_id, platform_refs, review_config
      FROM ManagedCampaigns
      WHERE campaign_request_id IS NOT NULL
    `);
    for (const campaign of campaigns) {
      const reviewConfig = objectValue(campaign.review_config);
      const transition = objectValue(reviewConfig.transition);
      const platformRefs = objectValue(campaign.platform_refs);
      let previousRequestId;
      if (transition.backfilled_by === MIGRATION_ID) {
        previousRequestId = positiveInt(transition.previous_campaign_request_id);
        delete reviewConfig.transition;
        if (transition.benchmark_refs_added_by === MIGRATION_ID) {
          delete platformRefs.benchmark_external_campaigns;
        }
      } else if (transition.campaign_request_relinked_by === MIGRATION_ID) {
        previousRequestId = positiveInt(transition.campaign_request_relink_previous_id);
        delete transition.campaign_request_relinked_by;
        delete transition.campaign_request_relink_previous_id;
        reviewConfig.transition = transition;
      } else {
        continue;
      }
      await sequelize.query(`
        UPDATE ManagedCampaigns
        SET campaign_request_id = :previousRequestId,
            platform_refs = :platformRefs,
            review_config = :reviewConfig
        WHERE id = :id
      `, {
        replacements: {
          id: campaign.id,
          previousRequestId,
          platformRefs: JSON.stringify(platformRefs),
          reviewConfig: JSON.stringify(reviewConfig),
        },
      });
    }
  },
};
