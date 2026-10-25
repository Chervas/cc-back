'use strict';
const crypto = require('node:crypto'), { Op } = require('sequelize');
const L = require('../lib/economic-concept-ledger');
const { hasCompletedAppointmentCare } = require('../lib/appointment-care');
const linksFromEvents = events => require('./budgetAppointmentLinks.service').linksFromEvents(events);
const active = row => !['cancelada', 'reprogramada', 'no_asistio'].includes(row.estado) && !row.es_provisional;
function createService({ db, canAccess = input => require('../lib/access-policy').canUserAccessFeature(input), rectify } = {}) {
  const funding = require('./economicFunding.service').createService({ db });
  async function context(input, transaction, writing = false) {
    if (!Number.isSafeInteger(Number(input.actorId)) || Number(input.actorId) <= 0) L.fail('unauthenticated', 'Inicia sesión para continuar.', 401);
    let budget = await db.EconomicBudget.findOne({ where: { public_id: input.publicId }, ...(!writing ? { transaction } : {}) });
    if (!budget) L.fail('budget_not_found', 'Presupuesto no encontrado.', 404);
    if (!await canAccess({ actorId: Number(input.actorId), clinicId: Number(budget.clinic_id), featureKey: writing ? input.booking ? 'appointments.manage' : 'patients.edit' : 'patients.view' })) L.fail('access_policy_forbidden', 'No tienes permiso para este presupuesto.', 403);
    const patient = await db.Paciente.findByPk(budget.patient_id, { transaction, ...(writing ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!patient || Number(patient.clinica_id) !== Number(budget.clinic_id) && !(db.PacienteClinica && await db.PacienteClinica.findOne({ where: { paciente_id: budget.patient_id, clinica_id: budget.clinic_id }, transaction }))) L.fail('patient_not_found', 'Paciente no encontrado en esta clínica.', 404);
    if (writing) budget = await db.EconomicBudget.findByPk(budget.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!budget) L.fail('budget_not_found', 'Presupuesto no encontrado.', 404);
    return { budget, clinicId: Number(budget.clinic_id), patientId: Number(budget.patient_id), actorId: Number(input.actorId) };
  }
  async function facts(ctx, transaction, writing = false) {
    const data = await funding.load({ ...ctx, transaction, persist: writing }), budget = ctx.budget;
    const version = data.versions.find(row => String(row.budget_id) === String(budget.id) && Number(row.version_number) === Number(budget.current_version));
    if (!version) L.fail('budget_version_not_found', 'No se encuentra la versión del presupuesto.', 404);
    const events = data.events.filter(row => String(row.budget_id) === String(budget.id)), lines = L.acceptedLines(budget, version, events);
    const vouchers = await db.PatientVoucher.findAll({ where: { budget_id: budget.id, clinic_id: ctx.clinicId, patient_id: ctx.patientId }, transaction, ...(writing ? { lock: transaction.LOCK.UPDATE } : {}) });
    const voucherIds = vouchers.map(row => row.id), links = linksFromEvents(events).filter(row => row.version === Number(budget.current_version));
    const movements = voucherIds.length ? await db.PatientVoucherMovement.findAll({ where: { voucher_id: { [Op.in]: voucherIds } }, transaction }) : [];
    const appointments = voucherIds.length || links.length ? await db.CitaPaciente.findAll({ where: { clinica_id: ctx.clinicId, paciente_id: ctx.patientId,
      [Op.or]: [...(voucherIds.length ? [{ voucher_id: { [Op.in]: voucherIds } }] : []), ...(links.length ? [{ id_cita: { [Op.in]: links.map(row => row.appointment_id) } }] : [])] }, transaction }) : [];
    return { ...data, budget, version, lines, events, vouchers, movements, appointments, links };
  }
  function progress(line, data) {
    const changes = data.adjustments.filter(row => String(row.budget_id) === String(data.budget.id) && Number(row.budget_version) === Number(data.version.version_number) && row.line_key === line.key);
    const contracted = Number(line.entitlement_units || line.quantity || 1), cancelled = changes.reduce((sum, row) => sum + Number(row.units), 0), voucher = data.vouchers.find(row => String(row.budget_id) === String(data.budget.id) && row.budget_line_key === line.key);
    const links = data.links.filter(row => row.line_key === line.key), appointments = data.appointments.filter(row => links.some(link => link.appointment_id === Number(row.id_cita)) || voucher && String(row.voucher_id) === String(voucher.id));
    const consumed = voucher ? data.movements.filter(row => String(row.voucher_id) === String(voucher.id) && row.movement_type === 'consumption') : [];
    const completedWithoutMovement = appointments.filter(row => hasCompletedAppointmentCare(row) && !consumed.some(movement => Number(movement.appointment_id) === Number(row.id_cita)));
    const used = consumed.reduce((sum, row) => sum + Math.abs(Number(row.units)), 0) + completedWithoutMovement.length, reserved = appointments.filter(row => active(row) && !hasCompletedAppointmentCare(row) && !consumed.some(movement => Number(movement.appointment_id) === Number(row.id_cita))).length;
    const cancelledAmount = changes.reduce((sum, row) => sum + L.cents(row.cancelled_amount), 0), original = L.cents(line.contracted_amount), payable = Math.max(0, original - cancelledAmount);
    const parts = data.parts.filter(row => String(row.budget_id) === String(data.budget.id) && row.line_key === line.key), unassigned = data.parts.some(row => String(row.budget_id) === String(data.budget.id) && !row.line_key && L.cents(row.amount) > funding.released(data, row.funding_key));
    const partKeys = new Set(parts.map(row => row.funding_key)), paid = parts.reduce((sum, row) => sum + Math.max(0, L.cents(row.amount) - funding.released(data, row.funding_key)), 0);
    const legacyFiscal = data.documents.some(row => String(row.budget_id) === String(data.budget.id) && row.document_type === 'invoice' && row.status !== 'voided'
      && !data.coverages.some(coverage => String(coverage.document_id) === String(row.id)));
    const invoiced = data.coverages.filter(row => partKeys.has(row.funding_key) && ['invoice', 'credit_note'].includes(row.document_type) && row.status === 'issued').reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
    let reason = null;
    if (!Number.isSafeInteger(contracted) || contracted < 1) reason = 'La cantidad de este concepto no expresa sesiones enteras. Requiere revisión.';
    else if (used + reserved + cancelled > contracted) reason = 'El historial de sesiones y reservas requiere revisión antes de cancelar.';
    else if (voucher && Math.abs(Number(voucher.available_units) - (contracted - used - cancelled)) > 0.001) reason = 'El saldo histórico del bono no coincide con los consumos acreditados. Requiere revisión manual.';
    else if (unassigned) reason = 'Hay dinero aplicado al presupuesto sin atribución a conceptos. Asigna o revisa el cobro antes de cancelar o devolver.';
    else if (legacyFiscal) reason = 'Hay facturas históricas sin cobertura verificable por concepto. Revisa su atribución antes de cancelar.';
    const pending = Math.max(0, contracted - used - reserved - cancelled), revision = changes.reduce((max, row) => Math.max(max, Number(row.concept_revision)), 0);
    return { contracted, used, reserved, pending, remaining: Math.max(0, contracted - used - cancelled), cancelled, concept_revision: revision,
      appointments: [...appointments].sort((a, b) => Number(a.id_cita) - Number(b.id_cita)).map(row => ({ id: Number(row.id_cita), status: row.estado, start_at: row.inicio, end_at: row.fin, performed: hasCompletedAppointmentCare(row) })),
      financial: { contracted: L.money(original), payable: L.money(payable), cancelled: L.money(cancelledAmount), paid: unassigned ? null : L.money(paid),
        invoiced: unassigned || legacyFiscal ? null : L.money(invoiced), uninvoiced: unassigned || legacyFiscal ? null : L.money(Math.max(0, paid - invoiced)),
        refunded: changes.reduce((sum, row) => sum + Number(row.refund_amount), 0), credited: changes.reduce((sum, row) => sum + Number(row.credited_amount), 0), attribution: unassigned ? 'unassigned' : 'explicit' },
      can_cancel: !reason && pending > 0, can_refund: !reason && pending > 0 && paid > Math.max(0, original - Math.round(original * (cancelled + pending) / contracted)), cancellation_reason: reason, fulfillment_voucher_id: voucher?.public_id || null };
  }
  async function bookingSource(input) {
    const ctx = await context({ ...input, booking: true }, input.transaction, input.lock === true), data = await facts(ctx, input.transaction), line = data.lines.find(row => row.key === input.lineKey);
    if (!line) L.fail('budget_concept_not_found', 'El concepto no consta aceptado en esta versión.', 404);
    if (input.expectedVersion !== undefined && Number(input.expectedVersion) !== Number(ctx.budget.current_version)) L.fail('budget_version_conflict', 'El presupuesto ha cambiado.');
    return { budget: ctx.budget, line, progress: progress(line, data) };
  }
  async function recordBooked(input) {
    if (!input.transaction) L.fail('budget_concept_transaction_required', 'No se pudo conservar el vínculo de las citas.', 500);
    const { budget, line, progress: state } = await bookingSource({ ...input, lock: true });
    if (!Array.isArray(input.appointments) || !input.appointments.length || input.appointments.length > state.pending) L.fail('budget_concept_count_changed', 'Las sesiones pendientes han cambiado. Revisa el plan antes de reservar.');
    const ids = input.appointments.map(row => Number(row.id_cita));
    const rows = await db.CitaPaciente.findAll({ where: { id_cita: { [Op.in]: ids }, clinica_id: budget.clinic_id, paciente_id: budget.patient_id }, transaction: input.transaction, lock: input.transaction.LOCK.UPDATE });
    if (rows.length !== ids.length || rows.some(row => Number(row.tratamiento_id) !== Number(line.treatment_id) || row.voucher_id != null)) L.fail('budget_concept_appointment_scope', 'Las citas no coinciden con el concepto aceptado.');
    for (const appointment of rows) await db.EconomicBudgetEvent.create({ budget_id: budget.id, version_number: budget.current_version,
      event_type: 'appointment_linked', from_status: budget.status, to_status: budget.status, actor_id: input.actorId, created_at: new Date(),
      metadata: { appointment_id: Number(appointment.id_cita), line_key: line.key, budget_version: Number(budget.current_version), association: 'scheduled', no_payment_or_clinical_effect: true } }, { transaction: input.transaction });
    return { linked: true, appointment_ids: ids };
  }
  async function paymentPreview(input) {
    const ctx = await context(input), data = await facts(ctx), payload = input.payload || {};
    if (Number(payload.expected_version) !== Number(ctx.budget.current_version)) L.fail('budget_version_conflict', 'Actualiza el presupuesto antes de cobrar.');
    if (payload.generic === true) {
      const parts = data.parts.filter(part => String(part.budget_id) === String(ctx.budget.id));
      if (!parts.some(part => !part.line_key && L.cents(part.amount) > funding.released(data, part.funding_key))) L.fail('payment_generic_not_required', 'Este presupuesto requiere seleccionar los conceptos del nuevo cobro.', 400);
      if (payload.lines?.length) L.fail('payment_generic_concepts_conflict', 'El cobro genérico no puede atribuirse a conceptos.', 400);
      const cancelled = data.adjustments.filter(row => String(row.budget_id) === String(ctx.budget.id)).reduce((sum, row) => sum + L.cents(row.cancelled_amount), 0);
      const paid = parts.reduce((sum, part) => sum + Math.max(0, L.cents(part.amount) - funding.released(data, part.funding_key)), 0);
      const pending = Math.max(0, L.cents(ctx.budget.accepted_amount) - cancelled - paid), total = L.cents(payload.amount);
      if (!total || total > pending) L.fail('payment_exceeds_budget_pending', 'El importe supera lo pendiente del presupuesto.', 400, { pending: L.money(pending) });
      return { budget_id: ctx.budget.public_id, version: Number(ctx.budget.current_version), total: L.money(total), pending: L.money(pending), attribution: 'unassigned', generic: true,
        lines: [], allocations: [{ target_type: 'budget', amount: L.money(total) }] };
    }
    if (!Array.isArray(payload.lines) || !payload.lines.length || payload.lines.length > 500 || new Set(payload.lines.map(row => row.line_key)).size !== payload.lines.length) L.fail('payment_concepts_required', 'Selecciona los conceptos que se están cobrando.', 400);
    const rows = payload.lines.map(selected => {
      const line = data.lines.find(line => line.key === selected.line_key); if (!line) L.fail('budget_concept_not_found', 'Uno de los conceptos no está aceptado.', 404);
      const state = progress(line, data);
      if (state.financial.attribution === 'unassigned') L.fail('payment_attribution_review_required', 'El presupuesto contiene cobros antiguos sin atribución. Revisa su aplicación antes de añadir un cobro por concepto.');
      const remaining = Math.max(0, L.cents(state.financial.payable) - L.cents(state.financial.paid)), units = selected.units == null ? null : Number(selected.units);
      if (units !== null && (!Number.isSafeInteger(units) || units < 1 || units > state.contracted - state.cancelled)) L.fail('payment_units_invalid', 'Indica un número válido de sesiones contratadas.', 400);
      const amount = units === null ? remaining : Math.min(remaining, Math.round(L.cents(state.financial.contracted) * units / state.contracted));
      return { line_key: line.key, units, amount: L.money(amount), remaining: L.money(remaining), label: line.name };
    });
    const maximum = rows.reduce((sum, row) => sum + L.cents(row.amount), 0), total = payload.amount == null ? maximum : L.cents(payload.amount);
    if (!total || total > maximum) L.fail('payment_exceeds_concepts_pending', 'El importe supera lo pendiente de los conceptos seleccionados.', 400, { available: L.money(maximum) });
    // This distribution is an explicit, confirmed quote for the newly selected
    // concepts, never an attribution of an older generic collection.
    const allocation = L.allocate(total, rows.map(row => L.cents(row.amount)));
    return { budget_id: ctx.budget.public_id, version: Number(ctx.budget.current_version), total: L.money(total),
      lines: rows.map((row, i) => ({ ...row, amount: L.money(allocation[i]) })),
      allocations: rows.flatMap((row, i) => allocation[i] ? [{ target_type: 'budget_line', line_key: row.line_key, amount: L.money(allocation[i]), label: row.label }] : []) };
  }
  async function cancellationQuote(ctx, data, line, command) {
    const state = progress(line, data), previous = data.adjustments.filter(row => String(row.budget_id) === String(ctx.budget.id) && Number(row.budget_version) === Number(data.version.version_number) && row.line_key === line.key);
    let reason = ['accepted', 'partially_accepted'].includes(ctx.budget.status) ? state.cancellation_reason : 'El presupuesto ya no está aceptado en esta versión.';
    if (!reason && command.units > state.pending) reason = 'Sólo se pueden cancelar sesiones pendientes sin cita. Cancela o desvincula primero las citas reservadas; las sesiones realizadas se conservan.';
    const snapshot = L.parse(line.program_snapshot);
    if (!reason && snapshot.appointments?.length && snapshot.kind !== 'voucher' && (state.used > 0 || command.units !== state.contracted - state.cancelled)) reason = 'Este programa reúne sesiones distintas con un precio conjunto. La parte realizada o la cancelación parcial requiere una valoración explícita; no se divide su precio por número de sesiones.';
    const priorAmount = previous.reduce((sum, row) => sum + L.cents(row.cancelled_amount), 0), original = L.cents(line.contracted_amount);
    const cancelledAmount = Math.max(0, Math.round(original * Math.min(state.contracted, state.cancelled + command.units) / state.contracted) - priorAmount);
    const paid = state.financial.paid == null ? null : L.cents(state.financial.paid), payableAfter = Math.max(0, L.cents(state.financial.payable) - cancelledAmount), settlementAmount = paid == null ? 0 : Math.max(0, paid - payableAfter);
    if (!reason && settlementAmount && command.settlement === 'none') reason = 'Hay dinero abonado que debe devolverse o quedar como saldo del paciente. Elige expresamente una de esas opciones.';
    const parts = data.parts.filter(part => String(part.budget_id) === String(ctx.budget.id) && part.line_key === line.key).sort((a, b) => String(a.funding_key).localeCompare(String(b.funding_key)));
    const allocations = new Map(); let remaining = settlementAmount;
    const balances = parts.map(part => {
      const net = Math.max(0, L.cents(part.amount) - funding.released(data, part.funding_key));
      const invoices = data.coverages.filter(row => row.funding_key === part.funding_key && row.status === 'issued' && ['invoice', 'credit_note'].includes(row.document_type)).reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
      const reserved = data.coverages.filter(row => row.funding_key === part.funding_key && row.status === 'reserved' && row.document_type === 'invoice').reduce((sum, row) => sum + L.cents(row.amount), 0);
      return { part, net, invoices: Math.max(0, invoices), reserved, unbilled: Math.max(0, net - invoices - reserved) };
    });
    for (const item of balances) {
      const take = Math.min(remaining, item.unbilled); if (take) { allocations.set(item.part.funding_key, { item, amount: take, credit: 0 }); remaining -= take; }
    }
    for (const item of balances) {
      const take = Math.min(remaining, item.invoices); if (take) { const current = allocations.get(item.part.funding_key) || { item, amount: 0, credit: 0 }; current.amount += take; current.credit += take; allocations.set(item.part.funding_key, current); remaining -= take; }
    }
    if (!reason && remaining) reason = 'Parte del importe está reservada en un borrador fiscal. Revisa ese documento antes de devolver o convertir el dinero en saldo.';
    const fundingAllocations = [...allocations.values()].map(({ item, amount, credit }) => {
      const previousBase = data.adjustments.flatMap(row => L.parse(row.funding_allocations, [])).filter(row => row.funding_key === item.part.funding_key).reduce((sum, row) => sum + L.cents(row.taxable_base), 0);
      const baseLeft = Math.max(0, L.cents(item.part.taxable_base) - previousBase), base = amount === item.net ? baseLeft : Math.round(amount * baseLeft / item.net);
      return { funding_key: item.part.funding_key, source_kind: item.part.source_kind, payment_id: item.part.payment_id || null, wallet_entry_id: item.part.wallet_entry_id || null,
        amount: L.money(amount), taxable_base: L.money(base), tax_amount: L.money(amount - base), credit_note_amount: L.money(credit) };
    });
    const requiresCreditNote = fundingAllocations.some(row => row.credit_note_amount > 0);
    if (!reason && requiresCreditNote && !await canAccess({ actorId: ctx.actorId, clinicId: ctx.clinicId, featureKey: 'billing.documents.manage' })) reason = 'La devolución afecta a una factura emitida. Se necesita permiso para emitir su rectificativa enlazada.';
    const dto = { budget_id: ctx.budget.public_id, line_key: line.key, version: Number(ctx.budget.current_version), concept_revision: state.concept_revision,
      units: command.units, cancelled_amount: L.money(cancelledAmount), refund_amount: command.settlement === 'refund' ? L.money(settlementAmount) : 0,
      wallet_credit_amount: command.settlement === 'wallet_credit' ? L.money(settlementAmount) : 0, requires_credit_note: requiresCreditNote,
      can_confirm: !reason, reason, progress: state };
    const previewHash = L.hash({ command, dto, funding_allocations: fundingAllocations,
      coverage: data.coverages.filter(row => parts.some(part => part.funding_key === row.funding_key)).map(row => ({ id: row.id, amount: row.amount, status: row.status, version: row.document_version })).sort((a, b) => String(a.id).localeCompare(String(b.id))) });
    return { ...dto, preview_hash: previewHash, funding_allocations: fundingAllocations };
  }
  async function cancellationPreview(input) {
    const command = L.cancellationCommand(input.payload, true), ctx = await context(input), data = await facts(ctx), line = data.lines.find(row => row.key === input.lineKey);
    if (!line) L.fail('budget_concept_not_found', 'El concepto no consta aceptado.', 404);
    if (command.expected_version !== Number(ctx.budget.current_version)) L.fail('budget_version_conflict', 'El presupuesto ha cambiado. Vuelve a consultar sus conceptos.');
    return cancellationQuote(ctx, data, line, command);
  }
  async function cancel(input) {
    const command = L.cancellationCommand(input.payload), requestHash = L.hash({ publicId: input.publicId, lineKey: input.lineKey, command });
    return db.sequelize.transaction(async transaction => {
      const ctx = await context(input, transaction, true), prior = await db.EconomicConceptAdjustment.findOne({ where: { clinic_id: ctx.clinicId, patient_id: ctx.patientId, idempotency_key: command.idempotency_key } });
      if (prior) {
        if (prior.request_hash !== requestHash || Number(prior.actor_id) !== ctx.actorId) L.fail('economic_request_conflict', 'Esta solicitud ya se utilizó para otra corrección.');
        return { ...L.parse(prior.snapshot).receipt, replayed: true };
      }
      if (Number(ctx.budget.current_version) !== command.expected_version) L.fail('budget_version_conflict', 'El presupuesto ha cambiado. Conserva tu selección y consulta la versión vigente.', 409, { applied: false });
      const data = await facts(ctx, transaction, true), line = data.lines.find(row => row.key === input.lineKey);
      if (!line) L.fail('budget_concept_not_found', 'El concepto no consta aceptado.', 404, { applied: false });
      const quoteCommand = Object.fromEntries(['expected_version', 'units', 'settlement', 'reason', 'refund_method'].map(key => [key, command[key]])), quote = await cancellationQuote(ctx, data, line, quoteCommand);
      if (quote.concept_revision !== command.expected_concept_revision) L.fail('concept_revision_conflict', 'Otra persona ha corregido este concepto. Revisa sus sesiones y cobros.', 409, { applied: false });
      if (quote.preview_hash !== command.preview_hash) L.fail('concept_cancellation_changed', 'Han cambiado las sesiones, cobros o documentos. Revisa de nuevo la previsualización.', 409, { applied: false });
      if (!quote.can_confirm) L.fail('concept_cancellation_blocked', quote.reason, 409, { applied: false });
      const id = crypto.randomUUID(), voucher = data.vouchers.find(row => row.budget_line_key === line.key);
      let walletEntry = null;
      if (quote.wallet_credit_amount > 0) walletEntry = await db.PatientWalletEntry.create({ public_id: crypto.randomUUID(), clinic_id: ctx.clinicId, patient_id: ctx.patientId, budget_id: ctx.budget.id,
        payment_id: null, entry_type: 'concept_credit', amount: quote.wallet_credit_amount, status: 'confirmed', reference: ctx.budget.number,
        notes: 'Saldo por cancelación de ' + line.name + ': ' + command.reason, occurred_at: new Date(), created_at: new Date(), created_by: ctx.actorId }, { transaction });
      const creditNotes = quote.requires_credit_note ? await (rectify || (args => require('./patientEconomics.service').rectifyEconomicCancellation(args)))({ ...ctx, transaction, adjustmentId: id, allocations: quote.funding_allocations, reason: command.reason }) : [];
      if (voucher) {
        const available = Number(voucher.available_units) - command.units;
        if (available < 0) L.fail('concept_voucher_balance_changed', 'El saldo del bono ha cambiado. Revisa la cancelación.', 409, { applied: false });
        await voucher.update({ available_units: available, status: available > 0 ? voucher.status : quote.progress.used > 0 ? 'consumed' : 'cancelled' }, { transaction });
        await db.PatientVoucherMovement.create({ voucher_id: voucher.id, movement_type: 'cancellation', units: command.units, appointment_id: null, notes: command.reason, occurred_at: new Date(), created_at: new Date(), created_by: ctx.actorId }, { transaction });
      }
      const receipt = { applied: true, adjustment_id: id, budget_id: ctx.budget.public_id, line_key: line.key, version: Number(ctx.budget.current_version), concept_revision: quote.concept_revision + 1,
        units: quote.units, cancelled_amount: quote.cancelled_amount, refund_amount: quote.refund_amount, wallet_credit_amount: quote.wallet_credit_amount,
        wallet_entry_id: walletEntry?.public_id || null, credit_notes: creditNotes, replayed: false };
      await db.EconomicConceptAdjustment.create({ id, clinic_id: ctx.clinicId, patient_id: ctx.patientId, budget_id: ctx.budget.id, budget_version: ctx.budget.current_version, line_key: line.key,
        concept_revision: quote.concept_revision + 1, units: quote.units, cancelled_amount: quote.cancelled_amount, refund_amount: quote.refund_amount, credited_amount: quote.wallet_credit_amount,
        settlement: command.settlement, refund_method: command.refund_method, reason: command.reason, funding_allocations: quote.funding_allocations,
        snapshot: { line, before: quote.progress, preview_hash: quote.preview_hash, receipt }, wallet_entry_id: walletEntry?.id || null,
        idempotency_key: command.idempotency_key, request_hash: requestHash, actor_id: ctx.actorId, created_at: new Date() }, { transaction });
      await db.EconomicBudgetEvent.create({ budget_id: ctx.budget.id, version_number: ctx.budget.current_version, event_type: 'concept_cancelled', from_status: ctx.budget.status, to_status: ctx.budget.status,
        metadata: { adjustment_id: id, line_key: line.key, concept_revision: receipt.concept_revision, units: quote.units, cancelled_amount: quote.cancelled_amount,
          refund_amount: quote.refund_amount, credited_amount: quote.wallet_credit_amount, credit_note_ids: creditNotes.map(row => row.id), no_clinical_history_erased: true, manual_settlement: true }, actor_id: ctx.actorId, created_at: new Date() }, { transaction });
      return receipt;
    });
  }
  async function workspace(input) {
    const data = await funding.load(input), scoped = { clinic_id: input.clinicId, patient_id: input.patientId };
    const vouchers = await db.PatientVoucher.findAll({ where: scoped }), voucherIds = vouchers.map(row => row.id), links = linksFromEvents(data.events);
    const [movements, appointments] = await Promise.all([
      voucherIds.length ? db.PatientVoucherMovement.findAll({ where: { voucher_id: { [Op.in]: voucherIds } } }) : [],
      voucherIds.length || links.length ? db.CitaPaciente.findAll({ where: { clinica_id: input.clinicId, paciente_id: input.patientId,
        [Op.or]: [...(voucherIds.length ? [{ voucher_id: { [Op.in]: voucherIds } }] : []), ...(links.length ? [{ id_cita: { [Op.in]: links.map(row => row.appointment_id) } }] : [])] } }) : [],
    ]);
    const result = input.workspace;
    for (const dto of result.budgets) {
      const budget = data.budgets.find(row => row.public_id === dto.id), version = budget && data.versions.find(row => String(row.budget_id) === String(budget.id) && Number(row.version_number) === Number(budget.current_version));
      if (!budget || !version) continue;
      const events = data.events.filter(row => String(row.budget_id) === String(budget.id)), lines = L.acceptedLines(budget, version, events), local = { ...data, budget, version, events, lines, vouchers: vouchers.filter(row => String(row.budget_id) === String(budget.id)), movements, appointments, links: linksFromEvents(events).filter(row => row.version === Number(version.version_number)) };
      dto.current.lines = dto.current.lines.map(line => { const accepted = lines.find(row => row.key === line.key); return accepted ? { ...line, progress: progress(accepted, local) } : line; });
      const changes = data.adjustments.filter(row => String(row.budget_id) === String(budget.id));
      const cancelled = changes.reduce((sum, row) => sum + L.cents(row.cancelled_amount), 0), released = changes.reduce((sum, row) => sum + L.cents(row.refund_amount) + L.cents(row.credited_amount), 0);
      const payable = Math.max(0, L.cents(dto.financial_summary.payable) - cancelled), paid = Math.max(0, L.cents(dto.financial_summary.paid) - released);
      dto.financial_summary = { ...dto.financial_summary, payable: L.money(payable), paid: L.money(paid), pending: L.money(Math.max(0, payable - paid)), cancelled: L.money(cancelled), refunded: L.money(changes.reduce((sum, row) => sum + L.cents(row.refund_amount), 0)), credited: L.money(changes.reduce((sum, row) => sum + L.cents(row.credited_amount), 0)) };
      dto.fiscal_summary = funding.fiscalSummary(data.parts.filter(part => String(part.budget_id) === String(budget.id)), data);
    }
    for (const payment of result.payments) {
      const raw = data.payments.find(row => row.public_id === payment.id);
      payment.fiscal_summary = funding.fiscalSummary(raw ? data.parts.filter(part => String(part.payment_id) === String(raw.id)) : [], data);
    }
    for (const entry of result.wallet.entries) {
      const raw = data.wallet.find(row => row.public_id === entry.id);
      entry.fiscal_summary = funding.fiscalSummary(raw ? data.parts.filter(part => String(part.wallet_entry_id) === String(raw.id)) : [], data);
    }
    result.concept_adjustments = data.adjustments.map(row => ({ id: row.id, budget_id: data.budgets.find(budget => String(budget.id) === String(row.budget_id))?.public_id, line_key: row.line_key,
      units: Number(row.units), cancelled_amount: Number(row.cancelled_amount), refund_amount: Number(row.refund_amount), credited_amount: Number(row.credited_amount), settlement: row.settlement, refund_method: row.refund_method, reason: row.reason, occurred_at: row.created_at, actor_id: row.actor_id }));
    const activeLines = result.budgets.filter(row => ['accepted', 'partially_accepted'].includes(row.status)).flatMap(row => row.current.lines).filter(line => line.progress?.remaining > 0);
    const linkedVouchers = new Set(activeLines.map(line => line.fulfillment_voucher_id).filter(Boolean));
    result.clinical_service_count = activeLines.length + result.vouchers.filter(row => !row.budget_id && !linkedVouchers.has(row.id) && ['active', 'pending'].includes(row.status) && Number(row.available_units) > 0).length;
    return result;
  }
  return { context, facts, progress, bookingSource, recordBooked, paymentPreview, cancellationPreview, cancel, workspace };
}
let singleton;
module.exports = { createService, ...Object.fromEntries(['bookingSource', 'recordBooked', 'paymentPreview', 'cancellationPreview', 'cancel', 'workspace'].map(method => [method, input => { singleton ||= createService({ db: require('../../models') }); return singleton[method](input); }])) };
