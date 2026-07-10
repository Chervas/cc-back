#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const path = require('path');
const axios = require('axios');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const originalConsoleLog = console.log;
if (process.env.OPS_VERBOSE_MODEL_LOAD !== 'true') {
  console.log = () => {};
}
const db = require(path.resolve(process.cwd(), 'models'));
console.log = originalConsoleLog;
db.sequelize.options.logging = false;

const apiUrl = (process.env.OPS_API_URL || 'https://ops.conmigas.com').replace(/\/$/, '');
const apiToken = process.env.OPS_INTERNAL_API_TOKEN;
const lookbackDays = Number(process.env.OPS_LOOKBACK_DAYS || 14);
const businessUnit = 'clinicaclick';

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toInteger(value) {
  return Math.max(0, Math.round(toNumber(value)));
}

function objectPayload(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function googleBusinessIdentityFromRawPayload(value) {
  const payload = objectPayload(value);
  const rawLocation = objectPayload(payload.rawLocation || payload.raw_location);
  const metadata = objectPayload(payload.metadata || rawLocation.metadata);
  const locationKey = objectPayload(payload.locationKey || payload.location_key || rawLocation.locationKey || rawLocation.location_key);
  const suspensionReasons = metadata.suspensionReasons || rawLocation.metadata?.suspensionReasons;

  return {
    placeId: metadata.placeId || payload.placeId || locationKey.placeId || null,
    mapsUri: metadata.mapsUri || payload.mapsUri || payload.googleMapsUri || rawLocation.metadata?.mapsUri || null,
    verified: metadata.hasVoiceOfMerchant ?? metadata.hasBusinessAuthority ?? null,
    suspended: Array.isArray(suspensionReasons) ? suspensionReasons.length > 0 : null,
    payload
  };
}

function campaignExternalId(accountId, campaignId) {
  return `${accountId}:${campaignId}`;
}

async function query(sql, replacements = {}) {
  return db.sequelize.query(sql, {
    replacements,
    type: db.Sequelize.QueryTypes.SELECT
  });
}

async function post(endpoint, payload) {
  const response = await axios.post(`${apiUrl}${endpoint}`, payload, {
    headers: {
      'content-type': 'application/json',
      'x-ops-api-key': apiToken
    },
    timeout: 30000
  });

  return response.data;
}

async function postBatch(endpoint, items, size = 50) {
  let sent = 0;

  for (let index = 0; index < items.length; index += size) {
    const slice = items.slice(index, index + size);
    if (!slice.length) {
      continue;
    }

    await post(endpoint, { items: slice });
    sent += slice.length;
  }

  return sent;
}

function domainFromSiteUrl(siteUrl) {
  const value = String(siteUrl || '').trim();

  if (!value) {
    return null;
  }

  if (value.startsWith('sc-domain:')) {
    return value.replace('sc-domain:', '').replace(/^www\./, '');
  }

  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch (_error) {
    return value.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || null;
  }
}

function accountPayload(row, platform) {
  return {
    platform,
    external_account_id: row.external_account_id,
    name: row.name || row.external_account_id,
    client_name: row.client_name || row.group_name || row.name || row.external_account_id,
    business_unit: businessUnit,
    billing_company: row.billing_company || 'unknown',
    account_status: row.status || 'active',
    sync_interval_hours: 4,
    notes: row.notes || null
  };
}

function campaignPayload(row, account, channel) {
  const externalId = campaignExternalId(row.account_external_id, row.campaign_id);

  return {
    name: row.name || `${channel} campaign ${row.campaign_id}`,
    platform_campaign_id: externalId,
    channel,
    campaign_status: row.status || 'active',
    objective: row.objective || null,
    currency: row.currency || account?.currency || 'EUR',
    client_name: account?.client_name || row.client_name || row.account_name || row.account_external_id,
    business_unit: businessUnit,
    ad_account: accountPayload({
      external_account_id: row.account_external_id,
      name: account?.name || row.account_name || row.account_external_id,
      client_name: account?.client_name || row.client_name || row.account_name || row.account_external_id,
      billing_company: account?.billing_company || 'unknown',
      status: account?.status || 'active',
      notes: account?.notes || null
    }, channel)
  };
}

async function syncAccounts() {
  const metaAccounts = await query(`
    SELECT a.id AS clinic_asset_id,
           a.metaAssetId AS external_account_id,
           COALESCE(NULLIF(a.metaAssetName, ''), a.metaAssetId) AS name,
           IF(a.isActive = 1, 'active', 'paused') AS status,
           IF(a.meta_billed_by = 1, 'client', 'unknown') AS billing_company,
           a.clinicaId,
           c.nombre_clinica AS client_name,
           a.ad_account_status,
           a.ad_account_disable_reason,
           a.ad_account_amount_spent,
           a.ad_account_refreshed_at
    FROM ClinicMetaAssets a
    LEFT JOIN Clinicas c ON c.id_clinica = a.clinicaId
    WHERE a.assetType = 'ad_account'
      AND a.isActive = 1
  `);

  const googleAccounts = await query(`
    SELECT g.id AS clinic_google_ads_account_id,
           g.customerId AS external_account_id,
           COALESCE(NULLIF(g.descriptiveName, ''), g.customerId) AS name,
           COALESCE(g.accountStatus, 'active') AS status,
           'unknown' AS billing_company,
           g.currencyCode AS currency,
           g.clinicaId,
           c.nombre_clinica AS client_name,
           g.publishingStatus,
           g.publishingReason,
           g.lastSyncedAt
    FROM ClinicGoogleAdsAccounts g
    LEFT JOIN Clinicas c ON c.id_clinica = g.clinicaId
    WHERE g.isActive = 1
  `);

  const metaPayload = {
    platform: 'meta',
    business_unit: businessUnit,
    sync_interval_hours: 4,
    accounts: metaAccounts.map((row) => accountPayload(row, 'meta'))
  };

  const googlePayload = {
    platform: 'google_ads',
    business_unit: businessUnit,
    sync_interval_hours: 4,
    accounts: googleAccounts.map((row) => accountPayload(row, 'google_ads'))
  };

  if (metaPayload.accounts.length) {
    await post('/api/internal/ad-account-discovery', metaPayload);
  }

  if (googlePayload.accounts.length) {
    await post('/api/internal/ad-account-discovery', googlePayload);
  }

  return {
    metaAccounts,
    googleAccounts,
    metaAccountMap: new Map(metaAccounts.map((row) => [row.external_account_id, row])),
    googleAccountMap: new Map(googleAccounts.map((row) => [row.external_account_id, row]))
  };
}

async function syncMetaCampaigns(metaAccountMap, startDate) {
  const campaigns = await query(`
    SELECT i.ad_account_id AS account_external_id,
           i.entity_id AS campaign_id,
           COALESCE(MAX(NULLIF(e.name, '')), CONCAT('Meta campaign ', i.entity_id)) AS name,
           COALESCE(MAX(NULLIF(e.effective_status, '')), MAX(NULLIF(e.status, '')), 'ACTIVE') AS status,
           MAX(NULLIF(e.objective, '')) AS objective
    FROM SocialAdsInsightsDaily i
    LEFT JOIN SocialAdsEntities e
      ON e.level = 'campaign'
     AND e.entity_id = i.entity_id
    WHERE i.level = 'campaign'
      AND i.date >= :startDate
    GROUP BY i.ad_account_id, i.entity_id
  `, { startDate });

  const byAccount = new Map();
  const campaignMap = new Map();

  for (const campaign of campaigns) {
    const externalId = campaignExternalId(campaign.account_external_id, campaign.campaign_id);
    campaignMap.set(externalId, campaign);

    if (!byAccount.has(campaign.account_external_id)) {
      byAccount.set(campaign.account_external_id, []);
    }

    byAccount.get(campaign.account_external_id).push({
      name: campaign.name,
      platform_campaign_id: externalId,
      external_campaign_id: externalId,
      status: campaign.status,
      objective: campaign.objective,
      currency: 'EUR'
    });
  }

  for (const [accountId, accountCampaigns] of byAccount.entries()) {
    const account = metaAccountMap.get(accountId);

    await post('/api/internal/campaign-discovery', {
      ad_account: accountPayload({
        external_account_id: accountId,
        name: account?.name || accountId,
        client_name: account?.client_name || account?.name || accountId,
        billing_company: account?.billing_company || 'unknown',
        status: account?.status || 'active'
      }, 'meta'),
      platform: 'meta',
      business_unit: businessUnit,
      campaigns: accountCampaigns
    });
  }

  return campaignMap;
}

async function syncGoogleCampaigns(googleAccountMap, startDate) {
  const campaigns = await query(`
    SELECT i.customerId AS account_external_id,
           i.campaignId AS campaign_id,
           COALESCE(MAX(NULLIF(i.campaignName, '')), CONCAT('Google Ads campaign ', i.campaignId)) AS name,
           COALESCE(MAX(NULLIF(i.campaignStatus, '')), MAX(NULLIF(i.campaignPrimaryStatus, '')), 'ENABLED') AS status,
           MAX(NULLIF(i.campaignServingStatus, '')) AS objective,
           MAX(acc.currencyCode) AS currency,
           MAX(c.nombre_clinica) AS client_name
    FROM GoogleAdsInsightsDaily i
    LEFT JOIN ClinicGoogleAdsAccounts acc ON acc.id = i.clinicGoogleAdsAccountId
    LEFT JOIN Clinicas c ON c.id_clinica = i.clinicaId
    WHERE i.date >= :startDate
    GROUP BY i.customerId, i.campaignId
  `, { startDate });

  const byAccount = new Map();
  const campaignMap = new Map();

  for (const campaign of campaigns) {
    const externalId = campaignExternalId(campaign.account_external_id, campaign.campaign_id);
    campaignMap.set(externalId, campaign);

    if (!byAccount.has(campaign.account_external_id)) {
      byAccount.set(campaign.account_external_id, []);
    }

    byAccount.get(campaign.account_external_id).push({
      name: campaign.name,
      platform_campaign_id: externalId,
      external_campaign_id: externalId,
      status: campaign.status,
      objective: campaign.objective,
      currency: campaign.currency || 'EUR'
    });
  }

  for (const [accountId, accountCampaigns] of byAccount.entries()) {
    const account = googleAccountMap.get(accountId);

    await post('/api/internal/campaign-discovery', {
      ad_account: accountPayload({
        external_account_id: accountId,
        name: account?.name || accountId,
        client_name: account?.client_name || account?.name || accountId,
        billing_company: account?.billing_company || 'unknown',
        status: account?.status || 'active'
      }, 'google_ads'),
      platform: 'google_ads',
      business_unit: businessUnit,
      campaigns: accountCampaigns
    });
  }

  return campaignMap;
}

async function syncMetaStats(metaAccountMap, metaCampaignMap, startDate) {
  const stats = await query(`
    SELECT i.ad_account_id AS account_external_id,
           i.entity_id AS campaign_id,
           i.date AS stat_date,
           ROUND(SUM(COALESCE(i.spend, 0)), 2) AS spend,
           SUM(COALESCE(i.impressions, 0)) AS impressions,
           SUM(COALESCE(i.clicks, 0)) AS clicks,
           COALESCE(MAX(a.leads), 0) AS leads
    FROM SocialAdsInsightsDaily i
    LEFT JOIN (
      SELECT ad_account_id,
             entity_id,
             date,
             SUM(COALESCE(value, 0)) AS leads
      FROM SocialAdsActionsDaily
      WHERE level = 'campaign'
        AND date >= :startDate
        AND (
          LOWER(action_type) LIKE '%lead%'
          OR LOWER(action_type) LIKE '%contact%'
          OR LOWER(action_type) LIKE '%complete_registration%'
        )
      GROUP BY ad_account_id, entity_id, date
    ) a ON a.ad_account_id = i.ad_account_id
       AND a.entity_id = i.entity_id
       AND a.date = i.date
    WHERE i.level = 'campaign'
      AND i.date >= :startDate
    GROUP BY i.ad_account_id, i.entity_id, i.date
  `, { startDate });

  for (const row of stats) {
    const externalId = campaignExternalId(row.account_external_id, row.campaign_id);
    const account = metaAccountMap.get(row.account_external_id);
    const campaign = metaCampaignMap.get(externalId) || row;

    await post('/api/internal/campaign-daily-stats', {
      campaign: campaignPayload({
        ...campaign,
        account_external_id: row.account_external_id,
        campaign_id: row.campaign_id
      }, account, 'meta'),
      stat_date: row.stat_date,
      spend: toNumber(row.spend),
      impressions: toInteger(row.impressions),
      clicks: toInteger(row.clicks),
      leads: toInteger(row.leads),
      currency: 'EUR',
      source_platform: 'clinicaclick_meta',
      raw_payload: {
        source: 'clinicaclick',
        source_table: 'SocialAdsInsightsDaily',
        account_external_id: row.account_external_id,
        campaign_id: row.campaign_id
      }
    });
  }

  return stats.length;
}

async function syncGoogleStats(googleAccountMap, googleCampaignMap, startDate) {
  const stats = await query(`
    SELECT i.customerId AS account_external_id,
           i.campaignId AS campaign_id,
           i.date AS stat_date,
           ROUND(SUM(COALESCE(i.costMicros, 0)) / 1000000, 2) AS spend,
           SUM(COALESCE(i.impressions, 0)) AS impressions,
           SUM(COALESCE(i.clicks, 0)) AS clicks,
           SUM(COALESCE(i.conversions, 0)) AS leads,
           MAX(acc.currencyCode) AS currency,
           MAX(c.nombre_clinica) AS client_name
    FROM GoogleAdsInsightsDaily i
    LEFT JOIN ClinicGoogleAdsAccounts acc ON acc.id = i.clinicGoogleAdsAccountId
    LEFT JOIN Clinicas c ON c.id_clinica = i.clinicaId
    WHERE i.date >= :startDate
    GROUP BY i.customerId, i.campaignId, i.date
  `, { startDate });

  for (const row of stats) {
    const externalId = campaignExternalId(row.account_external_id, row.campaign_id);
    const account = googleAccountMap.get(row.account_external_id);
    const campaign = googleCampaignMap.get(externalId) || row;

    await post('/api/internal/campaign-daily-stats', {
      campaign: campaignPayload({
        ...campaign,
        account_external_id: row.account_external_id,
        campaign_id: row.campaign_id,
        client_name: row.client_name
      }, account, 'google_ads'),
      stat_date: row.stat_date,
      spend: toNumber(row.spend),
      impressions: toInteger(row.impressions),
      clicks: toInteger(row.clicks),
      leads: toInteger(row.leads),
      currency: row.currency || account?.currency || 'EUR',
      source_platform: 'clinicaclick_google_ads',
      raw_payload: {
        source: 'clinicaclick',
        source_table: 'GoogleAdsInsightsDaily',
        account_external_id: row.account_external_id,
        campaign_id: row.campaign_id
      }
    });
  }

  return stats.length;
}

async function syncSocialProfilesAndStats(startDate) {
  const profiles = await query(`
    SELECT a.id AS clinic_asset_id,
           a.assetType AS asset_type,
           a.metaAssetId AS external_profile_id,
           COALESCE(NULLIF(a.metaAssetName, ''), a.metaAssetId) AS name,
           IF(a.isActive = 1, 'active', 'paused') AS status,
           a.clinicaId,
           c.nombre_clinica AS client_name
    FROM ClinicMetaAssets a
    LEFT JOIN Clinicas c ON c.id_clinica = a.clinicaId
    WHERE a.assetType IN ('facebook_page', 'instagram_business')
      AND a.isActive = 1
  `);

  const profileMap = new Map();

  for (const row of profiles) {
    const platform = row.asset_type === 'instagram_business' ? 'instagram' : 'facebook';
    profileMap.set(Number(row.clinic_asset_id), row);

    await post('/api/internal/social-profiles', {
      platform,
      external_profile_id: row.external_profile_id,
      name: row.name,
      client_name: row.client_name || row.name,
      business_unit: businessUnit,
      status: row.status,
      last_sync_status: 'ok',
      raw_payload: {
        source: 'clinicaclick',
        clinic_asset_id: row.clinic_asset_id,
        asset_type: row.asset_type
      }
    });
  }

  const stats = await query(`
    SELECT s.asset_id AS clinic_asset_id,
           s.asset_type,
           s.date AS stat_date,
           MAX(COALESCE(s.followers, 0)) AS followers,
           SUM(COALESCE(s.followers_day, 0)) AS followers_delta,
           SUM(
             CASE
               WHEN COALESCE(s.reach_total, 0) > 0 THEN COALESCE(s.reach_total, 0)
               WHEN COALESCE(s.reach, 0) > 0 THEN COALESCE(s.reach, 0)
               ELSE COALESCE(s.reach_instagram, 0) + COALESCE(s.reach_facebook, 0)
             END
           ) AS reach,
           SUM(
             CASE
               WHEN COALESCE(s.impressions, 0) > 0 THEN COALESCE(s.impressions, 0)
               ELSE COALESCE(s.impressions_instagram, 0) + COALESCE(s.impressions_facebook, 0)
             END
           ) AS impressions,
           SUM(COALESCE(s.engagement, 0) + COALESCE(s.likes, 0) + COALESCE(s.reactions, 0)) AS engagement,
           SUM(COALESCE(s.clicks, 0) + COALESCE(s.profile_visits, 0)) AS clicks,
           SUM(COALESCE(s.posts_count, 0)) AS posts_count,
           ROUND(SUM(COALESCE(s.spend_instagram, 0) + COALESCE(s.spend_facebook, 0)), 2) AS spend
    FROM SocialStatsDaily s
    WHERE s.date >= :startDate
      AND s.asset_type IN ('facebook_page', 'instagram_business')
    GROUP BY s.asset_id, s.asset_type, s.date
  `, { startDate });

  for (const row of stats) {
    const profile = profileMap.get(Number(row.clinic_asset_id));

    if (!profile) {
      continue;
    }

    const platform = row.asset_type === 'instagram_business' ? 'instagram' : 'facebook';

    await post('/api/internal/social-daily-stats', {
      profile: {
        platform,
        external_profile_id: profile.external_profile_id,
        name: profile.name,
        client_name: profile.client_name || profile.name,
        business_unit: businessUnit,
        status: profile.status,
        last_sync_status: 'ok'
      },
      stat_date: row.stat_date,
      followers: toInteger(row.followers),
      followers_delta: Math.round(toNumber(row.followers_delta)),
      reach: toInteger(row.reach),
      impressions: toInteger(row.impressions),
      engagement: toInteger(row.engagement),
      clicks: toInteger(row.clicks),
      posts_count: toInteger(row.posts_count),
      spend: toNumber(row.spend),
      currency: 'EUR',
      source_platform: 'clinicaclick_social',
      raw_payload: {
        source: 'clinicaclick',
        source_table: 'SocialStatsDaily',
        clinic_asset_id: row.clinic_asset_id,
        asset_type: row.asset_type
      }
    });
  }

  return {
    profiles: profiles.length,
    stats: stats.length
  };
}

async function syncClients() {
  const clients = await query(`
    SELECT id_clinica,
           nombre_clinica,
           url_web,
           email,
           COALESCE(telefono_whatsapp, telefono_movil, telefono_fijo, telefono) AS phone,
           estado_clinica
    FROM Clinicas
    WHERE nombre_clinica IS NOT NULL
      AND nombre_clinica <> ''
  `);

  return postBatch('/api/internal/clients', clients.map((client) => ({
    name: client.nombre_clinica,
    brand: client.nombre_clinica,
    business_unit: businessUnit,
    status: String(client.estado_clinica || '').toLowerCase().includes('paus') ? 'paused' : 'active',
    source_platform: 'clinicaclick',
    external_id: String(client.id_clinica),
    email: client.email || null,
    phone: client.phone || null,
    notes: client.url_web ? `Web: ${client.url_web}` : null
  })));
}

async function syncCampaignStructure(startDate) {
  const entityRows = await query(`
    SELECT e.ad_account_id,
           e.level,
           e.entity_id,
           e.parent_id,
           e.name,
           e.status,
           e.effective_status,
           CASE
             WHEN e.level = 'adset' THEN e.parent_id
             ELSE parent.parent_id
           END AS campaign_id
    FROM SocialAdsEntities e
    LEFT JOIN SocialAdsEntities parent
      ON parent.ad_account_id = e.ad_account_id
     AND parent.level = 'adset'
     AND parent.entity_id = e.parent_id
    WHERE e.level IN ('adset','ad')
      AND (e.updated_time IS NULL OR e.updated_time >= :startDate)
  `, { startDate });

  const items = entityRows
    .filter((row) => row.campaign_id)
    .map((row) => ({
      platform: 'meta',
      platform_campaign_id: campaignExternalId(row.ad_account_id, row.campaign_id),
      campaign_platform_campaign_id: campaignExternalId(row.ad_account_id, row.campaign_id),
      item_type: row.level === 'adset' ? 'adset' : 'ad',
      external_item_id: row.entity_id,
      parent_external_id: row.parent_id || null,
      name: row.name || row.entity_id,
      status: row.status || null,
      effective_status: row.effective_status || null,
      last_synced_at: new Date(),
      raw_payload: {
        source: 'clinicaclick',
        source_table: 'SocialAdsEntities',
        ad_account_id: row.ad_account_id
      }
    }));

  const promotedPosts = await query(`
    SELECT p.ad_account_id,
           p.campaign_id,
           p.adset_id,
           p.ad_id,
           p.ad_creative_id,
           p.effective_instagram_media_id,
           p.effective_object_story_id,
           p.instagram_permalink_url,
           p.status,
           sp.post_id,
           sp.post_type,
           sp.title,
           sp.content,
           sp.media_url,
           sp.permalink_url,
           sp.published_at
    FROM PostPromotions p
    INNER JOIN SocialPosts sp ON sp.id = p.post_id
    WHERE p.campaign_id IS NOT NULL
      AND (p.updated_at >= :startDate OR sp.updated_at >= :startDate)
  `, { startDate });

  for (const row of promotedPosts) {
    items.push({
      platform: 'meta',
      platform_campaign_id: campaignExternalId(row.ad_account_id, row.campaign_id),
      campaign_platform_campaign_id: campaignExternalId(row.ad_account_id, row.campaign_id),
      item_type: 'ad',
      external_item_id: row.ad_id || row.post_id,
      parent_external_id: row.adset_id || null,
      name: row.title || row.post_id,
      status: row.status || null,
      effective_status: row.status || null,
      preview_title: row.title || null,
      preview_body: row.content || null,
      media_url: row.media_url || null,
      thumbnail_url: row.media_url || null,
      permalink_url: row.instagram_permalink_url || row.permalink_url || null,
      cta_type: row.post_type || null,
      last_synced_at: new Date(),
      raw_payload: {
        source: 'clinicaclick',
        source_table: 'PostPromotions',
        ad_creative_id: row.ad_creative_id,
        effective_instagram_media_id: row.effective_instagram_media_id,
        effective_object_story_id: row.effective_object_story_id,
        published_at: row.published_at
      }
    });
  }

  return postBatch('/api/internal/campaign-structure-items', items);
}

async function syncSocialPosts(startDate) {
  const posts = await query(`
    SELECT sp.id,
           sp.clinica_id,
           c.nombre_clinica AS client_name,
           sp.asset_id,
           sp.asset_type,
           a.metaAssetId AS external_profile_id,
           COALESCE(NULLIF(a.metaAssetName, ''), a.metaAssetId) AS profile_name,
           sp.post_id,
           sp.post_type,
           sp.title,
           sp.content,
           sp.media_url,
           sp.permalink_url,
           sp.published_at,
           COALESCE(st.impressions, sp.impressions_count_fb, 0) AS impressions,
           COALESCE(st.reach, 0) AS reach,
           COALESCE(st.engagement, sp.reactions_and_likes, 0) AS engagement,
           COALESCE(st.likes, sp.reactions_and_likes, 0) AS likes,
           COALESCE(st.comments, sp.comments_count, 0) AS comments,
           COALESCE(st.shares, sp.shares_count, 0) AS shares,
           COALESCE(st.saved, sp.saved_count, 0) AS saves,
           COALESCE(st.video_views, sp.views_count, sp.views_count_fb, 0) AS video_views,
           COALESCE(st.avg_watch_time, sp.avg_watch_time_ms / 1000, 0) AS avg_watch_time_seconds
    FROM SocialPosts sp
    LEFT JOIN Clinicas c ON c.id_clinica = sp.clinica_id
    LEFT JOIN ClinicMetaAssets a ON a.id = sp.asset_id
    LEFT JOIN (
      SELECT post_id,
             SUM(impressions) AS impressions,
             SUM(reach) AS reach,
             SUM(engagement) AS engagement,
             SUM(likes) AS likes,
             SUM(comments) AS comments,
             SUM(shares) AS shares,
             SUM(saved) AS saved,
             SUM(video_views) AS video_views,
             AVG(avg_watch_time) AS avg_watch_time
      FROM SocialPostStatsDaily
      WHERE date >= :startDate
      GROUP BY post_id
    ) st ON st.post_id = sp.id
    WHERE sp.published_at IS NULL
       OR sp.published_at >= DATE_SUB(:startDate, INTERVAL 60 DAY)
  `, { startDate });

  const items = posts.map((postRow) => {
    const platform = postRow.asset_type === 'instagram_business' ? 'instagram' : 'facebook';
    const engagement = toInteger(postRow.engagement);
    return {
      profile: {
        platform,
        external_profile_id: postRow.external_profile_id || `${postRow.asset_type}:${postRow.asset_id}`,
        name: postRow.profile_name || postRow.external_profile_id || String(postRow.asset_id),
        client_name: postRow.client_name || postRow.profile_name,
        business_unit: businessUnit,
        status: 'active',
        last_sync_status: 'ok'
      },
      platform,
      external_post_id: postRow.post_id,
      post_type: postRow.post_type,
      title: postRow.title,
      content: postRow.content,
      media_url: postRow.media_url,
      permalink_url: postRow.permalink_url,
      published_at: postRow.published_at,
      impressions: toInteger(postRow.impressions),
      reach: toInteger(postRow.reach),
      engagement,
      likes: toInteger(postRow.likes),
      comments: toInteger(postRow.comments),
      shares: toInteger(postRow.shares),
      saves: toInteger(postRow.saves),
      video_views: toInteger(postRow.video_views),
      avg_watch_time_seconds: toNumber(postRow.avg_watch_time_seconds),
      is_winning: engagement >= 100,
      client_name: postRow.client_name,
      business_unit: businessUnit,
      raw_payload: {
        source: 'clinicaclick',
        source_table: 'SocialPosts',
        social_post_id: postRow.id
      }
    };
  });

  return postBatch('/api/internal/social-posts', items);
}

async function syncLocalBusiness() {
  const locations = await query(`
    SELECT loc.id,
           loc.clinica_id,
           loc.location_id,
           loc.location_name,
           loc.store_code,
           loc.is_verified,
           loc.is_suspended,
           loc.is_active,
           loc.last_synced_at,
           loc.raw_payload,
           c.nombre_clinica AS client_name,
           CONCAT_WS(', ', NULLIF(c.direccion, ''), NULLIF(c.codigo_postal, ''), NULLIF(c.ciudad, ''), NULLIF(c.provincia, '')) AS address
    FROM ClinicBusinessLocations loc
    LEFT JOIN Clinicas c ON c.id_clinica = loc.clinica_id
  `);

  await postBatch('/api/internal/local-locations', locations.map((location) => {
    const identity = googleBusinessIdentityFromRawPayload(location.raw_payload);

    return {
      external_location_id: location.location_id,
      place_id: identity.placeId,
      name: location.location_name || location.client_name || location.location_id,
      store_code: location.store_code || null,
      address: location.address || null,
      public_url: identity.mapsUri,
      google_maps_url: identity.mapsUri,
      verified: Boolean(location.is_verified) || identity.verified === true,
      suspended: Boolean(location.is_suspended) || identity.suspended === true,
      status: location.is_active ? 'active' : 'paused',
      last_synced_at: location.last_synced_at || null,
      client_name: location.client_name,
      business_unit: businessUnit,
      raw_payload: {
        ...identity.payload,
        source: 'clinicaclick',
        source_table: 'ClinicBusinessLocations',
        clinic_business_location_id: location.id
      }
    };
  }));

  const reviews = await query(`
    SELECT rv.review_name,
           rv.reviewer_name,
           rv.star_rating,
           rv.comment,
           rv.review_state,
           rv.has_reply,
           rv.is_negative,
           rv.create_time,
           rv.update_time,
           rv.reply_comment,
           loc.location_id,
           c.nombre_clinica AS client_name,
           rv.raw_payload
    FROM BusinessProfileReviews rv
    LEFT JOIN ClinicBusinessLocations loc ON loc.id = rv.business_location_id
    LEFT JOIN Clinicas c ON c.id_clinica = rv.clinica_id
  `);

  await postBatch('/api/internal/local-reviews', reviews.map((review) => ({
    external_location_id: review.location_id,
    external_review_id: review.review_name,
    reviewer_name: review.reviewer_name,
    rating: toInteger(review.star_rating),
    comment: review.comment,
    review_state: review.review_state,
    has_reply: Boolean(review.has_reply),
    is_negative: Boolean(review.is_negative) || toInteger(review.star_rating) <= 3,
    review_created_at: review.create_time,
    review_updated_at: review.update_time,
    reply_comment: review.reply_comment,
    client_name: review.client_name,
    business_unit: businessUnit,
    raw_payload: review.raw_payload || {}
  })));

  const posts = await query(`
    SELECT bp.post_name,
           bp.summary,
           bp.topic_type,
           bp.call_to_action_type,
           bp.call_to_action_url,
           bp.media_url,
           bp.create_time,
           bp.visibility_state,
           loc.location_id,
           c.nombre_clinica AS client_name,
           bp.raw_payload
    FROM BusinessProfilePosts bp
    LEFT JOIN ClinicBusinessLocations loc ON loc.id = bp.business_location_id
    LEFT JOIN Clinicas c ON c.id_clinica = bp.clinica_id
  `);

  const pushedPosts = await postBatch('/api/internal/local-posts', posts.map((postRow) => ({
    external_location_id: postRow.location_id,
    external_post_id: postRow.post_name,
    summary: postRow.summary,
    topic_type: postRow.topic_type,
    cta_type: postRow.call_to_action_type,
    cta_url: postRow.call_to_action_url,
    media_url: postRow.media_url,
    published_at: postRow.create_time,
    visibility_state: postRow.visibility_state,
    client_name: postRow.client_name,
    business_unit: businessUnit,
    raw_payload: postRow.raw_payload || {}
  })));

  return {
    locations: locations.length,
    reviews: reviews.length,
    posts: pushedPosts
  };
}

async function syncWebSeoAndPsi(startDate) {
  const seoRows = await query(`
    SELECT sc.clinica_id,
           c.nombre_clinica AS client_name,
           sc.site_url,
           sc.date,
           sc.clicks,
           sc.impressions,
           sc.ctr,
           sc.position
    FROM WebScDaily sc
    LEFT JOIN Clinicas c ON c.id_clinica = sc.clinica_id
    WHERE sc.date >= :startDate
  `, { startDate });

  await postBatch('/api/internal/web-seo-daily', seoRows.map((row) => ({
    client_name: row.client_name,
    business_unit: businessUnit,
    domain: domainFromSiteUrl(row.site_url),
    site_url: row.site_url,
    stat_date: row.date,
    clicks: toInteger(row.clicks),
    impressions: toInteger(row.impressions),
    ctr: toNumber(row.ctr),
    position: toNumber(row.position),
    raw_payload: {
      source: 'clinicaclick',
      source_table: 'WebScDaily',
      clinica_id: row.clinica_id
    }
  })));

  const psiRows = await query(`
    SELECT psi.clinica_id,
           c.nombre_clinica AS client_name,
           psi.url,
           psi.fetched_at,
           psi.performance,
           psi.accessibility,
           psi.lcp_ms,
           psi.cls,
           psi.inp_ms,
           psi.https_ok,
           psi.https_status,
           psi.sitemap_found,
           psi.sitemap_url,
           psi.sitemap_status,
           psi.indexed_ok
    FROM WebPsiSnapshots psi
    LEFT JOIN Clinicas c ON c.id_clinica = psi.clinica_id
    WHERE psi.fetched_at >= DATE_SUB(:startDate, INTERVAL 60 DAY)
  `, { startDate });

  const pushedPsi = await postBatch('/api/internal/web-psi-snapshots', psiRows.map((row) => ({
    client_name: row.client_name,
    business_unit: businessUnit,
    domain: domainFromSiteUrl(row.url),
    url: row.url,
    fetched_at: row.fetched_at,
    performance_score: toNumber(row.performance),
    accessibility_score: toNumber(row.accessibility),
    lcp_ms: toInteger(row.lcp_ms),
    cls: toNumber(row.cls),
    inp_ms: toInteger(row.inp_ms),
    https_ok: row.https_ok,
    https_status: toInteger(row.https_status),
    sitemap_found: row.sitemap_found,
    sitemap_url: row.sitemap_url,
    sitemap_status: toInteger(row.sitemap_status),
    indexed_ok: row.indexed_ok,
    raw_payload: {
      source: 'clinicaclick',
      source_table: 'WebPsiSnapshots',
      clinica_id: row.clinica_id
    }
  })));

  return {
    seo: seoRows.length,
    psi: pushedPsi
  };
}

async function main() {
  if (!apiToken) {
    throw new Error('OPS_INTERNAL_API_TOKEN is required');
  }

  const startDate = isoDateDaysAgo(lookbackDays);
  const startedAt = new Date();
  console.log(`[ops-push] start lookback=${lookbackDays} startDate=${startDate}`);

  const clients = await syncClients();
  const { metaAccounts, googleAccounts, metaAccountMap, googleAccountMap } = await syncAccounts();
  const metaCampaignMap = await syncMetaCampaigns(metaAccountMap, startDate);
  const googleCampaignMap = await syncGoogleCampaigns(googleAccountMap, startDate);
  const metaStats = await syncMetaStats(metaAccountMap, metaCampaignMap, startDate);
  const googleStats = await syncGoogleStats(googleAccountMap, googleCampaignMap, startDate);
  const campaignStructure = await syncCampaignStructure(startDate);
  const social = await syncSocialProfilesAndStats(startDate);
  const socialPosts = await syncSocialPosts(startDate);
  const local = await syncLocalBusiness();
  const web = await syncWebSeoAndPsi(startDate);

  const elapsedSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  console.log(JSON.stringify({
    event: 'ops_push_finished',
    elapsed_seconds: elapsedSeconds,
    clients,
    meta_accounts: metaAccounts.length,
    google_accounts: googleAccounts.length,
    meta_campaigns: metaCampaignMap.size,
    google_campaigns: googleCampaignMap.size,
    meta_stats: metaStats,
    google_stats: googleStats,
    campaign_structure: campaignStructure,
    social_profiles: social.profiles,
    social_stats: social.stats,
    social_posts: socialPosts,
    local_locations: local.locations,
    local_reviews: local.reviews,
    local_posts: local.posts,
    web_seo: web.seo,
    web_psi: web.psi
  }));
}

main()
  .catch((error) => {
    console.error('[ops-push] failed:', error.response?.data || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.sequelize.close();
    } catch (_error) {
      // noop
    }
  });
