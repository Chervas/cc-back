'use strict';
const { Op } = require('sequelize');
const { MAX_CLINICS, positive } = require('../../services/platform-audit/src/realtime-contract');
const PATIENT = ['quickchat.read_patients', 'patients.sensitive.view'];
const LEAD = ['quickchat.read_leads', 'leads.sensitive.view'];
function createPolicy({ models, canAccess, isAdmin }) {
  const db = () => typeof models === 'function' ? models() : models;
  async function context(actorId) {
    const admin = isAdmin(actorId);
    const memberships = await db().UsuarioClinica.findAll({ where: { id_usuario: actorId,
      [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }] },
    attributes: ['id_clinica', 'rol_clinica'], raw: true, limit: MAX_CLINICS + 1 });
    const profile = await db().PatientDirectionProfile.findOne({ where: { user_id: actorId, is_active: true }, attributes: ['user_id'], raw: true });
    const directed = profile ? await db().PatientDirectionSetting.findAll({ where: { director_user_id: actorId }, attributes: ['clinic_id'], raw: true, limit: MAX_CLINICS + 1 }) : [];
    const clinics = admin ? await db().Clinica.findAll({ attributes: ['id_clinica'], raw: true, limit: MAX_CLINICS + 1 }) : [];
    const ids = [...new Set([...memberships.map(v => v.id_clinica), ...directed.map(v => v.clinic_id), ...clinics.map(v => v.id_clinica)].filter(positive).map(Number))].sort((a,b) => a-b);
    if (ids.length > MAX_CLINICS) throw Error('realtime_scope_limit');
    return { clinicIds: ids, aggregate: admin || !!profile || memberships.some(v => ['propietario', 'admin'].includes(String(v.rol_clinica).toLowerCase())) };
  }
  async function subscription(actorId, requested) {
    if (!Array.isArray(requested) || requested.length > MAX_CLINICS || requested.some(v => !positive(v))) return { allowed: false, invalid: true, clinicIds: [] };
    const current = await context(actorId); const ids = [...new Set(requested.map(Number))];
    // An explicit denied selection must never fall back to every allowed clinic.
    if (ids.some(id => !current.clinicIds.includes(id))) return { allowed: false, clinicIds: [] };
    return { allowed: true, clinicIds: ids.length ? ids : current.aggregate ? current.clinicIds : [] };
  }
  async function scopeFor(clinicId, groupId) {
    if (positive(clinicId)) {
      const clinic = await db().Clinica.findByPk(Number(clinicId), { attributes: ['id_clinica'], raw: true });
      if (clinic) return { scope: { type: 'clinic', id: String(clinicId) }, clinicIds: [Number(clinicId)] };
    } else if (positive(groupId)) {
      const clinics = await db().Clinica.findAll({ where: { grupoClinicaId: Number(groupId) }, attributes: ['id_clinica'], raw: true, limit: MAX_CLINICS + 1 });
      if (clinics.length && clinics.length <= MAX_CLINICS) return { scope: { type: 'group', id: String(groupId) }, clinicIds: clinics.map(v => Number(v.id_clinica)).sort((a,b)=>a-b) };
    }
    return null;
  }
  async function resolve(packet) {
    const id = Number(packet.resource.id); const type = packet.resource.type; let row, location, features;
    if (type === 'conversation') {
      row = await db().Conversation.findByPk(id, { attributes: ['id', 'clinic_id', 'channel', 'patient_id'], raw: true });
      if (!row) return null;
      features = row.channel === 'internal' ? ['quickchat.read_team'] : row.patient_id ? PATIENT : LEAD;
      location = await scopeFor(row.clinic_id);
    } else if (type === 'lead') {
      row = await db().LeadIntake.findByPk(id, { attributes: ['id', 'clinica_id', 'grupo_clinica_id'], raw: true });
      if (!row) return null;
      features = LEAD; location = await scopeFor(row.clinica_id, row.grupo_clinica_id);
    } else if (type === 'execution') {
      row = await db().FlowExecutionV2.findByPk(id, { attributes: ['id', 'clinic_id', 'group_id'], raw: true });
      if (!row) return null;
      features = ['marketing', 'patients.sensitive.view', 'leads.sensitive.view']; location = await scopeFor(row.clinic_id, row.group_id);
    } else if (type === 'appointment') {
      row = await db().CitaPaciente.findByPk(id, { attributes: ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id'], raw: true });
      // Deleted rows have no authoritative lookup: only a content-free invalidation is emitted.
      if (!row && packet.event === 'appointment:deleted' && positive(packet.body.clinic_id)) {
        row = { clinica_id: packet.body.clinic_id }; packet.body = { appointment_id: id, clinic_id: Number(row.clinica_id) };
      }
      if (!row) return null;
      features = ['appointments.view', 'patients.sensitive.view', 'leads.sensitive.view']; location = await scopeFor(row.clinica_id);
    } else if (type === 'notification') {
      row = await db().Notification.findByPk(id, { attributes: ['id', 'userId', 'clinicaId', 'data'], raw: true });
      if (!row) return null;
      features = ['patients.sensitive.view', 'leads.sensitive.view'];
      location = row.clinicaId ? await scopeFor(row.clinicaId) : { scope: { type: 'platform', id: null }, clinicIds: [] };
      if (row.data?.quickChatConversationId) {
        if (!positive(row.data.quickChatConversationId)) return null;
        const related = await resolve({ resource: { type: 'conversation', id: String(row.data.quickChatConversationId) } });
        if (!related || row.clinicaId && !related.clinicIds.includes(Number(row.clinicaId))) return null;
        location = { scope: related.scope, clinicIds: related.clinicIds }; features = related.features;
      }
    }
    if (!location) return null;
    // Reject producer scope mismatches. Rooms and payload hints never expand a DB scope.
    if (positive(packet.body?.clinic_id) && !location.clinicIds.includes(Number(packet.body.clinic_id))) return null;
    return { ...location, features, ownerId: type === 'notification' ? Number(row.userId) : null };
  }
  async function authorize(actorId, descriptor) {
    if (!descriptor || descriptor.ownerId && descriptor.ownerId !== actorId) return false;
    for (const clinicId of descriptor.clinicIds) {
      for (const featureKey of descriptor.features) if (!await canAccess({ actorId, clinicId, featureKey })) return false;
    }
    return true;
  }
  return { context, subscription, resolve, authorize };
}
let policy;
function current() { return policy ||= createPolicy({ models: () => require('../../models'),
  canAccess: input => require('../lib/access-policy').canUserAccessFeature(input), isAdmin: id => require('../lib/role-helpers').isGlobalAdmin(id) }); }
module.exports = { createPolicy, subscription: (...a) => current().subscription(...a), resolve: (...a) => current().resolve(...a), authorize: (...a) => current().authorize(...a) };
