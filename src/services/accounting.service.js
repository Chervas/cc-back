'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const clinicalPrivateStorage = require('./clinicalPrivateStorage.service');
const patientEconomics = require('./patientEconomics.service');

const {
  AccountingExpenseDocument,
  AccountingCashMovement,
  AccountingCashClosure,
  AccountingCashSession,
  AccountingPayrollDocument,
  AccountingPayrollPeriod,
  ClinicalPrivateAsset,
  EconomicPayment,
  PatientFiscalDocument,
  Clinica,
  Usuario,
  UsuarioClinica,
} = db;

const EXPENSE_STATUSES = new Set(['pending', 'paid', 'cancelled']);
const EXPENSE_PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'direct_debit', 'other']);
const CASH_MOVEMENT_TYPES = new Set(['income', 'expense', 'adjustment']);
const CASH_METHODS = new Set(['cash', 'card', 'transfer', 'bizum', 'other']);
const CASH_SESSION_STATUSES = new Set(['open', 'closed']);
const PAYROLL_STATUSES = new Set(['draft', 'scheduled', 'paid']);
const DEFAULT_CLINIC_TIME_ZONE = 'Europe/Madrid';
const MAX_EXPENSE_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const EXPENSE_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

function domainError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function clean(value, max = 255) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function dateOnly(value, fallback = null) {
  const text = clean(value, 30);
  if (!text) return fallback;
  const match = text.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return fallback;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return fallback;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function dateTime(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function periodBounds(query = {}) {
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const fromText = dateOnly(query.from);
  const toText = dateOnly(query.to);
  const from = fromText ? new Date(`${fromText}T00:00:00.000Z`) : defaultFrom;
  const toInclusive = toText ? new Date(`${toText}T00:00:00.000Z`) : new Date(defaultTo.getTime() - 86400000);
  const toExclusive = new Date(toInclusive.getTime() + 86400000);
  if (from >= toExclusive) throw domainError(400, 'accounting_period_invalid', 'El periodo contable no es válido.');
  return {
    from,
    toExclusive,
    fromDate: from.toISOString().slice(0, 10),
    toDate: new Date(toExclusive.getTime() - 86400000).toISOString().slice(0, 10),
  };
}

function parseClinicConfig(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function validTimeZone(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function clinicTimeZone(config) {
  const candidates = [config.timezone, config.timeZone, config.tz];
  return candidates.find(validTimeZone) || DEFAULT_CLINIC_TIME_ZONE;
}

function partsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function localDateTimeToUtc(dateText, timeText, timeZone) {
  const dateMatch = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeText || '').match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;
  const naiveUtc = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3]),
  );
  let timestamp = naiveUtc;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = partsInTimeZone(new Date(timestamp), timeZone);
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    timestamp = naiveUtc - (representedAsUtc - timestamp);
  }
  return new Date(timestamp);
}

function nextDate(dateText) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function dateInTimeZone(date, timeZone) {
  const parts = partsInTimeZone(date, timeZone);
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-');
}

