'use strict';

// Read-only evidence. Neither HTML nor a plugin heartbeat proves browser
// execution, an accepted lead, or delivery to an advertising provider.
const WINDOW_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const ACTIVITY_TYPES = ['page_view', 'consent_update', 'tel_click', 'whatsapp_click', 'form_submit', 'chat_open', 'chat_lead'];

function attribute(tag, name) {
  const attrs = String(tag).replace(/^<\w+\b/, '').matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g);
  for (const match of attrs) {
    if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return null;
}

function scriptsInHtml(html) {
  const source = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(template|textarea|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  return Array.from(source.matchAll(/(<script\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)<\/script\s*>/gi), ([, tag, body]) => ({ tag, body }));
}

function executable(tag) {
  const type = String(attribute(tag, 'type') || '').trim().toLowerCase();
  return ['', 'module', 'text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'].includes(type);
}

function snippetTagsInHtml(html, checkedUrl, isAllowedAssetUrl) {
  return scriptsInHtml(html).filter(({ tag }) => {
    const src = attribute(tag, 'src');
    if (!src || !executable(tag)) return false;
    try {
      const url = new URL(src.replace(/&amp;/gi, '&'), checkedUrl);
      return /^https?:$/.test(url.protocol) && /\/(?:intake|loader)\.js$/i.test(url.pathname)
        && isAllowedAssetUrl(url.toString(), checkedUrl);
    } catch { return false; }
  }).map(({ tag }) => tag);
}

// Tokenize only the small literal patterns we inspect; do not execute JS.
// Quoted examples and comments cannot masquerade as gtag calls.
function jsTokens(source) {
  return Array.from(String(source).matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g))
    .map(([value]) => value).filter((value) => !value.startsWith('//') && !value.startsWith('/*'));
}

function detectGoogleTags(html, checkedUrl) {
  const gtm = new Set();
  const ga4 = new Set();
  const google = new Set();
  const ads = new Set();
  let deferred = false;
  const addId = (id) => {
    if (/^GTM-[A-Z0-9]{4,32}$/.test(id)) gtm.add(id);
    else if (/^G-[A-Z0-9]{4,32}$/.test(id)) ga4.add(id);
    else if (/^GT-[A-Z0-9]{4,32}$/.test(id)) google.add(id);
    else if (/^AW-[0-9]{4,20}$/.test(id)) ads.add(id);
  };
  for (const { tag, body } of scriptsInHtml(html)) {
    if (!executable(tag) && attribute(tag, 'type') !== 'text/plain') continue;
    const before = gtm.size + ga4.size + google.size + ads.size;
    for (const key of ['src', 'data-src']) {
      const src = attribute(tag, key);
      if (!src) continue;
      try {
        const url = new URL(src.replace(/&amp;/gi, '&'), checkedUrl);
        if (['www.googletagmanager.com', 'googletagmanager.com'].includes(url.hostname)
          && /^https?:$/.test(url.protocol) && ['/gtm.js', '/gtag/js'].includes(url.pathname)) {
          addId(url.searchParams.get('id') || '');
        }
      } catch { /* An invalid URL is not evidence. */ }
    }
    const tokens = jsTokens(body);
    const literal = (token) => /^(['"])[^'"\\]*\1$/.test(token || '') ? token.slice(1, -1) : '';
    const hasGtmLoader = tokens.some((token) => /^(?:https?:)?\/\/(?:www\.)?googletagmanager\.com\/gtm\.js\?/.test(literal(token)));
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i] === 'gtag' && tokens[i + 1] === '(' && literal(tokens[i + 2]) === 'config' && tokens[i + 3] === ',') {
        addId(literal(tokens[i + 4]));
      }
      if (hasGtmLoader && /^GTM-[A-Z0-9]{4,32}$/.test(literal(tokens[i]))) addId(literal(tokens[i]));
    }
    if (before < gtm.size + ga4.size + google.size + ads.size && (!executable(tag) || (!attribute(tag, 'src') && attribute(tag, 'data-src')))) deferred = true;
  }
  return {
    source: 'page_html',
    gtm_container_ids: [...gtm].sort(),
    ga4_measurement_ids: [...ga4].sort(),
    google_tag_ids: [...google].sort(),
    ads_tag_ids: [...ads].sort(),
    deferred_tags_present: deferred,
    // Multiple containers may serve different purposes or contain paused tags.
    overlap_review_recommended: gtm.size > 1 || (gtm.size > 0 && ga4.size + google.size + ads.size > 0),
    duplication: 'not_assessed',
    execution: 'not_verified',
    ga4_bridge: 'not_configured',
  };
}

function canonicalHost(value) {
  try {
    const url = new URL(String(value).includes('://') ? value : `https://${value}`);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch { return null; }
}

function safeDate(value, nowMs) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= nowMs ? date.toISOString() : null;
}

