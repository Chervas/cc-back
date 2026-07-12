'use strict';

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanToken(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeGoogleCustomerId(value) {
  const normalized = cleanToken(value);
  if (!normalized) return null;
  const digits = normalized.replace(/[^0-9]/g, '');
  return digits || null;
}

function normalizeGoogleCampaignId(value) {
  const normalized = cleanToken(value);
  // Los campos persistidos reservan 32 caracteres. Rechazar entradas mas
  // largas evita que un parametro de URL manipulado rompa la ingesta en MySQL.
  return normalized && /^\d{1,32}$/.test(normalized) ? normalized : null;
}

function queryParamFromUrl(value, key) {
  const normalized = cleanToken(value);
  if (!normalized) return null;
  try {
    return new URL(normalized, 'https://clinicaclick.invalid/').searchParams.get(key);
  } catch (_error) {
    return null;
  }
}

function firstValidCampaignId(values) {
  for (const value of values || []) {
    const normalized = normalizeGoogleCampaignId(value);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Resuelve el id de campaña sin convertir identificadores arbitrarios en
 * números. Nuestro sufijo cc_gads_* tiene prioridad sobre el parámetro legacy
 * gad_campaignid; las URLs permiten recuperar atribución aunque el navegador
 * no haya replicado todavía esos parámetros al payload.
 */
function resolveGoogleAdsCampaignId({
  ccCandidates = [],
  canonicalCandidates = [],
  gadCandidates = [],
  urls = [],
} = {}) {
  const urlValues = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  return firstValidCampaignId([
    ...(Array.isArray(ccCandidates) ? ccCandidates : [ccCandidates]),
    ...urlValues.map((value) => queryParamFromUrl(value, 'cc_gads_campaign_id')),
    ...(Array.isArray(canonicalCandidates) ? canonicalCandidates : [canonicalCandidates]),
    ...(Array.isArray(gadCandidates) ? gadCandidates : [gadCandidates]),
    ...urlValues.map((value) => queryParamFromUrl(value, 'gad_campaignid')),
  ]);
}

function firstPresent(...values) {
  return values.find((value) => cleanToken(value)) ?? null;
}

function extractGoogleLeadIdentity(body = {}) {
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  const googleAds = body?.google_ads && typeof body.google_ads === 'object' ? body.google_ads : {};
  const attribution = body?.attribution && typeof body.attribution === 'object' ? body.attribution : {};
  const customData = body?.custom_data && typeof body.custom_data === 'object' ? body.custom_data : {};
  const eventData = body?.event_data && typeof body.event_data === 'object' ? body.event_data : {};

  return {
    customerId: normalizeGoogleCustomerId(firstPresent(
      attribution.cc_gads_customer_id,
      attribution.ccGadsCustomerId,
      attribution.google_ads_customer_id,
      attribution.googleAdsCustomerId,
      attribution.google_customer_id,
      attribution.customer_id,
      body.cc_gads_customer_id,
      body.ccGadsCustomerId,
      body.google_ads_customer_id,
      body.googleAdsCustomerId,
      body.customer_id,
      body.customerId,
      body.google_customer_id,
      body.account_id,
      body.accountId,
      googleAds.customer_id,
      googleAds.customerId,
      googleAds.account_id,
      googleAds.accountId,
      googleAds.cc_gads_customer_id,
      googleAds.google_ads_customer_id,
      payload.cc_gads_customer_id,
      payload.google_ads_customer_id,
      payload.customer_id,
      payload.customerId,
      payload.google_customer_id,
      payload.account_id,
      payload.accountId,
      customData.cc_gads_customer_id,
      customData.google_ads_customer_id,
      customData.customer_id,
      customData.customerId,
      eventData.cc_gads_customer_id,
      eventData.google_ads_customer_id,
      eventData.customer_id,
    )),
    campaignId: resolveGoogleAdsCampaignId({
      ccCandidates: [
        attribution.cc_gads_campaign_id,
        attribution.ccGadsCampaignId,
        body.cc_gads_campaign_id,
        body.ccGadsCampaignId,
        googleAds.cc_gads_campaign_id,
        payload.cc_gads_campaign_id,
        customData.cc_gads_campaign_id,
        eventData.cc_gads_campaign_id,
      ],
      canonicalCandidates: [
        attribution.google_ads_campaign_id,
        attribution.googleAdsCampaignId,
        attribution.google_campaign_id,
        attribution.campaign_id,
        body.google_ads_campaign_id,
        body.googleAdsCampaignId,
        body.google_campaign_id,
        body.googleCampaignId,
        body.campaignid,
        body.external_campaign_id,
        body.externalCampaignId,
        body.campaign_id,
        body.campaignId,
        googleAds.google_ads_campaign_id,
        googleAds.external_campaign_id,
        googleAds.externalCampaignId,
        googleAds.campaign_id,
        googleAds.campaignId,
        payload.google_ads_campaign_id,
        payload.external_campaign_id,
        payload.externalCampaignId,
        payload.campaign_id,
        payload.campaignId,
        customData.google_ads_campaign_id,
        customData.google_campaign_id,
        customData.campaign_id,
        customData.campaignId,
        eventData.google_ads_campaign_id,
        eventData.google_campaign_id,
        eventData.campaign_id,
      ],
      gadCandidates: [
        attribution.gad_campaignid,
        attribution.gadCampaignId,
        body.gad_campaignid,
        body.gadCampaignId,
        googleAds.gad_campaignid,
        payload.gad_campaignid,
        customData.gad_campaignid,
        customData.gadCampaignId,
        eventData.gad_campaignid,
      ],
      urls: [
        attribution.page_url,
        attribution.pageUrl,
        attribution.landing_url,
        attribution.landingUrl,
        body.page_url,
        body.pageUrl,
        body.landing_url,
        body.landingUrl,
        body.event_source_url,
        body.eventSourceUrl,
        payload.page_url,
        payload.landing_url,
        customData.page_url,
        customData.pageUrl,
        customData.landing_url,
        customData.landingUrl,
        customData.event_source_url,
        eventData.page_url,
        eventData.pageUrl,
        eventData.landing_url,
      ],
    }),
  };
}

function plainRow(row) {
  if (!row) return null;
  return typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

function accountScopeKey(account) {
  const scope = String(account?.assignmentScope || '').trim().toLowerCase();
  if (scope === 'group') {
    const groupId = positiveInt(account?.grupoClinicaId ?? account?.grupo_clinica_id);
    return groupId ? `group:${groupId}` : null;
  }
  if (scope === 'clinic') {
    const clinicId = positiveInt(account?.clinicaId ?? account?.clinica_id);
    return clinicId ? `clinic:${clinicId}` : null;
  }
  return null;
}

function selectUnambiguousAccount(accounts, { currentClinicId = null, currentGroupId = null } = {}) {
  const rows = (Array.isArray(accounts) ? accounts : [])
    .map(plainRow)
    .filter((row) => accountScopeKey(row));
  const clinicId = positiveInt(currentClinicId);
  const groupId = positiveInt(currentGroupId);

  let candidates = rows;
  if (clinicId) {
    candidates = rows.filter((row) => accountScopeKey(row) === `clinic:${clinicId}`);
  } else if (groupId) {
    candidates = rows.filter((row) => accountScopeKey(row) === `group:${groupId}`);
  }

  const scopeKeys = new Set(candidates.map(accountScopeKey));
  if (scopeKeys.size !== 1) return null;
  return candidates.sort((left, right) => positiveInt(left.id) - positiveInt(right.id))[0] || null;
}

async function resolveGoogleLeadRoute({
  body = {},
  currentClinicId = null,
  currentGroupId = null,
  accountModel,
  assignmentModel,
} = {}) {
  const identity = extractGoogleLeadIdentity(body);
  const empty = {
    matched: false,
    customerId: identity.customerId,
    campaignId: identity.campaignId,
    clinicId: null,
    groupId: null,
    matchSource: null,
    matchValue: null,
    preserveGroupScope: false,
    ambiguous: false,
  };
  if (!identity.customerId || !accountModel?.findAll) return empty;

  const accountRows = await accountModel.findAll({
    where: { customerId: identity.customerId, isActive: true },
    order: [['id', 'ASC']],
    raw: true,
  });
  const accounts = (Array.isArray(accountRows) ? accountRows : []).map(plainRow);
  const account = selectUnambiguousAccount(accounts, { currentClinicId, currentGroupId });
  if (!account) {
    return { ...empty, ambiguous: accounts.length > 1 };
  }

  const scope = String(account.assignmentScope || '').trim().toLowerCase();
  if (scope === 'clinic') {
    const clinicId = positiveInt(account.clinicaId ?? account.clinica_id);
    if (!clinicId) return empty;
    return {
      ...empty,
      matched: true,
      clinicId,
      groupId: positiveInt(account.grupoClinicaId ?? account.grupo_clinica_id),
      matchSource: 'google_ads_customer',
      matchValue: identity.customerId,
    };
  }

  const groupId = positiveInt(account.grupoClinicaId ?? account.grupo_clinica_id);
  if (scope !== 'group' || !groupId) return empty;

  if (identity.campaignId && assignmentModel?.findOne) {
    const assignment = plainRow(await assignmentModel.findOne({
      where: {
        provider: 'google_ads',
        customer_id: identity.customerId,
        campaign_id: identity.campaignId,
        status: 'active',
      },
      raw: true,
    }));
    const assignmentGroupId = positiveInt(assignment?.grupo_clinica_id ?? assignment?.grupoClinicaId);
    const assignmentClinicId = positiveInt(assignment?.clinica_id ?? assignment?.clinicaId);
    if (assignment && assignmentGroupId === groupId && assignmentClinicId) {
      return {
        ...empty,
        matched: true,
        clinicId: assignmentClinicId,
        groupId,
        matchSource: 'google_ads_campaign',
        matchValue: `${identity.customerId}:${identity.campaignId}`,
      };
    }
  }

  // Las cuentas compartidas pueden conservar clinicaId por compatibilidad histórica.
  // Ese valor no representa el destino del lead y nunca debe usarse como fallback.
  return {
    ...empty,
    matched: true,
    groupId,
    preserveGroupScope: true,
  };
}

module.exports = {
  extractGoogleLeadIdentity,
  normalizeGoogleCampaignId,
  normalizeGoogleCustomerId,
  resolveGoogleAdsCampaignId,
  resolveGoogleLeadRoute,
  selectUnambiguousAccount,
};
