'use strict';

const GOOGLE_ATTRIBUTION_KEYS = Object.freeze([
  'cc_gads_customer_id',
  'cc_gads_campaign_id',
]);

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeDestinationUrl(rawValue) {
  const value = String(rawValue || '')
    .replace(/\{ignore\}/gi, '')
    .trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    parsed.search = '';
    const pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    parsed.pathname = pathname.endsWith('/') ? pathname : `${pathname}/`;
    return parsed.toString();
  } catch (_error) {
    return null;
  }
}

function destinationDomain(rawValue) {
  const normalized = normalizeDestinationUrl(rawValue);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_error) {
    return null;
  }
}

function normalizeCampaignId(value) {
  const normalized = String(value || '').trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function hasClinicaclickAttributionSuffix(value) {
  const suffix = String(value || '').toLowerCase();
  return GOOGLE_ATTRIBUTION_KEYS.every((key) => suffix.includes(key));
}

function mergeObservedDestination(map, rawUrl, clicks = 0) {
  const url = normalizeDestinationUrl(rawUrl);
  if (!url) return;
  const previous = map.get(url) || { url, clicks: 0 };
  previous.clicks += toNumber(clicks);
  map.set(url, previous);
}

function buildGoogleDestinationDetections({ campaignRows = [], landingRows = [], checkedAt = new Date() } = {}) {
  const campaigns = new Map();
  for (const row of Array.isArray(campaignRows) ? campaignRows : []) {
    const campaign = row?.campaign || {};
    const campaignId = normalizeCampaignId(campaign.id);
    if (!campaignId) continue;
    campaigns.set(campaignId, {
      campaignId,
      campaignName: campaign.name || null,
      channelType: campaign.advertisingChannelType || campaign.advertising_channel_type || null,
      urlExpansionEnabled: (campaign.advertisingChannelType || campaign.advertising_channel_type) === 'PERFORMANCE_MAX'
        ? !(campaign.urlExpansionOptOut ?? campaign.url_expansion_opt_out ?? false)
        : false,
      attributionSuffixPresent: hasClinicaclickAttributionSuffix(
        campaign.finalUrlSuffix || campaign.final_url_suffix
      ),
      destinations: new Map(),
    });
  }

  for (const row of Array.isArray(landingRows) ? landingRows : []) {
    const campaignId = normalizeCampaignId(row?.campaign?.id);
    if (!campaignId) continue;
    if (!campaigns.has(campaignId)) {
      campaigns.set(campaignId, {
        campaignId,
        campaignName: row?.campaign?.name || null,
        channelType: null,
        urlExpansionEnabled: false,
        attributionSuffixPresent: false,
        destinations: new Map(),
      });
    }
    const record = campaigns.get(campaignId);
    const rawUrl = row?.landingPageView?.unexpandedFinalUrl
      || row?.landing_page_view?.unexpanded_final_url
      || null;
    mergeObservedDestination(record.destinations, rawUrl, row?.metrics?.clicks);
  }

  const measuredAt = checkedAt instanceof Date ? checkedAt.toISOString() : String(checkedAt || '');
  const output = new Map();
  for (const [campaignId, campaign] of campaigns.entries()) {
    const destinations = Array.from(campaign.destinations.values())
      .sort((left, right) => right.clicks - left.clicks || left.url.localeCompare(right.url))
      .slice(0, 50);
    const urls = destinations.map((item) => item.url);
    const domains = Array.from(new Set(urls.map(destinationDomain).filter(Boolean)));
    output.set(campaignId, {
      provider: 'google_ads',
      source: 'landing_page_view',
      status: urls.length ? 'observed' : 'not_observed',
      checked_at: measuredAt || null,
      channel_type: campaign.channelType,
      urls,
      domains,
      primary_url: urls[0] || null,
      observed_destination_count: urls.length,
      url_expansion_enabled: campaign.urlExpansionEnabled,
      expanded_beyond_primary: campaign.urlExpansionEnabled && urls.length > 1,
      clinicaclick_attribution_suffix: campaign.attributionSuffixPresent,
    });
  }
  return output;
}

function normalizeDomainSet(values) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const candidate = String(value || '').trim().toLowerCase();
    if (!candidate) continue;
    const domain = candidate.includes('://') ? destinationDomain(candidate) : candidate.replace(/^www\./, '').replace(/\/$/, '');
    if (domain) out.add(domain);
  }
  return out;
}

