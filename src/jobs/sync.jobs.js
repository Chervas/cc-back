/**
 * Sistema de Jobs Cron para Sincronización de Métricas de Redes Sociales
 * ClinicaClick - Versión con Configuraciones .ENV
 * 
 * Este archivo contiene la implementación de jobs automatizados para:
 * - Sincronización diaria de métricas de Meta (Facebook/Instagram)
 * - Validación periódica de tokens de acceso
 * - Limpieza de datos antiguos
 * - Verificación de salud del sistema
 * 
 * @author Manus AI
 * @version 1.0.0 - ENV CONFIG
 * @date 2025-07-27
 */

const cron = require('node-cron');
const axios = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
// Unificar lógica: reutilizar las funciones del controlador
const { 
  syncAdAccountMetrics,
  syncFacebookPageMetrics: controllerSyncFacebookPageMetrics,
  syncInstagramMetrics: controllerSyncInstagramMetrics
} = require('../controllers/metasync.controller');
const META_API_BASE_URL = process.env.META_API_BASE_URL || 'https://graph.facebook.com/v23.0';
const url = `${META_API_BASE_URL}/...`;
const { metaGet } = require('../lib/metaClient');
const { buildClinicMatcher } = require('../lib/clinicAttribution');
const { googleAdsRequest, getGoogleAdsUsageStatus, resumeGoogleAdsUsage, ensureGoogleAdsConfig, normalizeCustomerId, formatCustomerId } = require('../lib/googleAdsClient');
const notificationService = require('../services/notifications.service');
const { enqueueSyncForAllWabas } = require('../services/whatsappTemplates.service');
const { enqueueSyncPhonesForAllWabas } = require('../services/whatsappPhones.service');
const marketingCompetitionService = require('../services/marketingCompetition.service');
const webEventsService = require('../services/webEvents.service');

const GOOGLE_BUSINESS_PERFORMANCE_API = 'https://businessprofileperformance.googleapis.com/v1';
const GOOGLE_MY_BUSINESS_API = 'https://mybusiness.googleapis.com/v4';
const GOOGLE_BUSINESS_INFORMATION_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GOOGLE_BUSINESS_LOCATION_READ_MASK = [
  'name',
  'title',
  'storeCode',
  'phoneNumbers',
  'categories',
  'storefrontAddress',
  'websiteUri',
  'metadata',
  'openInfo',
  'regularHours',
  'specialHours',
  'moreHours',
  'serviceArea',
  'labels'
].join(',');
const GOOGLE_BUSINESS_DAILY_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_DIRECTION_REQUESTS',
  'CALL_CLICKS',
  'WEBSITE_CLICKS',
  'BUSINESS_CONVERSATIONS',
  'BUSINESS_BOOKINGS'
];

// Importar modelos
const {
  ClinicMetaAsset,
  ClinicAnalyticsProperty,
  ClinicBusinessLocation,
  SocialStatsDaily,
  SocialPosts,
  SocialPostStatDaily,
  SyncLog,
  TokenValidations,
  MetaConnection,
  SocialAdsEntity,
  SocialAdsInsightsDaily,
  GoogleConnection,
  ClinicGoogleAdsAccount,
  GoogleAdsInsightsDaily,
  Clinica,
  GrupoClinica,
  WebGaDaily,
  WebGaDimensionDaily,
  WebScQueryDaily,
  BusinessProfileDailyMetric,
  BusinessProfileReview,
  BusinessProfilePost,
  AdAttributionIssue,
  FlowExecutionV2,
  FlowExecutionLogV2,
  AutomationFlowTemplateV2,
  JobRequest
} = require('../../models');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SEARCH_CONSOLE_BULK_CHUNK_SIZE = 500;

function resolveSearchConsoleBulkChunkSize() {
  const configured = Number(process.env.SEARCH_CONSOLE_BULK_CHUNK_SIZE || 0);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_SEARCH_CONSOLE_BULK_CHUNK_SIZE;
}

async function bulkCreateInChunks(model, rows, options = {}, chunkSize = resolveSearchConsoleBulkChunkSize()) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }

  for (let index = 0; index < rows.length; index += chunkSize) {
    await model.bulkCreate(rows.slice(index, index + chunkSize), options);
  }
}

function parseDateInput(value, label) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

function ensureAscending(start, end) {
  if (start && end && start.getTime() > end.getTime()) {
    return [end, start];
  }
  return [start, end];
}

