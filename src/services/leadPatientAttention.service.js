'use strict';

const { Op } = require('sequelize');
const { TEMPORARY_FOCUSED_ACCOUNT, TEMPORARY_DIRECTOR_CLINICS } = require('../lib/temporary-quickchat-focus');
const KEY = 'lead_patient_attention_v1';
const plain = row => row?.get ? row.get({ plain: true }) : row;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const closed = lead => !!lead.archived_at || ['acudio_cita', 'convertido', 'descartado'].includes(lead.status_lead);
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const reviewable = context => ['existing_patient', 'possible_patient'].includes(context?.relationship);

function createLeadPatientAttentionService(db, dependencies = {}) {
  const contexts = () => dependencies.contexts || require('./leadPatientContext.service').createLeadPatientContextService(db);
  const now = dependencies.now || (() => new Date());
  const authorize = dependencies.authorize || (async (actorId, clinicId) => {
    const { canUserAccessFeature } = require('../lib/access-policy');
    return await canUserAccessFeature({ actorId, clinicId, featureKey: 'leads.manage' })
      && await canUserAccessFeature({ actorId, clinicId, featureKey: 'leads.sensitive.view' });
  });
  const isAdmin = dependencies.isAdmin || require('../lib/role-helpers').isGlobalAdmin;

  async function decisions(leadIds, { transaction = null } = {}) {
    if (!leadIds.length || !db.LeadAttributionAudit) return new Map();
    const rows = await db.LeadAttributionAudit.findAll({
      where: { lead_intake_id: { [Op.in]: leadIds } },
      attributes: ['id', 'lead_intake_id', 'attribution_steps'],
      order: [['id', 'DESC']], transaction, raw: true,
    });
    const result = new Map();
    for (const raw of rows) {
      const row = plain(raw), decision = row.attribution_steps?.[KEY];
      if (row.attribution_steps?.type === KEY && decision?.version === 1
          && ['director', 'clinic'].includes(decision.decision)
          && ['commercial', 'patient_care'].includes(decision.request_kind)
          && !result.has(Number(row.lead_intake_id))) {
        result.set(Number(row.lead_intake_id), decision);
      }
    }
    return result;
  }

  async function directorFor(lead, { transaction = null } = {}) {
    const clinicId = Number(lead.clinica_id);
    const setting = db.PatientDirectionSetting && plain(await db.PatientDirectionSetting.findOne({
      where: { clinic_id: clinicId, is_enabled: true }, transaction,
    }));
    const temporary = !setting && TEMPORARY_DIRECTOR_CLINICS.includes(clinicId);
    const id = setting?.director_user_id || (temporary ? TEMPORARY_FOCUSED_ACCOUNT.userId : null);
    if (!positive(id) || !db.Usuario) return null;
    const user = plain(await db.Usuario.findByPk(id, {
      attributes: ['id_usuario', 'nombre', 'email_usuario'], transaction,
    }));
    if (!user || temporary && String(user.email_usuario || '').toLowerCase() !== TEMPORARY_FOCUSED_ACCOUNT.email) return null;
    return { id: Number(id), name: user.nombre || 'Director de pacientes', temporary,
      successorId: Number(setting?.default_successor_user_id) || null };
  }

  async function completedRequests(leads, transaction) {
    const byId = new Map(leads.map(lead => [Number(lead.id), Number(lead.clinica_id)]));
    const ids = [...byId.keys()].filter(positive), completed = new Set();
    if (!ids.length) return completed;
    if (db.Message) {
      const events = await db.Message.findAll({ where: { message_type: 'event',
        'metadata.source': 'temporary_patient_direction',
        'metadata.kind': 'temporary_patient_direction_handoff',
        'metadata.lead_intake_id': { [Op.in]: ids },
      }, attributes: ['metadata'], raw: true, transaction });
      for (const event of events) {
        const data = plain(event).metadata;
        if (data?.source === 'temporary_patient_direction' && data.kind === 'temporary_patient_direction_handoff'
          && positive(data.lead_intake_id) && Number(data.clinic_id) === byId.get(Number(data.lead_intake_id))) {
          completed.add(Number(data.lead_intake_id));
        }
      }
    }
    if (db.PatientDirectionAssignment) {
      const assignments = await db.PatientDirectionAssignment.findAll({ where: {
        lead_intake_id: { [Op.in]: ids }, end_reason: 'first_appointment_attended',
        status: { [Op.in]: ['handoff_pending', 'handed_off', 'ended_attended'] },
      }, attributes: ['lead_intake_id', 'clinic_id'], raw: true, transaction });
      for (const row of assignments) if (Number(row.clinic_id) === byId.get(Number(row.lead_intake_id))) {
        completed.add(Number(row.lead_intake_id));
      }
    }
    return completed;
  }

  async function enrich(leads, { actorId = null, transaction = null } = {}) {
    const rows = leads.map(plain);
    const chosen = await decisions(rows.map(row => Number(row.id)).filter(positive), { transaction });
    const completed = await completedRequests(rows, transaction);
    const contacts = db.LeadContactAttempt ? await db.LeadContactAttempt.findAll({
      where: { lead_intake_id: { [Op.in]: rows.map(row => Number(row.id)) } },
      attributes: ['lead_intake_id', 'usuario_id'], raw: true, transaction,
    }) : [];
    const directors = new Map(), permissions = new Map();
    const result = [];
    for (const lead of rows) {
      const context = lead.patient_context || await contexts().get(lead, { transaction });
      const clinicId = Number(lead.clinica_id);
      if (!directors.has(clinicId)) directors.set(clinicId, await directorFor(lead, { transaction }));
      const director = directors.get(clinicId), decision = chosen.get(Number(lead.id));
      const finished = closed(lead) || completed.has(Number(lead.id));
      let state = finished ? 'completed' : decision?.decision || (reviewable(context) && director ? 'pending_review'
        : director && Number(lead.asignado_a) === director.id ? 'director' : 'unassigned');
      const otherOwner = positive(lead.asignado_a) && Number(lead.asignado_a) !== director?.id
        || !decision && contacts.some(row => Number(row.lead_intake_id) === Number(lead.id)
          && positive(row.usuario_id) && Number(row.usuario_id) !== director?.id);
      if (otherOwner && !decision && !finished) state = 'clinic';
      if (!permissions.has(clinicId)) permissions.set(clinicId, positive(actorId) && director
        && (Number(actorId) === director.id || isAdmin(actorId)) && await authorize(actorId, clinicId));
      const canDecide = !!permissions.get(clinicId) && reviewable(context) && !finished && !otherOwner && state !== 'clinic';
      result.push({ ...lead, patient_context: context, patient_attention: {
        state, request_kind: decision?.request_kind || context?.request_kind || 'commercial',
        director_user_id: director?.id || null, director_name: director?.name || null,
        is_director: Number(actorId) === director?.id, can_decide: canDecide,
        decided_at: decision?.decided_at || null,
      } });
    }
    return result;
  }

  async function decide({ leadId, actorId, decision, requestKind = 'commercial' }) {
    if (!positive(leadId) || !positive(actorId) || !['director', 'clinic'].includes(decision)
      || !['commercial', 'patient_care'].includes(requestKind)) throw failure(400, 'patient_attention_invalid');
    const observed = plain(await db.LeadIntake.findByPk(leadId));
    if (!observed) throw failure(404, 'lead_not_found');
    if (!await authorize(actorId, observed.clinica_id)) throw failure(403, 'lead_manage_forbidden');
    const changed = await db.sequelize.transaction(async transaction => {
      // Same lock order as canonical attention: conversation before lead. No outbound/provider operation.
      const conversations = db.Conversation ? await db.Conversation.findAll({
        where: { clinic_id: observed.clinica_id, lead_id: Number(leadId) },
        order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE,
      }) : [];
      const instance = await db.LeadIntake.findByPk(leadId, { transaction, lock: transaction.LOCK.UPDATE });
      const lead = plain(instance);
      if (!lead || Number(lead.clinica_id) !== Number(observed.clinica_id)) throw failure(409, 'patient_attention_scope_changed');
      const director = await directorFor(lead, { transaction });
      if (!director || !(Number(actorId) === director.id || isAdmin(actorId))) throw failure(403, 'patient_attention_director_required');
      const previous = (await decisions([Number(leadId)], { transaction })).get(Number(leadId));
      if (previous?.decision === decision && previous.request_kind === requestKind) return { changed: false, clinicId: lead.clinica_id, conversations };
      if (previous?.decision === 'clinic' || closed(lead)
        || (await completedRequests([lead], transaction)).has(Number(leadId))) throw failure(409, 'patient_attention_already_resolved');
      if (positive(lead.asignado_a) && Number(lead.asignado_a) !== director.id) throw failure(409, 'patient_attention_other_owner');
      if (conversations.some(row => positive(row.assignee_id) && Number(row.assignee_id) !== director.id)) {
        throw failure(409, 'patient_attention_other_owner');
      }
      if (!previous && db.LeadContactAttempt && await db.LeadContactAttempt.findOne({ where: {
        lead_intake_id: Number(leadId), usuario_id: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: director.id }] },
      }, attributes: ['id'], transaction })) throw failure(409, 'patient_attention_other_owner');
      const context = await contexts().capture(lead, { transaction });
      if (!reviewable(context)) throw failure(409, 'patient_attention_no_patient_match');
      const record = { version: 1, decision, request_kind: requestKind, director_user_id: director.id,
        actor_user_id: Number(actorId), decided_at: now().toISOString(), clinic_id: Number(lead.clinica_id) };
      await db.LeadAttributionAudit.create({ lead_intake_id: Number(leadId), raw_payload: {},
        attribution_steps: { type: KEY, [KEY]: record } }, { transaction });
      await instance.update({ asignado_a: decision === 'director' ? director.id : director.successorId }, { transaction });

      if (decision === 'director' && !director.temporary && dependencies.activateFormal !== false) {
        const activate = dependencies.activateFormal || require('./patientDirection.service').ensureAssignment;
        await activate({ clinicId: lead.clinica_id, phone: lead.telefono, leadId: lead.id,
          conversationId: conversations[0]?.id || null,
          patientId: context.relationship === 'existing_patient' ? context.patient_id : null,
          startReason: 'existing_patient_request_accepted',
          actorUserId: actorId, requireNoHumanContact: false, transaction });
      }

      if (decision === 'clinic' && db.PatientDirectionAssignment) {
        const assignments = await db.PatientDirectionAssignment.findAll({ where: {
          clinic_id: lead.clinica_id, lead_intake_id: Number(leadId), director_user_id: director.id,
          status: { [Op.in]: ['active', 'unassigned'] },
        }, transaction, lock: transaction.LOCK.UPDATE });
        for (const assignment of assignments) {
          await assignment.update({ status: 'handed_off', active_phone_key: null,
            ended_at: now(), ended_by: actorId, end_reason: 'patient_request_transferred',
            handoff_state: 'not_required', old_number_notice_state: 'not_required',
          }, { transaction });
          if (db.PatientDirectionEvent) await db.PatientDirectionEvent.create({ assignment_id: assignment.id,
            clinic_id: lead.clinica_id, event_type: 'request_transferred_to_clinic', actor_user_id: actorId,
            payload: { lead_id: Number(leadId), internal_transfer: true } }, { transaction });
        }
      }
      for (const row of conversations) {
        const conversation = plain(row);
        if (!db.Message) continue;
        const key = `lead-patient-attention:${leadId}:${decision}:${requestKind}`;
        const duplicate = await db.Message.findOne({ where: { automation_delivery_key: key }, transaction });
        if (!duplicate) await db.Message.create({ conversation_id: conversation.id, sender_id: null,
          direction: 'outbound', message_type: 'event', status: 'sent', sent_at: now(), automation_delivery_key: key,
          content: decision === 'clinic' ? 'Esta solicitud pasa a ser atendida por el equipo de la clínica.'
            : `Esta solicitud será atendida por ${director.name} hasta que acuda a la cita vinculada.`,
          metadata: { source: KEY, kind: 'lead_patient_attention_decided', lead_id: Number(leadId), ...record },
        }, { transaction });
      }
      return { changed: true, clinicId: lead.clinica_id, groupId: lead.grupo_clinica_id || null, conversations };
    });
    if (changed.changed) {
      try { await dependencies.invalidateReports?.({ clinicId: changed.clinicId, groupId: changed.groupId }); }
      catch (error) { console.warn('[lead-patient-attention] report_cache_invalidation_failed'); }
      // Durable decision is already committed. Invalidating the UI cannot roll it back.
      try { await dependencies.notify?.({ leadId: Number(leadId), clinicId: changed.clinicId,
        conversationIds: changed.conversations.map(row => Number(row.id)) }); } catch { /* next read reconciles */ }
    }
    return changed;
  }

  return { decisions, directorFor, enrich, decide };
}

let instance;
function service() {
  if (!instance) instance = createLeadPatientAttentionService(require('../../models'), {
    invalidateReports: scope => require('./marketingReportOverviewCache.service').invalidateOverviewCacheForScope(scope),
    notify: ({ leadId, clinicId, conversationIds }) => {
      const io = require('./socket.service').getIO();
      for (const id of conversationIds) io?.to(`clinic:${clinicId}`).emit('conversation:updated', { id, clinic_id: clinicId, realtime_refresh: true });
      io?.to(`clinic:${clinicId}`).emit('lead:updated', { id: leadId, clinic_id: clinicId });
    },
  });
  return instance;
}
module.exports = { KEY, reviewable, createLeadPatientAttentionService,
  enrich: (...args) => service().enrich(...args), decide: (...args) => service().decide(...args),
  decisions: (...args) => service().decisions(...args) };
