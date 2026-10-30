'use strict';

const { Op, fn, col, where, literal, json } = require('sequelize');
const { LEAD_PATIENT_CONTEXT_TYPE, LEAD_PATIENT_ATTENTION_TYPE, plain, positiveId, jsonObject,
  normalizeContextPhone, normalizeContextEmail, unknownContext, readContextSnapshot, readAttentionKind,
  classifyLeadPatientContext, leadPatientContextSql } = require('../lib/lead-patient-context');

const BATCH_SIZE = 100;
const CANDIDATE_LIMIT = 500;
const APPOINTMENT_LIMIT = 5000;
const LEAD_FIELDS = ['id', 'clinica_id', 'grupo_clinica_id', 'created_at', 'telefono', 'email', 'nombre'];

/** No model registry, config, jobs or providers are loaded by this factory. */
function createLeadPatientContextService(db, { logger = console } = {}) {
  if (!db?.LeadAttributionAudit || !db?.LeadIntake) throw Error('lead_patient_context_models_required');
  const sequelize = db.sequelize || db.LeadIntake.sequelize;

  async function readAudits(ids, transaction, lock = false) {
    if (!ids.length) return new Map();
    const rows = await db.LeadAttributionAudit.findAll({ where: {
      lead_intake_id: { [Op.in]: ids },
      [Op.and]: [where(json('attribution_steps.type'), {
        [Op.in]: [LEAD_PATIENT_CONTEXT_TYPE, LEAD_PATIENT_ATTENTION_TYPE],
      })],
    }, attributes: ['id', 'lead_intake_id', [json('attribution_steps.type'), 'context_type'],
      [json(`attribution_steps.${LEAD_PATIENT_CONTEXT_TYPE}`), 'context_snapshot'],
      [json(`attribution_steps.${LEAD_PATIENT_ATTENTION_TYPE}`), 'attention']],
    order: [['id', 'ASC']], raw: true, transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    const result = new Map(ids.map(id => [id, { hasSnapshot: false, snapshot: null, attentions: [] }]));
    for (const row of rows) {
      const entry = result.get(positiveId(row.lead_intake_id));
      if (!entry) continue;
      // Also accepts ordinary model-shaped rows, useful for adapters and offline tests.
      const steps = jsonObject(row.attribution_steps);
      const type = row.context_type || steps?.type;
      if (type === LEAD_PATIENT_CONTEXT_TYPE && !entry.hasSnapshot) {
        entry.hasSnapshot = true;
        entry.snapshot = readContextSnapshot(row.context_snapshot ?? steps?.[LEAD_PATIENT_CONTEXT_TYPE])
          || unknownContext('snapshot_invalid', null, true);
      }
      const attention = jsonObject(row.attention ?? steps?.[LEAD_PATIENT_ATTENTION_TYPE]);
      if (type === LEAD_PATIENT_ATTENTION_TYPE && readAttentionKind(attention)) entry.attentions.push(attention);
    }
    return result;
  }

  function project(context, audit, lead) {
    const attention = [...(audit?.attentions || [])].reverse().find(row => row.clinic_id == null
      || positiveId(row.clinic_id) && positiveId(row.clinic_id) === positiveId(lead.clinica_id));
    return { ...context, ...(attention ? { request_kind: attention.request_kind } : {}) };
  }

  async function loadEvidence(leads, transaction) {
    const clinicIds = [...new Set(leads.map(lead => positiveId(lead.clinica_id)).filter(Boolean))];
    const groupIds = [...new Set(leads.map(lead => positiveId(lead.grupo_clinica_id)).filter(Boolean))];
    const scopeWhere = [];
    if (clinicIds.length) scopeWhere.push({ id_clinica: { [Op.in]: clinicIds } });
    if (groupIds.length) scopeWhere.push({ grupoClinicaId: { [Op.in]: groupIds } });
    const clinics = new Map();
    if (scopeWhere.length) {
      const rows = await db.Clinica.findAll({ where: { [Op.or]: scopeWhere },
        attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'], raw: true, transaction });
      rows.forEach(row => clinics.set(positiveId(row.id_clinica), row));
      const missingGroups = [...new Set(rows.filter(row => clinicIds.includes(positiveId(row.id_clinica)))
        .map(row => positiveId(row.grupoClinicaId)).filter(id => id && !groupIds.includes(id)))];
      if (missingGroups.length) {
        const siblings = await db.Clinica.findAll({ where: { grupoClinicaId: { [Op.in]: missingGroups } },
          attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'], raw: true, transaction });
        siblings.forEach(row => clinics.set(positiveId(row.id_clinica), row));
      }
    }
    const scopes = new Map();
    for (const lead of leads) {
      const clinic = clinics.get(positiveId(lead.clinica_id));
      const claimedGroup = positiveId(lead.grupo_clinica_id);
      const group = clinic ? positiveId(clinic.grupoClinicaId) : claimedGroup;
      const mismatch = positiveId(lead.clinica_id) && (!clinic || claimedGroup && claimedGroup !== group);
      scopes.set(positiveId(lead.id), mismatch ? [] : [...clinics.values()]
        .filter(row => positiveId(row.id_clinica) === positiveId(lead.clinica_id)
          || group && positiveId(row.grupoClinicaId) === group).map(row => positiveId(row.id_clinica)));
    }
    const evidence = { clinics, scopes, patients: [], relations: [], appointments: [], acquisitions: [], truncated: false };
    const scopeIds = [...new Set([...scopes.values()].flat())];
    const phones = [...new Set(leads.map(lead => normalizeContextPhone(lead.telefono)).filter(Boolean))];
    const emails = [...new Set(leads.map(lead => normalizeContextEmail(lead.email)).filter(Boolean))];
    const contacts = [];
    if (phones.length) {
      const values = [...new Set(phones.flatMap(phone => [phone, `00${phone}`,
        ...(/^34\d{9}$/.test(phone) ? [phone.slice(2)] : [])]))];
      for (const column of ['telefono_movil', 'telefono_secundario']) {
        let expression = col(`Paciente.${column}`);
        for (const char of [' ', '+', '-', '(', ')', '.', '/']) expression = fn('REPLACE', expression, char, '');
        contacts.push(where(expression, { [Op.in]: values }));
      }
    }
    if (emails.length) contacts.push(where(fn('LOWER', fn('TRIM', col('Paciente.email'))), { [Op.in]: emails }));
    if (!scopeIds.length || !contacts.length) return evidence;
    // IDs come only from validated positive database integers, never SQL/request text.
    const linkedScope = literal(`EXISTS (SELECT 1 FROM \`PacienteClinicas\` AS \`lpc_link\` WHERE \`lpc_link\`.\`paciente_id\` = \`Paciente\`.\`id_paciente\` AND \`lpc_link\`.\`clinica_id\` IN (${scopeIds.join(',')}))`);
    evidence.patients = (await db.Paciente.findAll({ where: { [Op.and]: [
      { [Op.or]: contacts }, { [Op.or]: [{ clinica_id: { [Op.in]: scopeIds } }, linkedScope] },
    ] }, attributes: ['id_paciente', 'clinica_id', 'telefono_movil', 'telefono_secundario', 'email', 'createdAt', 'nombre', 'apellidos'],
    include: [{ model: db.PacienteClinica, as: 'clinicasVinculadas', required: false,
      attributes: ['clinica_id', 'createdAt'] }], order: [['id_paciente', 'ASC']], limit: CANDIDATE_LIMIT + 1,
    transaction })).map(plain);
    if (evidence.patients.length > CANDIDATE_LIMIT) { evidence.truncated = true; return evidence; }
    const patientIds = evidence.patients.map(row => positiveId(row.id_paciente)).filter(Boolean);
    if (!patientIds.length) return evidence;
    evidence.relations = await db.PacienteRelacion.findAll({ where: { [Op.and]: [
      { [Op.or]: [{ id_paciente: { [Op.in]: patientIds } }, { id_paciente_relacionado: { [Op.in]: patientIds } }] },
      { [Op.or]: [{ es_contacto_principal: true }, { tipo_relacion: { [Op.in]: ['padre', 'madre', 'tutor_legal', 'hijo'] } }] },
    ] }, attributes: ['id_paciente', 'id_paciente_relacionado', 'fecha_inicio', 'fecha_fin'], raw: true, transaction });
    evidence.appointments = await db.CitaPaciente.findAll({ where: {
      paciente_id: { [Op.in]: patientIds }, clinica_id: { [Op.in]: scopeIds },
    }, attributes: ['id_cita', 'paciente_id', 'clinica_id', 'lead_intake_id', 'estado', 'inicio',
      'created_at', 'updated_at', 'arrived_at', 'care_started_at', 'care_completed_at'],
    order: [['id_cita', 'ASC']], limit: APPOINTMENT_LIMIT + 1, raw: true, transaction });
    if (evidence.appointments.length > APPOINTMENT_LIMIT) { evidence.truncated = true; return evidence; }
    const conversations = await db.Conversation.findAll({ where: { patient_id: { [Op.in]: patientIds },
      clinic_id: { [Op.in]: scopeIds }, lead_id: { [Op.ne]: null } },
    attributes: ['patient_id', 'clinic_id', 'lead_id'], raw: true, transaction, limit: APPOINTMENT_LIMIT + 1 });
    if (conversations.length > APPOINTMENT_LIMIT) { evidence.truncated = true; return evidence; }
    const links = [...conversations, ...evidence.appointments.map(row => ({ patient_id: row.paciente_id,
      clinic_id: row.clinica_id, lead_id: row.lead_intake_id }))];
    const linkedIds = [...new Set(links.map(row => positiveId(row.lead_id)).filter(Boolean))];
    if (linkedIds.length) {
      const open = await db.LeadIntake.findAll({ where: { id: { [Op.in]: linkedIds }, archived_at: null,
        status_lead: { [Op.in]: ['nuevo', 'contactado', 'esperando_info', 'info_recibida', 'cualificado', 'citado'] } },
      attributes: ['id', 'created_at', 'clinica_id'], raw: true, transaction });
      const openById = new Map(open.map(row => [positiveId(row.id), row]));
      evidence.acquisitions = links.filter(row => openById.has(positiveId(row.lead_id))
        && positiveId(row.clinic_id) === positiveId(openById.get(positiveId(row.lead_id)).clinica_id))
        .map(row => ({ ...row, created_at: openById.get(positiveId(row.lead_id)).created_at }));
    }
    return evidence;
  }

  async function derive(leads, options) {
    try {
      const evidence = await loadEvidence(leads, options.transaction);
      return new Map(leads.map(lead => [positiveId(lead.id), classifyLeadPatientContext(lead, evidence, options)]));
    } catch (error) {
      // Never persist contact details, SQL errors, provider data or stack traces in the snapshot.
      const code = error?.original?.code || error?.code;
      const knownCodes = new Set(['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_LOCK_DEADLOCK',
        'ER_LOCK_WAIT_TIMEOUT', 'ECONNREFUSED', 'ETIMEDOUT']);
      logger?.warn?.('lead_patient_context_classification_failed', { code: knownCodes.has(code) ? code : 'classification_error' });
      return new Map(leads.map(lead => [positiveId(lead.id), unknownContext('classification_failed', options.capturedAt || null)]));
    }
  }

  async function enrich(leads = [], { transaction = null } = {}) {
    const rows = leads.map(row => ({ ...plain(row) }));
    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const batch = rows.slice(start, start + BATCH_SIZE);
      const ids = [...new Set(batch.map(row => positiveId(row.id)).filter(Boolean))];
      const audits = await readAudits(ids, transaction);
      const missing = batch.filter(row => positiveId(row.id) && !audits.get(positiveId(row.id))?.hasSnapshot);
      // Conversation projections often omit contact/creation fields. Load these in one query.
      const incomplete = [...new Set(batch.filter(row => positiveId(row.id) && (row.clinica_id === undefined
        || !audits.get(positiveId(row.id))?.hasSnapshot && (!row.created_at || row.nombre === undefined
          || row.telefono === undefined && row.email === undefined))).map(row => positiveId(row.id)))];
      const loaded = incomplete.length ? await db.LeadIntake.findAll({ where: { id: { [Op.in]: incomplete } },
        attributes: LEAD_FIELDS, raw: true, transaction }) : [];
      const byId = new Map(loaded.map(row => [positiveId(row.id), row]));
      const derived = missing.length ? await derive(missing.map(row => byId.get(positiveId(row.id)) || row),
        { transaction, atCreation: false, capturedAt: null }) : new Map();
      for (const row of batch) {
        const id = positiveId(row.id);
        const audit = audits.get(id);
        const context = audit?.snapshot || derived.get(id) || unknownContext('lead_unavailable');
        row.patient_context = project(context, audit, byId.get(id) || row);
      }
    }
    return rows;
  }

  async function get(lead, options = {}) {
    return (await enrich([lead], options))[0].patient_context;
  }

  async function capture(lead, { transaction = null, atCreation = false } = {}) {
    const id = positiveId(plain(lead)?.id);
    if (!id) throw Error('lead_patient_context_lead_required');
    const persist = async tx => {
      // All writers serialize on the parent. No JSON uniqueness constraint/DDL needed.
      const fresh = await db.LeadIntake.findByPk(id, { attributes: LEAD_FIELDS, transaction: tx, lock: tx.LOCK.UPDATE });
      if (!fresh) throw Error('lead_patient_context_lead_missing');
      const audit = (await readAudits([id], tx, true)).get(id);
      if (audit?.hasSnapshot) return project(audit.snapshot, audit, plain(fresh));
      const capturedAt = new Date().toISOString();
      const context = (await derive([plain(fresh)], { transaction: tx, atCreation, capturedAt })).get(id);
      const { persisted, ...snapshot } = context;
      await db.LeadAttributionAudit.create({ lead_intake_id: id, raw_payload: null,
        attribution_steps: { type: LEAD_PATIENT_CONTEXT_TYPE,
          [LEAD_PATIENT_CONTEXT_TYPE]: { version: 1, ...snapshot } } }, { transaction: tx });
      return project({ ...snapshot, persisted: true }, audit, plain(fresh));
    };
    return transaction ? persist(transaction) : sequelize.transaction(persist);
  }
  return { capture, get, enrich };
}

// Convenience wrappers for the already-running application. Factory/hook/tests do
// not import models/index.js. Callers may also inject db into these wrappers.
const serviceFor = options => createLeadPatientContextService(options?.db || require('../../models'));
module.exports = { createLeadPatientContextService, leadPatientContextSql,
  enrich: (leads, options) => serviceFor(options).enrich(leads, options),
  get: (lead, options) => serviceFor(options).get(lead, options),
  capture: (lead, options) => serviceFor(options).capture(lead, options) };