function hasExpectedFileSignature(buffer, contentType) {
  if (contentType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function prepareExpenseAttachment(attachment) {
  if (!attachment?.base64) return null;
  const contentType = clean(attachment.content_type, 128).toLowerCase();
  if (!EXPENSE_ATTACHMENT_TYPES.has(contentType)) {
    throw domainError(400, 'expense_attachment_type_invalid', 'Adjunta un PDF, JPG, PNG o WebP.');
  }
  const encoded = String(attachment.base64)
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw domainError(400, 'expense_attachment_base64_invalid', 'El archivo adjunto no es válido.');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || !hasExpectedFileSignature(buffer, contentType)) {
    throw domainError(400, 'expense_attachment_content_invalid', 'El contenido del archivo no coincide con su formato.');
  }
  if (buffer.length > MAX_EXPENSE_ATTACHMENT_BYTES) {
    throw domainError(413, 'expense_attachment_too_large', 'El archivo no puede superar 18 MB.');
  }
  return {
    filename: clean(attachment.filename, 255) || 'factura-proveedor',
    contentType,
    buffer,
  };
}

function serializeParty(value) {
  return value && typeof value === 'object' ? value : {};
}

function serializeFiscalDocument(document) {
  const value = document.toJSON ? document.toJSON() : document;
  return {
    id: value.public_id,
    patient_id: Number(value.patient_id),
    document_type: value.document_type,
    series: value.series,
    number: value.number,
    status: value.status,
    issue_date: value.issue_date,
    due_date: value.due_date,
    issuer: serializeParty(value.issuer_snapshot),
    recipient: serializeParty(value.recipient_snapshot),
    lines: Array.isArray(value.lines) ? value.lines : [],
    totals: value.totals || {},
    payment_data: value.payment_data || null,
    template: value.template_snapshot || {},
    verifactu_status: value.verifactu_status,
    notes: value.notes || null,
    created_at: value.created_at,
  };
}

function serializeExpense(expense, asset = null) {
  const value = expense.toJSON ? expense.toJSON() : expense;
  return {
    id: value.public_id,
    clinic_id: Number(value.clinic_id),
    supplier_name: value.supplier_name,
    supplier_tax_id: value.supplier_tax_id,
    supplier_address: value.supplier_address,
    document_number: value.document_number,
    issue_date: value.issue_date,
    due_date: value.due_date,
    category: value.category,
    payment_method: value.payment_method,
    status: value.status,
    taxable_base: money(value.taxable_base),
    tax_amount: money(value.tax_amount),
    withholding_amount: money(value.withholding_amount),
    total: money(value.total),
    paid_at: value.paid_at,
    notes: value.notes,
    source_system: value.source_system,
    source_reference: value.source_reference,
    attachment: asset ? {
      id: asset.public_id,
      filename: asset.original_filename,
      content_type: asset.content_type,
      size_bytes: Number(asset.size_bytes),
    } : null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function serializeMovement(row) {
  const value = row.toJSON ? row.toJSON() : row;
  return {
    id: value.public_id,
    clinic_id: Number(value.clinic_id),
    movement_type: value.movement_type,
    amount: money(value.amount),
    method: value.method,
    description: value.description,
    source_type: value.source_type,
    source_id: value.source_id,
    occurred_at: value.occurred_at,
    created_by: value.created_by,
    created_at: value.created_at,
  };
}

function serializeClosure(row) {
  const value = row.toJSON ? row.toJSON() : row;
  return {
    id: value.public_id,
    clinic_id: Number(value.clinic_id),
    business_date: value.business_date,
    opening_cash: money(value.opening_cash),
    cash_receipts: money(value.cash_receipts),
    cash_outflows: money(value.cash_outflows),
    expected_cash: money(value.expected_cash),
    actual_cash: money(value.actual_cash),
    denomination_breakdown: value.denomination_breakdown || {},
    tender_reconciliation: value.tender_reconciliation || {},
    difference: money(value.difference),
    notes: value.notes,
    closed_by: value.closed_by,
    closed_at: value.closed_at,
    created_at: value.created_at,
  };
}

function serializeCashSession(row) {
  if (!row) return null;
  const value = row.toJSON ? row.toJSON() : row;
  return {
    id: value.public_id,
    clinic_id: Number(value.clinic_id),
    business_date: value.business_date,
    opening_cash: money(value.opening_cash),
    suggested_opening_cash: money(value.suggested_opening_cash),
    status: CASH_SESSION_STATUSES.has(value.status) ? value.status : 'open',
    closure_id: value.closure_id ? Number(value.closure_id) : null,
    notes: value.notes || null,
    opened_by: value.opened_by || null,
    opened_at: value.opened_at,
    closed_by: value.closed_by || null,
    closed_at: value.closed_at || null,
  };
}

function serializePayroll(row, asset = null) {
  const value = row.toJSON ? row.toJSON() : row;
  return {
    id: value.public_id,
    clinic_id: Number(value.clinic_id),
    period_month: value.period_month,
    gross_salaries: money(value.gross_salaries),
    employee_social_security: money(value.employee_social_security),
    irpf_withholding: money(value.irpf_withholding),
    net_paid: money(value.net_paid),
    employer_social_security: money(value.employer_social_security),
    other_costs: money(value.other_costs),
    total_personnel_cost: money(value.total_personnel_cost),
    status: value.status,
    paid_at: value.paid_at || null,
    notes: value.notes || null,
    document: asset ? {
      id: asset.public_id,
      filename: asset.original_filename,
      content_type: asset.content_type,
      size_bytes: Number(asset.size_bytes),
    } : null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function serializePayrollDocument(row, asset = null) {
  const value = row.toJSON ? row.toJSON() : row;
  return {
    id: value.public_id,
    clinic_id: Number(value.clinic_id),
    payroll_period_id: value.payroll_period_id ? String(value.payroll_period_id) : null,
    employee_id: value.employee_id ? Number(value.employee_id) : null,
    employee_name: value.employee_name,
    period_month: value.period_month,
    gross_salary: money(value.gross_salary),
    employee_social_security: money(value.employee_social_security),
    irpf_withholding: money(value.irpf_withholding),
    net_salary: money(value.net_salary),
    other_amounts: money(value.other_amounts),
    match_status: value.match_status,
    document: asset ? {
      id: asset.public_id,
      filename: asset.original_filename,
      content_type: asset.content_type,
      size_bytes: Number(asset.size_bytes),
    } : null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

async function loadClinic(clinicId) {
  const clinic = await Clinica.findByPk(clinicId, {
    attributes: [
      'id_clinica',
      'nombre_clinica',
      'url_avatar',
      'datos_fiscales_clinica',
      'direccion',
      'codigo_postal',
      'ciudad',
      'provincia',
      'pais',
      'configuracion',
    ],
  });
  if (!clinic) throw domainError(404, 'clinic_not_found', 'Clínica no encontrada.');
  const fiscal = clinic.datos_fiscales_clinica && typeof clinic.datos_fiscales_clinica === 'object'
    ? clinic.datos_fiscales_clinica
    : {};
  const config = parseClinicConfig(clinic.configuracion);
  return {
    id: Number(clinic.id_clinica),
    name: clinic.nombre_clinica,
    logo_url: clinic.url_avatar || null,
    legal_name: fiscal.denominacion_social || fiscal.razon_social || clinic.nombre_clinica,
    tax_id: fiscal.nif || fiscal.cif || null,
    address: fiscal.direccion || clinic.direccion || null,
    postal_code: fiscal.codigo_postal || clinic.codigo_postal || null,
    city: fiscal.ciudad || clinic.ciudad || null,
    province: fiscal.provincia || clinic.provincia || null,
    country: fiscal.pais || clinic.pais || 'España',
    time_zone: clinicTimeZone(config),
  };
}

async function cashForDate(
  clinicId,
  businessDate,
  openingCash = 0,
  timeZone = DEFAULT_CLINIC_TIME_ZONE,
) {
  const start = localDateTimeToUtc(businessDate, '00:00:00', timeZone);
  const end = localDateTimeToUtc(nextDate(businessDate), '00:00:00', timeZone);
  const [payments, expenses, movements] = await Promise.all([
    EconomicPayment.findAll({
      where: {
        clinic_id: clinicId,
        status: 'confirmed',
        paid_at: { [Op.gte]: start, [Op.lt]: end },
      },
      attributes: ['id', 'public_id', 'amount', 'method'],
    }),
    AccountingExpenseDocument.findAll({
      where: {
        clinic_id: clinicId,
        status: 'paid',
        payment_method: 'cash',
        paid_at: { [Op.gte]: start, [Op.lt]: end },
      },
      attributes: ['id', 'public_id', 'total'],
    }),
    AccountingCashMovement.findAll({
      where: {
        clinic_id: clinicId,
        occurred_at: { [Op.gte]: start, [Op.lt]: end },
      },
      attributes: ['id', 'public_id', 'movement_type', 'amount', 'method'],
    }),
  ]);
  const cashPayments = payments.filter((row) => row.method === 'cash');
  const cashMovements = movements.filter((row) => row.method === 'cash');
  const patientReceipts = money(cashPayments.reduce((sum, row) => sum + Number(row.amount), 0));
  const manualIncome = money(cashMovements
    .filter((row) => row.movement_type === 'income')
    .reduce((sum, row) => sum + Number(row.amount), 0));
  const expenseOutflows = money(expenses.reduce((sum, row) => sum + Number(row.total), 0));
  const manualOutflows = money(cashMovements
    .filter((row) => row.movement_type === 'expense')
    .reduce((sum, row) => sum + Number(row.amount), 0));
  const adjustments = money(cashMovements
    .filter((row) => row.movement_type === 'adjustment')
    .reduce((sum, row) => sum + Number(row.amount), 0));
  const cashReceipts = money(patientReceipts + manualIncome);
  const cashOutflows = money(expenseOutflows + manualOutflows);
  const tenderReconciliation = {};
  for (const payment of payments) {
    const method = payment.method || 'other';
    tenderReconciliation[method] = money((tenderReconciliation[method] || 0) + Number(payment.amount));
  }
  return {
    business_date: businessDate,
    opening_cash: money(openingCash),
    patient_receipts: patientReceipts,
    manual_income: manualIncome,
    expense_outflows: expenseOutflows,
    manual_outflows: manualOutflows,
    adjustments,
    cash_receipts: cashReceipts,
    cash_outflows: cashOutflows,
    expected_cash: money(openingCash + cashReceipts - cashOutflows + adjustments),
    tender_reconciliation: tenderReconciliation,
    source_ids: {
      payments: payments.map((row) => row.public_id),
      expenses: expenses.map((row) => row.public_id),
      movements: movements.map((row) => row.public_id),
    },
  };
}

async function getWorkspace({
  clinicId,
  query = {},
  portalMode = false,
  includePayroll = false,
}) {
  const period = periodBounds(query);
  const clinic = await loadClinic(clinicId);
  const businessDate = dateOnly(
    query.business_date,
    dateInTimeZone(new Date(), clinic.time_zone),
  );
  const [
    documents,
    expenses,
    payments,
    movements,
    closures,
    assets,
    templates,
    lastClosure,
    currentSession,
    payrollPeriods,
    payrollDocuments,
  ] = await Promise.all([
    PatientFiscalDocument.findAll({
      where: { clinic_id: clinicId, issue_date: { [Op.gte]: period.from, [Op.lt]: period.toExclusive } },
      order: [['issue_date', 'DESC'], ['id', 'DESC']],
    }),
    AccountingExpenseDocument.findAll({
      where: { clinic_id: clinicId, issue_date: { [Op.between]: [period.fromDate, period.toDate] } },
      order: [['issue_date', 'DESC'], ['id', 'DESC']],
    }),
    EconomicPayment.findAll({
      where: { clinic_id: clinicId, status: 'confirmed', paid_at: { [Op.gte]: period.from, [Op.lt]: period.toExclusive } },
      attributes: ['amount', 'method', 'paid_at'],
    }),
    AccountingCashMovement.findAll({
      where: { clinic_id: clinicId, occurred_at: { [Op.gte]: period.from, [Op.lt]: period.toExclusive } },
      order: [['occurred_at', 'DESC']],
    }),
    AccountingCashClosure.findAll({
      where: { clinic_id: clinicId, business_date: { [Op.between]: [period.fromDate, period.toDate] } },
      order: [['business_date', 'DESC']],
    }),
    ClinicalPrivateAsset.findAll({
      where: {
        clinic_id: clinicId,
        purpose: includePayroll
          ? { [Op.in]: ['accounting_expense_document', 'accounting_payroll_document'] }
          : 'accounting_expense_document',
        status: 'active',
      },
      attributes: ['id', 'public_id', 'original_filename', 'content_type', 'size_bytes'],
    }),
    patientEconomics.listTemplates({ clinicId, templateType: 'invoice' }),
    AccountingCashClosure.findOne({
      where: { clinic_id: clinicId, business_date: { [Op.lt]: businessDate } },
      order: [['business_date', 'DESC']],
      attributes: ['actual_cash'],
    }),
    AccountingCashSession.findOne({
      where: { clinic_id: clinicId, business_date: businessDate },
    }),
    includePayroll
      ? AccountingPayrollPeriod.findAll({
        where: {
          clinic_id: clinicId,
          period_month: { [Op.between]: [period.fromDate, period.toDate] },
        },
        order: [['period_month', 'DESC']],
      })
      : Promise.resolve([]),
    includePayroll
      ? AccountingPayrollDocument.findAll({
        where: {
          clinic_id: clinicId,
          period_month: { [Op.between]: [period.fromDate, period.toDate] },
        },
        order: [['period_month', 'DESC'], ['created_at', 'DESC']],
      })
      : Promise.resolve([]),
  ]);
  const assetMap = new Map(assets.map((asset) => [String(asset.id), asset]));
  const currentCash = await cashForDate(
    clinicId,
    businessDate,
    money(currentSession?.opening_cash ?? lastClosure?.actual_cash),
    clinic.time_zone,
  );
  const issuedDocuments = documents.filter((document) => document.status === 'issued');
  const activeExpenses = expenses.filter((expense) => expense.status !== 'cancelled');
  const salesTotal = money(issuedDocuments.reduce((sum, document) => sum + Number(document.totals?.total || 0), 0));
  const expensesTotal = money(activeExpenses.reduce((sum, expense) => sum + Number(expense.total), 0));
  const payrollTotal = money(payrollPeriods.reduce(
    (sum, payroll) => sum + Number(payroll.total_personnel_cost),
    0,
  ));
  const collectedTotal = money(payments.reduce((sum, payment) => sum + Number(payment.amount), 0));
  const daily = new Map();
  const dayKey = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : parsed.toISOString().slice(0, 10);
  };
  const ensureDay = (value) => {
    const key = dayKey(value);
    if (!daily.has(key)) {
      daily.set(key, {
        date: key,
        sales: 0,
        expenses: 0,
        payroll: 0,
        collected: 0,
      });
    }
    return daily.get(key);
  };
  for (const document of issuedDocuments) {
    ensureDay(document.issue_date).sales = money(
      ensureDay(document.issue_date).sales + Number(document.totals?.total || 0),
    );
  }
  for (const expense of activeExpenses) {
    ensureDay(expense.issue_date).expenses = money(
      ensureDay(expense.issue_date).expenses + Number(expense.total),
    );
  }
  for (const payment of payments) {
    ensureDay(payment.paid_at).collected = money(
      ensureDay(payment.paid_at).collected + Number(payment.amount),
    );
  }
  for (const payroll of payrollPeriods) {
    const day = ensureDay(payroll.paid_at || payroll.period_month);
    day.payroll = money(day.payroll + Number(payroll.total_personnel_cost));
  }
  const paymentMethods = {};
  for (const payment of payments) {
    paymentMethods[payment.method || 'other'] = money(
      (paymentMethods[payment.method || 'other'] || 0) + Number(payment.amount),
    );
  }
  const expenseCategories = {};
  for (const expense of activeExpenses) {
    expenseCategories[expense.category || 'Otros'] = money(
      (expenseCategories[expense.category || 'Otros'] || 0) + Number(expense.total),
    );
  }
  return {
    clinic,
    period: { from: period.fromDate, to: period.toDate },
    summary: {
      sales_total: salesTotal,
      expenses_total: expensesTotal,
      payroll_total: payrollTotal,
      result: money(salesTotal - expensesTotal - payrollTotal),
      collected_total: collectedTotal,
      pending_expenses: activeExpenses.filter((expense) => expense.status === 'pending').length,
      issued_documents: issuedDocuments.length,
    },
    issued_documents: documents.map(serializeFiscalDocument),
    received_documents: expenses.map((expense) => serializeExpense(
      expense,
      expense.attachment_asset_id ? assetMap.get(String(expense.attachment_asset_id)) : null
    )),
    payroll_periods: payrollPeriods.map((payroll) => serializePayroll(
      payroll,
      payroll.document_asset_id ? assetMap.get(String(payroll.document_asset_id)) : null,
    )),
    payroll_documents: payrollDocuments.map((document) => serializePayrollDocument(
      document,
      assetMap.get(String(document.source_asset_id)),
    )),
    cash: portalMode ? null : {
      session: serializeCashSession(currentSession),
      current: currentCash,
      movements: movements.map(serializeMovement),
      closures: closures.map(serializeClosure),
    },
    analytics: {
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      payment_methods: Object.entries(paymentMethods).map(([label, value]) => ({ label, value })),
      expense_categories: Object.entries(expenseCategories)
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
      receivables: {
        pending_expenses_amount: money(activeExpenses
          .filter((expense) => expense.status === 'pending')
          .reduce((sum, expense) => sum + Number(expense.total), 0)),
        draft_issued_amount: money(documents
          .filter((document) => document.status === 'draft')
          .reduce((sum, document) => sum + Number(document.totals?.total || 0), 0)),
      },
    },
    templates: portalMode ? [] : templates,
    verifactu: {
      mode: 'mock',
      enabled: false,
      label: 'Simulación: no se envían registros a la AEAT',
    },
  };
}

function normalizeExpense(payload) {
  const supplierName = clean(payload.supplier_name, 180);
  const documentNumber = clean(payload.document_number, 100);
  const issueDate = dateOnly(payload.issue_date);
  const category = clean(payload.category, 100);
  const status = clean(payload.status || 'paid', 30).toLowerCase();
  const paymentMethod = clean(payload.payment_method || 'transfer', 30).toLowerCase();
  if (!supplierName || !documentNumber || !issueDate || !category) {
    throw domainError(400, 'expense_required_fields', 'Completa proveedor, número, fecha y categoría.');
  }
  if (!EXPENSE_STATUSES.has(status)) throw domainError(400, 'expense_status_invalid', 'El estado del gasto no es válido.');
  if (!EXPENSE_PAYMENT_METHODS.has(paymentMethod)) throw domainError(400, 'expense_payment_method_invalid', 'La forma de pago no es válida.');
  const taxableBase = money(payload.taxable_base);
  const taxAmount = money(payload.tax_amount);
  const withholdingAmount = money(payload.withholding_amount);
  const calculated = money(taxableBase + taxAmount - withholdingAmount);
  const total = payload.total === undefined || payload.total === null || payload.total === ''
    ? calculated
    : money(payload.total);
  if (taxableBase < 0 || taxAmount < 0 || withholdingAmount < 0 || total <= 0) {
    throw domainError(400, 'expense_amount_invalid', 'Los importes de la factura no son válidos.');
  }
  return {
    supplier_name: supplierName,
    supplier_tax_id: clean(payload.supplier_tax_id, 40) || null,
    supplier_address: clean(payload.supplier_address, 500) || null,
    document_number: documentNumber,
    issue_date: issueDate,
    due_date: dateOnly(payload.due_date),
    category,
    payment_method: paymentMethod,
    status,
    taxable_base: taxableBase,
    tax_amount: taxAmount,
    withholding_amount: withholdingAmount,
    total,
    paid_at: status === 'paid' ? dateTime(payload.paid_at, new Date()) : null,
    notes: clean(payload.notes, 4000) || null,
    source_system: clean(payload.source_system || 'clinicaclick', 40),
    source_reference: clean(payload.source_reference, 120) || null,
  };
}

async function storeExpenseAttachment({
  expense,
  clinicId,
  actorId,
  preparedAttachment,
  transaction = null,
}) {
  if (!preparedAttachment) return null;
  const asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
    purpose: 'accounting_expense_document',
    clinicId,
    ownerType: 'accounting_expense',
    ownerId: expense.public_id,
    originalFilename: preparedAttachment.filename,
    contentType: preparedAttachment.contentType,
    buffer: preparedAttachment.buffer,
    createdBy: actorId,
    metadata: { document_number: expense.document_number },
  });
  await expense.update(
    { attachment_asset_id: asset.id, updated_by: actorId },
    { transaction },
  );
  return asset;
}

async function createExpense({ clinicId, actorId, payload, transaction = null }) {
  const values = normalizeExpense(payload);
  const preparedAttachment = prepareExpenseAttachment(payload.attachment);
  const duplicateWhere = {
    clinic_id: clinicId,
    document_number: values.document_number,
  };
  if (values.supplier_tax_id) {
    duplicateWhere.supplier_tax_id = values.supplier_tax_id;
  } else {
    duplicateWhere.supplier_name = values.supplier_name;
  }
  const duplicate = await AccountingExpenseDocument.findOne({
    where: duplicateWhere,
    transaction,
  });
  if (duplicate) {
    throw domainError(
      409,
      'expense_duplicate_detected',
      'Ya existe una factura recibida con ese proveedor y número.',
      { expense_id: duplicate.public_id },
    );
  }
  const expense = await AccountingExpenseDocument.create({
    public_id: crypto.randomUUID(),
    clinic_id: clinicId,
    ...values,
    created_by: actorId,
    updated_by: actorId,
  }, { transaction });
  let asset = null;
  try {
    asset = await storeExpenseAttachment({
      expense,
      clinicId,
      actorId,
      preparedAttachment,
      transaction,
    });
  } catch (error) {
    await expense.destroy({ transaction });
    throw error;
  }
  return serializeExpense(expense, asset);
}

async function updateExpense({ publicId, clinicId, actorId, payload }) {
  const expense = await AccountingExpenseDocument.findOne({ where: { public_id: publicId, clinic_id: clinicId } });
  if (!expense) throw domainError(404, 'expense_not_found', 'Factura recibida no encontrada.');
  const preparedAttachment = prepareExpenseAttachment(payload.attachment);
  await expense.update({ ...normalizeExpense(payload), updated_by: actorId });
  const asset = preparedAttachment
    ? await storeExpenseAttachment({ expense, clinicId, actorId, preparedAttachment })
    : expense.attachment_asset_id
      ? await ClinicalPrivateAsset.findByPk(expense.attachment_asset_id)
      : null;
  return serializeExpense(expense, asset);
}

async function readExpenseAttachment({ publicId, clinicId }) {
  const expense = await AccountingExpenseDocument.findOne({
    where: { public_id: publicId, clinic_id: clinicId },
    attributes: ['attachment_asset_id'],
  });
  if (!expense?.attachment_asset_id) throw domainError(404, 'expense_attachment_not_found', 'Esta factura no tiene archivo adjunto.');
  const asset = await ClinicalPrivateAsset.findOne({
    where: { id: expense.attachment_asset_id, clinic_id: clinicId, status: 'active' },
  });
  if (!asset) throw domainError(404, 'expense_attachment_not_found', 'Archivo privado no encontrado.');
  const stored = await clinicalPrivateStorage.readClinicalPrivateAsset(asset);
  return { asset, buffer: stored.buffer };
}

async function getCashWorkspace({ clinicId, query = {} }) {
  const clinic = await loadClinic(clinicId);
  const businessDate = dateOnly(
    query.business_date,
    dateInTimeZone(new Date(), clinic.time_zone),
  );
  const start = localDateTimeToUtc(businessDate, '00:00:00', clinic.time_zone);
  const end = localDateTimeToUtc(nextDate(businessDate), '00:00:00', clinic.time_zone);
  const [session, closure, lastClosure, movements, recentClosures] = await Promise.all([
    AccountingCashSession.findOne({
      where: { clinic_id: clinicId, business_date: businessDate },
    }),
    AccountingCashClosure.findOne({
      where: { clinic_id: clinicId, business_date: businessDate },
    }),
    AccountingCashClosure.findOne({
      where: { clinic_id: clinicId, business_date: { [Op.lt]: businessDate } },
      order: [['business_date', 'DESC']],
      attributes: ['actual_cash'],
    }),
    AccountingCashMovement.findAll({
      where: {
        clinic_id: clinicId,
        occurred_at: { [Op.gte]: start, [Op.lt]: end },
      },
      order: [['occurred_at', 'DESC']],
    }),
    AccountingCashClosure.findAll({
      where: { clinic_id: clinicId, business_date: { [Op.lte]: businessDate } },
      order: [['business_date', 'DESC']],
      limit: 14,
    }),
  ]);
  const suggestedOpeningCash = money(lastClosure?.actual_cash);
  const openingCash = money(session?.opening_cash ?? closure?.opening_cash ?? suggestedOpeningCash);
  const current = await cashForDate(
    clinicId,
    businessDate,
    openingCash,
    clinic.time_zone,
  );
  return {
    clinic: {
      id: clinic.id,
      name: clinic.name,
      time_zone: clinic.time_zone,
    },
    business_date: businessDate,
    suggested_opening_cash: suggestedOpeningCash,
    session: serializeCashSession(session),
    current,
    movements: movements.map(serializeMovement),
    closure: closure ? serializeClosure(closure) : null,
    recent_closures: recentClosures.map(serializeClosure),
  };
}

async function openCash({ clinicId, actorId, payload = {} }) {
  const clinic = await loadClinic(clinicId);
  const businessDate = dateOnly(
    payload.business_date,
    dateInTimeZone(new Date(), clinic.time_zone),
  );
  const [existingSession, existingClosure, lastClosure] = await Promise.all([
    AccountingCashSession.findOne({
      where: { clinic_id: clinicId, business_date: businessDate },
    }),
    AccountingCashClosure.findOne({
      where: { clinic_id: clinicId, business_date: businessDate },
      attributes: ['id'],
    }),
    AccountingCashClosure.findOne({
      where: { clinic_id: clinicId, business_date: { [Op.lt]: businessDate } },
      order: [['business_date', 'DESC']],
      attributes: ['actual_cash'],
    }),
  ]);
  if (existingClosure || existingSession?.status === 'closed') {
    throw domainError(409, 'cash_already_closed', 'La caja de este día ya está cerrada.');
  }
  if (existingSession) {
    throw domainError(409, 'cash_already_open', 'La caja de este día ya está abierta.');
  }
  const suggestedOpeningCash = money(lastClosure?.actual_cash);
  const openingCash = payload.opening_cash === undefined || payload.opening_cash === null
    ? suggestedOpeningCash
    : money(payload.opening_cash);
  if (openingCash < 0) {
    throw domainError(400, 'cash_opening_invalid', 'El fondo de apertura no puede ser negativo.');
  }
  const session = await AccountingCashSession.create({
    public_id: crypto.randomUUID(),
    clinic_id: clinicId,
    business_date: businessDate,
    opening_cash: openingCash,
    suggested_opening_cash: suggestedOpeningCash,
    status: 'open',
    notes: clean(payload.notes, 1000) || null,
    opened_by: actorId,
    opened_at: new Date(),
  });
  return serializeCashSession(session);
}

async function createCashMovement({ clinicId, actorId, payload }) {
  const movementType = clean(payload.movement_type, 30).toLowerCase();
  const method = clean(payload.method || 'cash', 30).toLowerCase();
  const amount = money(payload.amount);
  const description = clean(payload.description, 255);
  if (!CASH_MOVEMENT_TYPES.has(movementType) || !CASH_METHODS.has(method)) {
    throw domainError(400, 'cash_movement_invalid', 'El tipo o método del movimiento no es válido.');
  }
  if (!description || (movementType === 'adjustment' ? amount === 0 : amount <= 0)) {
    throw domainError(400, 'cash_movement_required', 'Completa una descripción y un importe válido.');
  }
  const occurredAt = dateTime(payload.occurred_at, new Date());
  const clinic = await loadClinic(clinicId);
  const businessDate = dateInTimeZone(occurredAt, clinic.time_zone);
  const session = await AccountingCashSession.findOne({
    where: { clinic_id: clinicId, business_date: businessDate },
    attributes: ['status'],
  });
  if (!session) {
    throw domainError(409, 'cash_not_open', 'Abre la caja antes de registrar movimientos manuales.');
  }
  if (session.status !== 'open') {
    throw domainError(409, 'cash_already_closed', 'La caja de este día ya está cerrada.');
  }
  const row = await AccountingCashMovement.create({
    public_id: crypto.randomUUID(),
    clinic_id: clinicId,
    movement_type: movementType,
    amount,
    method,
    description,
    source_type: clean(payload.source_type, 60) || null,
    source_id: clean(payload.source_id, 80) || null,
    occurred_at: occurredAt,
    created_by: actorId,
  });
  return serializeMovement(row);
}

async function closeCash({ clinicId, actorId, payload }) {
  const clinic = await loadClinic(clinicId);
  const businessDate = dateOnly(
    payload.business_date,
    dateInTimeZone(new Date(), clinic.time_zone),
  );
  const existing = await AccountingCashClosure.findOne({ where: { clinic_id: clinicId, business_date: businessDate } });
  if (existing) throw domainError(409, 'cash_already_closed', 'La caja de este día ya está cerrada.');
  const session = await AccountingCashSession.findOne({
    where: { clinic_id: clinicId, business_date: businessDate },
  });
  if (!session) throw domainError(409, 'cash_not_open', 'Abre la caja antes de cerrarla.');
  if (session.status !== 'open') throw domainError(409, 'cash_already_closed', 'La caja de este día ya está cerrada.');
  const openingCash = money(session.opening_cash);
  const allowedDenominations = new Set([
    '500', '200', '100', '50', '20', '10', '5', '2', '1',
    '0.5', '0.2', '0.1', '0.05', '0.02', '0.01',
  ]);
  const rawBreakdown = payload.denomination_breakdown && typeof payload.denomination_breakdown === 'object'
    ? payload.denomination_breakdown
    : {};
  const denominationBreakdown = {};
  for (const [rawDenomination, rawCount] of Object.entries(rawBreakdown)) {
    const denomination = String(Number(rawDenomination));
    const count = Number.parseInt(String(rawCount), 10);
    if (!allowedDenominations.has(denomination) || !Number.isInteger(count) || count < 0 || count > 10000) {
      throw domainError(400, 'cash_denomination_invalid', 'El recuento de efectivo contiene un valor no válido.');
    }
    if (count) denominationBreakdown[denomination] = count;
  }
  const countedFromBreakdown = money(Object.entries(denominationBreakdown)
    .reduce((sum, [denomination, count]) => sum + Number(denomination) * Number(count), 0));
  const actualCash = Object.keys(denominationBreakdown).length
    ? countedFromBreakdown
    : money(payload.actual_cash);
  if (actualCash < 0) throw domainError(400, 'cash_amount_invalid', 'El efectivo contado no es válido.');
  const snapshot = await cashForDate(clinicId, businessDate, openingCash, clinic.time_zone);
  const difference = money(actualCash - snapshot.expected_cash);
  const notes = clean(payload.notes, 4000) || null;
  if (Math.abs(difference) > 0.01 && !notes) {
    throw domainError(400, 'cash_difference_note_required', 'Indica el motivo de la diferencia para cerrar la caja.');
  }
  const row = await AccountingCashClosure.create({
    public_id: crypto.randomUUID(),
    clinic_id: clinicId,
    business_date: businessDate,
    opening_cash: openingCash,
    cash_receipts: snapshot.cash_receipts,
    cash_outflows: snapshot.cash_outflows,
    expected_cash: snapshot.expected_cash,
    actual_cash: actualCash,
    denomination_breakdown: denominationBreakdown,
    tender_reconciliation: snapshot.tender_reconciliation,
    difference,
    notes,
    snapshot,
    closed_by: actorId,
    closed_at: new Date(),
  });
  await session.update({
    status: 'closed',
    closure_id: row.id,
    closed_by: actorId,
    closed_at: row.closed_at,
  });
  return serializeClosure(row);
}

function normalizePayroll(payload) {
  const periodMonthRaw = dateOnly(payload.period_month);
  if (!periodMonthRaw) {
    throw domainError(400, 'payroll_period_required', 'Selecciona el mes de la nómina.');
  }
  const periodMonth = `${periodMonthRaw.slice(0, 7)}-01`;
  const status = clean(payload.status || 'draft', 20).toLowerCase();
  if (!PAYROLL_STATUSES.has(status)) {
    throw domainError(400, 'payroll_status_invalid', 'El estado de la nómina no es válido.');
  }
  const grossSalaries = money(payload.gross_salaries);
  const employeeSocialSecurity = money(payload.employee_social_security);
  const irpfWithholding = money(payload.irpf_withholding);
  const netPaid = money(payload.net_paid);
  const employerSocialSecurity = money(payload.employer_social_security);
  const otherCosts = money(payload.other_costs);
  if ([
    grossSalaries,
    employeeSocialSecurity,
    irpfWithholding,
    netPaid,
    employerSocialSecurity,
    otherCosts,
  ].some((value) => value < 0)) {
    throw domainError(400, 'payroll_amount_invalid', 'Los importes de nómina no pueden ser negativos.');
  }
  if (employeeSocialSecurity + irpfWithholding > grossSalaries + 0.01) {
    throw domainError(
      400,
      'payroll_withholdings_invalid',
      'Las retenciones no pueden superar los salarios brutos.',
    );
  }
  return {
    period_month: periodMonth,
    gross_salaries: grossSalaries,
    employee_social_security: employeeSocialSecurity,
    irpf_withholding: irpfWithholding,
    net_paid: netPaid,
    employer_social_security: employerSocialSecurity,
    other_costs: otherCosts,
    total_personnel_cost: money(grossSalaries + employerSocialSecurity + otherCosts),
    status,
    paid_at: status === 'paid' ? dateTime(payload.paid_at, new Date()) : null,
    notes: clean(payload.notes, 4000) || null,
  };
}

async function storePayrollAttachment({
  payroll,
  clinicId,
  actorId,
  preparedAttachment,
}) {
  if (!preparedAttachment) return null;
  const asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
    purpose: 'accounting_payroll_document',
    clinicId,
    ownerType: 'accounting_payroll',
    ownerId: payroll.public_id,
    originalFilename: preparedAttachment.filename,
    contentType: preparedAttachment.contentType,
    buffer: preparedAttachment.buffer,
    createdBy: actorId,
    metadata: { period_month: payroll.period_month },
  });
  await payroll.update({ document_asset_id: asset.id, updated_by: actorId });
  return asset;
}

async function createPayroll({ clinicId, actorId, payload }) {
  const values = normalizePayroll(payload);
  const existing = await AccountingPayrollPeriod.findOne({
    where: { clinic_id: clinicId, period_month: values.period_month },
    attributes: ['id'],
  });
  if (existing) {
    throw domainError(
      409,
      'payroll_period_exists',
      'Ya existe un registro de nóminas para ese mes.',
    );
  }
  const preparedAttachment = prepareExpenseAttachment(payload.attachment);
  const payroll = await AccountingPayrollPeriod.create({
    public_id: crypto.randomUUID(),
    clinic_id: clinicId,
    ...values,
    created_by: actorId,
    updated_by: actorId,
  });
  let asset = null;
  try {
    asset = await storePayrollAttachment({
      payroll,
      clinicId,
      actorId,
      preparedAttachment,
    });
  } catch (error) {
    await payroll.destroy();
    throw error;
  }
  return serializePayroll(payroll, asset);
}

async function updatePayroll({ publicId, clinicId, actorId, payload }) {
  const payroll = await AccountingPayrollPeriod.findOne({
    where: { public_id: publicId, clinic_id: clinicId },
  });
  if (!payroll) throw domainError(404, 'payroll_not_found', 'Registro de nóminas no encontrado.');
  const values = normalizePayroll(payload);
  const duplicate = await AccountingPayrollPeriod.findOne({
    where: {
      clinic_id: clinicId,
      period_month: values.period_month,
      id: { [Op.ne]: payroll.id },
    },
    attributes: ['id'],
  });
  if (duplicate) {
    throw domainError(
      409,
      'payroll_period_exists',
      'Ya existe un registro de nóminas para ese mes.',
    );
  }
  const preparedAttachment = prepareExpenseAttachment(payload.attachment);
  await payroll.update({ ...values, updated_by: actorId });
  const asset = preparedAttachment
    ? await storePayrollAttachment({
      payroll,
      clinicId,
      actorId,
      preparedAttachment,
    })
    : payroll.document_asset_id
      ? await ClinicalPrivateAsset.findByPk(payroll.document_asset_id)
      : null;
  return serializePayroll(payroll, asset);
}

async function readPayrollAttachment({ publicId, clinicId }) {
  const payroll = await AccountingPayrollPeriod.findOne({
    where: { public_id: publicId, clinic_id: clinicId },
    attributes: ['document_asset_id'],
  });
  if (!payroll?.document_asset_id) {
    throw domainError(404, 'payroll_attachment_not_found', 'Este registro no tiene documento adjunto.');
  }
  const asset = await ClinicalPrivateAsset.findOne({
    where: {
      id: payroll.document_asset_id,
      clinic_id: clinicId,
      purpose: 'accounting_payroll_document',
      status: 'active',
    },
  });
  if (!asset) throw domainError(404, 'payroll_attachment_not_found', 'Documento privado no encontrado.');
  const stored = await clinicalPrivateStorage.readClinicalPrivateAsset(asset);
  return { asset, buffer: stored.buffer };
}

async function createPayrollDocument({
  clinicId,
  actorId,
  payload,
  sourceAssetId,
  transaction = null,
}) {
  const periodMonthRaw = dateOnly(payload.period_month);
  if (!periodMonthRaw) {
    throw domainError(400, 'payroll_document_period_required', 'Selecciona el mes de la nómina.');
  }
  const periodMonth = `${periodMonthRaw.slice(0, 7)}-01`;
  const employeeId = Number.parseInt(String(payload.employee_id || ''), 10) || null;
  let employeeName = clean(payload.employee_name, 180);
  if (employeeId) {
    const pivot = await UsuarioClinica.findOne({
      where: {
        id_usuario: employeeId,
        id_clinica: clinicId,
        estado_invitacion: 'aceptada',
      },
      attributes: ['id_usuario'],
      transaction,
    });
    if (!pivot) {
      throw domainError(
        400,
        'payroll_document_employee_invalid',
        'La persona seleccionada no pertenece a esta clínica.',
      );
    }
    const user = await Usuario.findByPk(employeeId, {
      attributes: ['id_usuario', 'nombre', 'apellidos'],
      transaction,
    });
    employeeName = clean(
      `${user?.nombre || ''} ${user?.apellidos || ''}`,
      180,
    ) || employeeName;
  }
  if (!employeeName) {
    throw domainError(
      400,
      'payroll_document_employee_name_required',
      'Indica el nombre que aparece en la nómina.',
    );
  }
  const amounts = {
    gross_salary: money(payload.gross_salary),
    employee_social_security: money(payload.employee_social_security),
    irpf_withholding: money(payload.irpf_withholding),
    net_salary: money(payload.net_salary),
    other_amounts: money(payload.other_amounts),
  };
  if (Object.values(amounts).some((value) => value < 0)) {
    throw domainError(
      400,
      'payroll_document_amount_invalid',
      'Los importes de la nómina no pueden ser negativos.',
    );
  }
  const sourceAsset = await ClinicalPrivateAsset.findOne({
    where: {
      id: sourceAssetId,
      clinic_id: clinicId,
      purpose: 'accounting_payroll_document',
      status: 'active',
    },
    attributes: ['id'],
    transaction,
  });
  if (!sourceAsset) {
    throw domainError(404, 'payroll_document_asset_missing', 'El documento privado no está disponible.');
  }
  const payrollPeriod = await AccountingPayrollPeriod.findOne({
    where: { clinic_id: clinicId, period_month: periodMonth },
    attributes: ['id'],
    transaction,
  });
  const row = await AccountingPayrollDocument.create({
    public_id: crypto.randomUUID(),
    clinic_id: clinicId,
    payroll_period_id: payrollPeriod?.id || null,
    employee_id: employeeId,
    employee_name: employeeName,
    period_month: periodMonth,
    ...amounts,
    match_status: employeeId ? 'matched' : 'unmatched',
    source_asset_id: sourceAssetId,
    created_by: actorId,
    updated_by: actorId,
  }, { transaction });
  const asset = await ClinicalPrivateAsset.findByPk(sourceAssetId, { transaction });
  return serializePayrollDocument(row, asset);
}

async function readPayrollDocumentAttachment({ publicId, clinicId }) {
  const document = await AccountingPayrollDocument.findOne({
    where: { public_id: publicId, clinic_id: clinicId },
    attributes: ['source_asset_id'],
  });
  if (!document?.source_asset_id) {
    throw domainError(404, 'payroll_document_attachment_not_found', 'Esta nómina no tiene documento adjunto.');
  }
  const asset = await ClinicalPrivateAsset.findOne({
    where: {
      id: document.source_asset_id,
      clinic_id: clinicId,
      purpose: 'accounting_payroll_document',
      status: 'active',
    },
  });
  if (!asset) throw domainError(404, 'payroll_document_attachment_not_found', 'Documento privado no encontrado.');
  const stored = await clinicalPrivateStorage.readClinicalPrivateAsset(asset);
  return { asset, buffer: stored.buffer };
}

async function getFiscalDocument({ publicId, clinicId }) {
  const document = await PatientFiscalDocument.findOne({ where: { public_id: publicId, clinic_id: clinicId } });
  if (!document) throw domainError(404, 'fiscal_document_not_found', 'Documento fiscal no encontrado.');
  return serializeFiscalDocument(document);
}

function csvCell(value) {
  const text = String(value ?? '').replace(/"/g, '""');
  return `"${text}"`;
}

async function exportCsv({ clinicId, query = {} }) {
  const workspace = await getWorkspace({ clinicId, query });
  const rows = [
    ['tipo', 'fecha', 'numero', 'tercero', 'nif', 'base', 'impuestos', 'retencion', 'total', 'estado'],
    ...workspace.issued_documents.map((document) => [
      'emitida',
      String(document.issue_date).slice(0, 10),
      document.number,
      document.recipient?.legal_name || document.recipient?.name,
      document.recipient?.tax_id,
      document.totals?.taxable_base,
      document.totals?.taxes,
      0,
      document.totals?.total,
      document.status,
    ]),
    ...workspace.received_documents.map((document) => [
      'recibida',
      document.issue_date,
      document.document_number,
      document.supplier_name,
      document.supplier_tax_id,
      document.taxable_base,
      document.tax_amount,
      document.withholding_amount,
      document.total,
      document.status,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(';')).join('\n');
}

module.exports = {
  domainError,
  getWorkspace,
  getCashWorkspace,
  createExpense,
  updateExpense,
  readExpenseAttachment,
  openCash,
  createCashMovement,
  closeCash,
  createPayroll,
  updatePayroll,
  readPayrollAttachment,
  createPayrollDocument,
  readPayrollDocumentAttachment,
  getFiscalDocument,
  exportCsv,
};
