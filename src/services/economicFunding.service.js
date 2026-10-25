'use strict';
const crypto = require('node:crypto'), { Op } = require('sequelize');
const L = require('../lib/economic-concept-ledger'), prices = require('../lib/economicPriceProfile');
const plain = value => value?.toJSON ? value.toJSON() : value;
function createService({ db } = {}) {
  async function load({ clinicId, patientId, transaction, lock = false, persist = false }) {
    const scoped = { clinic_id: clinicId, patient_id: patientId }, locking = lock && transaction ? { lock: transaction.LOCK.UPDATE } : {};
    const [budgets, payments, wallet, saved, adjustments, coverages, documents] = await Promise.all([
      db.EconomicBudget.findAll({ where: scoped, transaction, ...locking }),
      db.EconomicPayment.findAll({ where: scoped, order: [['id', 'ASC']], transaction, ...locking }),
      db.PatientWalletEntry.findAll({ where: scoped, order: [['id', 'ASC']], transaction, ...locking }),
      db.EconomicFundingPart.findAll({ where: scoped, transaction, ...locking }),
      db.EconomicConceptAdjustment.findAll({ where: scoped, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction, ...locking }),
      db.EconomicFiscalCoverage.findAll({ where: { ...scoped, status: { [Op.in]: ['reserved', 'issued'] } }, transaction, ...locking }),
      db.PatientFiscalDocument.findAll({ where: scoped, transaction, ...locking }),
    ]);
    const ids = budgets.map(row => row.id), [versions, events] = ids.length ? await Promise.all([
      db.EconomicBudgetVersion.findAll({ where: { budget_id: { [Op.in]: ids } }, transaction }),
      db.EconomicBudgetEvent.findAll({ where: { budget_id: { [Op.in]: ids } }, order: [['id', 'ASC']], transaction }),
    ]) : [[], []];
    const data = { clinicId, patientId, budgets, payments, wallet, adjustments, coverages, documents, versions, events, parts: saved.map(plain) };
    const byKey = new Map(data.parts.map(part => [part.funding_key, part]));
    async function add(part) {
      const prior = byKey.get(part.funding_key);
      if (prior) {
        if (L.parse(prior.snapshot).source_hash !== part.snapshot.source_hash || L.cents(prior.amount) !== L.cents(part.amount)) L.fail('economic_funding_source_changed', 'La aplicación de un cobro ha cambiado y requiere revisión.');
        return;
      }
      const row = { id: crypto.randomUUID(), ...scoped, ...part, created_at: new Date() };
      if (persist) await db.EconomicFundingPart.create(row, { transaction });
      byKey.set(row.funding_key, row); data.parts.push(row);
    }
    const budgetMap = new Map(budgets.map(row => [String(row.id), row]));
    for (const payment of payments.filter(row => row.status === 'confirmed')) {
      const allocations = L.parse(payment.application).allocations;
      if (!Array.isArray(allocations) || allocations.some(item => !['budget', 'budget_line', 'wallet'].includes(item.target_type))
        || allocations.reduce((sum, item) => sum + L.cents(item.amount), 0) !== L.cents(payment.amount)) L.fail('economic_funding_allocation_review', 'Revisa la aplicación del cobro antes de documentarlo.');
      const budget = payment.budget_id ? budgetMap.get(String(payment.budget_id)) : null;
      if (payment.budget_id && !budget) L.fail('economic_funding_scope_invalid', 'El presupuesto del cobro no pertenece a este paciente y clínica.');
      const version = budget && versions.find(row => String(row.budget_id) === String(budget.id) && Number(row.version_number) === Number(payment.budget_version || budget.current_version));
      const lines = version ? L.acceptedLines(budget, version, events.filter(row => String(row.budget_id) === String(budget.id))) : [];
      const sourceHash = L.hash({ budget_id: payment.budget_id ? String(payment.budget_id) : null, version: Number(payment.budget_version) || null, amount: L.cents(payment.amount), application: L.parse(payment.application) });
      for (let i = 0; i < allocations.length; i++) {
        const allocation = allocations[i], cash = L.cents(allocation.amount); if (!cash) continue;
        const direct = allocation.target_type === 'budget_line' ? lines.find(row => row.key === allocation.line_key) : allocation.target_type === 'budget' && lines.length === 1 ? lines[0] : null;
        if (allocation.target_type === 'budget_line' && !direct) L.fail('economic_funding_line_review', 'Un cobro apunta a un concepto que no consta aceptado en su versión.');
        const profile = direct?.profile || (allocation.target_type === 'budget' ? prices.commonProfile(lines.map(line => line.profile)) : null);
        const tax = profile ? prices.breakdown(L.money(cash), profile) : { taxable_base: L.money(cash), tax_amount: 0 };
        await add({ funding_key: 'payment:' + payment.public_id + ':' + i, source_kind: 'payment', payment_id: payment.id, wallet_entry_id: null,
          budget_id: allocation.target_type === 'wallet' ? null : budget?.id || null, budget_version: version?.version_number || null, line_key: direct?.key || null,
          amount: L.money(cash), taxable_base: tax.taxable_base, tax_amount: tax.tax_amount,
          snapshot: { source_hash: sourceHash, payment_id: payment.public_id, budget_id: budget?.public_id || null, allocation_index: i,
            target_type: allocation.target_type, attribution: direct ? 'explicit' : 'unassigned', profile,
            description: direct?.name || allocation.label || (allocation.target_type === 'wallet' ? 'Anticipo del paciente' : 'Cobro a cuenta de ' + (budget?.number || 'presupuesto')) } });
      }
    }
    for (const entry of wallet.filter(row => row.status === 'confirmed' && row.entry_type === 'allocation' && Number(row.amount) < 0)) {
      const budget = budgetMap.get(String(entry.budget_id)); if (!budget) L.fail('economic_funding_scope_invalid', 'La aplicación de saldo no corresponde a un presupuesto de este paciente.');
      const version = versions.find(row => String(row.budget_id) === String(budget.id) && Number(row.version_number) === Number(budget.current_version));
      const lines = version ? L.acceptedLines(budget, version, events.filter(row => String(row.budget_id) === String(budget.id))) : [], direct = lines.length === 1 ? lines[0] : null;
      const profile = direct?.profile || prices.commonProfile(lines.map(line => line.profile)), amount = Math.abs(Number(entry.amount)), tax = profile ? prices.breakdown(amount, profile) : { taxable_base: amount, tax_amount: 0 };
      await add({ funding_key: 'wallet:' + entry.public_id, source_kind: 'wallet_allocation', payment_id: null, wallet_entry_id: entry.id,
        budget_id: budget.id, budget_version: version?.version_number || null, line_key: direct?.key || null, amount, taxable_base: tax.taxable_base, tax_amount: tax.tax_amount,
        snapshot: { source_hash: L.hash({ budget_id: String(entry.budget_id), amount: -L.cents(amount), entry_type: entry.entry_type }), wallet_entry_id: entry.public_id,
          budget_id: budget.public_id, attribution: direct ? 'explicit' : 'unassigned', profile, description: direct?.name || 'Saldo aplicado a ' + budget.number } });
    }
    const confirmedPayments = new Set(payments.filter(row => row.status === 'confirmed').map(row => String(row.id))), confirmedWallet = new Set(wallet.filter(row => row.status === 'confirmed').map(row => String(row.id)));
    data.parts = data.parts.filter(part => part.source_kind === 'payment' ? confirmedPayments.has(String(part.payment_id)) : confirmedWallet.has(String(part.wallet_entry_id)));
    return data;
  }
  function released(data, fundingKey) { return data.adjustments.flatMap(row => L.parse(row.funding_allocations, [])).filter(row => row.funding_key === fundingKey).reduce((sum, row) => sum + L.cents(row.amount), 0); }
  function available(part, data, kind, excludeDocumentId = null) {
    const used = data.coverages.filter(row => row.funding_key === part.funding_key && (row.document_type === kind || kind === 'invoice' && row.document_type === 'credit_note') && String(row.document_id) !== String(excludeDocumentId))
      .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
    return Math.max(0, L.cents(part.amount) - released(data, part.funding_key) - used);
  }
  function fiscalSummary(parts, data) {
    const out = {};
    for (const kind of ['invoice', 'receipt']) {
      const eligible = parts.filter(part => kind === 'receipt' ? part.source_kind === 'payment' : part.budget_id != null);
      const keys = new Set(eligible.map(part => part.funding_key)), rows = data.coverages.filter(row => (row.document_type === kind || kind === 'invoice' && row.document_type === 'credit_note') && keys.has(row.funding_key));
      const amount = eligible.reduce((sum, part) => sum + Math.max(0, L.cents(part.amount) - released(data, part.funding_key)), 0);
      const documents = [...new Set(rows.map(row => String(row.document_id)))].flatMap(id => {
        const document = data.documents.find(row => String(row.id) === id); if (!document) return [];
        return [{ id: document.public_id, number: document.number, status: document.status, document_type: document.document_type, amount: L.money(rows.filter(row => String(row.document_id) === id).reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0)) }];
      });
      const documented = rows.filter(row => row.status === 'issued').reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0), reserved = rows.filter(row => row.status === 'reserved').reduce((sum, row) => sum + L.cents(row.amount), 0);
      const budgetIds = new Set(eligible.filter(part => part.budget_id != null).map(part => String(part.budget_id))), paymentIds = new Set(eligible.filter(part => part.payment_id != null).map(part => String(part.payment_id)));
      const legacy = data.documents.filter(document => document.status !== 'voided' && document.document_type === kind && Number(L.parse(document.totals).total) > 0
        && (budgetIds.has(String(document.budget_id)) || paymentIds.has(String(document.payment_id))) && !data.coverages.some(row => String(row.document_id) === String(document.id)));
      for (const document of legacy) documents.push({ id: document.public_id, number: document.number, status: document.status, document_type: document.document_type, amount: Number(L.parse(document.totals).total), coverage_unknown: true });
      out[kind] = { amount: L.money(amount), documented: L.money(documented), undocumented: L.money(Math.max(0, amount - documented)), uninvoiced: L.money(Math.max(0, amount - documented)), reserved: L.money(reserved), remaining: L.money(Math.max(0, amount - documented - reserved)), documents,
        review_required: legacy.length > 0, attribution: legacy.length ? 'unassigned' : 'explicit',
        allocations: eligible.map(part => ({ funding_key: part.funding_key, line_key: part.line_key || null, amount: Number(part.amount), remaining: legacy.length ? 0 : L.money(available(part, data, kind)), attribution: L.parse(part.snapshot).attribution })) };
      if (legacy.length) Object.assign(out[kind], { documented: null, undocumented: null, uninvoiced: null, reserved: null, remaining: 0 });
    }
    return out;
  }
  return { load, released, available, fiscalSummary };
}
module.exports = { createService };
