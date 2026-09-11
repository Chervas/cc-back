'use strict';

const { CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');
const { enqueueMetaLeadLifecycleSignal } = require('./metaLeadLifecycleJob.service');
const { rememberCommittedMetaSignals, rememberCommittedGoogleSignals } = require('./leadLifecycleConversion.service');
const { WEB_LEAD_SOURCES } = require('../lib/meta-web-attribution');

const ACTIVE_APPOINTMENTS = new Set(['pendiente', 'info_enviada', 'info_confirmada',
  'recordatorio_enviado', 'recordatorio_confirmado', 'cambio_solicitado', 'reprogramada']);
const nativeGoogle = lead => lead?.source === 'google_ads' && lead.external_source === 'google_lead_form';
const enabled = (lead, dependencies) => (WEB_LEAD_SOURCES.includes(lead?.source) || nativeGoogle(lead))
  && (dependencies.env || process.env).CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED === 'true';
const scopeChanged = () => { throw Object.assign(new Error('La cita o el interesado han cambiado. Actualiza la vista.'),
  { status: 409, code: 'meta_crm_scope_changed' }); };

async function enqueueMilestones({ lead, appointment, qualified, transaction, dependencies }) {
  const google = nativeGoogle(lead);
  const enqueue = google
    ? dependencies.enqueueGoogle || require('./googleLeadLifecycleJob.service').enqueueGoogleLeadLifecycleSignal
    : dependencies.enqueue || enqueueMetaLeadLifecycleSignal;
  const results = [];
  const occurredAt = appointment?.created_at || lead.updated_at || (dependencies.now || (() => new Date()))();
  const events = [
    ...(qualified ? [{ eventName: 'qualified_lead', eventId: `lead-${lead.id}-qualified` }] : []),
    ...(appointment ? [{ eventName: 'schedule', eventId: `appointment-${appointment.id_cita}` }] : []),
  ];
  for (const event of events) {
    const result = await enqueue({ leadId: Number(lead.id), clinicId: Number(lead.clinica_id),
      ...event, occurredAt, crmEventSource: CRM_MILESTONE_SOURCE }, { ...dependencies, transaction });
    results.push({ eventId: event.eventId, result });
  }
  // Post-commit hooks reuse the durable result without another enqueue or provider call.
  transaction.afterCommit(() => (google ? rememberCommittedGoogleSignals : rememberCommittedMetaSignals)(lead, results));
  return results;
}

async function persistLeadWithCrmSignals({ lead, changes, appointment = null, dependencies = {} }) {
  const atomic = enabled(lead, dependencies);
  const expectedClinic = Number(lead.clinica_id);
  const persist = async transaction => {
    const options = transaction ? { transaction } : undefined;
    if (transaction) {
      if (appointment) await appointment.reload({ transaction, lock: transaction.LOCK.UPDATE });
      await lead.reload({ transaction, lock: transaction.LOCK.UPDATE });
      if (Number(lead.clinica_id) !== expectedClinic) scopeChanged();
    }
    if (appointment) {
      if (Number(appointment.clinica_id) !== expectedClinic
        || appointment.lead_intake_id != null && Number(appointment.lead_intake_id) !== Number(lead.id)
        || !ACTIVE_APPOINTMENTS.has(String(appointment.estado || '').trim().toLowerCase())) scopeChanged();
      if (Number(appointment.lead_intake_id) !== Number(lead.id)) {
        await appointment.update({ lead_intake_id: lead.id,
          ...(lead.campana_id && !appointment.campana_id ? { campana_id: lead.campana_id } : {}) }, options);
      }
    }
    const previousStatus = String(lead.status_lead || '').trim().toLowerCase();
    await lead.update(changes, options);
    const qualified = !!appointment || changes.status_lead === 'cualificado' && previousStatus !== 'cualificado';
    const results = transaction && qualified
      ? await enqueueMilestones({ lead, appointment, qualified, transaction, dependencies }) : [];
    return { previousStatus, results };
  };
  if (!atomic) return persist(null);
  const models = dependencies.models || require('../../models');
  return models.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, persist);
}

async function enqueueCreatedAppointmentCrmSignals({ lead, appointment, transaction, dependencies = {} }) {
  if (!enabled(lead, dependencies)) return [];
  if (!transaction?.afterCommit) throw new Error('meta_crm_transaction_required');
  const expectedClinic = Number(lead.clinica_id);
  await lead.reload({ transaction, lock: transaction.LOCK.UPDATE });
  if (Number(lead.clinica_id) !== expectedClinic || Number(appointment.clinica_id) !== expectedClinic
    || Number(appointment.lead_intake_id) !== Number(lead.id)) scopeChanged();
  return enqueueMilestones({ lead, appointment, qualified: true, transaction, dependencies });
}

module.exports = { persistLeadWithCrmSignals, enqueueCreatedAppointmentCrmSignals };