function diagnoseGoogleCampaignMeasurement({
  spend = 0,
  providerConversions = 0,
  providerAllConversions = 0,
  scopedCrmLeads = 0,
  otherClinicCrmLeads = 0,
  destinationDetection = null,
  measuredDomains = [],
} = {}) {
  const detection = destinationDetection && typeof destinationDetection === 'object'
    ? destinationDetection
    : {};
  const destinationDomains = normalizeDomainSet([
    ...(Array.isArray(detection.domains) ? detection.domains : []),
    ...(Array.isArray(detection.urls) ? detection.urls : []),
  ]);
  const coveredDomains = normalizeDomainSet(measuredDomains);
  const uncoveredDomains = Array.from(destinationDomains).filter((domain) => !coveredDomains.has(domain));
  const destinationKnown = destinationDomains.size > 0;
  const destinationCovered = destinationKnown && uncoveredDomains.length === 0;
  const attributionSuffixPresent = detection.clinicaclick_attribution_suffix === true;
  const primaryConversions = toNumber(providerConversions);
  const allConversions = Math.max(primaryConversions, toNumber(providerAllConversions));
  const hasSpendWithoutProviderConversions = toNumber(spend) >= 25 && allConversions === 0;
  const recommendations = [];

  if (detection.url_expansion_enabled === true && detection.expanded_beyond_primary === true) {
    recommendations.push({
      code: 'pmax_url_expansion_broad',
      severity: 'recommendation',
      message: 'Performance Max tiene activa la expansión de URL y ha enviado tráfico a varias páginas. Si esta campaña debe ser exclusivamente local, conviene limitar sus destinos desde Google Ads.',
    });
  }

  let state = 'healthy';
  let severity = 'ok';
  let alert;
  let notice;

  if (toNumber(spend) >= 25 && primaryConversions === 0 && allConversions > 0) {
    state = 'secondary_conversions_only';
    severity = 'info';
    notice = `Google Ads registra ${allConversions} conversi${allConversions === 1 ? 'ón' : 'ones'} en «Todas las conversiones», aunque ninguna está incluida en la columna principal del periodo.`;
  } else if (hasSpendWithoutProviderConversions) {
    if (toNumber(scopedCrmLeads) > 0) {
      state = 'provider_conversion_gap';
      severity = 'warning';
      alert = `ClinicaClick ha atribuido ${toNumber(scopedCrmLeads)} lead${toNumber(scopedCrmLeads) === 1 ? '' : 's'} a esta campaña, pero Google Ads todavía muestra 0 conversiones en el periodo. Revisa la importación, no el destino.`;
    } else if (toNumber(otherClinicCrmLeads) > 0) {
      state = 'cross_clinic_attribution';
      severity = 'warning';
      alert = `Esta campaña ha generado ${toNumber(otherClinicCrmLeads)} lead${toNumber(otherClinicCrmLeads) === 1 ? '' : 's'} en otra clínica del grupo. Revisa el alcance o la asignación de la campaña.`;
    } else if (destinationCovered && attributionSuffixPresent) {
      state = 'covered_no_conversions';
      severity = 'info';
      notice = 'Destino cubierto y medición de ClinicaClick operativa. Google Ads no ha registrado conversiones reales para esta campaña en el periodo.';
    } else if (destinationKnown && uncoveredDomains.length) {
      state = 'destination_not_covered';
      severity = 'critical';
      alert = `La campaña está enviando tráfico a ${uncoveredDomains.join(', ')}, fuera de la medición web confirmada de ClinicaClick.`;
    } else if (destinationKnown) {
      state = 'attribution_suffix_missing';
      severity = 'warning';
      alert = 'El destino está identificado, pero no hemos confirmado la atribución de campaña de ClinicaClick en Google Ads.';
    } else {
      state = 'destination_pending';
      severity = 'warning';
      alert = 'Google Ads no ha registrado conversiones en el periodo y todavía no tenemos un destino observado para comprobar su cobertura.';
    }
  }

  return {
    state,
    severity,
    alert,
    notice,
    destination_known: destinationKnown,
    destination_covered: destinationCovered,
    primary_destination_url: detection.primary_url || (Array.isArray(detection.urls) ? detection.urls[0] : null) || null,
    destination_urls: Array.isArray(detection.urls) ? detection.urls.slice(0, 10) : [],
    observed_destination_count: toNumber(detection.observed_destination_count),
    destination_domains: Array.from(destinationDomains),
    uncovered_domains: uncoveredDomains,
    clinicaclick_attribution_suffix: attributionSuffixPresent,
    url_expansion_enabled: detection.url_expansion_enabled === true,
    expanded_beyond_primary: detection.expanded_beyond_primary === true,
    destination_checked_at: detection.checked_at || null,
    provider_conversions: primaryConversions,
    provider_all_conversions: allConversions,
    recommendations,
  };
}

module.exports = {
  buildGoogleDestinationDetections,
  destinationDomain,
  diagnoseGoogleCampaignMeasurement,
  hasClinicaclickAttributionSuffix,
  normalizeDestinationUrl,
};
