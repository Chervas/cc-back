'use strict';
const crypto = require('node:crypto'), { Op } = require('sequelize');
const L = require('../lib/economic-concept-ledger'), prices = require('../lib/economicPriceProfile');
function createService({ db, helpers: H } = {}) {
  const funding = require('./economicFunding.service').createService({ db });
  const scope = ctx => ({ clinic_id: ctx.clinicId, patient_id: ctx.patientId });
  const snapshot = document => ({ ...H.serializeFiscalDocument(document), budget_id: L.parse(document.payment_data).budget_public_id || (L.parse(document.payment_data).source?.type === 'budget' ? L.parse(document.payment_data).source.id : null), version: Number(document.version_number || 1) });
  async function context(input, transaction, writing = false) {
    const { patient, clinic } = await H.loadContext(input.patientIdentifier, input.clinicId);
    if (writing) await db.Paciente.findByPk(patient.id_paciente, { attributes: ['id_paciente'], transaction, lock: transaction.LOCK.UPDATE });
    return { patient, clinic, patientId: Number(patient.id_paciente), clinicId: Number(input.clinicId), actorId: input.actorId };
  }
  function origin(payload, document) {
    const saved = L.parse(document?.payment_data).source;
    const type = saved?.type || payload.source_type || payload.source?.type;
    const id = saved?.id || payload.source_id || payload.source?.id;
    if (!['budget', 'payment'].includes(type) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) L.fail('fiscal_paid_source_required', 'Selecciona un cobro confirmado o el dinero aplicado a un presupuesto. No se admiten facturas o recibos manuales pendientes de cobro.', 400);
    if (document && (payload.source_type && payload.source_type !== type || payload.source_id && payload.source_id !== id)) L.fail('fiscal_source_immutable', 'El origen del documento se conserva. Crea otro documento para cambiarlo.', 400);
    return { type, id };
  }
  function select(data, source, kind, document) {
    const parent = source.type === 'payment' ? data.payments.find(row => row.public_id === source.id && row.status === 'confirmed') : data.budgets.find(row => row.public_id === source.id);
    if (!parent) L.fail('fiscal_source_not_found', 'El origen no pertenece a este paciente y clínica o el cobro ya no está confirmado.', 404);
    let parts = data.parts.filter(part => source.type === 'payment' ? String(part.payment_id) === String(parent.id) : String(part.budget_id) === String(parent.id));
    if (kind === 'receipt') parts = parts.filter(part => part.source_kind === 'payment');
    else parts = parts.filter(part => part.budget_id != null);
    // Unknown historical coverage cannot be silently assigned to another
    // payment or concept. Existing documents remain readable and unchanged.
    const budgetIds = new Set(parts.filter(row => row.budget_id != null).map(row => String(row.budget_id))), paymentIds = new Set(parts.filter(row => row.payment_id != null).map(row => String(row.payment_id)));
    const legacy = data.documents.find(row => row.status !== 'voided' && row.document_type === kind && String(row.id) !== String(document?.id)
      && (budgetIds.has(String(row.budget_id)) || paymentIds.has(String(row.payment_id))) && Number(L.parse(row.totals).total) > 0
      && !data.coverages.some(coverage => String(coverage.document_id) === String(row.id)));
    if (legacy) L.fail('fiscal_legacy_coverage_review_required', 'Hay documentos anteriores sin atribución verificable a cobros. Revisa su cobertura antes de emitir otro documento.', 409, { document_id: legacy.public_id, number: legacy.number });
    return { parent, parts };
  }
  function projection(data, source, kind, payload, document) {
    if (!['invoice', 'receipt'].includes(kind)) L.fail('fiscal_rectification_origin_required', 'Las rectificativas deben vincularse a una factura emitida y a la corrección del concepto.', 400);
    const { parent, parts } = select(data, source, kind, document), requested = payload.source_amount ?? (document ? L.parse(document.totals).total : null);
    let eligible = parts;
    if (payload.funding_keys !== undefined) {
      if (!Array.isArray(payload.funding_keys) || !payload.funding_keys.length || payload.funding_keys.length > 500 || new Set(payload.funding_keys).size !== payload.funding_keys.length
        || payload.funding_keys.some(key => !parts.some(part => part.funding_key === key))) L.fail('fiscal_funding_selection_invalid', 'Selecciona partes del cobro de este origen.', 400);
      eligible = parts.filter(part => payload.funding_keys.includes(part.funding_key));
    }
    const available = eligible.reduce((sum, part) => sum + funding.available(part, data, kind, document?.id), 0), amount = requested == null ? available : L.cents(requested);
    if (!amount || amount > available) L.fail('fiscal_source_amount_exceeded', 'El importe supera el dinero confirmado pendiente de documentar para este tipo de documento.', 409, { available: L.money(available), document_type: kind });
    let remaining = amount; const lines = [], allocations = [];
    for (const part of eligible) {
      if (!remaining) break;
      const rest = funding.available(part, data, kind, document?.id), applied = Math.min(remaining, rest); if (!applied) continue;
      const info = L.parse(part.snapshot), profile = kind === 'invoice' ? info.profile : null;
      if (kind === 'invoice' && !profile) L.fail('fiscal_paid_tax_review_required', 'Este dinero no tiene un desglose fiscal explícito verificable. Confirma su atribución y el impuesto antes de facturarlo.', 422);
      if (profile) prices.normalizeProfile(profile);
      const previous = data.coverages.filter(row => row.funding_key === part.funding_key && (row.document_type === kind || kind === 'invoice' && row.document_type === 'credit_note') && String(row.document_id) !== String(document?.id));
      const released = data.adjustments.flatMap(row => L.parse(row.funding_allocations, [])).filter(row => row.funding_key === part.funding_key);
      const originalBase = kind === 'receipt' ? L.cents(part.amount) : L.cents(part.taxable_base);
      const usedBase = previous.reduce((sum, row) => sum + Math.round(Number(row.taxable_base) * 100), 0), releasedBase = kind === 'receipt' ? released.reduce((sum, row) => sum + L.cents(row.amount), 0) : released.reduce((sum, row) => sum + L.cents(row.taxable_base), 0);
      const baseLeft = Math.max(0, originalBase - usedBase - releasedBase), base = applied === rest ? baseLeft : Math.round(applied * baseLeft / rest), tax = applied - base;
      const key = 'funding-' + L.hash(part.funding_key).slice(0, 24);
      lines.push({ key, source_line_key: part.line_key || null, description: info.description, quantity: 1, unit_price: L.money(applied), discount_percent: 0,
        price_semantics: kind === 'receipt' ? 'payment_receipt' : prices.SEMANTICS, tax_percent: profile?.tax_percent || 0, exemption_reason: profile?.exemption_reason || null,
        taxable_base: L.money(base), tax_amount: L.money(tax), total: L.money(applied) });
      allocations.push({ funding_key: part.funding_key, source_kind: part.source_kind, payment_id: part.payment_id || null, wallet_entry_id: part.wallet_entry_id || null,
        budget_id: part.budget_id || null, budget_version: part.budget_version || null, line_key: part.line_key || null, amount: L.money(applied), taxable_base: L.money(base), tax_amount: L.money(tax) });
      remaining -= applied;
    }
    if (lines.length > 500) L.fail('fiscal_lines_limit', 'Selecciona un máximo de quinientas partes de cobro.', 413);
    return { parent, allocations, lines, totals: { currency: 'EUR', total: L.money(amount), taxable_base: L.money(lines.reduce((sum, row) => sum + L.cents(row.taxable_base), 0)), taxes: L.money(lines.reduce((sum, row) => sum + L.cents(row.tax_amount), 0)) },
      source_amount: L.money(eligible.reduce((sum, part) => sum + Math.max(0, L.cents(part.amount) - funding.released(data, part.funding_key)), 0)), available_amount: L.money(available), lines_locked: true,
      price_semantics: kind === 'receipt' ? 'payment_receipt' : prices.SEMANTICS };
  }
  async function preview(input) {
    const ctx = await context(input), payload = input.payload || {}, data = await funding.load(ctx), document = payload.document_id ? data.documents.find(row => row.public_id === payload.document_id) : null;
    if (payload.document_id && !document) L.fail('fiscal_document_not_found', 'Documento no encontrado.', 404);
    if (document && document.status !== 'draft') L.fail('fiscal_document_not_editable', 'Sólo se editan borradores.');
    const result = projection(data, origin(payload, document), document?.document_type || payload.document_type, payload, document);
    const { parent, allocations, ...dto } = result; return { ...dto, funding_allocations: allocations.map(row => ({ funding_key: row.funding_key, line_key: row.line_key, amount: row.amount })), source_version: Number(result.parent.current_version || result.parent.budget_version) || null };
  }
  async function save(input) {
    const payload = input.payload || {}, requestKey = L.key(payload.idempotency_key), operation = input.id ? 'update' : 'create', requestHash = L.hash({ operation, id: input.id || null, payload });
    return db.sequelize.transaction(async transaction => {
      let located = null;
      if (input.id) {
        located = await db.PatientFiscalDocument.findOne({ where: { public_id: input.id }, attributes: ['id', 'patient_id', 'clinic_id'] });
        if (!located) L.fail('fiscal_document_not_found', 'Documento no encontrado.', 404);
        input = { ...input, patientIdentifier: located.patient_id, clinicId: located.clinic_id };
      }
      const ctx = await context(input, transaction, true);
      const receipt = await db.EconomicFiscalCommand.findOne({ where: { ...scope(ctx), idempotency_key: requestKey } });
      if (receipt) {
        if (receipt.request_hash !== requestHash || Number(receipt.actor_id) !== Number(input.actorId)) L.fail('economic_request_conflict', 'Esta solicitud ya corresponde a otro documento o contenido.');
        return { ...L.parse(receipt.snapshot), replayed: true };
      }
      let document = located ? await db.PatientFiscalDocument.findByPk(located.id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (document && !Number.isSafeInteger(payload.expected_version)) L.fail('fiscal_document_version_required', 'Vuelve a cargar el borrador antes de guardarlo.', 428, { applied: false });
      if (document && (document.status !== 'draft' || Number(payload.expected_version) !== Number(document.version_number || 1))) L.fail('fiscal_document_version_conflict', 'El documento ha cambiado. Conserva tu edición y consulta la versión vigente.', 409, { applied: false });
      if (!document && payload.expected_version !== undefined && payload.expected_version !== 0) L.fail('fiscal_document_version_conflict', 'El nuevo documento no puede tener una versión anterior.', 409, { applied: false });
      const data = await funding.load({ ...ctx, transaction, persist: true }), kind = document?.document_type || payload.document_type, source = origin(payload, document), result = projection(data, source, kind, payload, document);
      const status = payload.status || 'draft'; if (!['draft', 'issued'].includes(status)) L.fail('fiscal_document_status_invalid', 'Revisa el estado del documento.', 400);
      const issuer = H.normalizeFiscalParty(payload.issuer, document ? L.parse(document.issuer_snapshot) : await H.mapClinicSnapshot(ctx.clinic));
      const recipient = H.normalizeFiscalParty(payload.recipient, document ? L.parse(document.recipient_snapshot) : H.mapPatientSnapshot(ctx.patient));
      H.assertFiscalParties({ documentType: kind, status, issuer, recipient });
      const template = await H.resolveTemplate({ clinicId: ctx.clinicId, templateId: payload.template_id || L.parse(document?.template_snapshot).id, templateType: 'invoice' });
      const series = document?.series || payload.series || (kind === 'receipt' ? 'REC' : 'FAC');
      if (typeof series !== 'string' || !/^[A-Za-z0-9_-]{1,30}$/.test(series)) L.fail('fiscal_series_invalid', 'Indica una serie válida.', 400);
      const version = Number(document?.version_number || 0) + 1, number = document?.number || await H.nextFiscalNumber({ clinicId: ctx.clinicId, documentType: kind, series, transaction });
      const values = { document_type: kind, series, number, status, version_number: version, issuer_snapshot: issuer, recipient_snapshot: recipient,
        lines: result.lines, totals: result.totals, issue_date: H.dateOrNull(payload.issue_date) || document?.issue_date || new Date(), due_date: H.dateOrNull(payload.due_date),
        payment_data: { source: { ...source, applied_amount: result.totals.total }, budget_public_id: source.type === 'budget' ? result.parent.public_id : data.budgets.find(row => String(row.id) === String(result.parent.budget_id))?.public_id || null, coverage_schema_version: 1,
          fiscal_price_source: { schema_version: 2, funding_keys: result.allocations.map(row => row.funding_key) } },
        template_snapshot: { id: template.public_id, name: template.name, config: { ...L.parse(template.config), logo_mode: payload.logo_mode || L.parse(template.config).logo_mode || 'clinic', logo_url: payload.logo_url || L.parse(template.config).logo_url || null } },
        verifactu_status: kind === 'receipt' ? 'not_applicable' : status === 'issued' ? 'ready' : 'mock_pending', notes: payload.notes ?? document?.notes ?? null, updated_by: input.actorId };
      if (document) {
        await db.EconomicFiscalCoverage.update({ status: 'released' }, { where: { document_id: document.id, status: { [Op.in]: ['reserved', 'issued'] } }, transaction });
        await document.update(values, { transaction });
      } else document = await db.PatientFiscalDocument.create({ ...values, public_id: crypto.randomUUID(), ...scope(ctx),
        budget_id: source.type === 'budget' ? result.parent.id : result.parent.budget_id || null, payment_id: source.type === 'payment' ? result.parent.id : null, created_by: input.actorId }, { transaction });
      for (const allocation of result.allocations) await db.EconomicFiscalCoverage.create({ id: crypto.randomUUID(), ...scope(ctx), document_id: document.id, document_version: version,
        document_type: kind, ...allocation, status: status === 'issued' ? 'issued' : 'reserved', actor_id: input.actorId, created_at: new Date() }, { transaction });
      const dto = snapshot(document);
      await db.EconomicFiscalCommand.create({ id: crypto.randomUUID(), ...scope(ctx), document_id: document.id, document_version: version, operation,
        idempotency_key: requestKey, request_hash: requestHash, snapshot: dto, actor_id: input.actorId, created_at: new Date() }, { transaction });
      return { ...dto, replayed: false };
    });
  }
  async function rectify(input) {
    const { transaction, clinicId, patientId, actorId, adjustmentId } = input;
    if (!transaction) L.fail('fiscal_rectification_transaction_required', 'No se pudo registrar la rectificativa enlazada.', 500);
    const data = await funding.load({ clinicId, patientId, transaction }), groups = new Map();
    for (const allocation of input.allocations) {
      let pending = L.cents(allocation.credit_note_amount); if (!pending) continue;
      const invoices = data.coverages.filter(row => row.funding_key === allocation.funding_key && row.document_type === 'invoice' && row.status === 'issued').sort((a, b) => String(a.document_id).localeCompare(String(b.document_id)));
      for (const original of invoices) {
        if (!pending) break;
        const document = data.documents.find(row => String(row.id) === String(original.document_id));
        if (!document || document.status !== 'issued') L.fail('fiscal_rectification_source_invalid', 'La factura de origen requiere revisión antes de rectificarla.');
        const credits = data.coverages.filter(row => row.funding_key === allocation.funding_key && row.document_type === 'credit_note' && data.documents.some(note => String(note.id) === String(row.document_id) && String(note.rectifies_document_id) === String(document.id)));
        const previousGross = -credits.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0), previousBase = -credits.reduce((sum, row) => sum + Math.round(Number(row.taxable_base) * 100), 0);
        const available = L.cents(original.amount) - previousGross, gross = Math.min(pending, available); if (gross <= 0) continue;
        const baseLeft = L.cents(original.taxable_base) - previousBase, base = gross === available ? baseLeft : Math.round(gross * baseLeft / available);
        if (!groups.has(String(document.id))) groups.set(String(document.id), { document, rows: [] });
        const part = data.parts.find(part => part.funding_key === allocation.funding_key);
        if (!part || !L.parse(part.snapshot).profile) L.fail('fiscal_rectification_profile_required', 'No se puede verificar el desglose original de esta factura.', 422);
        groups.get(String(document.id)).rows.push({ part, original, amount: gross, base, tax: gross - base }); pending -= gross;
      }
      if (pending) L.fail('fiscal_rectification_amount_changed', 'La parte facturada ha cambiado. Revisa de nuevo la devolución.');
    }
    const notes = [];
    for (const { document: original, rows } of groups.values()) {
      const lines = rows.map(({ part, amount, base, tax }) => ({ key: 'rect-' + L.hash(part.funding_key).slice(0, 24), source_line_key: part.line_key,
        description: 'Rectificación de ' + original.number + ': ' + L.parse(part.snapshot).description, quantity: 1, unit_price: -L.money(amount), discount_percent: 0,
        price_semantics: prices.SEMANTICS, tax_percent: L.parse(part.snapshot).profile.tax_percent, exemption_reason: L.parse(part.snapshot).profile.exemption_reason,
        taxable_base: -L.money(base), tax_amount: -L.money(tax), total: -L.money(amount) }));
      const totals = { currency: 'EUR', total: -L.money(rows.reduce((sum, row) => sum + row.amount, 0)), taxable_base: -L.money(rows.reduce((sum, row) => sum + row.base, 0)), taxes: -L.money(rows.reduce((sum, row) => sum + row.tax, 0)) };
      const series = 'RECT', number = await H.nextFiscalNumber({ clinicId, documentType: 'credit_note', series, transaction });
      const note = await db.PatientFiscalDocument.create({ public_id: crypto.randomUUID(), clinic_id: clinicId, patient_id: patientId, budget_id: original.budget_id, payment_id: original.payment_id,
        document_type: 'credit_note', rectifies_document_id: original.id, series, number, status: 'issued', version_number: 1, issue_date: new Date(), due_date: null,
        issuer_snapshot: L.parse(original.issuer_snapshot), recipient_snapshot: L.parse(original.recipient_snapshot), lines, totals,
        payment_data: { rectifies_document: { id: original.public_id, number: original.number, version: Number(original.version_number || 1) }, adjustment_id: adjustmentId, reason: input.reason, coverage_schema_version: 1 },
        template_snapshot: L.parse(original.template_snapshot), verifactu_status: 'ready', notes: input.reason, created_by: actorId, updated_by: actorId }, { transaction });
      for (const row of rows) await db.EconomicFiscalCoverage.create({ id: crypto.randomUUID(), clinic_id: clinicId, patient_id: patientId, document_id: note.id, document_version: 1, document_type: 'credit_note',
        funding_key: row.part.funding_key, source_kind: row.part.source_kind, payment_id: row.part.payment_id, wallet_entry_id: row.part.wallet_entry_id, budget_id: row.part.budget_id,
        budget_version: row.part.budget_version, line_key: row.part.line_key, amount: -L.money(row.amount), taxable_base: -L.money(row.base), tax_amount: -L.money(row.tax), status: 'issued', actor_id: actorId, created_at: new Date() }, { transaction });
      const dto = snapshot(note);
      await db.EconomicFiscalCommand.create({ id: crypto.randomUUID(), clinic_id: clinicId, patient_id: patientId, document_id: note.id, document_version: 1, operation: 'rectify',
        idempotency_key: 'rectify:' + adjustmentId + ':' + original.public_id, request_hash: L.hash({ adjustmentId, original: original.public_id, totals }), snapshot: dto, actor_id: actorId, created_at: new Date() }, { transaction });
      notes.push(dto);
    }
    return notes;
  }
  return { preview, save, projection, rectify };
}
module.exports = { createService };
