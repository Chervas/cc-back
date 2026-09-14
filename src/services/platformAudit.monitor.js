'use strict';
const { randomUUID } = require('node:crypto'); const { Op } = require('sequelize');
const { ADMIN_USER_IDS, isGlobalAdmin } = require('../lib/role-helpers');
const { safeError } = require('../../services/platform-audit/src/batch');
const { fail } = require('../../services/platform-audit/src/event');
const STATE_KEY = 'platform-v1-writer';
const METRICS = ['pending', 'reconcile', 'oldestAgeSeconds', 'unresolvedAttempts', 'oldestUnresolvedAgeSeconds'];
const ALERTS = Object.freeze({
  audit_delivery_stale: ['critical', 'La entrega de auditoría no confirma actividad desde hace más de cinco minutos.'],
  audit_delivery_not_started: ['critical', 'No consta una ejecución del worker de auditoría.'],
  audit_backlog_exceeded: ['critical', 'La cola de auditoría ha alcanzado el umbral de bloqueo de los accesos instrumentados.'],
  audit_integrity_invalid: ['critical', 'Un evento de auditoría no supera la comprobación de integridad.'],
  audit_identity_invalid: ['critical', 'La identidad del writer de auditoría no coincide con la configuración autorizada.'],
  audit_configuration_invalid: ['critical', 'La configuración de entrega de auditoría requiere revisión.'],
  audit_backlog_warning: ['warning', 'La cola de auditoría acumula eventos pendientes de confirmación.'],
  audit_unresolved_attempts: ['warning', 'Hay intentos de acceso sin resultado registrado durante más de cinco minutos.'],
  audit_reconciliation_required: ['warning', 'Hay entregas sin confirmar que requieren conciliación con el lector independiente.'],
  audit_delivery_failed: ['warning', 'La última entrega de auditoría ha registrado un fallo.'],
  audit_delivery_recovered: ['healthy', 'La entrega de auditoría vuelve a estar dentro de los umbrales operativos.'],
});
function projectHealth(value) {
  return Object.fromEntries(METRICS.map(key => {
    if (!Number.isSafeInteger(value?.[key]) || value[key] < 0) fail('audit_health_invalid');
    return [key, value[key]];
  }));
}
function iso(value) {
  if (value === null || value === undefined) return null;
  const d = new Date(value); if (!Number.isFinite(d.getTime())) fail('audit_health_invalid');
  return d.toISOString();
}
function assess(health, state, now = new Date()) {
  health = projectHealth(health);
  const started = iso(state?.last_started_at); const completed = iso(state?.last_completed_at);
  const recent = Math.max(started ? Date.parse(started) : 0, completed ? Date.parse(completed) : 0);
  let code = null;
  if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) code = 'audit_backlog_exceeded';
  else if (['audit_integrity_invalid', 'audit_identity_invalid', 'audit_configuration_invalid'].includes(state?.last_error)) code = state.last_error;
  else if (!recent) code = 'audit_delivery_not_started';
  else if (recent > now.getTime() + 60000 || now.getTime() - recent > 300000) code = 'audit_delivery_stale';
  else if (health.pending >= 1000 || health.oldestAgeSeconds >= 300) code = 'audit_backlog_warning';
  else if (health.unresolvedAttempts > 0 && health.oldestUnresolvedAgeSeconds >= 300) code = 'audit_unresolved_attempts';
  else if (health.reconcile > 0) code = 'audit_reconciliation_required';
  else if (state?.last_error) code = 'audit_delivery_failed';
  return { version: 1, checkedAt: now.toISOString(), level: code ? ALERTS[code][0] : 'healthy', code,
    health, writer: { lastStartedAt: started, lastCompletedAt: completed, lastConfirmedAt: iso(state?.last_confirmed_at),
      lastError: state?.last_error ? safeError({ code: state.last_error }) : null },
    timeZone: 'UTC', displayTimeZone: 'Europe/Madrid', externalWatchdogVerified: false };
}
function createStateRepository(models) {
  const model = models.PlatformAuditDeliveryState; const sql = models.sequelize;
  const ensure = () => model.findOrCreate({ where: { state_key: STATE_KEY }, defaults: { state_key: STATE_KEY } });
  return {
    async read() { return model.findByPk(STATE_KEY, { raw: true }); },
    async acquire(now) {
      await ensure(); const lease = randomUUID();
      const [changed] = await model.update({ lease_token: lease, lease_until: new Date(now.getTime() + 270000), last_started_at: now }, {
        where: { state_key: STATE_KEY, [Op.or]: [{ lease_until: null }, { lease_until: { [Op.lte]: now } }] } });
      return changed === 1 ? lease : null;
    },
    async finish(lease, summary, error, now, { preserveError = false } = {}) {
      const value = summary ? { ...projectHealth(summary), delivered: summary.delivered, failed: summary.failed } : null;
      if (value && (![value.delivered, value.failed].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 50))) fail('audit_health_invalid');
      const [changed] = await model.update({ lease_token: null, lease_until: null, last_completed_at: now,
        ...(!preserveError ? { last_error: error ? safeError({ code: error }) : null } : {}),
        ...(value?.delivered > 0 ? { last_confirmed_at: now } : {}), ...(value ? { summary: value } : {}) },
      { where: { state_key: STATE_KEY, lease_token: lease, lease_until: { [Op.gt]: now } } });
      return changed === 1;
    },
    async observe(health, now) {
      await ensure();
      return sql.transaction(async transaction => {
        const row = await model.findByPk(STATE_KEY, { transaction, lock: transaction.LOCK.UPDATE });
        const view = assess(health, row.get({ plain: true }), now); const previous = row.alarm_level;
        const changed = view.level !== previous || view.code !== row.alarm_code;
        let episode = row.alarm_episode;
        if (view.level !== 'healthy' && (previous === 'healthy' || !episode)) episode = randomUUID();
        if (changed && (view.level !== 'healthy' || previous !== 'healthy')) {
          const code = view.code || 'audit_delivery_recovered';
          const recipients = await models.Usuario.findAll({ where: { id_usuario: { [Op.in]: ADMIN_USER_IDS } }, attributes: ['id_usuario'], raw: true, transaction });
          if (!recipients.length) fail('audit_notification_unavailable');
          for (const user of recipients) {
            if (!isGlobalAdmin(user.id_usuario)) fail('audit_notification_unavailable');
            const dedupeKey = `audit:${episode}:${code}:${user.id_usuario}`;
            await models.Notification.findOrCreate({ where: { dedupeKey }, defaults: { dedupeKey, userId: user.id_usuario,
              role: 'admin', subrole: '', category: 'system', event: `security.${code}`,
              title: view.level === 'healthy' ? 'Entrega de auditoría recuperada' : 'Revisar entrega de auditoría',
              message: ALERTS[code][1], icon: 'heroicons_outline:shield-check', level: view.level === 'critical' ? 'error' : view.level === 'healthy' ? 'info' : 'warning',
              data: { link: '/ajustes?panel=jobs-monitoring', useRouter: true, source: 'platform_audit_monitor', code, checkedAt: view.checkedAt },
            }, transaction });
          }
        }
        await row.update({ monitor_checked_at: now, alarm_episode: view.level === 'healthy' ? null : episode,
          alarm_level: view.level, alarm_code: view.code }, { transaction });
        return view;
      });
    },
  };
}
function createMonitor({ repository, state, config = () => ({}), now = () => new Date() }) {
  return {
    async getHealth(userId) {
      if (!isGlobalAdmin(userId)) throw Object.assign(Error('technical_admin_required'), { status: 403, code: 'technical_admin_required' });
      const settings = config();
      if (!settings.captureEnabled && !settings.deliveryEnabled && !settings.monitorEnabled) return { version: 1, status: 'disabled' };
      const [health, stored] = await Promise.all([repository.health(now()), state.read()]);
      return { status: 'available', ...assess(health, stored, now()), monitorCheckedAt: iso(stored?.monitor_checked_at) };
    },
    async run() {
      if (config().monitorEnabled !== true) return { status: 'completed', skipped: true, reason: 'audit_monitor_disabled' };
      try { return { status: 'completed', monitoring: await state.observe(await repository.health(now()), now()) }; }
      catch { return { status: 'failed', retryable: false, error: 'audit_monitor_unavailable' }; }
    },
  };
}
function settings() { return { captureEnabled: process.env.PLATFORM_AUDIT_AUTH_ENABLED === 'true',
  deliveryEnabled: process.env.PLATFORM_AUDIT_DELIVERY_ENABLED === 'true', monitorEnabled: process.env.PLATFORM_AUDIT_MONITOR_ENABLED === 'true' }; }
function runtime() {
  const models = require('../../models');
  return createMonitor({ repository: require('./platformAudit.repository').createRepository(models.PlatformAuditEvent),
    state: createStateRepository(models), config: settings });
}
module.exports = { STATE_KEY, ALERTS, projectHealth, assess, createStateRepository, createMonitor,
  run: () => settings().monitorEnabled ? runtime().run() : Promise.resolve({ status: 'completed', skipped: true, reason: 'audit_monitor_disabled' }),
  getHealth: userId => {
    if (!isGlobalAdmin(userId)) return Promise.reject(Object.assign(Error('technical_admin_required'), { status: 403 }));
    const cfg = settings();
    return cfg.captureEnabled || cfg.deliveryEnabled || cfg.monitorEnabled ? runtime().getHealth(userId) : Promise.resolve({ version: 1, status: 'disabled' });
  },
};
