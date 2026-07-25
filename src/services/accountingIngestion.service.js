'use strict';

const axios = require('axios');
const crypto = require('crypto');
const db = require('../../models');
const clinicalPrivateStorage = require('./clinicalPrivateStorage.service');
const accounting = require('./accounting.service');

const {
  sequelize,
  AccountingIngestionJob,
  AccountingExpenseDocument,
  ClinicalPrivateAsset,
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
    file: asset ? {
      name: asset.original_filename,
      content_type: asset.content_type,
      size_bytes: Number(asset.size_bytes),
    } : null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

async function list({ clinicId }) {
  const jobs = await AccountingIngestionJob.findAll({
    where: { clinic_id: clinicId },
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

async function enqueue({ clinicId, actorId, attachment }) {
  const file = decodeAttachment(attachment);
  const asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
    purpose: 'accounting_expense_document',
    clinicId,
    ownerType: 'accounting_ingestion',
    ownerId: crypto.randomUUID(),
    originalFilename: file.filename,
    contentType: file.contentType,
    buffer: file.buffer,
    createdBy: actorId,
    metadata: { queue: 'accounting_expenses' },
  });
  const job = await AccountingIngestionJob.create({
    public_id: crypto.randomUUID(),
    clinic_id: clinicId,
    source_asset_id: asset.id,
    status: 'queued',
    attempts: 0,
    created_by: actorId,
  });
  return serialize(job, asset);
}

function schema() {
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

function responseText(payload) {
  if (clean(payload?.output_text, 100000)) return String(payload.output_text);
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === 'output_text' && part.text) return String(part.text);
    }
  }
  return '';
}

async function extractWithOpenAi(asset, buffer) {
  const apiKey = clean(process.env.OPENAI_API_KEY, 1000);
  if (!apiKey) {
    throw domainError(503, 'accounting_ocr_not_configured', 'La lectura automática no está configurada.');
  }
  const content = [{
    type: 'input_text',
    text: [
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
        name: 'accounting_expense_invoice',
        strict: true,
        schema: schema(),
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
    const result = await extractWithOpenAi(asset, stored.buffer);
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

module.exports = {
  domainError,
  list,
  enqueue,
  process: processJob,
  accept,
  readSource,
};
