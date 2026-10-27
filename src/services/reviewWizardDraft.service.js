'use strict';

// Private wizard state uses its own namespace, never the global delivery policy.
const FIELDS = new Set(('reviewAudienceMode reviewImportedListId reviewRequestSource reviewHistoricalMoment reviewHistoricalTreatmentIds reviewTreatmentSelectionTouched reviewGroupClinicMode reviewSelectedClinicIds reviewGroupClinicSelectionTouched reviewExcludedPatientIds reviewExcludedPhonePrefixes reviewExclusionRuleState reviewAudienceGenerated reviewAudiencePreviewLimit reviewAudiencePageSize reviewStepperIndex reviewStepKey reviewDraftSaved reviewTemplateVariant reviewGiftDescription reviewDisplayClinicName reviewDisplayClinicNameEdited reviewSenderName reviewTeamPhotoUrl reviewTeamPhotoOverlayColor reviewTeamMembers reviewSelectedTemplateId reviewDispatchMode reviewDispatchBatchSize reviewDispatchDelayMinutes reviewDispatchDelayAmount reviewDispatchDelayUnit reviewDispatchTimeMode reviewDispatchSpecificTime reviewDispatchWindowStartTime reviewDispatchWindowEndTime reviewDispatchStartDate reviewDispatchIncludeWeekends').split(' '));
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const plain = value => typeof value === 'string' ? JSON.parse(value) : value || {};
function draftKey(actorId, scope) {
  if (!Number.isSafeInteger(actorId) || actorId < 1 || !scope?.clinicIds?.length) throw fail('Ámbito de borrador inválido');
  if (scope.scope !== 'group' && scope.clinicIds.length !== 1) throw fail('Selecciona una clínica o un grupo');
  return `review-draft:u${actorId}:${scope.scope === 'group' ? 'g' + scope.groupId : 'c' + scope.clinicIds[0]}`;
}
function cleanState(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw fail('Borrador inválido');
  const state = Object.fromEntries(Object.entries(value).filter(([key]) => FIELDS.has(key)));
  if (Buffer.byteLength(JSON.stringify(state)) > 192 * 1024) throw fail('El borrador supera el tamaño permitido');
  // This is configuration only. Audience rows and test destinations never enter storage.
  return JSON.parse(JSON.stringify(state));
}
function project(row) {
  const data = plain(row?.settings);
  return { success: true, revision: Number(data.revision) || 0, state: data.state || null, updatedAt: row?.updated_at || null };
}
async function get({ db, actorId, scope }) {
  return project(await db.MarketingBulkSendSetting.findOne({ where: { scope_key: draftKey(actorId, scope) } }));
}
async function save({ db, actorId, scope, expectedRevision, state }) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('Revisión de borrador inválida');
  const safe = cleanState(state), key = draftKey(actorId, scope);
  return db.sequelize.transaction(async transaction => {
    const anchor = scope.scope === 'group' ? db.GrupoClinica : db.Clinica;
    if (!await anchor.findByPk(scope.scope === 'group' ? scope.groupId : scope.clinicIds[0], { transaction, lock: transaction.LOCK.UPDATE })) throw fail('Ámbito no encontrado', 404);
    let row = await db.MarketingBulkSendSetting.findOne({ where: { scope_key: key }, transaction, lock: transaction.LOCK.UPDATE });
    if (project(row).revision !== expectedRevision) throw fail('El borrador ha cambiado en otra pestaña. Recarga el borrador antes de guardar.', 409);
    const values = { settings: { version: 1, revision: expectedRevision + 1, state: safe }, updated_by: actorId };
    if (row) await row.update(values, { transaction });
    else row = await db.MarketingBulkSendSetting.create({ scope_key: key, ...values }, { transaction });
    return project(row);
  });
}
module.exports = { draftKey, cleanState, get, save };
