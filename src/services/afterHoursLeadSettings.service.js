'use strict';

const BASE_KEY = 'system_message_received_after_hours';
const ACTIONS = ['notice', 'assistant', 'team'];
const failure = (code, status) => Object.assign(new Error(code), { code, status });

function create(db) {
  async function published(clinicId, transaction) {
    const where = { engine_version: 'v2', trigger_type: 'message_received', published_at: { [db.Sequelize.Op.ne]: null } };
    const latest = (scope) => db.AutomationFlowTemplateV2.findOne({
      where: { ...where, ...scope }, order: [['version', 'DESC'], ['id', 'DESC']], transaction,
    });
    const local = await latest({ clinic_id: clinicId, template_key: BASE_KEY + '__clinic_' + clinicId });
    const row = local || await latest({ clinic_id: null, is_system: true, template_key: BASE_KEY });
    if (!row || row.trigger_config?.timing !== 'clinic_closed') throw failure('after_hours_unavailable', 404);
    return row;
  }

  async function read(clinicId, transaction) {
    const row = await published(clinicId, transaction);
    const approved = await db.LeadAssistantPublication.findOne({
      where: { clinic_id: clinicId }, attributes: ['version'], order: [['version', 'DESC']], transaction,
    });
    return {
      template_id: row.id, active: row.clinic_id === clinicId && !!row.is_active,
      action: row.trigger_config.after_hours_action || 'notice',
      assistant_version: row.trigger_config.after_hours_assistant_version || null, approved_version: approved?.version || null,
    };
  }

  async function save(clinicId, actorId, input) {
    if (!input || !ACTIONS.includes(input.action) || !Number.isSafeInteger(input.template_id) ||
        (input.action === 'assistant' && (!Number.isSafeInteger(input.assistant_version) || input.assistant_version < 1))) {
      throw failure('after_hours_invalid', 400);
    }
    return db.sequelize.transaction(async transaction => {
      const clinic = await db.Clinica.findByPk(clinicId, {
        attributes: ['id_clinica', 'grupoClinicaId'], transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!clinic) throw failure('clinic_not_found', 404);
      const row = await published(clinicId, transaction);
      const local = row.clinic_id === clinicId;
      const version = input.action === 'assistant' ? input.assistant_version : null;
      if (version && !await db.LeadAssistantPublication.count({ where: { clinic_id: clinicId, version }, transaction })) {
        throw failure('assistant_version_unavailable', 409);
      }
      if (local && row.trigger_config.after_hours_action === input.action &&
          (row.trigger_config.after_hours_assistant_version || null) === version) return read(clinicId, transaction);
      if (row.id !== input.template_id) throw failure('after_hours_conflict', 409);
      const templateKey = BASE_KEY + '__clinic_' + clinicId;
      const family = { clinic_id: clinicId, template_key: templateKey };
      if (await db.AutomationFlowTemplateV2.count({ where: { ...family, published_at: null }, transaction })) {
        throw failure('after_hours_draft_exists', 409);
      }
      const config = { ...row.trigger_config, after_hours_action: input.action, after_hours_assistant_version: version };
      const entry = row.nodes.find(node => node.id === row.entry_node_id && node.type === 'trigger/message_received');
      if (!entry) throw failure('after_hours_unavailable', 409);
      const graph = row.nodes.map(node => node.id === entry.id
        ? { ...node, config: { ...node.config, after_hours_action: input.action, after_hours_assistant_version: version } }
        : node);
      const nodes = require('../lib/lead-social-flow').withAfterHoursReply(graph, row.entry_node_id, config);
      const active = local && !!row.is_active;
      await db.AutomationFlowTemplateV2.update({ is_active: false }, { where: { ...family, is_active: true }, transaction });
      await db.AutomationFlowTemplateV2.create({
        template_key: templateKey, public_id: local ? row.public_id : 'flw_after_hours_clinic_' + clinicId,
        version: local ? row.version + 1 : 1, name: row.name, description: row.description, engine_version: 'v2',
        is_active: active, is_system: false, clinic_id: clinicId, group_id: clinic.grupoClinicaId,
        trigger_type: row.trigger_type, trigger_config: config, entry_node_id: row.entry_node_id, nodes,
        published_at: new Date(), published_by: actorId, created_by: actorId,
      }, { transaction });
      return read(clinicId, transaction);
    });
  }
  return { read, save };
}
module.exports = { create };
