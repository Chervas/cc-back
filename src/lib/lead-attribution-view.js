'use strict';

const clean = (value) => String(value || '').trim().toLowerCase();
const present = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const text = (value) => present(value) ? String(value).trim() : null;

const GOOGLE_UTM_SOURCES = new Set(['google', 'googleads', 'google_ads', 'adwords']);
const PAID_UTM_MEDIA = new Set(['cpc', 'ppc', 'paid', 'paid_search', 'paidsearch', 'display']);
const MARKETING_ORIGIN_LABELS = Object.freeze({
  web: 'Web',
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  tiktok_ads: 'TikTok Ads',
  whatsapp: 'WhatsApp',
  call_click: 'Llamada',
  seo: 'SEO',
  direct: 'Directo',
  social_organic: 'Redes sociales',
  local_services: 'Local Services',
  unknown: 'Desconocido',
});
const CONTACT_METHOD_LABELS = Object.freeze({
  web_phone: 'Teléfono de la web',
  web_chat: 'Chat web',
  web_form: 'Formulario web',
  platform_form: 'Formulario del anuncio',
  whatsapp: 'WhatsApp',
  phone: 'Teléfono',
  web: 'Web',
  unknown: 'Desconocido',
});

const resolveLeadMarketingOrigin = (lead = {}) => {
  if (
    present(lead.gclid)
    || present(lead.gbraid)
    || present(lead.wbraid)
    || present(lead.google_ads_customer_id)
    || present(lead.google_ads_campaign_id)
  ) {
    return 'google_ads';
  }
  if (present(lead.fbclid)) return 'meta_ads';
  if (present(lead.ttclid)) return 'tiktok_ads';

  const source = clean(lead.source);
  if (source && source !== 'web') return source;

  const utmSource = clean(lead.utm_source);
  const utmMedium = clean(lead.utm_medium);
  if (GOOGLE_UTM_SOURCES.has(utmSource)) {
    return PAID_UTM_MEDIA.has(utmMedium) ? 'google_ads' : 'seo';
  }
  if (['facebook', 'instagram', 'meta', 'fb'].includes(utmSource)) {
    return PAID_UTM_MEDIA.has(utmMedium) ? 'meta_ads' : 'social_organic';
  }
  if (['tiktok', 'tik_tok'].includes(utmSource)) {
    return PAID_UTM_MEDIA.has(utmMedium) ? 'tiktok_ads' : 'social_organic';
  }

  return source || (clean(lead.channel) === 'organic' ? 'direct' : 'unknown');
};

const resolveLeadContactMethod = (lead = {}) => {
  const detail = clean(lead.source_detail);
  const source = clean(lead.source);

  if (['tel_modal', 'tel_modal_call', 'web_phone', 'phone_modal'].includes(detail)) return 'web_phone';
  if (detail.includes('chat')) return 'web_chat';
  if (detail.includes('form')) {
    return detail.includes('leadgen') || detail.includes('instant') ? 'platform_form' : 'web_form';
  }
  if (detail.includes('whatsapp') || source === 'whatsapp') return 'whatsapp';
  if (source === 'call_click') return 'phone';
  if (source === 'web') return 'web';
  if (['google_ads', 'meta_ads', 'tiktok_ads'].includes(source)) return 'platform_form';
  return source || 'unknown';
};

const buildMarketingOriginWhere = (source, Op) => {
  const normalized = clean(source);
  if (!normalized || !Op) return null;

  if (normalized === 'google_ads') {
    return {
      [Op.or]: [
        { source: 'google_ads' },
        { gclid: { [Op.ne]: null } },
        { gbraid: { [Op.ne]: null } },
        { wbraid: { [Op.ne]: null } },
        { google_ads_customer_id: { [Op.ne]: null } },
        { google_ads_campaign_id: { [Op.ne]: null } },
      ],
    };
  }
  if (normalized === 'meta_ads') {
    return { [Op.or]: [{ source: 'meta_ads' }, { fbclid: { [Op.ne]: null } }] };
  }
  if (normalized === 'tiktok_ads') {
    return { [Op.or]: [{ source: 'tiktok_ads' }, { ttclid: { [Op.ne]: null } }] };
  }
  if (normalized === 'web') {
    return {
      source: 'web',
      gclid: null,
      gbraid: null,
      wbraid: null,
      google_ads_customer_id: null,
      google_ads_campaign_id: null,
      fbclid: null,
      ttclid: null,
    };
  }
  return { source: normalized };
};

const buildLeadCreatedDescription = (lead = {}) => {
  const contactMethod = resolveLeadContactMethod(lead);
  const marketingOrigin = resolveLeadMarketingOrigin(lead);
  const contactLabel = CONTACT_METHOD_LABELS[contactMethod] || contactMethod;
  const originLabel = MARKETING_ORIGIN_LABELS[marketingOrigin] || marketingOrigin;
  const lines = [];
  if (contactLabel) lines.push(`Contacto: ${contactLabel}`);
  if (originLabel) lines.push(`Origen: ${originLabel}`);

  if (contactMethod === 'web_phone') {
    const clickedPhone = text(lead.telefono);
    const pageUrl = text(lead.page_url) || text(lead.landing_url);
    if (clickedPhone) lines.push(`Teléfono pulsado: ${clickedPhone}`);
    if (pageUrl) lines.push(`Página de entrada: ${pageUrl}`);
  }
  return lines.length ? lines.join('\n') : 'Nuevo lead';
};

const buildLeadAttributionView = (lead = {}, inventory = null) => {
  const marketingOrigin = resolveLeadMarketingOrigin(lead);
  const contactMethod = resolveLeadContactMethod(lead);
  const campaignId = text(inventory?.campaign_id) || text(lead.google_ads_campaign_id);
  const customerId = text(inventory?.customer_id) || text(lead.google_ads_customer_id);
  const internalCampaignName = text(lead?.campana?.nombre);
  const campaignName = text(inventory?.campaign_name)
    || text(lead.utm_campaign)
    || internalCampaignName;
  const campaignProvider = text(inventory?.provider)
    || (campaignId ? 'google_ads' : (marketingOrigin.endsWith('_ads') ? marketingOrigin : null));

  return {
    ...lead,
    contact_method: contactMethod,
    marketing_origin: marketingOrigin,
    marketing_campaign: (campaignName || campaignId || lead.campana_id)
      ? {
          provider: campaignProvider,
          customer_id: customerId,
          external_id: campaignId,
          name: campaignName,
          resolution: inventory?.campaign_name
            ? 'external_inventory'
            : (lead.utm_campaign ? 'utm_campaign' : (internalCampaignName ? 'clinicaclick_campaign' : 'external_id')),
        }
      : null,
  };
};

module.exports = {
  resolveLeadMarketingOrigin,
  resolveLeadContactMethod,
  buildMarketingOriginWhere,
  buildLeadCreatedDescription,
  buildLeadAttributionView,
};
