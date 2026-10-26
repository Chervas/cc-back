'use strict';
const { Op } = require('sequelize');
const json = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const fail = (status, code, message) => { throw Object.assign(Error(message), { statusCode: status, code }); };
const review = () => fail(409, 'accounting_budget_source_requires_review', 'El origen contiene versiones o relaciones que requieren revisión.');

function createService({ db = require('../../models'), readBudget = input => require('./patientEconomics.service').readBudgetForAccounting(input) } = {}) {
  async function read({ documentId, clinicId }) {
    if (!Number.isSafeInteger(clinicId) || clinicId < 1) fail(400, 'clinic_scope_required', 'Indica una clínica válida.');
    const document = await db.PatientFiscalDocument.findOne({ where: { public_id: documentId, clinic_id: clinicId } });
    if (!document) fail(404, 'fiscal_document_not_found', 'Documento fiscal no encontrado.');
    const payment = document.payment_id ? await db.EconomicPayment.findOne({ where: {
      id: document.payment_id, clinic_id: clinicId, patient_id: document.patient_id,
    } }) : null;
    if (document.payment_id && !payment) review();
    const coverages = db.EconomicFiscalCoverage ? await db.EconomicFiscalCoverage.findAll({ where: {
      document_id: document.id, status: { [Op.in]: ['reserved', 'issued'] },
    } }) : [];
    if (coverages.some(row => Number(row.clinic_id) !== clinicId || String(row.patient_id) !== String(document.patient_id))) review();
    const budgetIds = [...new Set([document.budget_id, payment?.budget_id, ...coverages.map(row => row.budget_id)].filter(value => value != null).map(String))];
    if (!budgetIds.length) fail(404, 'accounting_budget_source_not_found', 'Este documento no tiene un presupuesto de origen verificable.');
    if (budgetIds.length !== 1) review();
    const budget = await db.EconomicBudget.findOne({ where: { id: budgetIds[0], clinic_id: clinicId, patient_id: document.patient_id } });
    if (!budget) review();
    const data = json(document.payment_data), saved = data.source;
    if (saved?.type === 'budget' && saved.id !== budget.public_id || saved?.type === 'payment' && (!payment || saved.id !== payment.public_id)
      || data.budget_public_id && data.budget_public_id !== budget.public_id) review();
    const candidates = [];
    for (const row of coverages) if (row.budget_id != null) {
      if (String(row.budget_id) !== String(budget.id)) review();
      if (row.budget_version != null) candidates.push({ version: Number(row.budget_version), origin: 'fiscal_coverage' });
    }
    if (payment?.budget_version != null) candidates.push({ version: Number(payment.budget_version), origin: 'payment' });
    if (data.fiscal_price_source?.budget_version != null) candidates.push({ version: Number(data.fiscal_price_source.budget_version), origin: 'fiscal_price_source' });
    if (candidates.some(row => !Number.isSafeInteger(row.version) || row.version < 1)) review();
    const versions = [...new Set(candidates.map(row => row.version))];
    if (versions.length > 1) review();
    let version = versions[0], origin = candidates[0]?.origin;
    if (version == null) {
      const stored = await db.EconomicBudgetVersion.findAll({ where: { budget_id: budget.id }, attributes: ['version_number'], limit: 2 });
      if (stored.length !== 1) review();
      version = Number(stored[0].version_number); origin = 'single_stored_version';
      if (!Number.isSafeInteger(version) || version < 1) review();
    }
    const view = await readBudget({ publicId: budget.public_id, clinicId, versionNumber: version });
    if (view.budget.id !== budget.public_id || Number(view.budget.clinic_id) !== clinicId || String(view.budget.patient_id) !== String(document.patient_id)
      || Number(view.budget.current?.version) !== version) review();
    return { readonly: true, ...view, source: { document_id: document.public_id, budget_id: budget.public_id,
      version, budget_current_version: Number(budget.current_version), version_origin: origin } };
  }
  return { read };
}
let instance;
module.exports = { createService, read: input => (instance ||= createService()).read(input) };