async function readStoredWebEvidence({ models, Op, scopeType, scopeId, clinicId, domain, locationIds = [], nowMs = Date.now() }) {
  const host = canonicalHost(domain);
  const activity = { status: 'unavailable', window_hours: WINDOW_HOURS, last_received_at: null, source: 'stored_web_events' };
  const plugin = { status: 'unavailable', version: null, last_seen_at: null, recent_contact: false };
  if (!host || !Number.isSafeInteger(Number(scopeId)) || Number(scopeId) <= 0) return { plugin, activity };
  // Minimal projections only. No provider clients, payloads, visitor IDs,
  // URLs from events, installation tokens, or reportedState are read.
  await Promise.all([
    (async () => {
      if (!models.WebWordpressInstallation?.findAll) return;
      try {
        const rows = await models.WebWordpressInstallation.findAll({
          where: { scopeType, ...(scopeType === 'group' ? { grupoClinicaId: scopeId } : { clinicaId: scopeId }) },
          attributes: ['siteUrl', 'status', 'pluginVersion', 'lastSeenAt'],
          raw: true,
        });
        const matching = rows.filter((row) => canonicalHost(row.siteUrl) === host);
        if (!matching.length) { plugin.status = 'not_registered'; return; }
        const active = matching.filter((row) => row.status !== 'revoked');
        if (active.length > 1) { plugin.status = 'ambiguous'; return; }
        const row = active[0] || matching[0];
        plugin.status = ['pending', 'connected', 'outdated', 'revoked'].includes(row.status) ? row.status : 'unavailable';
        plugin.version = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(row.pluginVersion || '') ? row.pluginVersion : null;
        plugin.last_seen_at = safeDate(row.lastSeenAt, nowMs);
        plugin.recent_contact = !!plugin.last_seen_at && Date.parse(plugin.last_seen_at) >= nowMs - WINDOW_HOURS * HOUR_MS;
      } catch { /* Keep unknown, never turn query failure into absent. */ }
    })(),
    (async () => {
      if (!models.WebEvent?.max) return;
      try {
        const where = {
          domain: { [Op.in]: [host, `www.${host}`] },
          event_type: { [Op.in]: ACTIVITY_TYPES },
          created_at: { [Op.between]: [new Date(nowMs - WINDOW_HOURS * HOUR_MS), new Date(nowMs)] },
          ...(scopeType === 'group' ? { group_id: scopeId } : { clinic_id: scopeId }),
        };
        // A clinic opening its shared group configuration must not gain access
        // to activity belonging to the group's other clinics.
        if (clinicId != null) where.clinic_id = clinicId;
        else if (scopeType === 'group') {
          const ids = locationIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
          where[Op.or] = [{ clinic_id: null }, ...(ids.length ? [{ clinic_id: { [Op.in]: ids } }] : [])];
        }
        const last = await models.WebEvent.max('created_at', { where });
        activity.last_received_at = safeDate(last, nowMs);
        activity.status = activity.last_received_at ? 'received' : 'no_recent_activity';
      } catch { /* An unavailable read is different from no recent events. */ }
    })(),
  ]);
  return { plugin, activity };
}

function buildWebDiagnostics({ html, checkedUrl, evaluation = {}, stored, features, nowMs = Date.now(), isAllowedAssetUrl, expectedAttr, expectedId }) {
  const scripts = snippetTagsInHtml(html, checkedUrl, isAllowedAssetUrl);
  const scoped = scripts.filter((tag) => attribute(tag, expectedAttr) === String(expectedId));
  return {
    version: 1,
    checked_at: new Date(nowMs).toISOString(),
    page_status: html == null ? 'unreachable' : 'inspected',
    installation: {
      snippet_present: scripts.length > 0,
      scope_matches: scoped.length > 0,
      loader_visible: scoped.some((tag) => /\/loader\.js(?:[?#]|$)/i.test(attribute(tag, 'src'))),
      transport_configured: evaluation.installed === true && (
        ['same_origin_server_bridge', 'legacy_browser_hmac'].includes(evaluation.security_transport)
        || scoped.some((tag) => attribute(tag, 'data-event-bridge-url') === '/_clinicaclick/events')
      ),
      status: html == null ? 'unverified' : evaluation.installed ? 'detected' : evaluation.reason || 'unverified',
    },
    plugin: stored.plugin,
    runtime: {
      status: evaluation.runtime_compatible === true ? 'compatible' : evaluation.runtime_version ? 'incompatible' : 'unverified',
      version: evaluation.runtime_version || null,
      execution: 'not_verified',
    },
    activity: stored.activity,
    tags: { ...detectGoogleTags(html, checkedUrl), ga4_bridge: require('./intake-ga4-bridge').bridgeStatus(features) },
  };
}

module.exports = { attribute, snippetTagsInHtml, detectGoogleTags, readStoredWebEvidence, buildWebDiagnostics };
