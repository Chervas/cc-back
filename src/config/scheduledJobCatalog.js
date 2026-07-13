'use strict';

/**
 * Catálogo canónico de tareas periódicas.
 *
 * node-cron solo decide cuándo crear el JobRequest. La ejecución, los
 * reintentos y la recuperación tras reinicio pertenecen al scheduler durable.
 */
const SCHEDULED_JOB_DEFINITIONS = Object.freeze({
  metricsSync: Object.freeze({ type: 'meta_metrics_daily', priority: 'normal', executorMethod: 'executeMetricsSync' }),
  tokenValidation: Object.freeze({ type: 'meta_token_validation', priority: 'normal', executorMethod: 'executeTokenValidation' }),
  dataCleanup: Object.freeze({ type: 'system_data_cleanup', priority: 'low', executorMethod: 'executeDataCleanup' }),
  healthCheck: Object.freeze({ type: 'system_health_check', priority: 'low', executorMethod: 'executeHealthCheck' }),
  adsSync: Object.freeze({ type: 'meta_ads_recent', priority: 'normal', executorMethod: 'executeAdsSync' }),
  adsSyncMidday: Object.freeze({
    type: 'meta_ads_midday',
    priority: 'normal',
    executorMethod: 'executeAdsSync',
    payloadDefaults: Object.freeze({ windowLabel: 'midday' }),
  }),
  adsBackfill: Object.freeze({ type: 'meta_ads_backfill', priority: 'low', executorMethod: 'executeAdsBackfill' }),
  googleAdsSync: Object.freeze({ type: 'google_ads_recent', priority: 'normal', executorMethod: 'executeGoogleAdsSync' }),
  googleAdsBackfill: Object.freeze({ type: 'google_ads_backfill', priority: 'low', executorMethod: 'executeGoogleAdsBackfill' }),
  googleDataManagerDiagnostics: Object.freeze({
    type: 'google_data_manager_diagnostics',
    priority: 'normal',
    executorMethod: 'executeGoogleDataManagerDiagnostics',
    attachJobRequestId: true,
  }),
  googleConversionGoalPolicyAudit: Object.freeze({
    type: 'google_conversion_goal_policy_audit',
    priority: 'low',
    executorMethod: 'executeGoogleConversionGoalPolicyAudit',
    // Un drift detectado ya queda auditado/notificado; no es un fallo técnico.
    reportedFailureRetryable: false,
  }),
  campaignOptimizationEvaluation: Object.freeze({
    type: 'campaign_optimization_evaluation',
    priority: 'low',
    executorMethod: 'executeCampaignOptimizationEvaluation',
  }),
  webSync: Object.freeze({ type: 'web_recent', priority: 'normal', executorMethod: 'executeWebSync' }),
  webBackfill: Object.freeze({ type: 'web_backfill', priority: 'low', executorMethod: 'executeWebBackfill' }),
  analyticsSync: Object.freeze({ type: 'analytics_recent', priority: 'normal', executorMethod: 'executeAnalyticsSync' }),
  analyticsBackfill: Object.freeze({ type: 'analytics_backfill', priority: 'low', executorMethod: 'executeAnalyticsBackfill' }),
  businessProfileSync: Object.freeze({ type: 'business_profile_recent', priority: 'normal', executorMethod: 'executeBusinessProfileSync' }),
  businessProfileReviewsSync: Object.freeze({
    type: 'business_profile_reviews_recent',
    priority: 'normal',
    executorMethod: 'executeBusinessProfileReviewsSync',
  }),
  businessProfileBackfill: Object.freeze({
    type: 'business_profile_backfill',
    priority: 'low',
    executorMethod: 'executeBusinessProfileBackfill',
  }),
  competitionSync: Object.freeze({ type: 'competition_refresh', priority: 'low', executorMethod: 'executeCompetitionSync' }),
  webEventsAggregate: Object.freeze({ type: 'web_events_aggregate', priority: 'normal', executorMethod: 'executeWebEventsAggregate' }),
  whatsappTemplatesSync: Object.freeze({
    type: 'whatsapp_templates_sync',
    priority: 'normal',
    executorMethod: 'executeWhatsappTemplatesSync',
  }),
  whatsappPhonesSync: Object.freeze({
    type: 'whatsapp_phones_sync',
    priority: 'normal',
    executorMethod: 'executeWhatsappPhonesSync',
  }),
  automationHealthCheck: Object.freeze({
    type: 'automation_health_check',
    priority: 'low',
    executorMethod: 'executeAutomationHealthCheck',
    reportedFailureRetryable: false,
  }),
});

const getScheduledJobDefinition = (jobName) => SCHEDULED_JOB_DEFINITIONS[jobName] || null;

// Backfills que se crean a demanda pero comparten los mismos clientes,
// límites y flags mutables que los barridos periódicos.
const TARGETED_INTEGRATION_JOB_TYPES = Object.freeze([
  'meta_ads_backfill_for_sites',
  'web_backfill_for_sites',
  'analytics_backfill_properties',
  'business_profile_backfill_locations',
]);

const BACKGROUND_INTEGRATION_JOB_TYPES = Object.freeze([
  ...Object.values(SCHEDULED_JOB_DEFINITIONS).map((definition) => definition.type),
  ...TARGETED_INTEGRATION_JOB_TYPES,
]);

module.exports = {
  SCHEDULED_JOB_DEFINITIONS,
  TARGETED_INTEGRATION_JOB_TYPES,
  BACKGROUND_INTEGRATION_JOB_TYPES,
  getScheduledJobDefinition,
};
