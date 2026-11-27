'use strict';

const CHANNELS = ['whatsapp', 'social'];
function key(clinicId, channel) {
  if (!Number.isSafeInteger(clinicId) || clinicId < 1 || !CHANNELS.includes(channel)) {
    throw Object.assign(new Error('lead_capture_scope_invalid'), { status: 400 });
  }
  return `inbound_lead_capture_${channel}__clinic_${clinicId}`;
}
function current(db, clinicId, channel, transaction) {
  return db.AutomationFlowTemplateV2.findOne({
    where: {
      clinic_id: clinicId,
      template_key: key(clinicId, channel),
      published_at: { [db.Sequelize.Op.ne]: null },
    },
    order: [['version', 'DESC']],
    transaction,
  });
}
function status(channel, row) {
  return {
    channel,
    active: !!row?.is_active,
    effective_from: row?.trigger_config?.effective_from || null,
    template_id: row?.id || null,
    template_key: row?.template_key || null,
    public_id: row?.public_id || null,
    version: row?.version || null,
  };
}
async function save(db, clinicId, channel, actorId, active) {
  key(clinicId, channel);
  if (typeof active !== 'boolean' || !Number.isSafeInteger(actorId) || actorId <= 0)
    throw Object.assign(new Error('lead_capture_config_invalid'), { status: 400 });
  return db.sequelize.transaction(async (transaction) => {
    const clinic = await db.Clinica.findByPk(clinicId, {
      attributes: ['id_clinica', 'grupoClinicaId'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!clinic) throw Object.assign(new Error('clinic_not_found'), { status: 404 });
    const old = await current(db, clinicId, channel, transaction);
    if (old && !!old.is_active === active) return status(channel, old);
    const now = new Date();
    const config = {
      managed_feature: 'inbound_lead_capture',
      channel,
      channel_scope: 'selected',
      channels: channel === 'whatsapp' ? ['whatsapp'] : ['instagram', 'messenger'],
      effective_from: now.toISOString(),
    };
    const name = channel === 'whatsapp' ? 'Crear lead cuando pidan información por WhatsApp' : 'Crear lead cuando pidan información en redes';
    const nodes = [
      {
        id: 'N1',
        type: 'trigger/message_received',
        config,
        outputs: { on_success: 'N2' },
        position: { x: 260, y: 100 },
      },
      {
        id: 'N2',
        type: 'action/inbound_lead_capture',
        config: {},
        outputs: { on_success: 'N3' },
        position: { x: 260, y: 260 },
      },
      { id: 'N3', type: 'control/end', config: {}, outputs: {}, position: { x: 260, y: 420 } },
    ];
    if (old?.is_active) await old.update({ is_active: false }, { transaction });
    const flow = await db.AutomationFlowTemplateV2.create(
      {
        public_id: `flw_inbound_lead_capture_${channel}_${clinicId}`,
        template_key: key(clinicId, channel),
        version: (old?.version || 0) + 1,
        engine_version: 'v2',
        name,
        trigger_type: 'message_received',
        trigger_config: config,
        is_active: active,
        is_system: false,
        clinic_id: clinicId,
        group_id: clinic.grupoClinicaId || null,
        entry_node_id: 'N1',
        nodes,
        created_by: actorId,
        published_by: actorId,
        published_at: now,
      },
      { transaction },
    );
    return status(channel, flow);
  });
}
function effective(flow, at) {
  const since = Date.parse(flow?.trigger_config?.effective_from);
  return (
    !!flow?.is_active &&
    flow.trigger_config.managed_feature === 'inbound_lead_capture' &&
    Number.isFinite(since) &&
    at >= since
  );
}
module.exports = { CHANNELS, current, status, save, effective };
