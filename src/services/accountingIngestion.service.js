'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const clinicalPrivateStorage = require('./clinicalPrivateStorage.service');
const accounting = require('./accounting.service');

const {
  sequelize,
  AccountingIngestionJob,
  AccountingExpenseDocument,
  AccountingPayrollDocument,
  ClinicalPrivateAsset,
  Usuario,
  UsuarioClinica,
} = db;

const ALLOWED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_BYTES = 18 * 1024 * 1024;
const MODEL = String(process.env.ACCOUNTING_OCR_MODEL || 'gpt-5.4-nano').trim();

function domainError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function clean(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function decodeAttachment(attachment) {
  const contentType = clean(attachment?.content_type, 100).toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    throw domainError(400, 'accounting_ingestion_type_invalid', 'Usa PDF, JPG, PNG o WebP.');
  }
  const raw = String(attachment?.base64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw domainError(400, 'accounting_ingestion_file_invalid', 'El archivo no es válido.');
  }
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES) {
    throw domainError(413, 'accounting_ingestion_file_too_large', 'Cada archivo debe ocupar menos de 18 MB.');
  }
  return {
    filename: clean(attachment.filename, 255) || 'factura-proveedor',
    contentType,
    buffer,
  };
}

function serialize(job, asset = null) {
  const value = job.toJSON ? job.toJSON() : job;
  return {
    id: value.public_id,
    document_kind: value.document_kind || 'expense',
    status: value.status,
    provider: value.provider || null,
    model: value.model || null,
    extracted_data: value.extracted_data || null,
    confidence: value.confidence == null ? null : Number(value.confidence),
    error: value.error_message ? {
      code: value.error_code,
      message: value.error_message,
    } : null,
    attempts: Number(value.attempts || 0),
    expense_document_id: value.expense_document_id ? String(value.expense_document_id) : null,
    payroll_document_id: value.payroll_document_id ? String(value.payroll_document_id) : null,
    file: asset ? {
      name: asset.original_filename,
      content_type: asset.content_type,
      size_bytes: Number(asset.size_bytes),
    } : null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

async function list({ clinicId, documentKind = 'expense' }) {
  const normalizedKind = clean(documentKind || 'expense', 20).toLowerCase();
  if (!['expense', 'payroll'].includes(normalizedKind)) {
    throw domainError(400, 'accounting_ingestion_kind_invalid', 'El tipo de documento no es válido.');
  }
  const jobs = await AccountingIngestionJob.findAll({
    where: {
      clinic_id: clinicId,
      document_kind: normalizedKind,
    },
    order: [['created_at', 'DESC']],
    limit: 100,
  });
  const assetIds = [...new Set(jobs.map((job) => Number(job.source_asset_id)).filter(Boolean))];
  const assets = assetIds.length
    ? await ClinicalPrivateAsset.findAll({ where: { id: assetIds } })
    : [];
  const byId = new Map(assets.map((asset) => [Number(asset.id), asset]));
  return jobs.map((job) => serialize(job, byId.get(Number(job.source_asset_id))));
}

async function enqueue({
  clinicId,
  actorId,
  attachment,
  documentKind = 'expense',
}) {
  const normalizedKind = clean(documentKind, 20).toLowerCase();
  if (!['expense', 'payroll'].includes(normalizedKind)) {
    throw domainError(400, 'accounting_ingestion_kind_invalid', 'El tipo de documento no es válido.');
  }
  const file = decodeAttachment(attachment);
  const asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
    purpose: normalizedKind === 'payroll'
      ? 'accounting_payroll_document'
      : 'accounting_expense_document',
    clinicId,
    ownerType: 'accounting_ingestion',
    ownerId: crypto.randomUUID(),
    originalFilename: file.filename,
    contentType: file.contentType,
    buffer: file.buffer,
    createdBy: actorId,
    metadata: {
      queue: normalizedKind === 'payroll'
        ? 'accounting_payroll'
        : 'accounting_expenses',
    },
  });
  const job = await AccountingIngestionJob.create({
    public_id: crypto.randomUUID(),
    clinic_id: clinicId,
    document_kind: normalizedKind,
    source_asset_id: asset.id,
    status: 'queued',
    attempts: 0,
    created_by: actorId,
  });
  return serialize(job, asset);
}

function expenseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'supplier_name',
      'supplier_tax_id',
      'supplier_address',
      'document_number',
      'issue_date',
      'due_date',
      'category',
      'payment_method',
      'taxable_base',
      'tax_amount',
      'withholding_amount',
      'total',
      'currency',
      'confidence',
      'warnings',
    ],
    properties: {
      supplier_name: { type: ['string', 'null'] },
      supplier_tax_id: { type: ['string', 'null'] },
      supplier_address: { type: ['string', 'null'] },
      document_number: { type: ['string', 'null'] },
      issue_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      category: { type: ['string', 'null'] },
      payment_method: {
        type: ['string', 'null'],
        enum: ['cash', 'card', 'transfer', 'direct_debit', 'other', null],
      },
      taxable_base: { type: ['number', 'null'] },
      tax_amount: { type: ['number', 'null'] },
      withholding_amount: { type: ['number', 'null'] },
      total: { type: ['number', 'null'] },
      currency: { type: ['string', 'null'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      warnings: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    },
  };
}

function payrollSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'employee_name',
      'employee_tax_id',
      'period_month',
      'gross_salary',
      'employee_social_security',
      'irpf_withholding',
      'net_salary',
      'other_amounts',
      'currency',
      'confidence',
      'warnings',
    ],
    properties: {
      employee_name: { type: ['string', 'null'] },
      employee_tax_id: { type: ['string', 'null'] },
      period_month: { type: ['string', 'null'], description: 'YYYY-MM-01' },
      gross_salary: { type: ['number', 'null'] },
      employee_social_security: { type: ['number', 'null'] },
      irpf_withholding: { type: ['number', 'null'] },
      net_salary: { type: ['number', 'null'] },
      other_amounts: { type: ['number', 'null'] },
      currency: { type: ['string', 'null'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      warnings: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    },
  };
}

function responseText(payload) {
  if (clean(payload?.output_text, 100000)) return String(payload.output_text);
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === 'output_text' && part.text) return String(part.text);
    }
  }
  return '';
}

