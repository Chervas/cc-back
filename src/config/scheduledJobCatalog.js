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
  pm2LogRetention: Object.freeze({
    type: 'system_pm2_log_retention',
    priority: 'low',
    executorMethod: 'executePm2LogRetention',
  }),
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
  webDomainReconciliation: Object.freeze({
    type: 'marketing_web_domain_reconciliation',
    priority: 'low',
    executorMethod: 'executeWebDomainReconciliation',
    attachJobRequestId: true,
  }),
  webPublicationHealthMonitor: Object.freeze({
    type: 'marketing_web_publication_health_monitor',
    priority: 'low',
    executorMethod: 'executeWebPublicationHealthMonitor',
    attachJobRequestId: true,
    // Una URL caída es el resultado del monitor. El siguiente ciclo periódico
    // volverá a comprobarla; no se reintenta agresivamente el lote completo.
    reportedFailureRetryable: false,
  }),
  campaignDestinationDriftAudit: Object.freeze({
    type: 'marketing_campaign.destination_drift_audit.v1',
    priority: 'low',
    executorMethod: 'executeCampaignDestinationDriftAudit',
    // Detectar un cambio externo es resultado de negocio, no un fallo que deba
    // provocar reintentos agresivos ni autoreparaciones silenciosas.
    reportedFailureRetryable: false,
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
  competitionSync: Object.freeze({
    type: 'competition_refresh',
    priority: 'low',
    executorMethod: 'executeCompetitionSync',
    attachJobRequestId: true,
    // Solo el disparo periódico/manual del job global debe pedir BigQuery.
    // Los competition_refresh creados al añadir un competidor conservan el
    // fast-path puntual y no deben heredar este modo desde el ejecutor.
    scheduledPayloadDefaults: Object.freeze({ googleTransparencyMode: 'official_global' }),
  }),
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
  opsGlobalDiscovery: Object.freeze({
    type: 'ops_global_discovery',
    priority: 'low',
    executorMethod: 'executeOpsGlobalDiscovery',
    // Los cinco bridges migran desde el crontab del host, que operaba en UTC.
    // Mantener su zona evita desplazar ejecuciones durante el cutover o por DST.
    timezone: 'UTC',
  }),
  opsSummary: Object.freeze({
    type: 'ops_summary',
    priority: 'low',
    executorMethod: 'executeOpsSummary',
    timezone: 'UTC',
  }),
  opsGoogleBusinessProfileDaily: Object.freeze({
    type: 'ops_google_business_profile_daily',
    priority: 'low',
    executorMethod: 'executeOpsGoogleBusinessProfile',
    payloadDefaults: Object.freeze({ onlyRequested: false }),
    timezone: 'UTC',
  }),
  opsSearchConsoleDaily: Object.freeze({
    type: 'ops_search_console_daily',
    priority: 'low',
    executorMethod: 'executeOpsSearchConsole',
    timezone: 'UTC',
  }),
  opsGoogleBusinessProfileRequested: Object.freeze({
    type: 'ops_google_business_profile_requested',
    priority: 'low',
    executorMethod: 'executeOpsGoogleBusinessProfile',
    payloadDefaults: Object.freeze({ onlyRequested: true }),
    timezone: 'UTC',
  }),
});

const getScheduledJobDefinition = (jobName) => SCHEDULED_JOB_DEFINITIONS[jobName] || null;

// Integraciones dirigidas que se crean a demanda pero comparten los mismos
// clientes, límites y flags mutables que los barridos periódicos.
const TARGETED_INTEGRATION_JOB_TYPES = Object.freeze([
  'meta_ads_backfill_for_sites',
  'web_backfill_for_sites',
  'analytics_backfill_properties',
  'business_profile_backfill_locations',
  'marketing_competition_heatmap_refresh',
  'marketing_ai_visibility_run',
  // Explicit, user-triggered AI drafts. Provider calls share the serialized
  // background lane and never publish the generated content automatically.
  'web_content_generation',
  // Mutates Google conversion goals. It must share the serialized provider
  // lane and distributed lease with sync/backfill jobs.
  'guided_campaign_goal_policy_apply',
  // Provider destination mutations and their compensating rollback must use
  // the same distributed integration lease as Google Ads sync/mutations.
  'marketing_campaign.destination_apply.v1',
  'marketing_campaign.destination_rollback.v1',
  // Piloto creates and compensates Google Search resources in one serialized
  // provider lane. The execution service still denies both while its explicit
  // environment feature flag is off.
  'managed_campaign.google_search_create.v1',
  'managed_campaign.google_search_activate.v1',
  'managed_campaign.google_search_rollback.v1',
  'whatsapp_template_sync_delayed',
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
