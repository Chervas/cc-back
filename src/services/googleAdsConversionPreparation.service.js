'use strict';

const crypto = require('node:crypto');
const { GOOGLE_ADS_CONVERSIONS_API_VERSION } = require('../lib/googleAdsClient');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');

const EVENT_CATALOG = {
  lead: { name: 'Lead - ClinicaClick', category: 'SUBMIT_LEAD_FORM', detect: ['lead', 'leads', 'formulario'] },
  contact: { name: 'Contact - ClinicaClick', category: 'CONTACT', detect: ['contact', 'llamada', 'call'] },
  qualified_lead: { name: 'Qualified Lead - ClinicaClick', category: 'QUALIFIED_LEAD', detect: ['qualified lead', 'lead válido', 'lead valido', 'cualificado'] },
  schedule: { name: 'Schedule - ClinicaClick', category: 'BOOK_APPOINTMENT', detect: ['schedule', 'appointment', 'cita', 'agenda'] },
  purchase: { name: 'Purchase - ClinicaClick', category: 'PURCHASE', detect: ['purchase', 'venta', 'tratamiento', 'pago'] },
};
const VALID_EVENTS = Object.keys(EVENT_CATALOG);

function extractSendToFromTagSnippets(tagSnippets) {
  if (!Array.isArray(tagSnippets) || !tagSnippets.length) return null;
  const match = JSON.stringify(tagSnippets).match(/AW-\d+\/[A-Za-z0-9\-_]+/);
  return match ? match[0] : null;
}

function mapConversionActionRow(row) {
  const conversion = row?.conversionAction || {};
  return { id: conversion.id ? String(conversion.id) : null,
    resource_name: conversion.resourceName || null, name: conversion.name || null,
    category: conversion.category || null, type: conversion.type || null, status: conversion.status || null,
    counting_type: conversion.countingType || null,
    include_in_conversions_metric: conversion.includeInConversionsMetric !== false,
    primary_for_goal: conversion.primaryForGoal !== false,
    send_to: extractSendToFromTagSnippets(conversion.tagSnippets || []) };
}

function buildSuggestedMapping(actions) {
  const mapping = Object.fromEntries(VALID_EVENTS.map(event => [event, null]));
  for (const action of actions) {
    const name = String(action.name || '').toLowerCase();
    for (const key of VALID_EVENTS) {
      if (!mapping[key] && EVENT_CATALOG[key].detect.some(term => name.includes(term))) mapping[key] = action.id;
    }
  }
  if (!mapping.lead && actions.length) mapping.lead = actions[0].id;
  return mapping;
}

function buildClinicaclickManagedMapping(actions) {
  const mapping = Object.fromEntries(VALID_EVENTS.map(event => [event, null]));
  for (const key of VALID_EVENTS) {
    const matches = (Array.isArray(actions) ? actions : []).filter(action =>
      String(action?.name || '').trim().toLowerCase() === EVENT_CATALOG[key].name.toLowerCase());
    if (matches.length === 1 && matches[0]?.id) mapping[key] = String(matches[0].id);
  }
  return mapping;
}

async function listConversionActions({ accessToken, customerId, loginCustomerId, includeAllTypes = false, search = googleAdsSearchRows, timeoutMs = 45000 }) {
  const query = [
    'SELECT conversion_action.id, conversion_action.resource_name, conversion_action.name,',
    'conversion_action.category, conversion_action.type, conversion_action.status,',
    'conversion_action.counting_type, conversion_action.include_in_conversions_metric,',
    'conversion_action.primary_for_goal, conversion_action.tag_snippets FROM conversion_action',
    ...(includeAllTypes ? [] : ["WHERE conversion_action.type = 'UPLOAD_CLICKS'"]),
  ].join('\n');
  const rows = await search({ customerId, accessToken, loginCustomerId, query, timeoutMs, apiVersion: GOOGLE_ADS_CONVERSIONS_API_VERSION });
  const actions = rows.map(mapConversionActionRow).filter(action => action.id && action.status !== 'REMOVED')
    .sort((a, b) => Number(b.status === 'ENABLED') - Number(a.status === 'ENABLED'));
  return { actions, suggested_mapping: buildSuggestedMapping(actions), clinicaclick_mapping: buildClinicaclickManagedMapping(actions) };
}

function inspectCanonicalConversion({ listed, customerId, conversionActionId, event }) {
  const mapping = listed?.clinicaclick_mapping || {};
  if (!VALID_EVENTS.includes(event) || !conversionActionId || mapping[event] !== conversionActionId) return 'canonical_conversion_action_required';
  const actions = listed.actions.filter(action => String(action?.id || '') === conversionActionId);
  if (actions.length !== 1) return 'canonical_conversion_action_required';
  const action = actions[0];
  if (action.resource_name !== `customers/${customerId}/conversionActions/${conversionActionId}`
    || action.type !== 'UPLOAD_CLICKS' || action.category !== EVENT_CATALOG[event].category) return 'canonical_action_type_incompatible';
  if (action.status !== 'ENABLED') return 'canonical_conversion_action_not_enabled';
  if (action.counting_type !== 'MANY_PER_CLICK') return 'braid_incompatible_counting_type';
  if (action.primary_for_goal !== false) return 'canonical_action_primary_for_goal';
  return null;
}

function conversionFingerprint(action) {
  return crypto.createHash('sha256').update(JSON.stringify([action.id, action.resource_name, action.name,
    action.type, action.category, action.status, action.counting_type, action.primary_for_goal])).digest('hex');
}

function successfulValidationResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.error) return false;
  if (Object.keys(response).some(key => !['requestId', 'fieldWarnings'].includes(key))) return false;
  return (response.requestId === undefined || typeof response.requestId === 'string')
    && (response.fieldWarnings === undefined || Array.isArray(response.fieldWarnings) && response.fieldWarnings.length === 0);
}

module.exports = { EVENT_CATALOG, VALID_EVENTS, extractSendToFromTagSnippets, mapConversionActionRow,
  buildSuggestedMapping, buildClinicaclickManagedMapping, listConversionActions, inspectCanonicalConversion,
  conversionFingerprint, successfulValidationResponse };
