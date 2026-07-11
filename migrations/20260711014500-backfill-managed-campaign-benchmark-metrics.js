'use strict';

const MIGRATION_ID = '20260711014500';
const DAYS = 30;
const META_LEAD_ACTION_TYPES = new Set([
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_form',
  'leadgen.other',
  'onsite_conversion.lead_grouped',
]);

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

function clean(value, max = 255) {
  const result = String(value ?? '').trim();
  return result ? result.slice(0, max) : null;
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function validDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizedMetaAccountId(value) {
  const accountId = clean(value, 64);
  if (!accountId) return null;
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`;
}

function campaignRefs(payload) {
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
      const detection = objectValue(campaign?.destination_detection);
      refs.push({
        provider,
        account_id: accountId,
        external_campaign_id: externalCampaignId,
        name: clean(campaign?.name),
        status: clean(campaign?.status, 32),
        target_kind: clean(target?.kind, 32) || 'generic',
        treatment_id: positiveInt(target?.treatment_id),
        destination: Object.keys(detection).length
          ? {
              kind: clean(detection.kind, 32),
              reason: clean(detection.reason, 64),
              confidence: clean(detection.confidence, 32),
              urls: Array.isArray(detection.urls)
                ? detection.urls.map((url) => clean(url, 2048)).filter(Boolean).slice(0, 20)
                : [],
            }
          : null,
      });
    }
  }
  return refs;
}

function mergeRefDestinations(existingRefs, sourceRefs) {
  const sourceByKey = new Map(sourceRefs.map((ref) => [
    `${ref.provider}:${ref.account_id || ''}:${ref.external_campaign_id}`,
    ref,
  ]));
  return (Array.isArray(existingRefs) && existingRefs.length ? existingRefs : sourceRefs).map((ref) => {
    const source = sourceByKey.get(`${ref.provider}:${ref.account_id || ''}:${ref.external_campaign_id}`);
    return { ...ref, destination: ref.destination || source?.destination || null };
  });
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
      const transition = objectValue(reviewConfig.transition);
      if (Object.prototype.hasOwnProperty.call(transition, 'benchmark_metrics')) continue;

      const [requests] = await sequelize.query(`
        SELECT id, campaign_id, clinica_id, solicitud, created_at, updated_at
        FROM CampaignRequests
        WHERE clinica_id = :clinicId
          AND (id = :requestId OR campaign_id = :strategyId)
        ORDER BY (id = :requestId) DESC, updated_at DESC, id DESC
      `, {
        replacements: {
          clinicId: campaign.clinica_id,
          requestId: campaign.campaign_request_id || 0,
          strategyId: campaign.strategy_campaign_id,
        },
      });
      const source = requests.find((row) => {
        const payload = objectValue(row.solicitud);
        return payload.kind === 'marketing_strategy'
          && String(payload.objective_id || '').trim().toLowerCase() === 'new_patients'
          && String(payload.mode_snapshot || payload.mode || '').trim().toLowerCase() === 'connect_only';
      });
      if (!source) continue;

      const payload = objectValue(source.solicitud);
      const sourceRefs = campaignRefs(payload);
      const refs = mergeRefDestinations(platformRefs.benchmark_external_campaigns, sourceRefs);
      const capturedAt = validDate(transition.benchmark_captured_at) || new Date();
      const end = new Date(capturedAt);
      end.setUTCHours(0, 0, 0, 0);
      const start = new Date(end.getTime() - ((DAYS - 1) * 86400000));
      const periodStart = dateOnly(start);
      const periodEnd = dateOnly(end);
      const googleKeys = new Set(refs
        .filter((ref) => ref.provider === 'google_ads')
        .map((ref) => `${String(ref.account_id || '').replace(/[^0-9]/g, '')}:${ref.external_campaign_id}`));
      const metaKeys = new Set(refs
        .filter((ref) => ref.provider === 'meta_ads' && normalizedMetaAccountId(ref.account_id))
        .map((ref) => `${normalizedMetaAccountId(ref.account_id)}:${ref.external_campaign_id}`));
      const metaAccountIds = Array.from(new Set(refs
        .filter((ref) => ref.provider === 'meta_ads' && normalizedMetaAccountId(ref.account_id))
        .map((ref) => normalizedMetaAccountId(ref.account_id))));
      const metaCampaignIds = Array.from(new Set(refs
        .filter((ref) => ref.provider === 'meta_ads' && normalizedMetaAccountId(ref.account_id))
        .map((ref) => ref.external_campaign_id)));
      let investment = 0;
      let impressions = 0;
      let clicks = 0;
      let conversions = 0;
      const campaignsWithData = new Set();

      if (googleKeys.size) {
        const [rows] = await sequelize.query(`
          SELECT customerId, campaignId, impressions, clicks, costMicros, conversions
          FROM GoogleAdsInsightsDaily
          WHERE clinicaId = :clinicId
            AND date BETWEEN :periodStart AND :periodEnd
        `, {
          replacements: {
            clinicId: campaign.clinica_id,
            periodStart,
            periodEnd,
          },
        });
        for (const row of rows) {
          const key = `${String(row.customerId || '').replace(/[^0-9]/g, '')}:${row.campaignId}`;
          if (!googleKeys.has(key)) continue;
          investment += Number(row.costMicros || 0) / 1000000;
          impressions += Number(row.impressions || 0);
          clicks += Number(row.clicks || 0);
          conversions += Number(row.conversions || 0);
          campaignsWithData.add(`google_ads:${key}`);
        }
      }

      if (metaKeys.size) {
        const [rows] = await sequelize.query(`
          SELECT insights.ad_account_id,
                 adsets.parent_id AS campaign_id,
                 SUM(insights.impressions) AS impressions,
                 SUM(insights.clicks) AS clicks,
                 SUM(insights.spend) AS spend
          FROM SocialAdsInsightsDaily insights
          INNER JOIN SocialAdsEntities ads
            ON ads.level = 'ad'
           AND ads.entity_id = insights.entity_id
           AND ads.ad_account_id = insights.ad_account_id
          INNER JOIN SocialAdsEntities adsets
            ON adsets.level = 'adset'
           AND adsets.entity_id = ads.parent_id
           AND adsets.ad_account_id = insights.ad_account_id
          WHERE insights.level = 'ad'
            AND insights.date BETWEEN :periodStart AND :periodEnd
            AND insights.ad_account_id IN (:metaAccountIds)
            AND adsets.parent_id IN (:metaCampaignIds)
          GROUP BY insights.ad_account_id, adsets.parent_id
        `, {
          replacements: {
            periodStart,
            periodEnd,
            metaAccountIds,
            metaCampaignIds,
          },
        });
        for (const row of rows) {
          const key = `${normalizedMetaAccountId(row.ad_account_id) || ''}:${row.campaign_id}`;
          if (!metaKeys.has(key)) continue;
          investment += Number(row.spend || 0);
          impressions += Number(row.impressions || 0);
          clicks += Number(row.clicks || 0);
          campaignsWithData.add(`meta_ads:${key}`);
        }

        const [actionRows] = await sequelize.query(`
          SELECT actions.ad_account_id,
                 adsets.parent_id AS campaign_id,
                 actions.date,
                 actions.action_type,
                 SUM(actions.value) AS value
          FROM SocialAdsActionsDaily actions
          INNER JOIN SocialAdsEntities ads
            ON ads.level = 'ad'
           AND ads.entity_id = actions.entity_id
           AND ads.ad_account_id = actions.ad_account_id
          INNER JOIN SocialAdsEntities adsets
            ON adsets.level = 'adset'
           AND adsets.entity_id = ads.parent_id
           AND adsets.ad_account_id = actions.ad_account_id
          WHERE actions.level = 'ad'
            AND actions.date BETWEEN :periodStart AND :periodEnd
            AND actions.ad_account_id IN (:metaAccountIds)
            AND adsets.parent_id IN (:metaCampaignIds)
          GROUP BY actions.ad_account_id,
                   adsets.parent_id,
                   actions.date,
                   actions.action_type
        `, {
          replacements: {
            periodStart,
            periodEnd,
            metaAccountIds,
            metaCampaignIds,
          },
        });
        const leadAliasesByCampaignDay = new Map();
        for (const row of actionRows) {
          const actionType = String(row.action_type || '').trim().toLowerCase();
          if (!META_LEAD_ACTION_TYPES.has(actionType) && !actionType.includes('add_meta_leads')) continue;
          const campaignKey = `${normalizedMetaAccountId(row.ad_account_id) || ''}:${row.campaign_id}`;
          if (!metaKeys.has(campaignKey)) continue;
          const entityDayKey = `${campaignKey}:${row.date || ''}`;
          const aliases = leadAliasesByCampaignDay.get(entityDayKey) || new Map();
          aliases.set(actionType, (aliases.get(actionType) || 0) + Number(row.value || 0));
          leadAliasesByCampaignDay.set(entityDayKey, aliases);
        }
        for (const aliases of leadAliasesByCampaignDay.values()) {
          conversions += Math.max(0, ...aliases.values());
        }
      }

      const roundedInvestment = money(investment);
      const roundedConversions = Math.round((conversions + Number.EPSILON) * 1000000) / 1000000;
      const nextPlatformRefs = {
        ...platformRefs,
        benchmark_external_campaigns: refs,
      };
      const nextReviewConfig = {
        ...reviewConfig,
        transition: {
          ...transition,
          benchmark_preserved: true,
          benchmark_campaign_count: refs.length,
          benchmark_target_destinations: Array.isArray(transition.benchmark_target_destinations)
            ? transition.benchmark_target_destinations
            : (Array.isArray(payload.target_destinations) ? payload.target_destinations : []),
          benchmark_metrics: {
            period_start: periodStart,
            period_end: periodEnd,
            days: DAYS,
            captured_at: capturedAt.toISOString(),
            source: 'cached_provider_insights',
            currency: 'EUR',
            investment: roundedInvestment,
            impressions: Math.max(0, Math.round(impressions)),
            clicks: Math.max(0, Math.round(clicks)),
            conversions: Math.max(0, roundedConversions),
            cost_per_conversion: roundedConversions > 0
              ? money(roundedInvestment / roundedConversions)
              : null,
            campaign_count: refs.length,
            campaigns_with_data: campaignsWithData.size,
          },
          benchmark_metrics_backfilled_by: MIGRATION_ID,
        },
      };
      await sequelize.query(`
        UPDATE ManagedCampaigns
        SET platform_refs = :platformRefs,
            review_config = :reviewConfig
        WHERE id = :id
      `, {
        replacements: {
          id: campaign.id,
          platformRefs: JSON.stringify(nextPlatformRefs),
          reviewConfig: JSON.stringify(nextReviewConfig),
        },
      });
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [campaigns] = await sequelize.query(`
      SELECT id, review_config
      FROM ManagedCampaigns
    `);
    for (const campaign of campaigns) {
      const reviewConfig = objectValue(campaign.review_config);
      const transition = objectValue(reviewConfig.transition);
      if (transition.benchmark_metrics_backfilled_by !== MIGRATION_ID) continue;
      delete transition.benchmark_metrics;
      delete transition.benchmark_metrics_backfilled_by;
      reviewConfig.transition = transition;
      await sequelize.query(`
        UPDATE ManagedCampaigns
        SET review_config = :reviewConfig
        WHERE id = :id
      `, {
        replacements: {
          id: campaign.id,
          reviewConfig: JSON.stringify(reviewConfig),
        },
      });
    }
  },
};
