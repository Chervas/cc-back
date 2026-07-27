#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

const API_ORIGIN = process.env.QA_API_ORIGIN || 'http://127.0.0.1:3004/api';
const TOKEN = process.env.QA_AUTH_TOKEN;
const CLINIC_ID = Number(process.env.QA_CLINIC_ID || 66);

assert(TOKEN, 'QA_AUTH_TOKEN is required');
assert(Number.isInteger(CLINIC_ID) && CLINIC_ID > 0, 'QA_CLINIC_ID must be a positive integer');

async function request(path, options = {}) {
  return fetch(`${API_ORIGIN}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function json(path, options = {}) {
  const response = await request(path, options);
  const body = await response.json();
  return { response, body };
}

async function workspace() {
  const { response, body } = await json(
    `/accounting/workspace?clinic_id=${CLINIC_ID}&from=2026-07-01&to=2026-07-31&business_date=2026-07-24`,
  );
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function main() {
  const before = await workspace();
  assert(before.issued_documents.length > 0, 'The demo needs an issued fiscal document');
  assert(before.received_documents.length > 0, 'The demo needs a received supplier invoice');
  assert.equal(before.clinic.time_zone, 'Europe/Madrid');
  assert.equal(before.cash.current.business_date, '2026-07-24');

  const expense = before.received_documents.find((item) => item.attachment);
  assert(expense, 'The demo supplier invoice needs a private attachment');
  const attachment = await request(
    `/accounting/expenses/${encodeURIComponent(expense.id)}/attachment?clinic_id=${CLINIC_ID}`,
  );
  const attachmentBuffer = Buffer.from(await attachment.arrayBuffer());
  assert.equal(attachment.status, 200);
  assert.equal(attachment.headers.get('cache-control'), 'private, no-store');
  assert.equal(attachmentBuffer.subarray(0, 5).toString('ascii'), '%PDF-');

  const csv = await request(
    `/accounting/export.csv?clinic_id=${CLINIC_ID}&from=2026-07-01&to=2026-07-31`,
  );
  const csvText = await csv.text();
  assert.equal(csv.status, 200);
  assert(csvText.includes('"emitida"'));
  assert(csvText.includes('"recibida"'));

  const fiscal = before.issued_documents[0];
  const fiscalResponse = await json(
    `/accounting/documents/${encodeURIComponent(fiscal.id)}?clinic_id=${CLINIC_ID}`,
  );
  assert.equal(fiscalResponse.response.status, 200);
  assert.equal(fiscalResponse.body.number, fiscal.number);

  const invalidDocumentNumber = `QA-INVALID-${Date.now()}`;
  const invalid = await json('/accounting/expenses', {
    method: 'POST',
    body: JSON.stringify({
      clinic_id: CLINIC_ID,
      supplier_name: 'Proveedor inválido QA',
      document_number: invalidDocumentNumber,
      issue_date: '2026-07-24',
      category: 'Otros',
      payment_method: 'transfer',
      status: 'pending',
      taxable_base: 10,
      tax_amount: 2.1,
      withholding_amount: 0,
      total: 12.1,
      attachment: {
        filename: 'factura.svg',
        content_type: 'image/svg+xml',
        base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
      },
    }),
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error?.code, 'expense_attachment_type_invalid');

  const after = await workspace();
  assert.equal(after.received_documents.length, before.received_documents.length);
  assert.equal(
    after.received_documents.some((item) => item.document_number === invalidDocumentNumber),
    false,
  );

  process.stdout.write(`${JSON.stringify({
    workspace: true,
    issued_documents: before.issued_documents.length,
    received_documents: before.received_documents.length,
    private_attachment: {
      bytes: attachmentBuffer.length,
      cache_control: attachment.headers.get('cache-control'),
    },
    csv: true,
    fiscal_document: fiscal.number,
    cash: {
      business_date: before.cash.current.business_date,
      time_zone: before.clinic.time_zone,
      expected: before.cash.current.expected_cash,
    },
    invalid_attachment_rejected_without_row: true,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
