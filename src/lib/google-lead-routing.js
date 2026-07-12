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

function firstPresent(...values) {
  return values.find((value) => cleanToken(value)) ?? null;
}

function extractGoogleLeadIdentity(body = {}) {
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  const googleAds = body?.google_ads && typeof body.google_ads === 'object' ? body.google_ads : {};

  return {
    customerId: normalizeGoogleCustomerId(firstPresent(
      body.customer_id,
      body.customerId,
      body.google_customer_id,
      body.account_id,
      body.accountId,
      googleAds.customer_id,
      googleAds.customerId,
      googleAds.account_id,
      googleAds.accountId,
      payload.customer_id,
      payload.customerId,
      payload.google_customer_id,
      payload.account_id,
      payload.accountId,
    )),
    campaignId: cleanToken(firstPresent(
      body.external_campaign_id,
      body.externalCampaignId,
      body.campaign_id,
      body.campaignId,
      googleAds.external_campaign_id,
      googleAds.externalCampaignId,
      googleAds.campaign_id,
      googleAds.campaignId,
      payload.external_campaign_id,
      payload.externalCampaignId,
      payload.campaign_id,
      payload.campaignId,
    )),
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
  normalizeGoogleCustomerId,
  resolveGoogleLeadRoute,
  selectUnambiguousAccount,
};
