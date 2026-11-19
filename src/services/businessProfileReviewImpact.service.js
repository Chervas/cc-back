'use strict';
const { Op } = require('sequelize');
const C = require('./businessProfileAssociation.contract');

// Metadata only: both ordinary changes and first-profile admission must bind
// the same review queues to the user's explicit destination-change decision.
async function readReviewImpact({ models, clinic, transaction }) {
  const clinicId = Number(clinic.id_clinica);
  const lists = await models.MarketingPatientList.findAll({ transaction, lock: transaction.LOCK.UPDATE,
    logging: false, raw: true, attributes: ['id', 'clinica_id', 'objective_id', 'source', 'status', 'criteria', 'clinic_ids'],
    where: { [Op.or]: [{ clinica_id: clinicId }, { grupo_clinica_id: clinic.grupoClinicaId || -1 }] }, limit: 1001 });
  if (!Array.isArray(lists) || lists.length > 1000) C.fail('gbp_association_limit');
  const applies = row => Number(row.clinica_id) === clinicId || row.clinic_ids == null
    || !C.array(row.clinic_ids).length || C.array(row.clinic_ids).some(id => Number(id) === clinicId);
  const impacted = lists.filter(row => applies(row) && C.reviewCampaign(row) && !['archived', 'cancelled'].includes(row.status))
    .sort((a, b) => Number(a.id) - Number(b.id));
  return { reviewDestinationChangeRequired: impacted.length > 0, affectedReviewCampaignCount: impacted.length,
    reviewCampaignImpactDigest: C.hash(impacted.map(row => [Number(row.id), row.clinica_id == null ? null : Number(row.clinica_id),
      row.clinic_ids == null ? null : C.array(row.clinic_ids).map(Number).sort((a, b) => a - b)])) };
}
module.exports = { readReviewImpact };