function diffInDaysInclusive(start, end) {
  if (!start || !end) {
    return null;
  }
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

function parseGoogleReasons(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map((value) => String(value));
  return [String(raw)];
}

function evaluateGooglePublishingIssue(campaign) {
  const servingStatus = String(campaign?.servingStatus || campaign?.serving_status || '').trim().toUpperCase();
  const primaryStatus = String(campaign?.primaryStatus || campaign?.primary_status || '').trim().toUpperCase();
  const reasons = parseGoogleReasons(campaign?.primaryStatusReasons || campaign?.primary_status_reasons || null)
    .map((value) => value.toUpperCase());

  if (reasons.some((value) => value.includes('BILLING') || value.includes('PAYMENT'))) {
    return {
      priority: 100,
      status: 'Saldo pendiente o problema de facturación',
      reason: 'Google Ads indica que la campaña no se está publicando por un bloqueo de billing o pago pendiente.',
      reasons,
    };
  }

  if (['SUSPENDED', 'ENDED', 'DISABLED'].includes(servingStatus) || primaryStatus === 'NOT_ELIGIBLE') {
    return {
      priority: 50,
      status: primaryStatus || servingStatus || 'No publicando',
      reason: reasons.length ? reasons.join(', ') : 'La campaña no está publicando actualmente.',
      reasons,
    };
  }

  return null;
}

class MetaSyncJobs {
  constructor() {
    this.jobs = new Map();
    this.isInitialized = false;
    this.isRunning = false;
    this.isGatewayRuntime = String(process.env.RUNTIME_ROLE || '').trim().toLowerCase() === 'gateway';
    
    this._webBackfillMode = false;
    this._analyticsBackfillMode = false;
    this._localBackfillMode = false;
    this._groupAssignmentCache = new Map();
    
    // Descripciones por job (usadas por el monitor/UX)
    this.jobDescriptions = {
      metricsSync: 'Sincroniza orgánico (Facebook/Instagram): seguidores, posts y agregados diarios por asset.',
      adsSync: 'Sincroniza Ads (Marketing API) con ventana reciente: entidades, insights diarios y actions.',
      adsSyncMidday: 'Refrescado parcial de Ads al mediodía para capturar datos en curso (48 h).',
      adsBackfill: 'Backfill semanal de Ads con ventana extendida para consolidar atribución y cierres.',
      googleAdsSync: 'Sincroniza campañas y métricas diarias de Google Ads para cuentas vinculadas.',
      googleAdsBackfill: 'Backfill de Google Ads para nuevas cuentas o rangos extendidos.',
      webSync: 'Sincroniza Search Console (serie diaria) y PSI reciente para clínicas mapeadas.',
      webBackfill: 'Backfill histórico de Search Console (12–16 meses) para cache y rapidez.',
      analyticsSync: 'Sincroniza métricas de Google Analytics 4 (sesiones, usuarios, fuentes, audiencias).',
      analyticsBackfill: 'Backfill extendido de Analytics para nuevos mapeos o reprocesos.',
      businessProfileSync: 'Sincroniza Perfil de Empresa Google: rendimiento local, reseñas y publicaciones.',
      businessProfileBackfill: 'Backfill de Perfil de Empresa Google para nuevas fichas o reprocesos.',
      competitionSync: 'Actualiza semanalmente benchmark local: competidores, ficha publica Google Places y anuncios activos desde Meta Ads Library oficial.',
      webEventsAggregate: 'Agrega WebEvents propios en tablas diarias para informes sin recalcular desde el front.',
      whatsappTemplatesSync: 'Sincroniza estados de plantillas WhatsApp para todos los WABA activos.',
      whatsappPhonesSync: 'Sincroniza números WhatsApp (existencia/estado) para evitar datos desactualizados.',
      automationHealthCheck: 'Barrido funcional de automatizaciones críticas: flujos fallidos, jobs vencidos y ejecuciones atascadas.',
      tokenValidation: 'Valida tokens (usuario/página) y registra estado/errores recientes.',
      dataCleanup: 'Limpia registros antiguos según retenciones configuradas (logs, validaciones, métricas).',
      healthCheck: 'Comprueba salud de BD, disponibilidad de Meta API y actividad reciente.'
    };

    // Configuración desde variables de entorno
    this.config = {
      schedules: {
        metricsSync: process.env.JOBS_METRICS_SCHEDULE || '0 2 * * *',
        tokenValidation: process.env.JOBS_TOKEN_VALIDATION_SCHEDULE || '0 */6 * * *',
        dataCleanup: process.env.JOBS_CLEANUP_SCHEDULE || '0 3 * * 0',
        healthCheck: process.env.JOBS_HEALTH_CHECK_SCHEDULE || '0 * * * *',
        adsSync: process.env.JOBS_ADS_SCHEDULE || '30 0 * * *',
        adsSyncMidday: process.env.JOBS_ADS_MIDDAY_SCHEDULE || '0 12 * * *',
        adsBackfill: process.env.JOBS_ADS_BACKFILL_SCHEDULE || '0 4 * * 0',
        googleAdsSync: process.env.JOBS_GOOGLE_ADS_SCHEDULE || '20 0 * * *',
        googleAdsBackfill: process.env.JOBS_GOOGLE_ADS_BACKFILL_SCHEDULE || '30 5 * * 0',
        webSync: process.env.JOBS_WEB_SCHEDULE || '15 4 * * *',
        webBackfill: process.env.JOBS_WEB_BACKFILL_SCHEDULE || '30 4 * * 0',
        analyticsSync: process.env.JOBS_ANALYTICS_SCHEDULE || '45 4 * * *',
        analyticsBackfill: process.env.JOBS_ANALYTICS_BACKFILL_SCHEDULE || '0 5 * * 0',
        businessProfileSync: process.env.JOBS_BUSINESS_PROFILE_SCHEDULE || '10 5 * * *',
        businessProfileBackfill: process.env.JOBS_BUSINESS_PROFILE_BACKFILL_SCHEDULE || '20 5 * * 0',
        competitionSync: process.env.JOBS_COMPETITION_SCHEDULE || '0 6 * * 1',
        webEventsAggregate: process.env.JOBS_WEB_EVENTS_AGGREGATE_SCHEDULE || '*/15 * * * *',
        whatsappTemplatesSync: process.env.JOBS_WHATSAPP_TEMPLATES_SCHEDULE || '*/20 * * * *',
        whatsappPhonesSync: process.env.JOBS_WHATSAPP_PHONES_SCHEDULE || '*/15 * * * *',
        automationHealthCheck: process.env.JOBS_AUTOMATION_HEALTH_CHECK_SCHEDULE || '0 10,16 * * *'
      },
      timezone: process.env.JOBS_TIMEZONE || 'Europe/Madrid',
      autoStart: process.env.JOBS_AUTO_START === 'true',
      ads: {
        initialDays: parseInt(process.env.ADS_SYNC_INITIAL_DAYS || '30', 10),
        recentDays: parseInt(process.env.ADS_SYNC_RECENT_DAYS || '7', 10),
        middayDays: parseInt(process.env.ADS_SYNC_MIDDAY_DAYS || '2', 10),
        backfillDays: parseInt(process.env.ADS_SYNC_BACKFILL_DAYS || '28', 10),
        betweenAccountsSleepMs: parseInt(process.env.ADS_SYNC_BETWEEN_ACCOUNTS_SLEEP_MS || '60000', 10)
      },
      googleAds: {
        initialDays: parseInt(process.env.GOOGLE_ADS_SYNC_INITIAL_DAYS || '30', 10),
        recentDays: parseInt(process.env.GOOGLE_ADS_SYNC_RECENT_DAYS || '7', 10),
        backfillDays: parseInt(process.env.GOOGLE_ADS_BACKFILL_DAYS || '180', 10),
        chunkDays: parseInt(process.env.GOOGLE_ADS_SYNC_CHUNK_DAYS || '7', 10),
        betweenAccountsSleepMs: parseInt(process.env.GOOGLE_ADS_SYNC_BETWEEN_ACCOUNTS_SLEEP_MS || '2000', 10)
      },
      web: {
        recentDays: parseInt(process.env.WEB_SYNC_RECENT_DAYS || '30', 10),
        backfillDays: parseInt(process.env.WEB_BACKFILL_DAYS || '480', 10), // ~16 meses
        betweenClinicsSleepMs: parseInt(process.env.WEB_SYNC_BETWEEN_CLINICS_SLEEP_MS || '0', 10),
        psiEnabled: (process.env.WEB_PSI_ENABLED || 'true') !== 'false',
        psiOnBackfill: (process.env.WEB_PSI_ON_BACKFILL || 'false') === 'true',
        psiMinHoursBetweenRuns: parseInt(process.env.WEB_PSI_MIN_HOURS_BETWEEN_RUNS || '24', 10)
      },
      analytics: {
        recentDays: parseInt(process.env.ANALYTICS_SYNC_RECENT_DAYS || '90', 10),
        backfillDays: parseInt(process.env.ANALYTICS_BACKFILL_DAYS || '540', 10),
        betweenClinicsSleepMs: parseInt(process.env.ANALYTICS_SYNC_BETWEEN_CLINICS_SLEEP_MS || '0', 10),
        batchSize: parseInt(process.env.ANALYTICS_SYNC_BATCH_SIZE || '4', 10)
      },
      local: {
        recentDays: parseInt(process.env.LOCAL_SYNC_RECENT_DAYS || '30', 10),
        backfillDays: parseInt(process.env.LOCAL_BACKFILL_DAYS || '180', 10),
        betweenLocationsSleepMs: parseInt(process.env.LOCAL_SYNC_BETWEEN_LOCATIONS_SLEEP_MS || '250', 10)
      },
      dataRetention: {
        syncLogs: parseInt(process.env.JOBS_SYNC_LOGS_RETENTION) || 90,
        tokenValidations: parseInt(process.env.JOBS_TOKEN_VALIDATIONS_RETENTION) || 30,
        socialStats: parseInt(process.env.JOBS_SOCIAL_STATS_RETENTION) || 730
      },
      retries: {
        maxAttempts: parseInt(process.env.JOBS_MAX_RETRIES) || 3,
        delayMs: parseInt(process.env.JOBS_RETRY_DELAY) || 5000
      }
    };

    if (!this.isGatewayRuntime) {
      console.log('🔧 Configuración de Jobs cargada desde .env:');
      console.log(`  - Timezone: ${this.config.timezone}`);
      console.log(`  - Auto Start: ${this.config.autoStart}`);
      console.log('  - Horarios:');
      for (const [name, schedule] of Object.entries(this.config.schedules)) {
        console.log(`    ${name}: ${schedule}`);
      }
    }
    this._webBackfillMode = false;
    this._analyticsBackfillMode = false;
  }

  /**
   * Inicializa el sistema de jobs
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('⚠️ Sistema de jobs ya está inicializado');
      return { status: 'already_initialized' };
    }

    try {
      console.log('🚀 Inicializando Sistema de Jobs Cron...');
      
      // Registrar jobs con configuraciones del .env
      this.registerJob('metricsSync', this.config.schedules.metricsSync, () => this.executeMetricsSync());
      this.registerJob('tokenValidation', this.config.schedules.tokenValidation, () => this.executeTokenValidation());
      this.registerJob('dataCleanup', this.config.schedules.dataCleanup, () => this.executeDataCleanup());
      this.registerJob('healthCheck', this.config.schedules.healthCheck, () => this.executeHealthCheck());
      this.registerJob('adsSync', this.config.schedules.adsSync, () => this.executeAdsSync());
      this.registerJob('adsSyncMidday', this.config.schedules.adsSyncMidday, () => this.executeAdsSync({ windowLabel: 'midday' }));
      this.registerJob('adsBackfill', this.config.schedules.adsBackfill, () => this.executeAdsBackfill());
      this.registerJob('googleAdsSync', this.config.schedules.googleAdsSync, () => this.executeGoogleAdsSync());
      this.registerJob('googleAdsBackfill', this.config.schedules.googleAdsBackfill, () => this.executeGoogleAdsBackfill());
      this.registerJob('webSync', this.config.schedules.webSync, () => this.executeWebSync());
      this.registerJob('webBackfill', this.config.schedules.webBackfill, () => this.executeWebBackfill());
      this.registerJob('analyticsSync', this.config.schedules.analyticsSync, () => this.executeAnalyticsSync());
      this.registerJob('analyticsBackfill', this.config.schedules.analyticsBackfill, () => this.executeAnalyticsBackfill());
      this.registerJob('businessProfileSync', this.config.schedules.businessProfileSync, () => this.executeBusinessProfileSync());
      this.registerJob('businessProfileBackfill', this.config.schedules.businessProfileBackfill, () => this.executeBusinessProfileBackfill());
      this.registerJob('competitionSync', this.config.schedules.competitionSync, () => this.executeCompetitionSync());
      this.registerJob('webEventsAggregate', this.config.schedules.webEventsAggregate, () => this.executeWebEventsAggregate());
      this.registerJob('whatsappTemplatesSync', this.config.schedules.whatsappTemplatesSync, () => this.executeWhatsappTemplatesSync());
      this.registerJob('whatsappPhonesSync', this.config.schedules.whatsappPhonesSync, () => this.executeWhatsappPhonesSync());
      this.registerJob('automationHealthCheck', this.config.schedules.automationHealthCheck, () => this.executeAutomationHealthCheck());

      this.isInitialized = true;
      
      console.log('✅ Sistema de Jobs Cron inicializado correctamente');
      console.log(`📊 Jobs registrados: ${this.jobs.size}`);
      console.log(`🌍 Timezone configurado: ${this.config.timezone}`);
      console.log('\n📅 Próximas ejecuciones programadas:');
      
      for (const [name, schedule] of Object.entries(this.config.schedules)) {
        console.log(`  ${name}: ${schedule}`);
      }

      return {
        status: 'initialized',
        jobsCount: this.jobs.size,
        jobs: Object.fromEntries(this.jobs),
        config: {
          timezone: this.config.timezone,
          autoStart: this.config.autoStart
        }
      };
    } catch (error) {
      console.error('❌ Error al inicializar sistema de jobs:', error);
      throw error;
    }
  }

  /**
   * Registra un job con su programación
   */
  registerJob(name, schedule, handler) {
    const job = cron.schedule(schedule, async () => {
      await this.executeWithRetry(name, handler);
    }, {
      scheduled: false,
      timezone: this.config.timezone // Usar timezone del .env
    });
    // node-cron v4 starts tasks created with schedule() immediately. Keep the
    // explicit lifecycle controlled by start()/stop() so non-leader runtimes do
    // not enqueue duplicated jobs just by registering them.
    if (typeof job.stop === 'function') {
      job.stop();
    }

    this.jobs.set(name, {
      job,
      schedule,
      handler,
      lastExecution: null,
      status: 'registered',
      description: this.jobDescriptions[name] || ''
    });

    console.log(`📝 Job '${name}' registrado con programación: ${schedule} (${this.config.timezone})`);
  }

  /**
   * Inicia todos los jobs
   */
  start() {
    if (!this.isInitialized) {
      throw new Error('Sistema de jobs no está inicializado');
    }

    if (this.isRunning) {
      console.log('⚠️ Los jobs ya están en ejecución');
      return { status: 'already_running' };
    }

    console.log('\n🚀 Iniciando todos los jobs...');
    
    for (const [name, jobData] of this.jobs) {
      jobData.job.start();
      jobData.status = 'running';
      console.log(`▶️ Job '${name}' iniciado`);
    }

    this.isRunning = true;
    console.log('🚀 Todos los jobs han sido iniciados');
    
    return {
      status: 'started',
      jobsCount: this.jobs.size
    };
  }

  /**
   * Detiene todos los jobs
   */
  stop() {
    if (!this.isRunning) {
      console.log('⚠️ Los jobs no están en ejecución');
      return { status: 'already_stopped' };
    }

    console.log('🛑 Deteniendo todos los jobs...');
    
    for (const [name, jobData] of this.jobs) {
      jobData.job.stop();
      jobData.status = 'stopped';
      console.log(`⏹️ Job '${name}' detenido`);
    }

    this.isRunning = false;
    console.log('🛑 Todos los jobs han sido detenidos');
    
    return {
      status: 'stopped',
      jobsCount: this.jobs.size
    };
  }

  /**
   * Reinicia el sistema de jobs
   */
  restart() {
    console.log('🔄 Reiniciando sistema de jobs...');
    this.stop();
    return this.start();
  }

  /**
   * Ejecuta un job con sistema de reintentos
   */
  async executeWithRetry(jobName, handler) {
    const maxAttempts = this.config.retries.maxAttempts;
    const delay = this.config.retries.delayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`🔄 Ejecutando job '${jobName}' (intento ${attempt}/${maxAttempts})`);
        
        const result = await handler();
        
        // Actualizar información del job
        const jobData = this.jobs.get(jobName);
        if (jobData) {
          jobData.lastExecution = new Date();
          jobData.status = 'completed';
        }

        console.log(`✅ Job '${jobName}' completado exitosamente`);
        return result;
        
      } catch (error) {
        console.error(`❌ Error en job '${jobName}' (intento ${attempt}/${maxAttempts}):`, error.message);
        
        if (attempt === maxAttempts) {
          // Actualizar estado del job como fallido
          const jobData = this.jobs.get(jobName);
          if (jobData) {
            jobData.lastExecution = new Date();
            jobData.status = 'failed';
            jobData.lastError = error.message;
          }
          
          throw error;
        }
        
        // Esperar antes del siguiente intento
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }

  // =====================
  // Enrichment helpers
  // =====================
  async _updateAdAccountStatus(asset, accessToken) {
    try {
      if (asset.assetType !== 'ad_account') return;
      const accountId = asset.metaAssetId.startsWith('act_') ? asset.metaAssetId : `act_${asset.metaAssetId}`;
      const resp = await metaGet(accountId, {
        // disable_reasons no existe en AdAccount -> provocaba 400 (#100)
        params: { fields: 'account_status,disable_reason,spend_cap,amount_spent' },
        accessToken
      });
      const d = resp.data || {};
      const disable = d.disable_reason ?? null;
      await asset.update({
        ad_account_status: d.account_status ?? null,
        ad_account_disable_reason: disable ?? null,
        ad_account_spend_cap: d.spend_cap ?? null,
        ad_account_amount_spent: d.amount_spent ?? null,
        ad_account_refreshed_at: new Date()
      });
    } catch (e) {
      const st = e?.response?.status;
      const er = e?.response?.data?.error || {};
      console.warn('updateAdAccountStatus error', { status: st, code: er.code, subcode: er.error_subcode, message: er.message, fbtrace_id: er.fbtrace_id });
    }
  }

  async _enrichAdsetDeliveryReasons(asset, accessToken, endDate) {
    try {
      const accountId = asset.metaAssetId.startsWith('act_') ? asset.metaAssetId : `act_${asset.metaAssetId}`;
      // Encontrar adsets activos sin impresiones en últimas 48h
      const e = (d)=> d.toISOString().slice(0,10);
      const end = new Date(endDate); end.setHours(0,0,0,0);
      const start48 = new Date(end); start48.setDate(start48.getDate() - 1);
      const [rows] = await SocialAdsInsightsDaily.sequelize.query(`
        SELECT se.entity_id as adset_id
        FROM SocialAdsEntities se
        LEFT JOIN (
          SELECT entity_id, SUM(impressions) impr
          FROM SocialAdsInsightsDaily
          WHERE ad_account_id = :acc AND level='adset' AND date BETWEEN :s AND :e
          GROUP BY entity_id
        ) x ON x.entity_id = se.entity_id
        WHERE se.ad_account_id = :acc AND se.level='adset'
          AND UPPER(IFNULL(se.status,'')) NOT IN ('PAUSED','ARCHIVED','DELETED','INACTIVE')
          AND UPPER(IFNULL(se.effective_status,'')) NOT IN ('PAUSED','ARCHIVED','DELETED','INACTIVE')
          AND IFNULL(x.impr,0)=0
        ORDER BY se.updated_at DESC
        LIMIT 10;`, { replacements: { acc: accountId, s: e(start48), e: e(end) } });

      const cap = Math.min(rows.length || 0, 10);
      for (let i=0; i<cap; i++) {
        const adsetId = String(rows[i].adset_id);
        try {
          // Nota: delivery_info no existe en AdSet → provocaba 400. Pedimos sólo issues_info + effective_status
          const resp = await metaGet(adsetId, { params: { fields: 'issues_info,effective_status' }, accessToken });
          const data = resp.data || {};
          const arr = Array.isArray(data.issues_info) ? data.issues_info : [];
          const texts = arr.map(x => x?.description || x?.message || x?.title || x?.summary).filter(Boolean);
          const reason = texts.length ? Array.from(new Set(texts)).slice(0,3).join(' · ') : null;
          await SocialAdsEntity.update({ delivery_reason_text: reason || null, delivery_status: data.effective_status || null, delivery_checked_at: new Date() }, { where: { level: 'adset', entity_id: adsetId } });
        } catch (enrichErr) {
          const st = enrichErr?.response?.status;
          const er = enrichErr?.response?.data?.error || {};
          console.warn('enrichAdset error', { adsetId, status: st, code: er.code, subcode: er.error_subcode, message: er.message, fbtrace_id: er.fbtrace_id });
        }
      }
    } catch (e) {
      console.warn('enrichAdsetDeliveryReasons error:', e.message);
    }
  }

  async _fetchGroupWithClinics(groupId) {
    if (!groupId) {
      return null;
    }

    const cacheKey = String(groupId);
    if (this._groupAssignmentCache.has(cacheKey)) {
      return this._groupAssignmentCache.get(cacheKey);
    }

    const group = await GrupoClinica.findByPk(groupId, {
      include: [{
        model: Clinica,
        as: 'clinicas',
        attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId']
      }]
    });

    const plain = group ? group.get({ plain: true }) : null;
    this._groupAssignmentCache.set(cacheKey, plain);
    return plain;
  }

  async _buildMetaAssignmentContext(asset) {
    const groupId = asset.grupoClinicaId || asset.clinica?.grupoClinicaId || null;

    if (groupId) {
      const group = await this._fetchGroupWithClinics(groupId);
      if (group) {
        const clinics = Array.isArray(group.clinicas) ? group.clinicas : [];
        const delimiter = group.ads_assignment_delimiter || '**';
        const matcher = clinics.length ? buildClinicMatcher(clinics, { delimiter, requireDelimiter: true }) : null;
        const adsMode = (group.ads_assignment_mode || '').toLowerCase();

        if (adsMode === 'automatic') {
          return {
            mode: 'group-auto',
            groupId: group.id_grupo,
            delimiter,
            matcher,
            clinics,
            clinicaId: asset.clinicaId || null
          };
        }

        if (asset.assignmentScope === 'group') {
          return {
            mode: 'group-manual',
            groupId: group.id_grupo,
            delimiter,
            matcher,
            clinics,
            clinicaId: asset.clinicaId || null
          };
        }
      }
    }
    return {
      mode: 'manual',
      clinicaId: asset.clinicaId || null,
      groupId,
      clinics: asset.clinica ? [asset.clinica] : []
    };
  }

  /**
   * Ejecuta job manualmente
   */
  async runJob(jobName) {
    if (!this.jobs.has(jobName)) {
      throw new Error(`Job '${jobName}' no encontrado`);
    }

    const jobData = this.jobs.get(jobName);
    console.log(`🔄 Ejecutando job '${jobName}' manualmente...`);
    
    try {
      const result = await jobData.handler();
      
      jobData.lastExecution = new Date();
      jobData.status = 'completed';
      
      console.log(`✅ Job '${jobName}' ejecutado correctamente`);
      return result;
      
    } catch (error) {
      jobData.lastExecution = new Date();
      jobData.status = 'failed';
      jobData.lastError = error.message;
      
      console.error(`❌ Error al ejecutar job '${jobName}':`, error);
      throw error;
    }
  }

  /**
   * Job: Sincronización de métricas de Meta
   */
  async executeMetricsSync() {
  console.log('📊 Ejecutando sincronización de métricas...');
  
  const syncLog = await SyncLog.create({
    job_type: 'metrics_sync',
    status: 'running',
    start_time: new Date(),
    records_processed: 0
  });

  try {
    let totalProcessed = 0;
    const errors = [];

    // Obtener todos los assets activos (FB Page + IG Business) con conexión válida
    const activeAssets = await ClinicMetaAsset.findAll({
      where: {
        isActive: true,
        assetType: { [Op.in]: ['facebook_page', 'instagram_business'] }
      },
      include: [{
        model: MetaConnection,
        as: 'metaConnection',
        required: true,
        where: {
          accessToken: { [Op.ne]: null },
          expiresAt: { [Op.gt]: new Date() }
        }
      }]
    });

    console.log(`📋 Assets activos encontrados: ${activeAssets.length}`);

    for (const [idx, asset] of activeAssets.entries()) {
      try {
        const processed = await this.syncAssetMetrics(asset);
        totalProcessed += processed;
        console.log(`✅ Asset ${asset.metaAssetName}: ${processed} métricas sincronizadas`);
        // Progreso + estado de uso API
        try {
          const { getUsageStatus } = require('../lib/metaClient');
          const u = await getUsageStatus();
          await syncLog.update({
            records_processed: totalProcessed,
            status_report: JSON.stringify({
              totalAssets: activeAssets.length,
              processedAssets: idx + 1,
              usagePct: u.usagePct || 0,
              waiting: (u.nextAllowedAt || 0) > Date.now()
            })
          });
        } catch {}
      } catch (error) {
        console.error(`❌ Error sincronizando asset ${asset.metaAssetName}:`, error.message);
        errors.push(`${asset.metaAssetName}: ${error.message}`);
      }
    }

    // Actualizar log de sincronización
    await syncLog.update({
      status: 'completed',
      end_time: new Date(),
      records_processed: totalProcessed,
      status_report: JSON.stringify({
        assetsProcessed: activeAssets.length,
        totalMetrics: totalProcessed,
        errors: errors.length > 0 ? errors : null
      })
    });

    console.log(`✅ Sincronización completada: ${totalProcessed} métricas procesadas`);
    return { success: true, processed: totalProcessed };

  } catch (error) {
    console.error('❌ Error en sincronización de métricas:', error);
    
    await syncLog.update({
      status: 'failed',
      end_time: new Date(),
      error_message: error.message
    });

    throw error;
  }
  }

  /**
   * Job: Sincronización diaria de Ads (ventana reciente)
   */
  async executeAdsSync(options = {}) {
    const windowLabel = options.windowLabel || 'default';
    console.log(`📢 Ejecutando adsSync (${windowLabel})...`);

    this._groupAssignmentCache.clear();

    const syncLog = await SyncLog.create({
      job_type: windowLabel === 'midday' ? 'ads_sync_midday' : 'ads_sync',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    const report = { accounts: 0, processed: 0, errors: [], totals: { entities: 0, insightsRows: 0, actionsRows: 0, linkedPromotions: 0 } };
    try {
      let activeAdAccounts = await ClinicMetaAsset.findAll({
        where: { isActive: true, assetType: 'ad_account' },
        include: [
          { model: MetaConnection, as: 'metaConnection' },
          { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'] }
        ]
      });

      if (Array.isArray(options.clinicIds) && options.clinicIds.length) {
        const allowedClinicIds = options.clinicIds
          .map((id) => Number(id))
          .filter(Number.isFinite);
        activeAdAccounts = activeAdAccounts.filter((asset) => {
          const clinicId = Number(asset.clinicaId ?? asset.clinica?.id_clinica);
          return allowedClinicIds.includes(clinicId);
        });
      }

      if (Array.isArray(options.groupIds) && options.groupIds.length) {
        const allowedGroupIds = options.groupIds
          .map((id) => Number(id))
          .filter(Number.isFinite);
        if (allowedGroupIds.length) {
          activeAdAccounts = activeAdAccounts.filter((asset) => {
            const groupId = Number(asset.grupoClinicaId ?? asset.clinica?.grupoClinicaId);
            if (!Number.isFinite(groupId)) {
              return false;
            }
            return allowedGroupIds.includes(groupId);
          });
        }
      }

      console.log(`🧾 Cuentas publicitarias activas: ${activeAdAccounts.length}`);
      report.accounts = activeAdAccounts.length;
      if (!activeAdAccounts.length) {
        await syncLog.update({
          status: 'completed',
          end_time: new Date(),
          records_processed: 0,
          status_report: report
        });
        console.log('ℹ️ adsSync sin cuentas tras aplicar filtros.');
        return { status: 'completed', ...report };
      }

      const defaultEnd = new Date();
      defaultEnd.setHours(0, 0, 0, 0);
      if (!options.endDate && windowLabel !== 'midday') {
        defaultEnd.setDate(defaultEnd.getDate() - 1);
      }

      const parsedEnd = parseDateInput(options.endDate, 'endDate') || defaultEnd;
      const parsedStart = parseDateInput(options.startDate, 'startDate');
      const customWindowDays = Number(options.windowDays || options.days);

      for (const [idx, asset] of activeAdAccounts.entries()) {
        try {
          const accessToken = asset.pageAccessToken || asset.metaConnection?.accessToken;
          if (!accessToken) { throw new Error('Sin access token para ad_account'); }
          // Detectar si es primera vez (sin logs previos)
          let start;
          let end = new Date(parsedEnd);

          if (parsedStart) {
            start = new Date(parsedStart);
          } else {
            let days;
            if (Number.isFinite(customWindowDays) && customWindowDays > 0) {
              days = Math.floor(customWindowDays);
            } else {
              days = windowLabel === 'midday' ? Math.max(2, this.config.ads.middayDays || 2) : this.config.ads.recentDays;
              if (windowLabel !== 'midday') {
                try {
                  const prev = await SyncLog.count({ where: { asset_id: asset.id, job_type: { [Op.in]: ['ads_sync','ads_backfill'] }, status: 'completed' } });
                  if (!prev) {
                    days = this.config.ads.initialDays;
                  }
                } catch (_) { /* no-op */ }
              }
            }
            days = Math.max(1, days);
            start = new Date(end);
            start.setDate(start.getDate() - (days - 1));
          }

          [start, end] = ensureAscending(start, end);

          console.log(`▶️ AdsSync ${asset.metaAssetName} (${asset.metaAssetId}) ${start.toISOString().slice(0,10)}..${end.toISOString().slice(0,10)}`);
          const assignment = await this._buildMetaAssignmentContext(asset);
          const result = await syncAdAccountMetrics(asset, accessToken, start, end, { assignment });
          // Persistir estado de cuenta y motivos de entrega (ligero)
          try { await this._updateAdAccountStatus(asset, accessToken); } catch (e) { console.warn('Account status update error:', e.message); }
          try { await this._enrichAdsetDeliveryReasons(asset, accessToken, end); } catch (e) { console.warn('Adset delivery enrich error:', e.message); }
          report.processed += 1;
          if (result) {
            report.totals.entities += result.entities || 0;
            report.totals.insightsRows += result.insightsRows || 0;
            report.totals.actionsRows += result.actionsRows || 0;
            report.totals.linkedPromotions += result.linkedPromotions || 0;
          }
          // Progreso + estado de uso
          try {
            const { getUsageStatus } = require('../lib/metaClient');
            const u = await getUsageStatus();
            await syncLog.update({
              records_processed: report.processed,
              status_report: JSON.stringify({
                accounts: report.accounts,
                processed: report.processed,
                totals: report.totals,
                usagePct: u.usagePct || 0,
                waiting: (u.nextAllowedAt || 0) > Date.now()
              })
            });
          } catch {}
          // Espera entre cuentas para repartir carga
          if (this.config.ads.betweenAccountsSleepMs > 0) {
            await new Promise(r => setTimeout(r, this.config.ads.betweenAccountsSleepMs));
          }
        } catch (err) {
          console.error('❌ Error en adsSync para asset:', asset.id, err.message);
          report.errors.push({ assetId: asset.id, name: asset.metaAssetName, error: err.message });
        }
      }

      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: report.processed,
        status_report: report
      });
      console.log('✅ adsSync completado', report);
      return { status: 'completed', ...report };
    } catch (error) {
      await syncLog.update({ status: 'failed', end_time: new Date(), error_message: error.message, status_report: report });
      console.error('❌ Error en adsSync:', error);
      throw error;
    }
  }

  /**
   * Job: Backfill semanal de Ads (ventana más larga)
   */
  async executeAdsBackfill(options = {}) {
    console.log('📢 Ejecutando adsBackfill (ventana extendida)...');
    this._groupAssignmentCache.clear();
    const syncLog = await SyncLog.create({
      job_type: 'ads_backfill',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    const report = { accounts: 0, processed: 0, errors: [], totals: { entities: 0, insightsRows: 0, actionsRows: 0, linkedPromotions: 0 }, dateRange: null, windowDays: null };
    try {
      let activeAdAccounts = await ClinicMetaAsset.findAll({
        where: { isActive: true, assetType: 'ad_account' },
        include: [
          { model: MetaConnection, as: 'metaConnection' },
          { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'] }
        ]
      });

      if (Array.isArray(options.clinicIds) && options.clinicIds.length) {
        const allowedClinicIds = options.clinicIds.map((id) => Number(id)).filter(Number.isFinite);
        if (allowedClinicIds.length) {
          activeAdAccounts = activeAdAccounts.filter((asset) => {
            const clinicId = Number(asset.clinicaId ?? asset.clinica?.id_clinica);
            return allowedClinicIds.includes(clinicId);
          });
        }
      }

      if (Array.isArray(options.groupIds) && options.groupIds.length) {
        const allowedGroupIds = options.groupIds.map((id) => Number(id)).filter(Number.isFinite);
        if (allowedGroupIds.length) {
          activeAdAccounts = activeAdAccounts.filter((asset) => {
            const groupId = Number(asset.grupoClinicaId ?? asset.clinica?.grupoClinicaId);
            if (!Number.isFinite(groupId)) {
              return false;
            }
            return allowedGroupIds.includes(groupId);
          });
        }
      }

      console.log(`🧾 Cuentas publicitarias activas: ${activeAdAccounts.length}`);
      report.accounts = activeAdAccounts.length;

      // Ventana: últimos M días hasta ayer
      const defaultEnd = new Date();
      defaultEnd.setHours(0, 0, 0, 0);
      defaultEnd.setDate(defaultEnd.getDate() - 1);

      let end = parseDateInput(options.endDate, 'endDate') || defaultEnd;
      let start = parseDateInput(options.startDate, 'startDate');
      let windowDays = Number(options.windowDays || options.days);
      if (!Number.isFinite(windowDays) || windowDays <= 0) {
        windowDays = this.config.ads.backfillDays;
      } else {
        windowDays = Math.floor(windowDays);
      }

      if (!start) {
        start = new Date(end);
        start.setDate(start.getDate() - (Math.max(1, windowDays) - 1));
      }

      [start, end] = ensureAscending(start, end);

      report.windowDays = diffInDaysInclusive(start, end);
      report.dateRange = {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10)
      };

      for (const asset of activeAdAccounts) {
        try {
          const accessToken = asset.pageAccessToken || asset.metaConnection?.accessToken;
          if (!accessToken) { throw new Error('Sin access token para ad_account'); }
          const assetStart = new Date(start);
          const assetEnd = new Date(end);
          console.log(`▶️ AdsBackfill ${asset.metaAssetName} (${asset.metaAssetId}) ${assetStart.toISOString().slice(0,10)}..${assetEnd.toISOString().slice(0,10)}`);
          const assignment = await this._buildMetaAssignmentContext(asset);
          const result = await syncAdAccountMetrics(asset, accessToken, assetStart, assetEnd, { assignment });
          // Sólo actualizar estado/motivos una vez por backfill (usa fin de ventana)
          try { await this._updateAdAccountStatus(asset, accessToken); } catch (e) { console.warn('Account status update error:', e.message); }
          try { await this._enrichAdsetDeliveryReasons(asset, accessToken, assetEnd); } catch (e) { console.warn('Adset delivery enrich error:', e.message); }
          report.processed += 1;
          if (result) {
            report.totals.entities += result.entities || 0;
            report.totals.insightsRows += result.insightsRows || 0;
            report.totals.actionsRows += result.actionsRows || 0;
            report.totals.linkedPromotions += result.linkedPromotions || 0;
          }
          if (this.config.ads.betweenAccountsSleepMs > 0) {
            await new Promise(r => setTimeout(r, this.config.ads.betweenAccountsSleepMs));
          }
        } catch (err) {
          console.error('❌ Error en adsBackfill para asset:', asset.id, err.message);
          report.errors.push({ assetId: asset.id, name: asset.metaAssetName, error: err.message });
        }
      }

      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: report.processed,
        status_report: report
      });
      console.log('✅ adsBackfill completado', report);
      return { status: 'completed', ...report };
    } catch (error) {
      await syncLog.update({ status: 'failed', end_time: new Date(), error_message: error.message, status_report: report });
      console.error('❌ Error en adsBackfill:', error);
      throw error;
    }
  }

  // ===== Web jobs (Search Console + PSI) =====
  async executeWebSync(options = {}) {
    const { clinicId = null, siteUrls = null, siteMappings = null } = options;
    const { ClinicWebAsset, GoogleConnection, WebScDaily, WebScDailyAgg, WebPsiSnapshot, WebIndexCoverageDaily, WebScQueryDaily } = require('../../models');
    const SyncLog = require('../../models').SyncLog;
    console.log('🌐 Ejecutando webSync (Search Console + PSI)…');
    const syncLog = await SyncLog.create({ job_type: 'web_sync', status: 'running', start_time: new Date(), records_processed: 0 });
    try {
      const where = { isActive: true };
      if (clinicId) {
        where.clinicaId = clinicId;
      }
      if (siteMappings && Array.isArray(siteMappings) && siteMappings.length) {
        const orConditions = siteMappings
          .map((entry) => {
            const cond = {};
            if (entry?.clinicId || entry?.clinicaId) {
              cond.clinicaId = entry.clinicId ?? entry.clinicaId;
            }
            if (entry?.siteUrl) {
              cond.siteUrl = entry.siteUrl;
            }
            return Object.keys(cond).length ? cond : null;
          })
          .filter(Boolean);
        if (orConditions.length) {
          where[Op.or] = orConditions;
        }
      } else if (siteUrls && Array.isArray(siteUrls) && siteUrls.length) {
        where.siteUrl = { [Op.in]: siteUrls };
      }

      const assets = await ClinicWebAsset.findAll({ where, raw: true });
      if (!assets.length) {
        await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: 0 });
        console.log('ℹ️ webSync sin activos para los criterios indicados', { clinicId, siteUrls, siteMappingsLength: siteMappings?.length || 0 });
        return { status: 'completed', processed: 0 };
      }
      const byClinic = new Map();
      for (const a of assets) {
        if (!byClinic.has(a.clinicaId)) byClinic.set(a.clinicaId, []);
        byClinic.get(a.clinicaId).push(a);
      }
      const end = new Date(); end.setHours(0,0,0,0);
      const start = new Date(end); start.setDate(start.getDate() - (this.config.web.recentDays-1));
      let processed = 0;
      const fmt = (d)=>d.toISOString().slice(0,10);
      for (const [clinicaId, arr] of byClinic.entries()) {
        try {
          // Conexión Google del primer asset
          const conn = await GoogleConnection.findByPk(arr[0].googleConnectionId);
          if (!conn) continue;
          let accessToken = conn.accessToken;
          // Refresh si expira pronto
          try {
            const expiresAt = conn.expiresAt ? new Date(conn.expiresAt).getTime() : 0;
            if (expiresAt && expiresAt < Date.now() + 60000 && conn.refreshToken) {
              const tr = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: conn.refreshToken
              }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
              accessToken = tr.data?.access_token || accessToken;
              const expiresIn = tr.data?.expires_in || 3600;
              await conn.update({ accessToken, expiresAt: new Date(Date.now() + expiresIn*1000) });
            }
          } catch {}

          // Timeseries por siteUrl (guardar por clínica+site+fecha)
          for (const a of arr) {
            const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(a.siteUrl)}/searchAnalytics/query`;
            const resp = await axios.post(url, { startDate: fmt(start), endDate: fmt(end), dimensions: ['date'], rowLimit: 25000 }, { headers: { Authorization: `Bearer ${accessToken}` } });
            const rows = resp.data?.rows || [];
            for (const r of rows) {
              const date = r.keys?.[0]; if (!date) continue;
              const payload = {
                clinica_id: clinicaId,
                site_url: a.siteUrl,
                date,
                clicks: r.clicks||0,
                impressions: r.impressions||0,
                ctr: r.ctr||0,
                position: r.position||null
              };
              const [rec, created] = await WebScDaily.findOrCreate({ where: { clinica_id: clinicaId, site_url: a.siteUrl, date }, defaults: payload });
              if (!created) await rec.update(payload);
            }
          }

          // Aggregado por día: nº queries Top10/Top3 con chunk mensual si rango > 2 meses
          const queryDailyMap = new Map();
          const topByDate = new Map(); // date => { set10:Set, set3:Set }
          function* monthChunks(s, e) {
            const d1 = new Date(s); d1.setHours(0,0,0,0);
            const d2 = new Date(e); d2.setHours(0,0,0,0);
            let cur = new Date(d1);
            while (cur <= d2) {
              const mStart = new Date(cur.getFullYear(), cur.getMonth(), 1);
              const mEnd = new Date(cur.getFullYear(), cur.getMonth()+1, 0);
              const startC = mStart < d1 ? d1 : mStart;
              const endC = mEnd > d2 ? d2 : mEnd;
              yield { s: fmt(startC), e: fmt(endC) };
              cur = new Date(cur.getFullYear(), cur.getMonth()+1, 1);
            }
          }
          const daysWindow = Math.round((end - start) / 86400000) + 1;
          const useChunks = daysWindow > 62;
          for (const a of arr) {
            const urlQ = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(a.siteUrl)}/searchAnalytics/query`;
            const ranges = useChunks ? Array.from(monthChunks(start, end)) : [{ s: fmt(start), e: fmt(end) }];
            for (const rg of ranges) {
              const respQ = await axios.post(urlQ, { startDate: rg.s, endDate: rg.e, dimensions: ['date','query','page'], rowLimit: 25000 }, { headers: { Authorization: `Bearer ${accessToken}` } });
              const rowsQ = respQ.data?.rows || [];
              for (const r of rowsQ) {
                const date = r.keys?.[0];
                const query = r.keys?.[1];
                const pageUrl = r.keys?.[2] || null;
                if (!date || !query) continue;
                const clicks = r.clicks || 0;
                const impressions = r.impressions || 0;
                const position = r.position || 0;

                let topEntry = topByDate.get(date);
                if (!topEntry) { topEntry = { set10: new Set(), set3: new Set() }; topByDate.set(date, topEntry); }
                if (position <= 10) topEntry.set10.add(query);
                if (position <= 3) topEntry.set3.add(query);

                const queryHash = crypto.createHash('sha256').update(query).digest('hex');
                const pageHash = crypto.createHash('sha256').update(pageUrl || '').digest('hex');
                const key = `${clinicaId}|${date}|${queryHash}|${pageHash}`;
                let agg = queryDailyMap.get(key);
                if (!agg) {
                  agg = {
                    clinica_id: clinicaId,
                    site_url: a.siteUrl,
                    date,
                    query,
                    query_hash: queryHash,
                    page_url: pageUrl,
                    page_url_hash: pageHash,
                    clicks: 0,
                    impressions: 0,
                    positionWeighted: 0,
                    lastPosition: position
                  };
                  queryDailyMap.set(key, agg);
                }
                agg.clicks += clicks;
                agg.impressions += impressions;
                agg.positionWeighted += position * (impressions || 1);
                agg.lastPosition = position;
              }
            }
          }

          if (queryDailyMap.size) {
            const bulkPayload = Array.from(queryDailyMap.values()).map((entry) => {
              const impressions = entry.impressions || 0;
              const ctr = impressions ? entry.clicks / impressions : 0;
              const position = impressions ? (entry.positionWeighted / impressions) : entry.lastPosition || null;
              return {
                clinica_id: entry.clinica_id,
                site_url: entry.site_url,
                date: entry.date,
                query: entry.query,
                query_hash: entry.query_hash,
                page_url: entry.page_url,
                page_url_hash: entry.page_url_hash,
                clicks: entry.clicks,
                impressions,
                ctr,
                position
              };
            });
            if (bulkPayload.length) {
              await bulkCreateInChunks(
                WebScQueryDaily,
                bulkPayload,
                { updateOnDuplicate: ['clicks', 'impressions', 'ctr', 'position', 'updated_at'] }
              );
            }
          }

          for (const [date, sets] of topByDate.entries()) {
            const defaults = { clinica_id: clinicaId, date, queries_top10: sets.set10.size, queries_top3: sets.set3.size };
            const [agg, created] = await WebScDailyAgg.findOrCreate({ where: { clinica_id: clinicaId, date }, defaults });
            if (!created) await agg.update(defaults);
          }

          // PSI + checks técnicos persistidos (solo si habilitado, no backfill, y con API key)
          try {
            const isBackfill = !!this._webBackfillMode;
            const psiAllowed = this.config.web.psiEnabled && !isBackfill && !!process.env.GOOGLE_PSI_API_KEY;
            if (psiAllowed) {
              // Debounce por clínica: si hay snapshot < N horas, saltar
              const minH = Math.max(0, this.config.web.psiMinHoursBetweenRuns || 0);
              const last = await WebPsiSnapshot.findOne({ where: { clinica_id: clinicaId }, order: [['fetched_at','DESC']] });
              const now = Date.now();
              const tooSoon = last && (now - new Date(last.fetched_at).getTime()) < (minH*3600*1000);
              if (!tooSoon) {
                const siteUrl = arr.find(s=>s.siteUrl.startsWith('http'))?.siteUrl || ('https://' + arr[0].siteUrl.replace('sc-domain:',''));
                const params = { url: siteUrl, strategy: 'mobile', category: ['performance','accessibility'], key: process.env.GOOGLE_PSI_API_KEY };
                const psi = await axios.get('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', { params });
                const lr = psi.data?.lighthouseResult || {};
                let https_ok = null, https_status = null, sitemap_found = null, sitemap_url = null, sitemap_status = null;
                try {
                  const origin = new URL(siteUrl).origin;
                  const r = await axios.get(origin, { timeout: 3500, maxRedirects: 2, validateStatus: ()=>true });
                  https_status = r.status; https_ok = (r.status>=200 && r.status<400);
                } catch {}
                try {
                  const origin = new URL(siteUrl).origin;
                  const cands = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
                  for (const u of cands) {
                    try { const h = await axios.head(u, { timeout: 2500, validateStatus: ()=>true }); if (h.status>=200 && h.status<400) { sitemap_found=true; sitemap_url=u; sitemap_status=h.status; break; } } catch {}
                  }
                  if (sitemap_found !== true) sitemap_found = false;
                } catch {}
                // Index status (1 URL via URL Inspection API)
                let indexed_ok = null;
                try {
                  const siteProperty = arr[0].siteUrl;
                  const inspectUrl = siteUrl;
                  const inspectEndpoint = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
                  const respI = await axios.post(inspectEndpoint, { inspectionUrl: inspectUrl, siteUrl: siteProperty }, { headers: { Authorization: `Bearer ${accessToken}` } });
                  const verdict = respI.data?.inspectionResult?.indexStatusResult?.verdict || '';
                  const coverageState = respI.data?.inspectionResult?.indexStatusResult?.coverageState || '';
                  indexed_ok = (String(verdict).toUpperCase() === 'PASS') || /indexed/i.test(String(coverageState));
                } catch {}

                const sn = {
                  clinica_id: clinicaId, url: siteUrl, fetched_at: new Date(),
                  performance: Math.round((lr.categories?.performance?.score||0)*100),
                  accessibility: Math.round((lr.categories?.accessibility?.score||0)*100),
                  lcp_ms: lr.audits?.['largest-contentful-paint']?.numericValue || null,
                  cls: lr.audits?.['cumulative-layout-shift']?.numericValue || null,
                  inp_ms: lr.audits?.['interaction-to-next-paint']?.numericValue || null,
                  https_ok, https_status, sitemap_found, sitemap_url, sitemap_status,
                  indexed_ok
                };
                await WebPsiSnapshot.create(sn);
              }
            }
          } catch (e) { console.warn('PSI error:', e.response?.data?.error?.message || e.message); }

          // (Cobertura eliminada)

          processed++;
          await syncLog.update({ records_processed: processed });
          if (this.config.web.betweenClinicsSleepMs>0) await new Promise(r=>setTimeout(r,this.config.web.betweenClinicsSleepMs));
        } catch (err) {
          console.error('❌ webSync clínica error:', clinicaId, err.message);
        }
      }
      await syncLog.update({ status:'completed', end_time:new Date(), records_processed: processed });
      console.log('✅ webSync completado:', processed);
      return { status:'completed', processed };
    } catch (e) {
      await syncLog.update({ status:'failed', end_time:new Date(), error_message: e.message });
      console.error('❌ Error en webSync:', e);
      throw e;
    }
  }

  async executeWebBackfill() {
    const prev = this.config.web.recentDays;
    const prevMode = this._webBackfillMode;
    this.config.web.recentDays = this.config.web.backfillDays;
    this._webBackfillMode = true;
    try {
      return await this.executeWebSync();
    } finally {
      this._webBackfillMode = prevMode;
      this.config.web.recentDays = prev;
    }
  }

  async executeAnalyticsSync(options = {}) {
    const { clinicId = null, propertyIds = null, propertyNames = null, startDate = null, endDate = null } = options;
    const jobType = this._analyticsBackfillMode ? 'analytics_backfill' : 'analytics_sync';
    const syncLog = await SyncLog.create({ job_type: jobType, status: 'running', start_time: new Date(), records_processed: 0 });
    try {
      const where = { isActive: true };
      if (clinicId) { where.clinicaId = clinicId; }
      const ids = Array.isArray(propertyIds) && propertyIds.length ? propertyIds.map((id) => Number(id)).filter(Boolean) : null;
      if (ids && ids.length) { where.id = { [Op.in]: ids }; }
      const names = Array.isArray(propertyNames) && propertyNames.length ? propertyNames.filter(Boolean) : null;
      if (names && names.length) {
        if (where.id) {
          where[Op.or] = [{ id: where.id[Op.in] }, { propertyName: { [Op.in]: names } }];
          delete where.id;
        } else {
          where.propertyName = { [Op.in]: names };
        }
      }
      const properties = await ClinicAnalyticsProperty.findAll({ where });
      if (!properties.length) {
        await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: 0, status_report: { properties: 0 } });
        console.log('ℹ️ analyticsSync sin propiedades coincidentes', { clinicId, propertyIds: ids, propertyNames: names });
        return { status: 'completed', processed: 0 };
      }
      const end = this._coerceDate(endDate) || new Date();
      end.setHours(0, 0, 0, 0);
      const spanDays = Math.max(1, this.config.analytics.recentDays || 1);
      const start = this._coerceDate(startDate) || new Date(end);
      start.setDate(start.getDate() - (spanDays - 1));
      const startStr = this._formatDate(start);
      const endStr = this._formatDate(end);
      const report = { properties: properties.length, start: startStr, end: endStr, rows: 0, dimensionRows: 0, errors: [] };
      let processed = 0;
      for (const property of properties) {
        try {
          const { accessToken } = await this._ensureGoogleAccessToken(property.googleConnectionId);
          const counts = await this._syncGaProperty(property, accessToken, startStr, endStr);
          processed += counts.rows || 0;
          report.rows += counts.rows || 0;
          report.dimensionRows += counts.dimensionRows || 0;
        } catch (err) {
          console.error('❌ analyticsSync property error:', property.id, err.message);
          report.errors.push({ propertyId: property.id, clinicaId: property.clinicaId, message: err.message });
        }
        if (this.config.analytics.betweenClinicsSleepMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.config.analytics.betweenClinicsSleepMs));
        }
      }
      await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: processed, status_report: report });
      console.log('✅ analyticsSync completado', report);
      return { status: 'completed', processed, report };
    } catch (error) {
      await syncLog.update({ status: 'failed', end_time: new Date(), error_message: error.message });
      console.error('❌ Error en analyticsSync:', error);
      throw error;
    }
  }

  async executeAnalyticsBackfill() {
    const prev = this.config.analytics.recentDays;
    const prevMode = this._analyticsBackfillMode;
    this.config.analytics.recentDays = this.config.analytics.backfillDays;
    this._analyticsBackfillMode = true;
    try {
      return await this.executeAnalyticsSync();
    } finally {
      this._analyticsBackfillMode = prevMode;
      this.config.analytics.recentDays = prev;
    }
  }

  async executeWhatsappTemplatesSync() {
    console.log('💬 Ejecutando sincronización de plantillas WhatsApp...');
    const syncLog = await SyncLog.create({
      job_type: 'whatsapp_templates_sync',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      const queueResult = await enqueueSyncForAllWabas({ onlyPending: true });
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: 0,
        status_report: queueResult || { queued: true }
      });
      console.log('✅ Plantillas WhatsApp encoladas para sincronización');
      return { status: 'completed', ...(queueResult || { queued: true }) };
    } catch (error) {
      await syncLog.update({ status: 'failed', end_time: new Date(), error_message: error.message });
      console.error('❌ Error sincronizando plantillas WhatsApp:', error);
      throw error;
    }
  }

  async executeWhatsappPhonesSync() {
    console.log('📱 Ejecutando sincronización de números WhatsApp...');
    const syncLog = await SyncLog.create({
      job_type: 'whatsapp_phones_sync',
      status: 'running',
      start_time: new Date(),
      records_processed: 0,
    });

    try {
      const result = await enqueueSyncPhonesForAllWabas();
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: result?.queued || 0,
        status_report: { queued: result?.queued || 0 },
      });
      console.log(`✅ Números WhatsApp encolados para sincronización: ${result?.queued || 0}`);
      return { status: 'completed', queued: result?.queued || 0 };
    } catch (error) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message,
      });
      console.error('❌ Error sincronizando números WhatsApp:', error);
      throw error;
    }
  }

  async executeAnalyticsBackfillForProperties(propertyMappings = []) {
    if (!Array.isArray(propertyMappings) || propertyMappings.length === 0) {
      throw new Error('propertyMappings must contain at least one { clinicId, propertyId|propertyName }');
    }
    const ids = [];
    const names = [];
    propertyMappings.forEach((item) => {
      if (item?.propertyId) { ids.push(Number(item.propertyId)); }
      if (item?.propertyName) { names.push(String(item.propertyName)); }
    });
    const prev = this.config.analytics.recentDays;
    const prevMode = this._analyticsBackfillMode;
    this.config.analytics.recentDays = this.config.analytics.backfillDays;
    this._analyticsBackfillMode = true;
    try {
      const clinicId = propertyMappings[0]?.clinicId || null;
      return await this.executeAnalyticsSync({ propertyIds: ids, propertyNames: names, clinicId });
    } finally {
      this._analyticsBackfillMode = prevMode;
      this.config.analytics.recentDays = prev;
    }
  }

  async executeBusinessProfileSync(options = {}) {
    const {
      clinicId = null,
      locationIds = null,
      startDate = null,
      endDate = null
    } = options;
    const jobType = this._localBackfillMode ? 'business_profile_backfill' : 'business_profile_sync';
    const syncLog = await SyncLog.create({ job_type: jobType, status: 'running', start_time: new Date(), records_processed: 0 });
    const report = { locations: 0, processed: 0, metricRows: 0, reviews: 0, posts: 0, errors: [] };

    try {
      const where = { is_active: true };
      if (clinicId) {
        where.clinica_id = clinicId;
      }
      if (Array.isArray(locationIds) && locationIds.length) {
        where.location_id = { [Op.in]: locationIds.map((id) => String(id)).filter(Boolean) };
      }

      const locations = await ClinicBusinessLocation.findAll({ where });
      report.locations = locations.length;

      if (!locations.length) {
        await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: 0, status_report: report });
        console.log('ℹ️ businessProfileSync sin ubicaciones activas', { clinicId, locationIds });
        return { status: 'completed', processed: 0, report };
      }

      const defaultEnd = new Date();
      defaultEnd.setHours(0, 0, 0, 0);
      defaultEnd.setDate(defaultEnd.getDate() - 1);
      const end = this._coerceDate(endDate) || defaultEnd;
      end.setHours(0, 0, 0, 0);
      const spanDays = Math.max(1, this._localBackfillMode ? this.config.local.backfillDays : this.config.local.recentDays);
      const start = this._coerceDate(startDate) || new Date(end);
      start.setDate(start.getDate() - (spanDays - 1));
      const startStr = this._formatDate(start);
      const endStr = this._formatDate(end);
      report.start = startStr;
      report.end = endStr;

      for (const location of locations) {
        try {
          const { accessToken } = await this._ensureGoogleAccessToken(location.google_connection_id);
          await this._syncBusinessProfileLocationDetails(location, accessToken);
          const metricRows = await this._syncBusinessProfileMetrics(location, accessToken, start, end);
          const reviews = await this._syncBusinessProfileReviews(location, accessToken);
          const posts = await this._syncBusinessProfilePosts(location, accessToken);

          report.processed += 1;
          report.metricRows += metricRows;
          report.reviews += reviews;
          report.posts += posts;
          await location.update({ last_synced_at: new Date(), sync_status: 'completed' });
          await syncLog.update({ records_processed: report.processed, status_report: report });

          if (this.config.local.betweenLocationsSleepMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.config.local.betweenLocationsSleepMs));
          }
        } catch (err) {
          const message = err.response?.data?.error?.message || err.message;
          report.errors.push({ locationId: location.location_id, clinicaId: location.clinica_id, message });
          console.error('❌ businessProfileSync location error:', location.location_id, message);
          try {
            await location.update({ sync_status: 'error', last_synced_at: new Date() });
          } catch (_) {}
        }
      }

      await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: report.processed, status_report: report });
      console.log('✅ businessProfileSync completado', report);
      return { status: 'completed', processed: report.processed, report };
    } catch (error) {
      await syncLog.update({ status: 'failed', end_time: new Date(), error_message: error.message, status_report: report });
      console.error('❌ Error en businessProfileSync:', error);
      throw error;
    }
  }

  async executeBusinessProfileBackfill(options = {}) {
    const prevMode = this._localBackfillMode;
    this._localBackfillMode = true;
    try {
      return await this.executeBusinessProfileSync(options);
    } finally {
      this._localBackfillMode = prevMode;
    }
  }

  async executeBusinessProfileBackfillForLocations(locationMappings = []) {
    if (!Array.isArray(locationMappings) || locationMappings.length === 0) {
      throw new Error('locationMappings must contain at least one { clinicId, locationId }');
    }
    const locationIds = Array.from(new Set(locationMappings.map((item) => String(item?.locationId || '').trim()).filter(Boolean)));
    const clinicId = locationMappings[0]?.clinicId || locationMappings[0]?.clinicaId || null;
    return this.executeBusinessProfileBackfill({ clinicId, locationIds });
  }

  async executeCompetitionSync(options = {}) {
    const syncLog = await SyncLog.create({
      job_type: 'competition_sync',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      const scope = {
        isAll: !options.clinicId && !options.clinicaId && !options.groupId,
        scope: options.groupId ? 'group' : (options.clinicId || options.clinicaId ? 'clinic' : 'all'),
        clinicIds: options.clinicId || options.clinicaId ? [Number(options.clinicId || options.clinicaId)] : [],
        groupId: options.groupId ? Number(options.groupId) : null,
        original: options.groupId ? `group:${options.groupId}` : (options.clinicId || options.clinicaId || 'all')
      };

      const result = await marketingCompetitionService.refreshCompetition(scope, {
        competitorIds: options.competitorIds || options.competitor_ids || null
      });
      const report = result.report || {};
      await syncLog.update({
        status: report.errors?.length ? 'completed' : 'completed',
        end_time: new Date(),
        records_processed: report.processed || 0,
        status_report: report
      });
      console.log('✅ competitionSync completado', report);
      return { status: 'completed', processed: report.processed || 0, report };
    } catch (error) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message
      });
      console.error('❌ Error en competitionSync:', error);
      throw error;
    }
  }

  async executeWebEventsAggregate(options = {}) {
    const syncLog = await SyncLog.create({
      job_type: 'web_events_aggregate',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      const aggregate = await webEventsService.aggregateWebEvents(options);
      const cleanup = options.skipCleanup ? { deleted: 0, skipped: true } : await webEventsService.cleanupWebEvents();
      const report = { aggregate, cleanup };
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: aggregate.processed || 0,
        status_report: report
      });
      console.log('✅ webEventsAggregate completado', report);
      return { status: 'completed', processed: aggregate.processed || 0, report };
    } catch (error) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message
      });
      console.error('❌ Error en webEventsAggregate:', error);
      throw error;
    }
  }

  async _syncBusinessProfileMetrics(location, accessToken, start, end) {
    const locationName = this._normalizeBusinessProfilePerformanceLocation(location.location_id);
    if (!locationName) {
      throw new Error('Ubicación Google Business Profile sin location_id válido');
    }

    const params = this._buildBusinessProfileMetricParams(start, end);
    const response = await axios.get(
      `${GOOGLE_BUSINESS_PERFORMANCE_API}/${locationName}:fetchMultiDailyMetricsTimeSeries`,
      { params, headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const containers = response.data?.multiDailyMetricTimeSeries
      || response.data?.multi_daily_metric_time_series
      || [];
    let rows = 0;

    for (const container of containers) {
      const seriesList = container.dailyMetricTimeSeries
        || container.daily_metric_time_series
        || [];
      for (const series of seriesList) {
        const metric = series.dailyMetric || series.daily_metric;
        if (!metric) {
          continue;
        }
        const datedValues = series.timeSeries?.datedValues
          || series.time_series?.dated_values
          || [];
        for (const point of datedValues) {
          const date = this._formatGoogleDateObject(point.date);
          if (!date) {
            continue;
          }
          const value = Number(point.value?.value ?? point.value ?? 0) || 0;
          await this._upsertBusinessProfileDailyMetric({
            clinica_id: location.clinica_id,
            business_location_id: location.id,
            metric_type: metric,
            metric_subtype: this._stringifyMetricSubtype(series.dailySubEntityType || series.daily_sub_entity_type),
            date,
            value
          });
          rows += 1;
        }
      }
    }

    return rows;
  }

  async _syncBusinessProfileReviews(location, accessToken) {
    const resourceBase = this._buildBusinessProfileV4LocationPath(location);
    if (!resourceBase) {
      throw new Error('Ubicación Google Business Profile sin accountName para sincronizar reseñas');
    }

    let nextPageToken = null;
    let processed = 0;
    do {
      const response = await axios.get(`${GOOGLE_MY_BUSINESS_API}/${resourceBase}/reviews`, {
        params: { pageSize: 50, pageToken: nextPageToken || undefined },
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const reviews = response.data?.reviews || [];
      for (const review of reviews) {
        const reviewName = review.name || review.reviewId || null;
        if (!reviewName) {
          continue;
        }
        const starRating = this._normalizeGoogleStarRating(review.starRating);
        const reply = review.reviewReply || null;
        const payload = {
          clinica_id: location.clinica_id,
          business_location_id: location.id,
          review_name: reviewName,
          reviewer_name: review.reviewer?.displayName || review.reviewer?.name || null,
          reviewer_profile_photo_url: review.reviewer?.profilePhotoUrl || null,
          star_rating: starRating,
          comment: review.comment || null,
          create_time: review.createTime ? new Date(review.createTime) : null,
          update_time: review.updateTime ? new Date(review.updateTime) : null,
          review_state: review.reviewState || null,
          is_new: review.createTime ? (Date.now() - new Date(review.createTime).getTime()) <= 30 * MS_PER_DAY : false,
          is_negative: starRating > 0 && starRating <= 3,
          reply_comment: reply?.comment || null,
          reply_update_time: reply?.updateTime ? new Date(reply.updateTime) : null,
          has_reply: Boolean(reply?.comment),
          raw_payload: review
        };
        const existing = await BusinessProfileReview.findOne({ where: { review_name: reviewName } });
        if (existing) {
          await existing.update(payload);
        } else {
          await BusinessProfileReview.create(payload);
        }
        processed += 1;
      }
      nextPageToken = response.data?.nextPageToken || null;
    } while (nextPageToken);

    return processed;
  }

  async _syncBusinessProfilePosts(location, accessToken) {
    const resourceBase = this._buildBusinessProfileV4LocationPath(location);
    if (!resourceBase) {
      throw new Error('Ubicación Google Business Profile sin accountName para sincronizar publicaciones');
    }

    let nextPageToken = null;
    let processed = 0;
    do {
      const response = await axios.get(`${GOOGLE_MY_BUSINESS_API}/${resourceBase}/localPosts`, {
        params: { pageSize: 100, pageToken: nextPageToken || undefined },
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const posts = response.data?.localPosts || [];
      for (const post of posts) {
        const postName = post.name || null;
        if (!postName) {
          continue;
        }
        const media = Array.isArray(post.media) && post.media.length ? post.media[0] : null;
        const payload = {
          clinica_id: location.clinica_id,
          business_location_id: location.id,
          post_name: postName,
          summary: post.summary || null,
          topic_type: post.topicType || null,
          call_to_action_type: post.callToAction?.actionType || null,
          call_to_action_url: post.callToAction?.url || null,
          media_url: media?.googleUrl || media?.sourceUrl || null,
          create_time: post.createTime ? new Date(post.createTime) : null,
          update_time: post.updateTime ? new Date(post.updateTime) : null,
          event_start_time: post.event?.schedule?.startDate ? this._dateFromGoogleDateObject(post.event.schedule.startDate) : null,
          event_end_time: post.event?.schedule?.endDate ? this._dateFromGoogleDateObject(post.event.schedule.endDate) : null,
          visibility_state: post.state || post.visibilityState || null,
          raw_payload: post
        };
        const existing = await BusinessProfilePost.findOne({ where: { post_name: postName } });
        if (existing) {
          await existing.update(payload);
        } else {
          await BusinessProfilePost.create(payload);
        }
        processed += 1;
      }
      nextPageToken = response.data?.nextPageToken || null;
    } while (nextPageToken);

    return processed;
  }

  async _syncBusinessProfileLocationDetails(location, accessToken) {
    const rawPayload = location.raw_payload && typeof location.raw_payload === 'object'
      ? location.raw_payload
      : {};
    const accountName = rawPayload.accountName || rawPayload.account_name || null;
    const locationName = this._normalizeBusinessProfilePerformanceLocation(location.location_id);
    const locationId = locationName ? locationName.split('/').pop() : null;
    if (!accountName || !locationId) {
      return null;
    }

    try {
      const response = await axios.get(`${GOOGLE_BUSINESS_INFORMATION_API}/locations/${locationId}`, {
        params: { readMask: GOOGLE_BUSINESS_LOCATION_READ_MASK },
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const details = response.data || {};
      const primaryCategory = details.primaryCategory?.displayName
        || details.categories?.primaryCategory?.displayName
        || details.primaryCategory?.name
        || details.categories?.primaryCategory?.name
        || location.primary_category
        || null;

      await location.update({
        location_name: details.title || details.locationName || location.location_name || null,
        store_code: details.storeCode || location.store_code || null,
        primary_category: primaryCategory,
        is_verified: details.metadata?.verificationState
          ? String(details.metadata.verificationState).toUpperCase() === 'VERIFIED'
          : location.is_verified,
        is_suspended: Array.isArray(details.metadata?.suspensionReasons)
          ? details.metadata.suspensionReasons.length > 0
          : location.is_suspended,
        raw_payload: {
          ...rawPayload,
          ...details,
          accountName,
          accountDisplayName: rawPayload.accountDisplayName || rawPayload.account_display_name || null
        }
      });

      return details;
    } catch (error) {
      console.warn('⚠️ No se pudo refrescar detalles de Google Business Profile', {
        locationId: location.location_id,
        status: error.response?.status,
        message: error.response?.data?.error?.message || error.message
      });
      return null;
    }
  }

  _buildBusinessProfileMetricParams(start, end) {
    const params = new URLSearchParams();
    for (const metric of GOOGLE_BUSINESS_DAILY_METRICS) {
      params.append('dailyMetrics', metric);
    }
    this._appendGoogleDateParams(params, 'daily_range.start_date', start);
    this._appendGoogleDateParams(params, 'daily_range.end_date', end);
    return params;
  }

  _appendGoogleDateParams(params, prefix, date) {
    const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
    params.append(`${prefix}.year`, String(d.getFullYear()));
    params.append(`${prefix}.month`, String(d.getMonth() + 1));
    params.append(`${prefix}.day`, String(d.getDate()));
  }

  async _upsertBusinessProfileDailyMetric(payload) {
    const where = {
      business_location_id: payload.business_location_id,
      metric_type: payload.metric_type,
      metric_subtype: payload.metric_subtype,
      date: payload.date
    };
    const existing = await BusinessProfileDailyMetric.findOne({ where });
    if (existing) {
      await existing.update(payload);
    } else {
      await BusinessProfileDailyMetric.create(payload);
    }
  }

  _normalizeBusinessProfilePerformanceLocation(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return null;
    }
    const match = raw.match(/(?:^|\/)locations\/([^/]+)$/);
    const id = match ? match[1] : raw.replace(/^locations\//, '');
    return id ? `locations/${id}` : null;
  }

  _buildBusinessProfileV4LocationPath(location) {
    const rawPayload = location.raw_payload && typeof location.raw_payload === 'object'
      ? location.raw_payload
      : {};
    const accountName = rawPayload.accountName || rawPayload.account_name || null;
    const locationName = this._normalizeBusinessProfilePerformanceLocation(location.location_id);
    const locationId = locationName ? locationName.split('/').pop() : null;
    if (!accountName || !locationId) {
      return null;
    }
    return `${accountName}/locations/${locationId}`;
  }

  _formatGoogleDateObject(value) {
    if (!value) {
      return null;
    }
    const year = Number(value.year);
    const month = Number(value.month);
    const day = Number(value.day);
    if (!year || !month || !day) {
      return null;
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  _dateFromGoogleDateObject(value) {
    const date = this._formatGoogleDateObject(value);
    return date ? new Date(date) : null;
  }

  _stringifyMetricSubtype(value) {
    if (!value) {
      return null;
    }
    if (typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch (_) {
      return null;
    }
  }

  _normalizeGoogleStarRating(value) {
    const raw = String(value || '').trim().toUpperCase();
    const map = {
      ONE: 1,
      TWO: 2,
      THREE: 3,
      FOUR: 4,
      FIVE: 5
    };
    if (map[raw]) {
      return map[raw];
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  async _ensureGoogleAccessToken(connectionId) {
    if (!connectionId) { throw new Error('Sin googleConnectionId en propiedad Analytics'); }
    const conn = await GoogleConnection.findByPk(connectionId);
    if (!conn) { throw new Error('GoogleConnection no encontrada'); }
    let accessToken = conn.accessToken;
    const expiresAt = conn.expiresAt ? new Date(conn.expiresAt).getTime() : 0;
    if (expiresAt && expiresAt < Date.now() + 60000 && conn.refreshToken) {
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: conn.refreshToken
      });
      const resp = await axios.post('https://oauth2.googleapis.com/token', params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      accessToken = resp.data?.access_token || accessToken;
      const expiresIn = resp.data?.expires_in || 3600;
      await conn.update({ accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000) });
    }
    return { accessToken, connection: conn };
  }

  async _runGaReport(accessToken, propertyName, body) {
    if (!propertyName) { throw new Error('Propiedad GA sin propertyName'); }
    const url = `https://analyticsdata.googleapis.com/v1beta/${propertyName}:runReport`;
    const resp = await axios.post(url, body, { headers: { Authorization: `Bearer ${accessToken}` } });
    return resp.data || {};
  }

  async _syncGaProperty(property, accessToken, start, end) {
    const propertyName = property.propertyName;
    if (!propertyName) { throw new Error('Propiedad GA sin propertyName'); }
    const metrics = ['sessions', 'activeUsers', 'newUsers', 'conversions', 'totalRevenue'];
    const baseRequest = {
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [{ name: 'date' }],
      metrics: metrics.map((name) => ({ name })),
      limit: 100000
    };
    const mainReport = await this._runGaReport(accessToken, propertyName, baseRequest);
    const rows = mainReport.rows || [];
    let inserted = 0;
    for (const row of rows) {
      const dateKey = this._normalizeGaDate(row.dimensionValues?.[0]?.value);
      if (!dateKey) { continue; }
      const metricValues = row.metricValues || [];
      const getMetric = (idx, fallback = 0) => {
        const entry = metricValues[idx];
        if (!entry || entry.value === undefined || entry.value === null || entry.value === '') { return fallback; }
        return Number(entry.value);
      };
      await WebGaDaily.upsert({
        clinica_id: property.clinicaId,
        property_id: property.id,
        date: dateKey,
        sessions: Math.round(getMetric(0, 0)),
        active_users: Math.round(getMetric(1, 0)),
        new_users: Math.round(getMetric(2, 0)),
        conversions: Math.round(getMetric(3, 0)),
        total_revenue: metricValues[4]?.value !== undefined ? Number(metricValues[4].value) : null
      });
      inserted += 1;
    }
    const dimensionDefs = [
      { type: 'channel', dimension: 'sessionDefaultChannelGroup' },
      { type: 'source_medium', dimension: 'sessionSourceMedium' },
      { type: 'device', dimension: 'deviceCategory' },
      { type: 'country', dimension: 'country' },
      { type: 'city', dimension: 'city' },
      { type: 'language', dimension: 'language' },
      { type: 'gender', dimension: 'userGender' },
      { type: 'age', dimension: 'userAgeBracket' }
    ];
    let dimensionRows = 0;
    for (const def of dimensionDefs) {
      try {
        const body = {
          dateRanges: [{ startDate: start, endDate: end }],
          dimensions: [{ name: 'date' }, { name: def.dimension }],
          metrics: metrics.map((name) => ({ name })),
          limit: 100000,
          orderBys: [{ dimension: { dimensionName: 'date' } }]
        };
        const resp = await this._runGaReport(accessToken, propertyName, body);
        const dRows = resp.rows || [];
        for (const row of dRows) {
          const dateKey = this._normalizeGaDate(row.dimensionValues?.[0]?.value);
          if (!dateKey) { continue; }
          const dimensionValue = row.dimensionValues?.[1]?.value || '(not set)';
          const metricValues = row.metricValues || [];
          const getMetric = (idx, fallback = 0) => {
            const entry = metricValues[idx];
            if (!entry || entry.value === undefined || entry.value === null || entry.value === '') { return fallback; }
            return Number(entry.value);
          };
          await WebGaDimensionDaily.upsert({
            clinica_id: property.clinicaId,
            property_id: property.id,
            date: dateKey,
            dimension_type: def.type,
            dimension_value: dimensionValue,
            sessions: Math.round(getMetric(0, 0)),
            active_users: Math.round(getMetric(1, 0)),
            conversions: Math.round(getMetric(3, 0)),
            total_revenue: metricValues[4]?.value !== undefined ? Number(metricValues[4].value) : null
          });
          dimensionRows += 1;
        }
      } catch (err) {
        console.warn(`⚠️ GA dimension ${def.type} error`, err.response?.data?.error?.message || err.message);
      }
    }
    return { rows: inserted, dimensionRows };
  }

  _coerceDate(value) {
    if (!value) { return null; }
    if (value instanceof Date) { return new Date(value.getTime()); }
    if (typeof value === 'string') {
      const normalized = /^\d{8}$/.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}` : value;
      const dt = new Date(normalized);
      if (!isNaN(dt.getTime())) { return dt; }
    }
    return null;
  }

  _formatDate(date) {
    const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
    d.setHours(0, 0, 0, 0);
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  _normalizeGaDate(value) {
    if (!value) { return null; }
    if (/^\d{8}$/.test(value)) {
      return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    try {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return this._formatDate(d);
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  async executeWebBackfillForSites(siteMappings = []) {
    if (!Array.isArray(siteMappings) || siteMappings.length === 0) {
      throw new Error('siteMappings must contain at least one { clinicId, siteUrl } pair');
    }
    const prev = this.config.web.recentDays;
    const prevMode = this._webBackfillMode;
    this.config.web.recentDays = this.config.web.backfillDays;
    this._webBackfillMode = true;
    try {
      return await this.executeWebSync({ siteMappings });
    } finally {
      this._webBackfillMode = prevMode;
      this.config.web.recentDays = prev;
    }
  }


  //  Usar la variable extraída:
async syncAssetMetrics(asset) {
  let processed = 0;

  // Token preferente: pageAccessToken y fallback al de usuario
  const accessToken = asset.pageAccessToken || asset.metaConnection?.accessToken;
  if (!accessToken) {
    console.warn(`⚠️ Asset ${asset.id} sin token disponible (page/user). Omitido.`);
    return 0;
  }

  // Ventana de sincronización: últimos N días hasta ayer (por defecto 7)
  const days = parseInt(process.env.METRICS_SYNC_DAYS || '7', 10);
  const end = new Date();
  end.setHours(0,0,0,0); // día cerrado
  end.setDate(end.getDate() - 1); // hasta ayer
  const start = new Date(end);
  start.setDate(start.getDate() - (Math.max(1, days) - 1));

  switch (asset.assetType) {
    case 'facebook_page': {
      try {
        const result = await controllerSyncFacebookPageMetrics(asset, accessToken, start, end);
        processed = typeof result === 'number' ? result : (result?.recordsProcessed || 0);
      } catch (e) {
        console.error(`❌ Error en sync (FB Page) para asset ${asset.id}:`, e.message);
        processed = 0;
      }
      break;
    }
    case 'instagram_business': {
      try {
        const result = await controllerSyncInstagramMetrics(asset, accessToken, start, end);
        processed = typeof result === 'number' ? result : (result?.recordsProcessed || 0);
      } catch (e) {
        console.error(`❌ Error en sync (IG Business) para asset ${asset.id}:`, e.message);
        processed = 0;
      }
      break;
    }
    case 'ad_account':
      console.log(`ℹ️ Ad Account ${asset.metaAssetName}: Métricas de anuncios gestionadas en jobs de Ads.`);
      processed = 0;
      break;
    default:
      console.log(`⚠️ Tipo de asset no soportado: ${asset.assetType}`);
      processed = 0;
  }

  return processed;
}

/**
 * Sincronizar métricas de Facebook Page
 * FUNCIÓN COMPLETA Y CORREGIDA - REEMPLAZAR COMPLETAMENTE
 */
async syncFacebookPageMetrics(asset) {
  console.log(`📘 Sincronizando métricas de Facebook: ${asset.metaAssetName}`);

  try {
    // Obtener número total de seguidores actuales
    const response = await axios.get(
      `${process.env.META_API_BASE_URL}/${asset.metaAssetId}`,
      {
        params: {
          fields: 'fan_count',
          access_token: asset.pageAccessToken
        }
      }
    );

    const fanCount = response.data?.fan_count;
    if (fanCount === undefined) {
      throw new Error('Respuesta de API inválida al obtener fan_count');
    }

    const date = new Date();
    date.setHours(0, 0, 0, 0);

    const prevDate = new Date(date);
    prevDate.setDate(prevDate.getDate() - 1);

    const prevStats = await SocialStatsDaily.findOne({
      where: {
        clinica_id: asset.clinicaId,
        asset_id: asset.id,
        date: prevDate
      }
    });

    const followersDay = fanCount - (prevStats ? prevStats.followers : 0);

    await SocialStatsDaily.upsert({
      clinica_id: asset.clinicaId,
      asset_id: asset.id,
      asset_type: 'facebook_page',
      date: date.toISOString().split('T')[0],
      followers: fanCount,
      followers_day: followersDay
    });

    console.log(`✅ Facebook ${asset.metaAssetName}: métricas guardadas`);
    return 1;

  } catch (error) {
    console.error(`❌ Error sincronizando Facebook ${asset.metaAssetName}:`, error.message);
    console.error(`🔍 DEBUG: Error completo:`, error.response?.data || error);
    throw error;
  }
}




  /**
   * Sincroniza métricas de Instagram Business
   */
  async syncInstagramMetrics(asset) {
  console.log(`📷 Sincronizando métricas de Instagram: ${asset.metaAssetName}`);

  try {
    const until = Math.floor(Date.now() / 1000);
    const since = until - 30 * 24 * 60 * 60; // últimos 30 días

    // Variación diaria de seguidores
    const followersDayResp = await axios.get(
      `${process.env.META_API_BASE_URL}/${asset.metaAssetId}/insights`,
      {
        params: {
          metric: 'follower_count',
          period: 'day',
          since,
          until,
          access_token: asset.pageAccessToken
        }
      }
    );

    const statsByDate = {};
    const followerValues = followersDayResp.data?.data?.[0]?.values || [];
    for (const value of followerValues) {
      const date = new Date(value.end_time);
      date.setHours(0, 0, 0, 0);
      const dateStr = date.toISOString().split('T')[0];

      statsByDate[dateStr] = {
        asset_id: asset.id,
        clinica_id: asset.clinicaId,
        asset_type: 'instagram_business',
        date: dateStr,
        followers_day: value.value || 0
      };
    }

    // Total actual de seguidores
    const followersTotalResp = await axios.get(
      `${process.env.META_API_BASE_URL}/${asset.metaAssetId}`,
      {
        params: {
          fields: 'followers_count',
          access_token: asset.pageAccessToken
        }
      }
    );

    const currentFollowers = followersTotalResp.data?.followers_count || 0;

    // Reconstruir followers (solo si hay serie follower_count)
    const followerDates = Object.keys(statsByDate).sort();
    if (followerDates.length > 0) {
      let runningTotal = currentFollowers;
      for (let i = followerDates.length - 1; i >= 0; i--) {
        const dateStr = followerDates[i];
        statsByDate[dateStr].followers = runningTotal;
        runningTotal -= statsByDate[dateStr].followers_day || 0;
      }
    }

    // Alcance diario a nivel de cuenta (IG User Insights)
    try {
      const reachResp = await axios.get(
        `${process.env.META_API_BASE_URL}/${asset.metaAssetId}/insights`,
        {
          params: {
            metric: 'reach',
            period: 'day',
            since,
            until,
            access_token: asset.pageAccessToken
          }
        }
      );
      const reachValues = reachResp.data?.data?.[0]?.values || [];
      for (const r of reachValues) {
        const d = new Date(r.end_time);
        d.setHours(0, 0, 0, 0);
        const dStr = d.toISOString().split('T')[0];
        if (!statsByDate[dStr]) {
          statsByDate[dStr] = {
            asset_id: asset.id,
            clinica_id: asset.clinicaId,
            asset_type: 'instagram_business',
            date: dStr
          };
        }
        statsByDate[dStr].reach = r.value || 0;
      }
      console.log(`✅ Instagram ${asset.metaAssetName}: reach diario obtenido (${reachValues.length} días)`);
    } catch (e) {
      console.warn(`⚠️ IG reach (user insights) no disponible:`, e.response?.data || e.message);
    }

    let processed = 0;
    const allDates = Object.keys(statsByDate).sort();
    for (const dateStr of allDates) {
      await SocialStatsDaily.upsert(statsByDate[dateStr]);
      processed++;
    }

    console.log(`✅ Instagram ${asset.metaAssetName}: ${processed} métricas guardadas (followers/alcance)`);
    return processed;

  } catch (error) {
    console.error(`❌ Error sincronizando Instagram ${asset.metaAssetName}:`, error.message);
    throw error;
  }
}

  /**
   * Job: Validación de tokens de acceso
   */
  async executeTokenValidation() {
    console.log('🔐 Iniciando validación de tokens de acceso...');
    
    const syncLog = await SyncLog.create({
      job_type: 'token_validation',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      // Obtener todos los assets con tokens de página
      const assets = await ClinicMetaAsset.findAll({
        where: {
          pageAccessToken: { [Op.not]: null }
        }
      });

      console.log(`🔍 Validando ${assets.length} tokens...`);
      
      let validCount = 0;
      let invalidCount = 0;

      for (const asset of assets) {
        try {
          const isValid = await this.validateToken(asset.pageAccessToken, asset.metaAssetId);
          
          // Registrar resultado de validación en TokenValidations (por conexión)
          try {
            await TokenValidations.create({
              connection_id: asset.metaConnectionId,
              validation_date: new Date(),
              status: isValid ? 'valid' : 'invalid',
              error_message: isValid ? null : `Asset ${asset.id}: token de página inválido o expirado`
            });
          } catch (logErr) {
            console.error('❌ Error registrando validación de token:', logErr.message);
          }

          if (isValid) {
            validCount++;
          } else {
            invalidCount++;
            console.log(`⚠️ Token inválido para asset ${asset.id}`);
          }
          
          // Delay entre validaciones
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`❌ Error validando token para asset ${asset.id}:`, error.message);
          invalidCount++;
        }
      }

      // Actualizar log
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: assets.length,
        error_message: invalidCount > 0 ? `${invalidCount} tokens inválidos` : null
      });

      console.log(`✅ Validación completada: ${validCount} válidos, ${invalidCount} inválidos`);
      
      return {
        status: 'completed',
        valid: validCount,
        invalid: invalidCount
      };

    } catch (error) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message
      });

      throw error;
    }
  }

  /**
   * Valida un token de acceso específico
   */
  async validateToken(token, assetId) {
    try {
      const response = await axios.get(
        `${META_API_BASE_URL}/${assetId}`,
        {
          params: {
            fields: 'id,name',
            access_token: token
          },
          timeout: 10000
        }
      );

      return response.status === 200 && response.data.id;
      
    } catch (error) {
      console.error(`❌ Token inválido para asset ${assetId}:`, error.message);
      return false;
    }
  }

  /**
   * Job: Limpieza de datos antiguos
   */
  async executeDataCleanup() {
    console.log('🧹 Iniciando limpieza de datos antiguos...');
    
    const syncLog = await SyncLog.create({
      job_type: 'data_cleanup',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    try {
      let totalDeleted = 0;
      
      // Limpiar logs de sincronización antiguos
      const syncLogsDeleted = await this.cleanupSyncLogs();
      totalDeleted += syncLogsDeleted;
      
      // Limpiar validaciones de tokens antiguas
      const tokenValidationsDeleted = await this.cleanupTokenValidations();
      totalDeleted += tokenValidationsDeleted;
      
      // Limpiar métricas sociales muy antiguas (opcional)
      const socialStatsDeleted = await this.cleanupOldSocialStats();
      totalDeleted += socialStatsDeleted;

      // Actualizar log
      await syncLog.update({
        status: 'completed',
        end_time: new Date(),
        records_processed: totalDeleted
      });

      console.log(`✅ Limpieza completada: ${totalDeleted} registros eliminados`);
      
      return {
        status: 'completed',
        deleted: totalDeleted,
        breakdown: {
          syncLogs: syncLogsDeleted,
          tokenValidations: tokenValidationsDeleted,
          socialStats: socialStatsDeleted
        }
      };

    } catch (error) {
      await syncLog.update({
        status: 'failed',
        end_time: new Date(),
        error_message: error.message
      });

      throw error;
    }
  }

  /**
   * Limpia logs de sincronización antiguos
   */
  async cleanupSyncLogs() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.dataRetention.syncLogs);
    
    const deleted = await SyncLog.destroy({
      where: {
        created_at: { [Op.lt]: cutoffDate }
      }
    });

    console.log(`🗑️ Eliminados ${deleted} logs de sincronización antiguos (>${this.config.dataRetention.syncLogs} días)`);
    return deleted;
  }

  /**
   * Limpia validaciones de tokens antiguas
   */
  async cleanupTokenValidations() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.dataRetention.tokenValidations);
    
    const deleted = await TokenValidations.destroy({
      where: {
        validation_date: { [Op.lt]: cutoffDate }
      }
    });

    console.log(`🗑️ Eliminadas ${deleted} validaciones de tokens antiguas (>${this.config.dataRetention.tokenValidations} días)`);
    return deleted;
  }

  /**
   * Limpia métricas sociales muy antiguas
   */
  async cleanupOldSocialStats() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.dataRetention.socialStats);
    
    const deleted = await SocialStatsDaily.destroy({
      where: {
        created_at: { [Op.lt]: cutoffDate }
      }
    });

    console.log(`🗑️ Eliminadas ${deleted} métricas sociales antiguas (>${this.config.dataRetention.socialStats} días)`);
    return deleted;
  }

  /**
   * Job: Barrido funcional de automatizaciones críticas
   */
async executeAutomationHealthCheck() {
  console.log('🧭 Ejecutando barrido de salud de automatizaciones...');

  const syncLog = await SyncLog.create({
    job_type: 'automation_health_check',
    status: 'running',
    start_time: new Date(),
    records_processed: 0
  });

  const now = new Date();
  const runtimeNamespace = process.env.JOB_RUNTIME_NAMESPACE || process.env.RUNTIME_NAMESPACE || (process.env.PORT ? `port:${process.env.PORT}` : null);
  const lookbackHours = Math.max(1, parseInt(process.env.JOBS_AUTOMATION_HEALTH_LOOKBACK_HOURS || '24', 10));
  const staleRunningMinutes = Math.max(5, parseInt(process.env.JOBS_AUTOMATION_HEALTH_STALE_RUNNING_MINUTES || '30', 10));
  const overdueGraceMinutes = Math.max(5, parseInt(process.env.JOBS_AUTOMATION_HEALTH_OVERDUE_GRACE_MINUTES || '15', 10));
  const fallbackSince = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  let since = fallbackSince;
  let sinceSource = 'configured_lookback';
  let previousSweepId = null;
  const staleBefore = new Date(now.getTime() - staleRunningMinutes * 60 * 1000);
  const overdueBefore = new Date(now.getTime() - overdueGraceMinutes * 60 * 1000);
  const automationJobTypes = ['automations_v2_execute', 'appointment_automation_schedule_fire'];

  const parseReport = (value) => {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  };

  const issues = [];
  const addIssue = (issue) => {
    issues.push({
      severity: issue.severity || 'critical',
      type: issue.type,
      title: issue.title,
      detail: issue.detail,
      data: issue.data || {}
    });
  };

  const buildExecutionData = (execution) => {
    const failedLog = Array.isArray(execution.logs) ? execution.logs[0] : null;
    return {
      execution_id: execution.id,
      status: execution.status,
      clinic_id: execution.clinic_id,
      clinic_name: execution.clinic?.nombre_clinica || null,
      template_version_id: execution.template_version_id,
      template_name: execution.templateVersion?.name || null,
      template_key: execution.templateVersion?.template_key || null,
      template_version: execution.templateVersion?.version || null,
      trigger_type: execution.trigger_type,
      trigger_entity_type: execution.trigger_entity_type,
      trigger_entity_id: execution.trigger_entity_id,
      current_node_id: execution.current_node_id,
      wait_until: execution.wait_until,
      updated_at: execution.updated_at,
      last_error: execution.last_error || failedLog?.error_message || null,
      failed_node_id: failedLog?.node_id || null,
      failed_node_type: failedLog?.node_type || null
    };
  };

  const buildJobData = (job) => ({
    job_request_id: job.id,
    type: job.type,
    status: job.status,
    priority: job.priority,
    origin: job.origin,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    next_run_at: job.next_run_at,
    completed_at: job.completed_at,
    updated_at: job.updated_at,
    error_message: job.error_message,
    result_summary: job.result_summary || null,
    payload: job.payload || {}
  });

  try {
    const previousSweepCandidates = await SyncLog.findAll({
      where: {
        job_type: 'automation_health_check',
        id: { [Op.ne]: syncLog.id },
        start_time: { [Op.lt]: now }
      },
      order: [['start_time', 'DESC']],
      limit: 20
    });
    const previousSweep = previousSweepCandidates.find((candidate) => {
      const report = parseReport(candidate.status_report);
      return report.runtime_namespace && runtimeNamespace && report.runtime_namespace === runtimeNamespace;
    });
    if (previousSweep?.start_time) {
      const previousStart = new Date(previousSweep.start_time);
      if (!Number.isNaN(previousStart.getTime()) && previousStart > fallbackSince) {
        since = previousStart;
        sinceSource = 'previous_sweep';
        previousSweepId = previousSweep.id;
      }
    }

    const failedExecutions = await FlowExecutionV2.findAll({
      where: {
        status: { [Op.in]: ['failed', 'dead_letter'] },
        updated_at: { [Op.gte]: since }
      },
      include: [
        { model: AutomationFlowTemplateV2, as: 'templateVersion', attributes: ['id', 'name', 'template_key', 'version', 'trigger_type'] },
        { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica'] },
        {
          model: FlowExecutionLogV2,
          as: 'logs',
          required: false,
          separate: true,
          where: { status: 'error' },
          attributes: ['id', 'node_id', 'node_type', 'error_message', 'started_at', 'finished_at'],
          order: [['id', 'DESC']],
          limit: 1
        }
      ],
      order: [['updated_at', 'DESC']],
      limit: 50
    });

    failedExecutions.forEach((execution) => {
      const data = buildExecutionData(execution);
      addIssue({
        type: 'flow_execution_failed',
        title: `Flujo fallido: ${data.template_name || data.template_key || `#${data.template_version_id}`}`,
        detail: data.last_error || 'La ejecución quedó marcada como fallida sin detalle.',
        data
      });
    });

    const staleRunningExecutions = await FlowExecutionV2.findAll({
      where: {
        status: 'running',
        updated_at: { [Op.between]: [since, staleBefore] }
      },
      include: [
        { model: AutomationFlowTemplateV2, as: 'templateVersion', attributes: ['id', 'name', 'template_key', 'version', 'trigger_type'] },
        { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica'] }
      ],
      order: [['updated_at', 'ASC']],
      limit: 50
    });

    staleRunningExecutions.forEach((execution) => {
      const data = buildExecutionData(execution);
      addIssue({
        type: 'flow_execution_stale_running',
        title: `Ejecución atascada: ${data.template_name || data.template_key || `#${data.template_version_id}`}`,
        detail: `La ejecución sigue en running desde hace más de ${staleRunningMinutes} minutos.`,
        data
      });
    });

    const overdueWaitingExecutions = await FlowExecutionV2.findAll({
      where: {
        status: 'waiting',
        wait_until: { [Op.lt]: overdueBefore },
        updated_at: { [Op.gte]: since }
      },
      include: [
        { model: AutomationFlowTemplateV2, as: 'templateVersion', attributes: ['id', 'name', 'template_key', 'version', 'trigger_type'] },
        { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica'] }
      ],
      order: [['wait_until', 'ASC']],
      limit: 50
    });

    overdueWaitingExecutions.forEach((execution) => {
      const data = buildExecutionData(execution);
      addIssue({
        type: 'flow_execution_overdue_wait',
        title: `Espera vencida sin reanudar: ${data.template_name || data.template_key || `#${data.template_version_id}`}`,
        detail: `La ejecución debía reanudarse hace más de ${overdueGraceMinutes} minutos.`,
        data
      });
    });

    const failedJobs = await JobRequest.findAll({
      where: {
        type: { [Op.in]: automationJobTypes },
        status: 'failed',
        updated_at: { [Op.gte]: since }
      },
      order: [['updated_at', 'DESC']],
      limit: 50
    });

    failedJobs.forEach((job) => {
      const data = buildJobData(job);
      addIssue({
        type: 'automation_job_failed',
        title: `Job de automatización fallido: ${job.type}`,
        detail: job.error_message || 'La solicitud de job quedó fallida sin detalle.',
        data
      });
    });

    const overdueJobs = await JobRequest.findAll({
      where: {
        type: { [Op.in]: automationJobTypes },
        status: { [Op.in]: ['pending', 'waiting', 'running'] },
        next_run_at: { [Op.lt]: overdueBefore },
        updated_at: { [Op.gte]: since }
      },
      order: [['next_run_at', 'ASC']],
      limit: 50
    });

    overdueJobs.forEach((job) => {
      const data = buildJobData(job);
      addIssue({
        type: 'automation_job_overdue',
        title: `Job de automatización vencido: ${job.type}`,
        detail: `La solicitud debía ejecutarse hace más de ${overdueGraceMinutes} minutos y sigue en ${job.status}.`,
        data
      });
    });

    const recentScheduleJobs = await JobRequest.findAll({
      where: {
        type: 'appointment_automation_schedule_fire',
        status: 'completed',
        completed_at: { [Op.gte]: since }
      },
      order: [['completed_at', 'DESC']],
      limit: 200
    });

    recentScheduleJobs
      .filter((job) => {
        const summary = job.result_summary || {};
        return summary?.result?.reason === 'invalid_schedule' || summary?.reason === 'invalid_schedule';
      })
      .forEach((job) => {
        const data = buildJobData(job);
        addIssue({
          type: 'appointment_schedule_invalid',
          title: 'Recordatorio programado descartado por horario inválido',
          detail: 'Un job de recordatorio de cita terminó como completado, pero el motor lo descartó por invalid_schedule.',
          data
        });
      });

    const counts = issues.reduce((acc, issue) => {
      acc[issue.type] = (acc[issue.type] || 0) + 1;
      return acc;
    }, {});
    const criticalCount = issues.filter((issue) => issue.severity === 'critical').length;
    const report = {
      checked_at: now.toISOString(),
      runtime_namespace: runtimeNamespace,
      since: since.toISOString(),
      since_source: sinceSource,
      previous_sweep_id: previousSweepId,
      lookback_hours: lookbackHours,
      stale_running_minutes: staleRunningMinutes,
      overdue_grace_minutes: overdueGraceMinutes,
      issue_count: issues.length,
      critical_count: criticalCount,
      counts,
      issues: issues.slice(0, 75)
    };

    const hasCriticalIssues = criticalCount > 0;
    const errorMessage = hasCriticalIssues
      ? `Se detectaron ${criticalCount} incidencias críticas de automatizaciones.`
      : null;

    await syncLog.update({
      status: hasCriticalIssues ? 'failed' : 'completed',
      end_time: new Date(),
      records_processed: issues.length,
      error_message: errorMessage,
      status_report: report
    });

    if (hasCriticalIssues) {
      await notificationService.dispatchEvent({
        event: 'jobs.automation_health_issue',
        data: {
          jobName: 'Barrido de automatizaciones',
          error: errorMessage,
          issueCount: criticalCount,
          counts,
          firstIssue: issues[0] || null
        }
      });
      console.warn('⚠️ Barrido de automatizaciones con incidencias:', report);
      return { status: 'failed', ...report };
    }

    console.log('✅ Barrido de automatizaciones sin incidencias críticas');
    return { status: 'completed', ...report };
  } catch (error) {
    console.error('❌ Error ejecutando barrido de automatizaciones:', error);
    await syncLog.update({
      status: 'failed',
      end_time: new Date(),
      error_message: error.message,
      status_report: {
        checked_at: now.toISOString(),
        error: error.message
      }
    });
    await notificationService.dispatchEvent({
      event: 'jobs.failed',
      data: {
        jobName: 'automationHealthCheck',
        error: error.message
      }
    });
    throw error;
  }
}

  /**
 * Job: Verificación de salud del sistema
 */
async executeHealthCheck() {
  console.log('🏥 Ejecutando verificación de salud del sistema...');
  
  const syncLog = await SyncLog.create({
    job_type: 'health_check',
    status: 'running',
    start_time: new Date(),
    records_processed: 0
  });

  try {
    const healthStatus = {
      database: false,
      metaApi: false,
      activeConnections: 0,
      validTokens: 0,
      recentActivity: false
    };

    // Verificar conectividad de base de datos
    try {
      await SyncLog.findOne({ limit: 1 });
      healthStatus.database = true;
      console.log('✅ Base de datos: Conectada');
    } catch (error) {
      console.error('❌ Base de datos: Error de conexión');
      throw new Error('Database connection failed');
    }

    // Verificar conexiones activas
    try {
      const activeConnections = await MetaConnection.count({
        where: {
          accessToken: { [Op.ne]: null },
          expiresAt: { [Op.gt]: new Date() }  // No expirado
        }
      });
      healthStatus.activeConnections = activeConnections;
      console.log(`✅ Conexiones activas: ${activeConnections}`); 
    } catch (error) {
      console.error('❌ Error verificando conexiones activas:', error);
    }

    // Verificar disponibilidad de Meta API (prueba simple)
    // ✅ CORRECTO (usar token real):
    try {
      const connection = await MetaConnection.findOne({
        where: {
          accessToken: { [Op.ne]: null },
          expiresAt: { [Op.gt]: new Date() }
        }
      });

      if (connection && connection.accessToken) {
        const testResponse = await axios.get(`${META_API_BASE_URL}/me`, {
          params: { access_token: connection.accessToken },
          timeout: 5000
        });
        healthStatus.metaApi = testResponse.status === 200;
        console.log('✅ Meta API: Disponible');
      } else {
        healthStatus.metaApi = false;
        console.log('❌ Meta API: Sin tokens válidos');
      }
    } catch (error) {
      console.error('❌ Meta API: Error -', error.message);
      healthStatus.metaApi = false;
    }

    // Verificar tokens válidos
    // Verificar tokens válidos (incluir tokens de página permanentes)
try {
  // Contar tokens de página permanentes (más importantes)
  const pageTokens = await ClinicMetaAsset.count({
    where: {
      pageAccessToken: { [Op.ne]: null },
      isActive: true
    }
  });

  // Contar validaciones recientes de tokens de usuario
  const recentValidations = await TokenValidations.count({
    where: {
      status: 'valid',
      validation_date: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }
  });

  // Total de tokens válidos (página + validaciones recientes)
  const totalValidTokens = pageTokens + recentValidations;
  
  healthStatus.validTokens = totalValidTokens;
  console.log(`✅ Tokens válidos: ${totalValidTokens} (${pageTokens} de página + ${recentValidations} validaciones)`);
} catch (error) {
  console.error('❌ Error verificando tokens válidos:', error);
  healthStatus.validTokens = 0;
}

    // Verificar actividad reciente
    try {
      const recentLogs = await SyncLog.findAll({
        where: {
          created_at: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        },
        limit: 1
      });
      healthStatus.recentActivity = recentLogs.length > 0;
      console.log(`✅ Actividad reciente: ${healthStatus.recentActivity ? 'Sí' : 'No'}`);
    } catch (error) {
      console.error('❌ Error verificando actividad reciente:', error);
    }

    // ✅ CORREGIDO: Usar status_report para health status
    await syncLog.update({
      status: 'completed',
      end_time: new Date(),
      records_processed: 1,
      status_report: healthStatus  // ✅ Usar el nuevo campo
    });

    console.log('✅ Verificación de salud completada');
    
    return {
      status: 'completed',
      health: healthStatus
    };

  } catch (error) {
    console.error('❌ Error en verificación de salud:', error);
    
    // ✅ CORREGIDO: error_message solo para errores reales
    await syncLog.update({
      status: 'failed',
      end_time: new Date(),
      error_message: error.message  // ✅ Solo errores reales aquí
    });

    throw error;
  }
}

  

  /**
   * Obtiene el estado actual del sistema
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      running: this.isRunning,
      jobsCount: this.jobs.size,
      config: {
        timezone: this.config.timezone,
        autoStart: this.config.autoStart,
        schedules: this.config.schedules
      },
      jobs: Object.fromEntries(
        Array.from(this.jobs.entries()).map(([name, data]) => [
          name,
          {
            schedule: data.schedule,
            status: data.status,
            lastExecution: data.lastExecution,
            lastError: data.lastError,
            description: this.jobDescriptions[name] || ''
          }
        ])
      )
    };
  }

  /**
   * Obtiene la configuración actual
   */
  getConfiguration() {
    return {
      schedules: this.config.schedules,
      timezone: this.config.timezone,
      autoStart: this.config.autoStart,
      dataRetention: this.config.dataRetention,
      retries: this.config.retries,
      jobDescriptions: this.jobDescriptions,
      validationNotes: 'Validación: /debug_token para tokens de usuario; tokens de página permanentes se contabilizan. Retenciones y recuentos diarios en SyncLogs. Rate-limit controlado por cabeceras X-*Usage con pausa hasta la siguiente hora si se supera el umbral.'
    };
  }
  /**
   * Job: Sincronización reciente de Google Ads
   */
  async executeGoogleAdsSync(options = {}) {
    console.log('📢 Ejecutando googleAdsSync (ventana reciente)...');
    const syncLog = await SyncLog.create({
      job_type: 'google_ads_sync',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    const report = { accounts: 0, processed: 0, rows: 0, errors: [], notes: [], skipped: 0, windowDays: options.windowDays || this.config.googleAds.recentDays, dateRange: null };
    try {
      let accounts = await ClinicGoogleAdsAccount.findAll({
        where: {
          isActive: true,
          [Op.or]: [
            { managerLinkStatus: 'ACTIVE' },
            { loginCustomerId: { [Op.ne]: null } }
          ]
        },
        include: [
          { model: GoogleConnection, as: 'googleConnection' },
          { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'] }
        ]
      });

      if (Array.isArray(options.clinicIds) && options.clinicIds.length) {
        const allowedIds = options.clinicIds
          .map((id) => Number(id))
          .filter(Number.isFinite);
        accounts = accounts.filter((acc) => allowedIds.includes(Number(acc.clinicaId ?? acc.clinica?.id_clinica)));
      }

      if (Array.isArray(options.groupIds) && options.groupIds.length) {
        const allowedGroupIds = options.groupIds
          .map((id) => Number(id))
          .filter(Number.isFinite);
        if (allowedGroupIds.length) {
          accounts = accounts.filter((acc) => {
            const groupId = Number(acc.grupoClinicaId ?? acc.clinica?.grupoClinicaId);
            if (!Number.isFinite(groupId)) {
              return false;
            }
            return allowedGroupIds.includes(groupId);
          });
        }
      }

      report.accounts = accounts.length;
      if (!accounts.length) {
        await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: 0, status_report: report });
        console.log('ℹ️ googleAdsSync sin cuentas activas.');
        return { status: 'completed', ...report };
      }

      // Ventana: últimos N días hasta ayer
      const defaultEnd = new Date();
      defaultEnd.setHours(0, 0, 0, 0);
      defaultEnd.setDate(defaultEnd.getDate() - 1);

      const parsedEnd = parseDateInput(options.endDate, 'endDate') || defaultEnd;
      const parsedStart = parseDateInput(options.startDate, 'startDate');
      const customWindowDays = Number(options.windowDays || options.days);

      const usageStatus = await getGoogleAdsUsageStatus();
      if (usageStatus.pauseUntil && usageStatus.pauseUntil > Date.now()) {
        const waitSeconds = Math.ceil((usageStatus.pauseUntil - Date.now()) / 1000);
        console.warn(`⏸️ Google Ads en pausa hasta ${new Date(usageStatus.pauseUntil).toISOString()} (faltan ${waitSeconds}s)`);
        await syncLog.update({ status: 'waiting', end_time: new Date(), records_processed: 0, status_report: { ...report, waiting: true } });
        return { status: 'waiting', ...report, waiting: true };
      }

      for (const account of accounts) {
        try {
          const token = await this._getGoogleAccessToken(account.googleConnection);

          let end = new Date(parsedEnd);
          let start;
          if (parsedStart) {
            start = new Date(parsedStart);
          } else {
            let days;
            if (Number.isFinite(customWindowDays) && customWindowDays > 0) {
              days = Math.floor(customWindowDays);
            } else {
              days = report.windowDays;
            }
            days = Math.max(1, days);
            start = new Date(end);
            start.setDate(start.getDate() - (days - 1));
          }

          [start, end] = ensureAscending(start, end);
          const rangeDays = diffInDaysInclusive(start, end);
          if (rangeDays) {
            report.windowDays = rangeDays;
            report.dateRange = {
              start: start.toISOString().slice(0, 10),
              end: end.toISOString().slice(0, 10)
            };
          }

          const stats = await this._syncGoogleAdsAccount(account, {
            start,
            end,
            chunkDays: options.chunkDays || this.config.googleAds.chunkDays,
            accessToken: token,
            report
          });
          if (stats?.skipped) {
            report.skipped += 1;
            continue;
          }
          report.processed += 1;
          report.rows += stats.rows || 0;
          await ClinicGoogleAdsAccount.update({ lastSyncedAt: new Date() }, { where: { id: account.id } });

          if (this.config.googleAds.betweenAccountsSleepMs > 0) {
            await new Promise(r => setTimeout(r, this.config.googleAds.betweenAccountsSleepMs));
          }
        } catch (err) {
          const details = err?.response?.data?.error || err?.response?.data;
         if (err?.code === 'GOOGLE_ADS_QUOTA_REACHED' || err?.code === 'GOOGLE_ADS_PAUSED') {
           console.warn('⏸️ googleAdsSync detenido por cuota:', err.message);
           report.errors.push({ customerId: account.customerId, error: err.message, code: err.code, details });
            await notificationService.dispatchEvent({
              event: 'ads.sync_error',
              clinicId: account.clinicaId || account.clinica?.id_clinica || null,
              data: {
                clinicName: account.clinica?.nombre_clinica,
                accountName: account.descriptiveName,
                customerId: account.customerId,
                error: err.message,
                details
              }
            });
            await syncLog.update({ status: 'waiting', end_time: new Date(), records_processed: report.processed, status_report: { ...report, waiting: true } });
            return { status: 'waiting', ...report, waiting: true };
          }
          console.error('❌ Error en googleAdsSync para cuenta:', account.customerId, err.message, details);
          report.errors.push({ customerId: account.customerId, error: err.message, details });
          await notificationService.dispatchEvent({
            event: 'ads.sync_error',
            clinicId: account.clinicaId || account.clinica?.id_clinica || null,
            data: {
              clinicName: account.clinica?.nombre_clinica,
              accountName: account.descriptiveName,
              customerId: account.customerId,
              error: err.message,
              details
            }
          });
        }
      }

      await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: report.processed, status_report: report });
      console.log('✅ googleAdsSync completado', report);
      return { status: 'completed', ...report };
    } catch (error) {
      await syncLog.update({ status: 'failed', end_time: new Date(), error_message: error.message, status_report: report });
      console.error('❌ Error en googleAdsSync:', error);
      await notificationService.dispatchEvent({
        event: 'jobs.failed',
        data: {
          jobName: 'googleAdsSync',
          error: error.message
        }
      });
      throw error;
    }
  }

  /**
   * Job: Backfill extendido de Google Ads
   */
  async executeGoogleAdsBackfill(options = {}) {
    console.log('📢 Ejecutando googleAdsBackfill (ventana extendida)...');
    const syncLog = await SyncLog.create({
      job_type: 'google_ads_backfill',
      status: 'running',
      start_time: new Date(),
      records_processed: 0
    });

    const report = { accounts: 0, processed: 0, rows: 0, errors: [], notes: [], skipped: 0, windowDays: options.windowDays || this.config.googleAds.backfillDays, dateRange: null };
    try {
      let accounts = await ClinicGoogleAdsAccount.findAll({
        where: {
          isActive: true,
          [Op.or]: [
            { managerLinkStatus: 'ACTIVE' },
            { loginCustomerId: { [Op.ne]: null } }
          ]
        },
        include: [
          { model: GoogleConnection, as: 'googleConnection' },
          { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'] }
        ]
      });
      if (Array.isArray(options.clinicIds) && options.clinicIds.length) {
        const allowedIds = options.clinicIds.map((id) => Number(id)).filter(Number.isFinite);
        if (allowedIds.length) {
          accounts = accounts.filter((acc) => allowedIds.includes(Number(acc.clinicaId ?? acc.clinica?.id_clinica)));
        }
      }

      if (Array.isArray(options.groupIds) && options.groupIds.length) {
        const allowedGroupIds = options.groupIds.map((id) => Number(id)).filter(Number.isFinite);
        if (allowedGroupIds.length) {
          accounts = accounts.filter((acc) => {
            const groupId = Number(acc.grupoClinicaId ?? acc.clinica?.grupoClinicaId);
            if (!Number.isFinite(groupId)) {
              return false;
            }
            return allowedGroupIds.includes(groupId);
          });
        }
      }

      report.accounts = accounts.length;
      if (!accounts.length) {
        await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: 0, status_report: report });
        console.log('ℹ️ googleAdsBackfill sin cuentas activas.');
        return { status: 'completed', ...report };
      }

      const defaultEnd = new Date();
      defaultEnd.setHours(0, 0, 0, 0);
      defaultEnd.setDate(defaultEnd.getDate() - 1);

      let end = parseDateInput(options.endDate, 'endDate') || defaultEnd;
      let start = parseDateInput(options.startDate, 'startDate');
      let windowDays = Number(options.windowDays || options.days);
      if (!Number.isFinite(windowDays) || windowDays <= 0) {
        windowDays = this.config.googleAds.backfillDays;
      } else {
        windowDays = Math.floor(windowDays);
      }

      if (!start) {
        start = new Date(end);
        start.setDate(start.getDate() - (Math.max(1, windowDays) - 1));
      }

      [start, end] = ensureAscending(start, end);

      report.windowDays = diffInDaysInclusive(start, end) || report.windowDays;
      report.dateRange = {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10)
      };

      for (const account of accounts) {
        try {
          const token = await this._getGoogleAccessToken(account.googleConnection);
          const accountStart = new Date(start);
          const accountEnd = new Date(end);

          const stats = await this._syncGoogleAdsAccount(account, {
            start: accountStart,
            end: accountEnd,
            chunkDays: options.chunkDays || this.config.googleAds.chunkDays,
            accessToken: token,
            report
          });
          if (stats?.skipped) {
            report.skipped += 1;
            continue;
          }
          report.processed += 1;
          report.rows += stats.rows || 0;
          await ClinicGoogleAdsAccount.update({ lastSyncedAt: new Date() }, { where: { id: account.id } });

          if (this.config.googleAds.betweenAccountsSleepMs > 0) {
            await new Promise(r => setTimeout(r, this.config.googleAds.betweenAccountsSleepMs));
          }
        } catch (err) {
          const details = err?.response?.data?.error || err?.response?.data;
          if (err?.code === 'GOOGLE_ADS_QUOTA_REACHED' || err?.code === 'GOOGLE_ADS_PAUSED') {
            console.warn('⏸️ googleAdsBackfill detenido por cuota:', err.message);
            report.errors.push({ customerId: account.customerId, error: err.message, code: err.code, details });
            await syncLog.update({ status: 'waiting', end_time: new Date(), records_processed: report.processed, status_report: { ...report, waiting: true } });
            return { status: 'waiting', ...report, waiting: true };
          }
          console.error('❌ Error en googleAdsBackfill para cuenta:', account.customerId, err.message, details);
          report.errors.push({ customerId: account.customerId, error: err.message, details });
        }
      }

      await syncLog.update({ status: 'completed', end_time: new Date(), records_processed: report.processed, status_report: report });
      console.log('✅ googleAdsBackfill completado', report);
      return { status: 'completed', ...report };
    } catch (error) {
      await syncLog.update({ status: 'failed', end_time: new Date(), error_message: error.message, status_report: report });
      console.error('❌ Error en googleAdsBackfill:', error);
      throw error;
    }
  }

  async _getGoogleAccessToken(conn) {
    if (!conn) {
      throw new Error('No existe conexión Google asociada');
    }
    if (!conn.accessToken) {
      throw new Error('No existe access token Google almacenado');
    }
    let accessToken = conn.accessToken;
    let expiresAt = conn.expiresAt ? new Date(conn.expiresAt) : null;
    const now = Date.now();
    const threshold = now + 60_000;

    if (conn.refreshToken && (!expiresAt || expiresAt.getTime() <= threshold)) {
      try {
        const tr = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: conn.refreshToken
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const newToken = tr.data?.access_token;
        const expiresIn = tr.data?.expires_in || 3600;
        if (newToken) {
          accessToken = newToken;
          expiresAt = new Date(Date.now() + expiresIn * 1000);
          await conn.update({ accessToken, expiresAt });
        }
      } catch (err) {
        console.error('❌ Error refrescando token Google Ads:', err.message);
        throw err;
      }
    }
    return accessToken;
  }

  async _syncGoogleAdsAccount(account, { start, end, chunkDays = 7, accessToken, report }) {
    const managerId = ensureGoogleAdsConfig().managerId;
    const effectiveLoginCustomerId = normalizeCustomerId(account.loginCustomerId || account.managerCustomerId || managerId);
    if (!effectiveLoginCustomerId) {
      throw new Error(`No se puede sincronizar la cuenta ${account.customerId}: falta loginCustomerId`);
    }
    const customerId = normalizeCustomerId(account.customerId);
    const clinicId = account.clinicaId;

    const assignment = await this._buildMetaAssignmentContext(account);
    const groupId = assignment.groupId || account.grupoClinicaId || (account.clinica ? account.clinica.grupoClinicaId : null) || null;
    const defaultClinicId = assignment.mode === 'manual'
      ? (assignment.clinicaId || clinicId || null)
      : (assignment.mode === 'group-manual' ? null : (assignment.clinicaId || null));

    const metricVariants = [
      {
        name: 'extended',
        metrics: [
          'metrics.impressions',
          'metrics.clicks',
          'metrics.cost_micros',
          'metrics.conversions',
          'metrics.conversions_value',
          'metrics.ctr',
          'metrics.average_cpc',
          'metrics.average_cpm',
          'metrics.average_cost',
          'metrics.conversions_from_interactions_rate'
        ]
      },
      {
        name: 'basic',
        metrics: [
          'metrics.impressions',
          'metrics.clicks'
        ]
      }
    ];

    let variantIndex = 0;

    const resourceFields = [
      'campaign.id',
      'campaign.name',
      'campaign.status',
      'campaign.serving_status',
      'campaign.primary_status',
      'campaign.primary_status_reasons',
      'campaign.advertising_channel_type',
      'ad_group.id',
      'ad_group.name',
      'ad_group.status'
    ];
    const segmentFields = ['segments.date', 'segments.ad_network_type', 'segments.device'];

    const buildQuery = (metrics, startDate, endDate) => {
      const selectFields = [...resourceFields, ...metrics, ...segmentFields];
      const lines = selectFields.map((field, idx) => {
        const suffix = idx < selectFields.length - 1 ? ',' : '';
        return `  ${field}${suffix}`;
      });
      return [
        'SELECT',
        ...lines,
        'FROM ad_group',
        `WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`
      ].join('\n');
    };

    const isInvalidArgumentError = (err) => err?.response?.data?.error?.status === 'INVALID_ARGUMENT';

    const extractErrorMessages = (err) => {
      const messages = new Set();
      const rootMessage = err?.response?.data?.error?.message || err?.message;
      if (rootMessage) messages.add(rootMessage);
      const details = err?.response?.data?.error?.details;
      if (Array.isArray(details)) {
        for (const detail of details) {
          if (Array.isArray(detail?.errors)) {
            for (const detailError of detail.errors) {
              if (detailError?.message) {
                messages.add(detailError.message);
              }
              const fieldPath = detailError?.location?.fieldPathElements;
              if (Array.isArray(fieldPath) && fieldPath.length) {
                const last = fieldPath[fieldPath.length - 1]?.fieldName;
                if (last) {
                  messages.add(`Campo: ${last}`);
                }
              }
            }
          }
        }
      }
      return Array.from(messages);
    };

    let rows = 0;
    const dayMs = 86400000;
    let cursor = new Date(start);

    const processedCampaignDates = new Set();

    await this._syncGoogleAdsPublishingState(account, {
      accessToken,
      effectiveLoginCustomerId,
      report
    });

    while (cursor <= end) {
      const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + (chunkDays - 1) * dayMs));
      const startDate = cursor.toISOString().slice(0, 10);
      const endDate = chunkEnd.toISOString().slice(0, 10);

      let chunkProcessed = false;
      while (!chunkProcessed) {
        const activeVariant = metricVariants[variantIndex];
        const query = buildQuery(activeVariant.metrics, startDate, endDate);

        let pageToken = null;
        try {
          do {
            const resp = await googleAdsRequest('POST', `customers/${customerId}/googleAds:search`, {
              accessToken,
              loginCustomerId: effectiveLoginCustomerId,
              data: { query, pageToken }
            });
            const results = resp?.results || [];
            const nextToken = resp?.nextPageToken || resp?.next_page_token || null;
            for (const row of results) {
              const campaignId = row?.campaign?.id ? String(row.campaign.id) : null;
              const date = row?.segments?.date;
              if (campaignId && date) {
                processedCampaignDates.add(`${campaignId}:${date}`);
              }
            }
            await this._persistGoogleAdsResults({
              account,
              assignment,
              groupId,
              defaultClinicId,
              results,
              report
            });
            rows += results.length;
            pageToken = nextToken;
          } while (pageToken);

          chunkProcessed = true;
        } catch (err) {
          const detailMessages = extractErrorMessages(err);
          const managerAccountMessage = detailMessages.find(msg => /Metrics cannot be requested for a manager account/i.test(msg));
          if (managerAccountMessage) {
            const formattedId = formatCustomerId(customerId);
            const skipNote = `Cuenta ${formattedId} es un MCC. Google Ads no permite solicitar métricas directamente al manager; mapea la(s) cuenta(s) hija(s) y vuelve a ejecutar.`;
            console.warn(`⏭️ ${skipNote}`);
            if (report && Array.isArray(report.notes)) {
              report.notes.push(skipNote);
            }
            return { rows, skipped: true, skippedReason: 'manager_account' };
          }

          if (isInvalidArgumentError(err) && variantIndex < metricVariants.length - 1) {
            const fallbackVariant = metricVariants[variantIndex + 1];
            const warnMsg = `Google Ads devolvió INVALID_ARGUMENT para ${customerId} con el set '${activeVariant.name}'. Cambiando a '${fallbackVariant.name}'.${detailMessages.length ? ` Detalle: ${detailMessages.join(' | ')}` : ''}`;
            console.warn(`⚠️ ${warnMsg}`);
            if (report && Array.isArray(report.notes)) {
              report.notes.push(warnMsg);
            }
            variantIndex += 1;
            continue;
          }
          throw err;
        }
      }

      // Fallback: campañas Performance Max sin filas a nivel ad_group
      try {
        const fallbackRows = await this._fetchPerformanceMaxMetrics({
          account,
          assignment,
          groupId,
          defaultClinicId,
          accessToken,
          effectiveLoginCustomerId,
          startDate,
          endDate,
          processedCampaignDates,
          report
        });
        rows += fallbackRows;
      } catch (fallbackErr) {
        console.error('⚠️ Error en fallback Performance Max:', fallbackErr.message || fallbackErr);
        report?.notes?.push?.(`PMAX fallback ${startDate}..${endDate}: ${fallbackErr.message || fallbackErr}`);
      }

      cursor = new Date(chunkEnd.getTime() + dayMs);
    }

    return { rows, metricVariant: metricVariants[variantIndex]?.name };
  }

  async _syncGoogleAdsPublishingState(account, { accessToken, effectiveLoginCustomerId, report }) {
    const customerId = normalizeCustomerId(account.customerId);
    const query = [
      'SELECT',
      '  campaign.id,',
      '  campaign.name,',
      '  campaign.status,',
      '  campaign.serving_status,',
      '  campaign.primary_status,',
      '  campaign.primary_status_reasons',
      'FROM campaign',
      "WHERE campaign.status != 'REMOVED'"
    ].join('\n');

    let pageToken = null;
    let selectedIssue = null;
    do {
      const resp = await googleAdsRequest('POST', `customers/${customerId}/googleAds:search`, {
        accessToken,
        loginCustomerId: effectiveLoginCustomerId,
        data: { query, pageToken }
      });
      const results = resp?.results || [];
      for (const row of results) {
        const campaign = row?.campaign || {};
        const issue = evaluateGooglePublishingIssue(campaign);
        if (!issue) {
          continue;
        }
        if (!selectedIssue || issue.priority > selectedIssue.priority) {
          selectedIssue = {
            ...issue,
            campaignId: campaign.id ? String(campaign.id) : null,
            campaignName: campaign.name || null
          };
        }
      }
      pageToken = resp?.nextPageToken || resp?.next_page_token || null;
    } while (pageToken);

    await account.update({
      publishingStatus: selectedIssue?.status || null,
      publishingReason: selectedIssue?.reason || null,
      publishingReasons: selectedIssue?.reasons ? JSON.stringify(selectedIssue.reasons) : null,
      publishingCampaignId: selectedIssue?.campaignId || null,
      publishingCampaignName: selectedIssue?.campaignName || null,
      publishingSyncedAt: new Date()
    });

    if (selectedIssue && report && Array.isArray(report.notes)) {
      report.notes.push(`Google Ads publishing issue ${account.customerId}: ${selectedIssue.status}`);
    }
  }

  async _fetchPerformanceMaxMetrics({
    account,
    assignment,
    groupId,
    defaultClinicId,
    accessToken,
    effectiveLoginCustomerId,
    startDate,
    endDate,
    processedCampaignDates,
    report
  }) {
    const customerId = normalizeCustomerId(account.customerId);
    const query = [
      'SELECT',
      '  campaign.id,',
      '  campaign.name,',
      '  campaign.status,',
      '  campaign.serving_status,',
      '  campaign.primary_status,',
      '  campaign.primary_status_reasons,',
      '  campaign.advertising_channel_type,',
      '  segments.date,',
      '  metrics.impressions,',
      '  metrics.clicks,',
      '  metrics.cost_micros,',
      '  metrics.conversions,',
      '  metrics.conversions_value',
      'FROM campaign',
      "WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'",
      `  AND segments.date BETWEEN '${startDate}' AND '${endDate}'`
    ].join('\n');

    let fallbackRows = 0;
    let pageToken = null;
    do {
      const resp = await googleAdsRequest('POST', `customers/${customerId}/googleAds:search`, {
        accessToken,
        loginCustomerId: effectiveLoginCustomerId,
        data: { query, pageToken }
      });
      const results = (resp?.results || []).filter((row) => {
        const campaignId = row?.campaign?.id ? String(row.campaign.id) : null;
        const date = row?.segments?.date;
        if (!campaignId || !date) {
          return false;
        }
        const key = `${campaignId}:${date}`;
        if (processedCampaignDates.has(key)) {
          return false;
        }
        processedCampaignDates.add(key);
        return true;
      });

      if (results.length) {
        fallbackRows += results.length;
        await this._persistGoogleAdsResults({
          account,
          assignment,
          groupId,
          defaultClinicId,
          results,
          report
        });
      }

      pageToken = resp?.nextPageToken || resp?.next_page_token || null;
    } while (pageToken);

    return fallbackRows;
  }
  async _persistGoogleAdsResults({ account, assignment, groupId, defaultClinicId, results, report }) {
    if (!Array.isArray(results) || !results.length) {
      return;
    }

    const matcher = assignment && assignment.matcher ? assignment.matcher : null;
    const groupClinicaId = groupId || account.grupoClinicaId || (account.clinica ? account.clinica.grupoClinicaId : null) || null;
    const customerId = normalizeCustomerId(account.customerId);
    const campaignAssignments = new Map();
    const adGroupAssignments = new Map();
    const recordedIssues = new Set();
    const resolvedIssues = new Set();

    const recordAttributionIssue = async ({ entityLevel, entityId, campaignId = null, campaignName = null, adGroupName = null, tokens = [], candidates = [] }) => {
      if (!matcher || assignment.mode !== 'group-auto') {
        return;
      }
      const key = `${entityLevel}:${entityId}`;
      if (recordedIssues.has(key)) {
        return;
      }
      recordedIssues.add(key);

      const payload = {
        provider: 'google',
        ad_account_id: null,
        customer_id: customerId,
        entity_level: entityLevel,
        entity_id: String(entityId),
        campaign_id: campaignId ? String(campaignId) : null,
        campaign_name: campaignName || null,
        adset_name: adGroupName || null,
        detected_tokens: Array.isArray(tokens) && tokens.length ? tokens.map(t => t.raw) : null,
        match_candidates: Array.isArray(candidates) && candidates.length ? candidates.map(item => ({
          clinicId: item?.clinic?.id || null,
          clinicName: item?.clinic?.displayName || null,
          token: item?.token?.raw || null
        })) : null,
        grupo_clinica_id: groupClinicaId || null,
        clinica_id: null,
        status: 'open',
        last_seen_at: new Date()
      };

      const [issue, created] = await AdAttributionIssue.findOrCreate({
        where: {
          provider: 'google',
          entity_level: entityLevel,
          entity_id: String(entityId)
        },
        defaults: payload
      });

      if (!created) {
        await issue.update({
          ...payload,
          resolved_at: null
        });
      }
    };

    const resolveAttributionIssue = async (entityLevel, entityId, clinicaId = null) => {
      if (assignment.mode !== 'group-auto') {
        return;
      }
      const key = `${entityLevel}:${entityId}`;
      if (resolvedIssues.has(key)) {
        return;
      }
      resolvedIssues.add(key);
      await AdAttributionIssue.update({
        status: 'resolved',
        resolved_at: new Date(),
        clinica_id: clinicaId || null
      }, {
        where: {
          provider: 'google',
          entity_level: entityLevel,
          entity_id: String(entityId)
        }
      });
    };

    const getCampaignAssignment = async (campaignId, campaignName) => {
      const key = campaignId ? String(campaignId) : null;
      if (!key) {
        return { clinicaId: null, source: null, matchValue: null };
      }
      if (campaignAssignments.has(key)) {
        return campaignAssignments.get(key);
      }
      let assignmentResult = { clinicaId: null, source: null, matchValue: null };
      if (matcher && assignment.mode === 'group-auto') {
        const matchResult = matcher.matchFromText(campaignName || '', {
          level: 'campaign',
          campaignId
        });
        if (matchResult.match) {
          assignmentResult = {
            clinicaId: matchResult.match.clinic.id,
            source: 'campaign',
            matchValue: matchResult.match.token?.raw || null
          };
          await resolveAttributionIssue('campaign', key, assignmentResult.clinicaId);
        } else if ((matchResult.tokens && matchResult.tokens.length) || (matchResult.candidates && matchResult.candidates.length)) {
          await recordAttributionIssue({
            entityLevel: 'campaign',
            entityId: key,
            campaignId,
            campaignName,
            tokens: matchResult.tokens,
            candidates: matchResult.candidates
          });
        }
      }
      campaignAssignments.set(key, assignmentResult);
      return assignmentResult;
    };

    const getAdGroupAssignment = async (adGroupId, adGroupName, campaignId, campaignName) => {
      const key = adGroupId ? String(adGroupId) : null;
      if (!key) {
        return { clinicaId: null, source: null, matchValue: null };
      }
      if (adGroupAssignments.has(key)) {
        return adGroupAssignments.get(key);
      }
      let assignmentResult = { clinicaId: null, source: null, matchValue: null };
      if (matcher && assignment.mode === 'group-auto') {
        const matchResult = matcher.matchFromText(adGroupName || '', {
          level: 'ad_group',
          adGroupId,
          campaignId
        });
        if (matchResult.match) {
          assignmentResult = {
            clinicaId: matchResult.match.clinic.id,
            source: 'ad_group',
            matchValue: matchResult.match.token?.raw || null
          };
          await resolveAttributionIssue('ad_group', key, assignmentResult.clinicaId);
        } else if ((matchResult.tokens && matchResult.tokens.length) || (matchResult.candidates && matchResult.candidates.length)) {
          await recordAttributionIssue({
            entityLevel: 'ad_group',
            entityId: key,
            campaignId,
            campaignName,
            adGroupName,
            tokens: matchResult.tokens,
            candidates: matchResult.candidates
          });
        }
      }
      if (!assignmentResult.clinicaId && campaignId) {
        const campaignAssignment = await getCampaignAssignment(campaignId, campaignName);
        if (campaignAssignment && campaignAssignment.clinicaId) {
          assignmentResult = {
            clinicaId: campaignAssignment.clinicaId,
            source: campaignAssignment.source || 'campaign',
            matchValue: campaignAssignment.matchValue || null
          };
        }
      }
      adGroupAssignments.set(key, assignmentResult);
      return assignmentResult;
    };

    const decimalToMicros = (value) => {
      if (value === null || typeof value === 'undefined') return 0;
      const numeric = typeof value === 'string' ? parseFloat(value) : Number(value);
      if (!Number.isFinite(numeric)) return 0;
      return Math.round(numeric * 1_000_000);
    };

    for (const row of results) {
      const campaign = row.campaign || {};
      const adGroup = row.adGroup || row.ad_group || {};
      const metrics = row.metrics || {};
      const segments = row.segments || {};
      const date = segments.date;
      if (!date || !campaign.id) {
        continue;
      }
      const campaignId = String(campaign.id);
      const campaignName = campaign.name || null;
      const adGroupId = adGroup.id ? String(adGroup.id) : null;
      const adGroupName = adGroup.name || null;

      let targetClinicId = null;
      let matchSource = null;
      let matchValue = null;

      if (assignment.mode === 'manual') {
        targetClinicId = defaultClinicId || null;
        matchSource = targetClinicId ? 'manual' : null;
      } else if (assignment.mode === 'group-manual') {
        matchSource = 'group-manual';
      } else if (assignment.mode === 'group-auto' && matcher) {
        if (adGroupId) {
          const adGroupAssignment = await getAdGroupAssignment(adGroupId, adGroupName, campaignId, campaignName);
          if (adGroupAssignment && adGroupAssignment.clinicaId) {
            targetClinicId = adGroupAssignment.clinicaId;
            matchSource = adGroupAssignment.source || 'ad_group';
            matchValue = adGroupAssignment.matchValue || null;
          }
        }
        if (!targetClinicId) {
          const campaignAssignment = await getCampaignAssignment(campaignId, campaignName);
          if (campaignAssignment && campaignAssignment.clinicaId) {
            targetClinicId = campaignAssignment.clinicaId;
            matchSource = campaignAssignment.source || 'campaign';
            matchValue = campaignAssignment.matchValue || null;
          }
        }
      }

      if (!targetClinicId && assignment.mode === 'manual' && defaultClinicId) {
        targetClinicId = defaultClinicId;
        matchSource = 'manual';
      }

      try {
        await GoogleAdsInsightsDaily.upsert({
          clinicGoogleAdsAccountId: account.id,
          clinicaId: targetClinicId || null,
          grupoClinicaId: groupClinicaId || null,
          customerId,
          campaignId,
          campaignName,
          campaignStatus: campaign.status || null,
          campaignServingStatus: campaign.servingStatus || campaign.serving_status || null,
          campaignPrimaryStatus: campaign.primaryStatus || campaign.primary_status || null,
          campaignPrimaryStatusReasons: (() => {
            const reasons = campaign.primaryStatusReasons || campaign.primary_status_reasons || null;
            return reasons ? JSON.stringify(reasons) : null;
          })(),
          adGroupId,
          adGroupName: adGroupName || null,
          date,
          network: segments.adNetworkType || segments.ad_network_type || null,
          device: segments.device || null,
          impressions: Number(metrics.impressions || 0),
          clicks: Number(metrics.clicks || 0),
          costMicros: Number(metrics.costMicros || metrics.cost_micros || 0),
          conversions: Number(metrics.conversions || 0),
          conversionsValue: Number(metrics.conversionsValue || metrics.conversions_value || 0),
          ctr: Number(metrics.ctr || 0),
          averageCpcMicros: decimalToMicros(metrics.averageCpc || metrics.average_cpc),
          averageCpmMicros: decimalToMicros(metrics.averageCpm || metrics.average_cpm),
          averageCostMicros: decimalToMicros(metrics.averageCost || metrics.average_cost),
          conversionsFromInteractionsRate: Number(metrics.conversionsFromInteractionsRate || metrics.conversions_from_interactions_rate || 0),
          clinicMatchSource: matchSource || null,
          clinicMatchValue: matchValue || null
        });
      } catch (err) {
        console.error('❌ Error guardando fila Google Ads', {
          customerId: account.customerId,
          campaignId: campaign.id,
          adGroupId,
          date,
          error: err.message
        });
      }
    }
  }
}

// Crear instancia singleton
const metaSyncJobs = new MetaSyncJobs();

module.exports = {
  metaSyncJobs,
  MetaSyncJobs
};
