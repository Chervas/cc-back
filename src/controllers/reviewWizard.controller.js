'use strict';
const db = require('../../models');
const { resolveClinicScope } = require('../lib/clinicScope');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const drafts = require('../services/reviewWizardDraft.service');
const registration = require('../services/reviewRecipientRegistration.service');

async function context(req, access) {
  const actorId = Number(req.userData?.userId);
  if (!Number.isSafeInteger(actorId) || actorId < 1) throw Object.assign(Error('Accede de nuevo a la aplicación'), { status:401 });
  const scope = await resolveClinicScope(req.query.scope || req.query.clinic_id, { allowAll:false });
  if (!scope.isValid || !scope.clinicIds.length || scope.notFound) throw Object.assign(Error('Selecciona una clínica o grupo'), { status:400 });
  if (!await hasMarketingClinicScopeAccess({ userId:actorId,clinicIds:scope.clinicIds,access })) throw Object.assign(Error('No tienes acceso a este ámbito'), { status:403 });
  return { db,actorId,scope };
}
const handler = work => async (req,res) => {
  res.set('Cache-Control','no-store');
  try { res.json(await work(req)); }
  catch (error) {
    const status = error.status || error.statusCode || 500;
    // Do not log patients, phone numbers or draft content.
    if (status >= 500) console.error('review wizard operation failed', error.code || error.name);
    res.status(status).json({ success:false,error:status >= 500 ? 'No se pudo completar la operación. Comprueba el estado antes de repetirla.' : error.message });
  }
};
exports.getDraft = handler(async req => drafts.get(await context(req,'read')));
exports.saveDraft = handler(async req => drafts.save({ ...await context(req,'write'),expectedRevision:req.body?.revision,state:req.body?.state }));
async function register(req,apply) {
  const ctx = await context(req,apply ? 'write' : 'read');
  if (ctx.scope.scope !== 'clinic' || ctx.scope.clinicIds.length !== 1) throw Object.assign(Error('Selecciona la clínica del listado para registrar pacientes'),{ status:400 });
  const clinicId = ctx.scope.clinicIds[0];
  await assertUserCanAccessFeature({ actorId:ctx.actorId,featureKey:'patients.view',clinicId });
  if (apply) await assertUserCanAccessFeature({ actorId:ctx.actorId,featureKey:'patients.edit',clinicId });
  return registration.run({ ...ctx,clinicId,listId:Number(req.params.listId),apply,expectedSha256:req.body?.sha256,sourceSystem:req.body?.sourceSystem });
}
exports.previewRegistration = handler(req => register(req,false));
exports.applyRegistration = handler(req => register(req,true));
