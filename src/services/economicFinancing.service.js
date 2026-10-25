'use strict';

const F = require('../lib/economicFinancing');
function createService({ db = require('../../models') } = {}) {
  async function update({ publicId, actorId, payload }) {
    if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) < 1) F.fail('unauthenticated', 'Inicia sesión para continuar.', 401);
    const input = F.command(payload), requestHash = F.hash(input);
    return db.sequelize.transaction(async transaction => {
      const budget = await db.EconomicBudget.findOne({ where: { public_id: publicId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!budget) F.fail('budget_not_found', 'Presupuesto no encontrado.', 404);
      const [version, events, payments] = await Promise.all([
        db.EconomicBudgetVersion.findOne({ where: { budget_id: budget.id, version_number: budget.current_version }, transaction }),
        db.EconomicBudgetEvent.findAll({ where: { budget_id: budget.id }, order: [['id', 'ASC']], transaction }),
        db.EconomicPayment.findAll({ where: { budget_id: budget.id, status: 'confirmed' }, transaction }),
      ]);
      const previous = events.find(event => event.event_type === 'financing_updated'
        && (typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata)?.request_key === input.idempotency_key);
      if (previous) {
        const receipt = typeof previous.metadata === 'string' ? JSON.parse(previous.metadata) : previous.metadata;
        if (receipt.request_hash !== requestHash || Number(previous.actor_id) !== Number(actorId)) F.fail('financing_idempotency_conflict', 'Esta solicitud ya corresponde a otro seguimiento.', 409);
        return { financing_summary: F.summary(budget, version, events, payments), replayed: true };
      }
      if (Number(budget.current_version) !== input.expected_version) F.fail('budget_version_conflict', 'El presupuesto ha cambiado. Actualiza antes de guardar.', 409);
      const before = F.summary(budget, version, events, payments);
      if (!before) F.fail('financing_not_selected', 'Este presupuesto no tiene financiación externa aceptada.', 409);
      if (before.revision !== input.expected_financing_revision) F.fail('financing_version_conflict', 'Otra persona ha actualizado la financiación. Conserva tus cambios y revisa el seguimiento vigente.', 409);
      if (input.financed_amount != null && Math.round(input.financed_amount * 100) > Math.round(Number(budget.accepted_amount) * 100)) F.fail('financing_amount_exceeds_accepted', 'El importe de la financiera supera el importe aceptado.');
      const event = await db.EconomicBudgetEvent.create({ budget_id: budget.id, version_number: budget.current_version,
        event_type: 'financing_updated', from_status: budget.status, to_status: budget.status,
        metadata: { schema_version: 1, revision: before.revision + 1, approval_status: input.approval_status,
          financed_amount: input.financed_amount, reference: input.reference, notes: input.notes,
          previous_approval_status: before.approval_status, request_key: input.idempotency_key, request_hash: requestHash,
          manual_tracking: true, no_payment_created: true }, actor_id: actorId, created_at: new Date() }, { transaction });
      return { financing_summary: F.summary(budget, version, [...events, event], payments), replayed: false };
    });
  }
  return { update };
}
module.exports = { createService, update: input => createService().update(input) };
