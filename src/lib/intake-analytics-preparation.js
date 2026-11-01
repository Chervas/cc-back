'use strict';
const { createHash } = require('node:crypto');
const CHANNELS = ['phone', 'whatsapp', 'form'];
const error = (code, status = 409) => Object.assign(Error(code), { code, status });
function safeTags(value) {
  const result = {};
  for (const [key, pattern] of Object.entries({ gtm_container_ids: /^GTM-[A-Z0-9]{4,32}$/,
    ga4_measurement_ids: /^G-[A-Z0-9]{4,32}$/, google_tag_ids: /^GT-[A-Z0-9]{4,32}$/ })) {
    result[key] = [...new Set((Array.isArray(value?.[key]) ? value[key] : [])
      .filter(id => typeof id === 'string' && pattern.test(id)))].sort().slice(0, 50);
  }
  return result;
}
function host(value) {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch { return null; }
}
function revision(record, mappings) {
  return createHash('sha256').update(JSON.stringify({
    id: record.id, clinic_id: record.clinic_id, group_id: record.group_id, assignment_scope: record.assignment_scope, domains: record.domains, config: record.config,
    mappings: mappings.map(m => [Number(m.id), Number(m.clinicaId), Number(m.googleConnectionId), m.propertyName,
      m.broker_read_connection_ref, m.broker_read_asset_ref]).sort((a, b) => a[0] - b[0]),
  })).digest('hex');
}
function plan({ record, mappings, streams, domain, signals, streamName }) {
  const features = record.config?.features || {};
  const matching = streams.filter(s => host(s.webStreamData.defaultUri) === host(domain));
  const unique = [...new Map(matching.map(s => [s.name, s])).values()];
  const selected = streamName ? unique.find(s => s.name === streamName) || null : unique.length === 1 ? unique[0] : null;
  const target = selected?.webStreamData.measurementId || null;
  const tags = signals?.analytics_tags ? safeTags(signals.analytics_tags) : null;
  const pending = [];
  if (!mappings.length) pending.push('analytics_connection_required');
  else if (!unique.length) pending.push('matching_stream_required');
  else if (!selected) pending.push('stream_selection_required');
  if (!signals?.installed || !signals?.runtime_compatible || !tags) pending.push('web_verification_required');
  if (features.consent_mode_enabled !== true) pending.push('consent_required');
  if (signals?.installed && !signals?.consent_mode_detected) pending.push('consent_verification_required');
  const existing = features.ga4_bridge_enabled === true;
  if (existing && target && features.ga4_measurement_id !== target) pending.push('destination_conflict');
  const baseVisible = !!(tags && target && tags.ga4_measurement_ids.includes(target));
  if (tags && target && !baseVisible && !tags.gtm_container_ids.length && !tags.google_tag_ids.length) pending.push('base_tag_required');
  // HTML cannot tell us what a GTM container sends. Preserve a reviewed bridge;
  // never infer that an absent literal event means a missing contact emitter.
  if (!existing) pending.push('contact_channels_review');
  const channels = existing ? CHANNELS.filter(c => features.ga4_bridge_channels?.includes(c)) : [];
  return { revision: revision(record, mappings), domain: host(domain), measurement_id: target,
    streams: unique.map(s => ({ name: s.name, measurement_id: s.webStreamData.measurementId })),
    property_name: selected?.name.split('/dataStreams/')[0] || null,
    channels, pending, base: baseVisible ? 'visible' : tags?.gtm_container_ids.length ? 'tag_manager' : 'unverified',
    configured: existing && features.ga4_measurement_id === target, verified: false,
    can_apply: !!target && !pending.some(p => p !== 'contact_channels_review'), tags,
  };
}
function apply(record, result, body) {
  if (body.expected_revision !== result.revision) throw error('analytics_preparation_changed');
  if (!result.can_apply) throw error('analytics_preparation_incomplete');
  if (!Array.isArray(body.channels) || !body.channels.length || body.channels.some(c => !CHANNELS.includes(c))
    || new Set(body.channels).size !== body.channels.length) throw error('analytics_channels_invalid', 400);
  if (body.channels.some(channel => !result.channels.includes(channel)) && body.channels_reviewed !== true) throw error('analytics_channels_review_required');
  return { ...record.config, features: { ...record.config?.features,
    ga4_bridge_enabled: true, ga4_measurement_id: result.measurement_id, ga4_bridge_channels: CHANNELS.filter(c => body.channels.includes(c)),
  } };
}
module.exports = { safeTags, host, revision, plan, apply, error, CHANNELS };