async function extractWithOpenAi(asset, buffer, documentKind = 'expense') {
  const apiKey = clean(process.env.OPENAI_API_KEY, 1000);
  if (!apiKey) {
    throw domainError(503, 'accounting_ocr_not_configured', 'La lectura automática no está configurada.');
  }
  const isPayroll = documentKind === 'payroll';
  const content = [{
    type: 'input_text',
    text: isPayroll
      ? [
        'Extrae los datos de esta nómina individual.',
        'No inventes valores y usa null cuando no sean legibles.',
        'period_month debe ser el primer día del mes en formato YYYY-MM-01.',
        'Distingue salario bruto, Seguridad Social del trabajador, IRPF, neto y otros importes.',
        'El resultado siempre será revisado por una persona y vinculado al trabajador correcto.',
      ].join(' ')
      : [
        'Extrae los datos de esta factura o ticket de proveedor.',
        'No inventes valores. Usa null cuando no sean legibles.',
        'Comprueba que base + impuestos - retención coincide con total y añade una advertencia si no coincide.',
        'El resultado siempre será revisado por una persona antes de contabilizarse.',
      ].join(' '),
  }];
  const encoded = buffer.toString('base64');
  if (asset.content_type === 'application/pdf') {
    content.push({
      type: 'input_file',
      filename: asset.original_filename || 'factura.pdf',
      file_data: `data:application/pdf;base64,${encoded}`,
    });
  } else {
    content.push({
      type: 'input_image',
      image_url: `data:${asset.content_type};base64,${encoded}`,
      detail: 'high',
    });
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (clean(process.env.OPENAI_ORGANIZATION_ID, 200)) {
    headers['OpenAI-Organization'] = clean(process.env.OPENAI_ORGANIZATION_ID, 200);
  }
  if (clean(process.env.OPENAI_PROJECT_ID, 200)) {
    headers['OpenAI-Project'] = clean(process.env.OPENAI_PROJECT_ID, 200);
  }
  const response = await axios.post('https://api.openai.com/v1/responses', {
    model: MODEL,
    store: false,
    reasoning: { effort: 'none' },
    max_output_tokens: 1800,
    input: [{ role: 'user', content }],
    text: {
      format: {
        type: 'json_schema',
        name: isPayroll ? 'accounting_payroll_document' : 'accounting_expense_invoice',
        strict: true,
        schema: isPayroll ? payrollSchema() : expenseSchema(),
      },
    },
  }, {
    headers,
    timeout: 120000,
  });
  const text = responseText(response.data);
  if (!text) throw domainError(502, 'accounting_ocr_empty', 'La lectura automática no devolvió datos.');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw domainError(502, 'accounting_ocr_invalid', 'La lectura automática devolvió datos no válidos.');
  }
  return {
    data: parsed,
    model: clean(response.data?.model, 100) || MODEL,
  };
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values.map((item) => clean(item, 180)).filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

async function applySupplierHistory(clinicId, extracted) {
  const supplierTaxId = clean(extracted.supplier_tax_id, 40);
  const supplierName = clean(extracted.supplier_name, 180);
  if (!supplierTaxId && !supplierName) return extracted;
  const conditions = [];
  if (supplierTaxId) conditions.push({ supplier_tax_id: supplierTaxId });
  if (supplierName) conditions.push({ supplier_name: supplierName });
  const previous = await AccountingExpenseDocument.findAll({
    where: {
      clinic_id: clinicId,
      [Op.or]: conditions,
    },
    attributes: ['category', 'payment_method'],
    order: [['issue_date', 'DESC'], ['id', 'DESC']],
    limit: 20,
  });
  const suggestedCategory = mostCommon(previous.map((row) => row.category));
  const suggestedPaymentMethod = mostCommon(previous.map((row) => row.payment_method));
  const categoryIsGeneric = !clean(extracted.category, 180)
    || ['otro', 'otros', 'other'].includes(clean(extracted.category, 180).toLowerCase());
  const paymentMethodMissing = !clean(extracted.payment_method, 30);
  return {
    ...extracted,
    category: categoryIsGeneric && suggestedCategory ? suggestedCategory : extracted.category,
    payment_method: paymentMethodMissing && suggestedPaymentMethod
      ? suggestedPaymentMethod
      : extracted.payment_method,
    learning: {
      supplier_recognized: previous.length > 0,
      previous_documents: previous.length,
      suggested_category: suggestedCategory,
      category_applied: Boolean(categoryIsGeneric && suggestedCategory),
    },
  };
}

function normalizePersonName(value) {
  return clean(value, 240)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function applyEmployeeMatching(clinicId, extracted) {
  const pivots = await UsuarioClinica.findAll({
    where: {
      id_clinica: clinicId,
      estado_invitacion: 'aceptada',
    },
    attributes: ['id_usuario'],
  });
  const userIds = [...new Set(pivots.map((row) => Number(row.id_usuario)).filter(Boolean))];
  const users = userIds.length
    ? await Usuario.findAll({
      where: { id_usuario: { [Op.in]: userIds } },
      attributes: ['id_usuario', 'nombre', 'apellidos'],
    })
    : [];
  const extractedName = normalizePersonName(extracted.employee_name);
  const ranked = users
    .map((user) => {
      const name = clean(`${user.nombre || ''} ${user.apellidos || ''}`, 180);
      const normalized = normalizePersonName(name);
      const expectedTokens = new Set(extractedName.split(' ').filter(Boolean));
      const actualTokens = new Set(normalized.split(' ').filter(Boolean));
      const common = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
      const score = normalized === extractedName
        ? 100
        : expectedTokens.size
          ? Math.round(common / expectedTokens.size * 100)
          : 0;
      return {
        id: Number(user.id_usuario),
        name,
        score,
      };
    })
    .filter((candidate) => candidate.score >= 40)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
  const exact = ranked.find((candidate) => candidate.score === 100) || null;
  return {
    ...extracted,
    employee_match: {
      matched: Boolean(exact),
      suggested_employee_id: exact?.id || null,
      suggested_employee_name: exact?.name || null,
      candidates: ranked,
    },
  };
}

async function processJob({ publicId, clinicId }) {
  const claim = await sequelize.transaction(async (transaction) => {
    const job = await AccountingIngestionJob.findOne({
      where: { public_id: publicId, clinic_id: clinicId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!job) throw domainError(404, 'accounting_ingestion_not_found', 'Documento de la cola no encontrado.');
    if (!['queued', 'failed'].includes(job.status)) return { job, shouldProcess: false };
    await job.update({
      status: 'processing',
      attempts: Number(job.attempts || 0) + 1,
      error_code: null,
      error_message: null,
    }, { transaction });
    return { job, shouldProcess: true };
  });
  const { job, shouldProcess } = claim;
  if (!shouldProcess) {
    return serialize(job, await ClinicalPrivateAsset.findByPk(job.source_asset_id));
  }
  const asset = await ClinicalPrivateAsset.findOne({
    where: { id: job.source_asset_id, clinic_id: clinicId, status: 'active' },
  });
  try {
    if (!asset) {
      throw domainError(404, 'accounting_ingestion_asset_missing', 'El archivo privado no está disponible.');
    }
    const stored = await clinicalPrivateStorage.readClinicalPrivateAsset(asset);
    const documentKind = job.document_kind || 'expense';
    const result = await extractWithOpenAi(asset, stored.buffer, documentKind);
    result.data = documentKind === 'payroll'
      ? await applyEmployeeMatching(clinicId, result.data)
      : await applySupplierHistory(clinicId, result.data);
    await job.update({
      status: 'review',
      provider: 'openai',
      model: result.model,
      extracted_data: result.data,
      confidence: Number(result.data.confidence || 0),
      processed_at: new Date(),
    });
  } catch (error) {
    await job.update({
      status: 'failed',
      provider: 'openai',
      model: MODEL,
      error_code: clean(error.code || 'accounting_ocr_failed', 80),
      error_message: clean(
        error.response?.data?.error?.message || error.message || 'No se pudo leer el documento.',
        1000,
      ),
      processed_at: new Date(),
    });
    throw error;
  }
  return serialize(job, asset);
}

async function accept({ publicId, clinicId, actorId, payload }) {
  return sequelize.transaction(async (transaction) => {
    const job = await AccountingIngestionJob.findOne({
      where: { public_id: publicId, clinic_id: clinicId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!job) throw domainError(404, 'accounting_ingestion_not_found', 'Documento de la cola no encontrado.');
    if (job.status !== 'review') {
      throw domainError(409, 'accounting_ingestion_not_reviewable', 'El documento todavía no está listo para revisar.');
    }
    if ((job.document_kind || 'expense') === 'payroll') {
      const payrollDocument = await accounting.createPayrollDocument({
        clinicId,
        actorId,
        payload,
        sourceAssetId: job.source_asset_id,
        transaction,
      });
      const payrollRow = await AccountingPayrollDocument.findOne({
        where: { public_id: payrollDocument.id, clinic_id: clinicId },
        attributes: ['id'],
        transaction,
      });
      await job.update({
        status: 'accepted',
        payroll_document_id: payrollRow.id,
        reviewed_by: actorId,
        reviewed_at: new Date(),
      }, { transaction });
      const asset = await ClinicalPrivateAsset.findByPk(job.source_asset_id, { transaction });
      return {
        job: serialize(job, asset),
        payroll_document: payrollDocument,
      };
    }
    const expense = await accounting.createExpense({
      clinicId,
      actorId,
      payload: {
        ...payload,
        source_system: 'clinicaclick_ocr',
        source_reference: job.public_id,
        attachment: null,
      },
      transaction,
    });
    const expenseRow = await AccountingExpenseDocument.findOne({
      where: { public_id: expense.id, clinic_id: clinicId },
      transaction,
    });
    await expenseRow.update(
      { attachment_asset_id: job.source_asset_id, updated_by: actorId },
      { transaction },
    );
    await job.update({
      status: 'accepted',
      expense_document_id: expenseRow.id,
      reviewed_by: actorId,
      reviewed_at: new Date(),
    }, { transaction });
    const asset = await ClinicalPrivateAsset.findByPk(job.source_asset_id, { transaction });
    return {
      job: serialize(job, asset),
      expense: {
        ...expense,
        attachment: asset ? {
          id: asset.public_id,
          filename: asset.original_filename,
          content_type: asset.content_type,
          size_bytes: Number(asset.size_bytes),
        } : null,
      },
    };
  });
}

async function readSource({ publicId, clinicId }) {
  const job = await AccountingIngestionJob.findOne({
    where: { public_id: publicId, clinic_id: clinicId },
  });
  if (!job) throw domainError(404, 'accounting_ingestion_not_found', 'Documento de la cola no encontrado.');
  const asset = await ClinicalPrivateAsset.findOne({
    where: { id: job.source_asset_id, clinic_id: clinicId, status: 'active' },
  });
  if (!asset) throw domainError(404, 'accounting_ingestion_asset_missing', 'Archivo privado no encontrado.');
  const stored = await clinicalPrivateStorage.readClinicalPrivateAsset(asset);
  return { asset, buffer: stored.buffer };
}

async function kind({ publicId, clinicId }) {
  const job = await AccountingIngestionJob.findOne({
    where: { public_id: publicId, clinic_id: clinicId },
    attributes: ['document_kind'],
  });
  if (!job) throw domainError(404, 'accounting_ingestion_not_found', 'Documento de la cola no encontrado.');
  return job.document_kind || 'expense';
}

module.exports = {
  domainError,
  list,
  enqueue,
  process: processJob,
  accept,
  readSource,
  kind,
};
