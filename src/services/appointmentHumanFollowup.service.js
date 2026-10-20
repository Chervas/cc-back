'use strict';

function createService({ models, openingHours, findHumanReply, emitUpdated, enrichDirection, findAssignment, now = () => new Date() }) {
  async function prepare({ clinicId, conversationId, minutes, userIds }) {
    if (minutes !== 30 || !conversationId) return { data: {}, userIds };
    const [clinic, rows, conversation] = await Promise.all([
      models.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'configuracion'], raw: true }),
      models.ClinicaHorario.findAll({ where: { clinica_id: clinicId, activo: true }, raw: true }),
      models.Conversation.findByPk(conversationId, { raw: true }),
    ]);
    if (Number(conversation?.clinic_id) !== Number(clinicId)) return { data: {}, userIds };
    const due = openingHours.addClinicWorkingMinutes({ now: now(), minutes, rows,
      timeZone: openingHours.resolveClinicTimeZone(clinic) });
    const [directed] = await enrichDirection([conversation]);
    const assignment = directed?.patient_direction || await findAssignment({ clinicId, conversationId, statuses: ['active'] });
    const directorId = Number(assignment?.director_user_id);
    return { userIds: directorId > 0 ? [directorId] : userIds, data: {
      appointment_human_followup: true, human_followup_minutes: minutes,
      human_followup_due_at: due?.toISOString() || null,
    } };
  }

  async function run() {
    const { Op } = require('sequelize');
    const checkedAt = now();
    const rows = await models.Notification.findAll({ where: { event: 'automation.persistent_alert', isRead: false,
      [Op.and]: [models.sequelize.literal("JSON_EXTRACT(data, '$.appointment_human_followup') = true"),
        models.sequelize.literal("JSON_EXTRACT(data, '$.human_followup_escalated_at') IS NULL"),
        models.sequelize.where(models.sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(data, '$.human_followup_due_at'))"),
          { [Op.lte]: checkedAt.toISOString() })] }, attributes: ['id'], order: [['id', 'ASC']], limit: 100 });
    let highlighted = 0;
    const openStates = new Map();
    for (const item of rows) {
      await models.sequelize.transaction(async transaction => {
        const row = await models.Notification.findByPk(item.id, { transaction, lock: transaction.LOCK.UPDATE });
        const data = row?.data;
        const due = new Date(data?.human_followup_due_at || 'invalid');
        if (!row || row.isRead || data?.appointment_human_followup !== true || data.human_followup_escalated_at
          || !Number.isFinite(due.getTime()) || due > checkedAt || !data.quickChatConversationId || !data.quickChatResponseMessageId) return;
        if (!openStates.has(row.clinicaId)) openStates.set(row.clinicaId,
          await openingHours.resolveClinicOpenState({ clinicId: row.clinicaId, now: checkedAt, models }));
        if (openStates.get(row.clinicaId)?.open_now !== true) return;
        if (await findHumanReply(data.quickChatConversationId, data.quickChatResponseMessageId, { transaction })) return;
        await row.update({ level: 'error', icon: 'heroicons_outline:exclamation-triangle',
          data: { ...data, human_followup_escalated_at: checkedAt.toISOString() } }, { transaction });
        transaction.afterCommit(() => emitUpdated(row));
        highlighted++;
      });
    }
    return { checked: rows.length, highlighted };
  }
  return { prepare, run };
}

let instance;
function current() {
  return instance ||= createService({ models: require('../../models'), openingHours: require('./clinicOpeningHours.service'),
    findHumanReply: (...args) => require('./conversationPendingReply.service').findHumanReplyAfterMessage(...args),
    emitUpdated: row => require('./notificationsRealtime.service').emitNotificationUpdated(row),
    enrichDirection: rows => require('./temporaryPatientDirection.service').enrich(rows),
    findAssignment: params => require('./patientDirection.service').findAssignment(params) });
}
module.exports = { createService, current };
