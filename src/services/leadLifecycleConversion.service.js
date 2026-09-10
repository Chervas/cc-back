'use strict';

const { CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');

async function maybeUploadLeadLifecycleConversion(input = {}) {
  const dependencies = input.dependencies || {};
  const google = dependencies.google || require('./googleLeadLifecycleConversion.service').maybeUploadLeadLifecycleConversion;
  const enqueueMeta = dependencies.enqueueMeta || require('./metaLeadLifecycleJob.service').enqueueMetaLeadLifecycleSignal;
  const lead = input.lead?.get ? input.lead.get({ plain: true }) : input.lead;
  const logger = dependencies.logger || console;
  let meta;
  // Enqueue before the synchronous legacy Google upload, so its timeout cannot lose Meta's job.
  try {
    meta = await enqueueMeta({ leadId: lead?.id, clinicId: input.clinicId ?? lead?.clinica_id,
      eventName: input.eventName, eventId: input.eventId, occurredAt: input.occurredAt,
      crmEventSource: CRM_MILESTONE_SOURCE });
  } catch { meta = { queued: false, reason: 'meta_crm_unavailable' }; }
  if (meta.reason === 'meta_crm_unavailable') logger.warn?.('CRM signal queue unavailable: meta_crm_unavailable');
  try { return { ...await google(input), meta }; }
  catch {
    logger.warn?.('CRM Google conversion failed: conversion_upload_failed');
    return { sent: false, reason: 'conversion_upload_failed', meta };
  }
}

module.exports = { maybeUploadLeadLifecycleConversion };
