'use strict';

// Native production models + existing owned HTTP/SQL/job/flow/fake broker.
// The reviewed graphs/configuration below are synthetic and fixture-only.
const S = require('sequelize');
const { createOwnedVoucherVisitFixture } = require('./owned-voucher-visit-fixture');
const r = require('../../../lib/appointment-visit-runtime-contract');
async function createOwnedVisitReminderFixture(context) {
  // The production selector captures this model at load. Initialize it before
  // loading the existing fixture/runtime, not a fake selector result.
  context.models.AutomationFlowCatalog = require('../../../../models/automationflowcatalog')(context.sql, S.DataTypes);
  const f = await createOwnedVoucherVisitFixture(context), { db } = f;
  try {
    const base = await db.AutomationFlowTemplateV2.findByPk(42), reminderManifests = [];
    for (const [id, moment, whatsappId] of [[45, 'day_before', 504], [46, 'same_day', 505]]) {
      const name = 'owned_visit_reminder_' + moment, nodes = structuredClone(base.nodes);
      nodes[0].type = 'trigger/appointment_reminder_window';
      const config = { schedule_moment: moment, schedule_time_mode: moment === 'same_day' ? 'one_hour_before' : 'custom',
        custom_time: moment === 'same_day' ? null : '09:00', exclude_if_booked_day_before: false,
        exclude_if_booked_same_day: false, exclude_if_not_confirmed: false, only_if_not_confirmed: false };
      nodes[0].config = config; nodes.find(row => row.id === 'S').config.template_id = whatsappId;
      const catalog = await db.WhatsappTemplateCatalog.create({ name, family_key: name, locale: 'es', category: 'UTILITY',
        body_text: 'Recordatorio sintético ' + moment, variables: [], components: [] });
      await db.WhatsappTemplate.create({ id: whatsappId, clinic_id: 100, waba_id: '90002', name, language: 'es_ES', category: 'UTILITY',
        status: 'APPROVED', catalog_template_id: catalog.id, components: [{ type: 'BODY', text: 'Recordatorio sintético ' + moment }] });
      const template = await db.AutomationFlowTemplateV2.create({ ...base.toJSON(), id, public_id: name, template_key: name,
        name, trigger_type: 'appointment_reminder_window', trigger_config: config, nodes });
      reminderManifests.push({ clinic_id: 100, template_version_id: id, graph_sha256: r.graphHash(template),
        stages: [{ key: 'attendance_' + moment, node_ids: ['S'] }], mutations: [] });
    }
    const original = f.manifests(), managedModule = require('../../../services/appointmentVisitManaged.service');
    let registered = [...original, ...reminderManifests], enabled = true, clock = '2030-01-01T12:00:00Z', managed;
    const build = () => managedModule.createAppointmentVisitManagedService({ db, now: () => new Date(clock), enabled: () => enabled,
      manifests: () => registered, namespace: () => 'visit_fixture', foundation: f.foundation,
      notifyJob: async id => f.publication.push(id), resolveBirthTemplate: row => f.runtime.resolveTemplateForCitaEvent(row, 'appointment_created') });
    managed = build(); f.clock(clock);
    require.cache[require.resolve('../../../services/appointmentVisitManaged.service')].exports = { ...managedModule, current: () => managed };
    f.scheduler.setExternalDispatcher(async () => 0); // Existing tick discovers; tests own exact job claims manually.
    const refreshRegistry = async () => {
      registered = await Promise.all(registered.map(async entry => {
        const template = await db.AutomationFlowTemplateV2.findByPk(entry.template_version_id);
        return { ...entry, graph_sha256: r.graphHash(template) };
      }));
    };
    return { ...f, get managed() { return managed; },
      registry: value => { registered = value; }, manifests: () => registered,
      restoreRegistry: () => { registered = [...original, ...reminderManifests]; }, refreshRegistry,
      clock: value => { clock = value; f.clock(value); }, enable: value => { enabled = value; f.enable(value); },
      restartManaged: () => { managed = build(); }, tick: () => f.scheduler._handleCriticalTick(),
      close: async () => { f.scheduler.setExternalDispatcher(null); await f.close(); } };
  } catch (error) { await f.close(); throw error; }
}
module.exports = { createOwnedVisitReminderFixture };
