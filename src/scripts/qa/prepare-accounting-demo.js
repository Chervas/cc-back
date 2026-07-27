#!/usr/bin/env node
'use strict';

require('dotenv').config();
const db = require('../../../models');
const accounting = require('../../services/accounting.service');
const economics = require('../../services/patientEconomics.service');

function buildDemoPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 132 >>\nstream\nBT /F1 18 Tf 72 760 Td (Factura proveedor demo) Tj /F1 11 Tf 0 -30 Td (Material clinico - Clinicaclick QA) Tj 0 -20 Td (Total: 124.83 EUR) Tj ET\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

async function main() {
  const clinicId = Number(process.env.DEMO_ACCOUNTING_CLINIC_ID || 66);
  const actorId = Number(process.env.DEMO_ACCOUNTING_ACTOR_ID || 1);
  const patientIdentifier = process.env.DEMO_ACCOUNTING_PATIENT_ID || 'ccdemo260722_19_23051359';
  const today = new Date().toISOString().slice(0, 10);
  const previousDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const expenseReference = 'accounting-demo-expense-v1';
  const movementReference = 'accounting-demo-opening-v1';

  let expense = await db.AccountingExpenseDocument.findOne({
    where: { clinic_id: clinicId, source_system: 'clinicaclick_demo', source_reference: expenseReference },
  });
  if (!expense) {
    expense = await accounting.createExpense({
      clinicId,
      actorId,
      payload: {
        supplier_name: 'Suministros Médicos Demo SL',
        supplier_tax_id: 'B12345678',
        supplier_address: 'Avenida de la Demo 10, Alicante',
        document_number: 'PROV-DEMO-2026-018',
        issue_date: today,
        due_date: today,
        category: 'Material clínico',
        payment_method: 'cash',
        status: 'paid',
        taxable_base: 103.17,
        tax_amount: 21.66,
        withholding_amount: 0,
        total: 124.83,
        paid_at: `${today}T10:00:00.000Z`,
        notes: 'Dato de demostración para validar contabilidad y portal de gestoría.',
        source_system: 'clinicaclick_demo',
        source_reference: expenseReference,
        attachment: {
          filename: 'factura-proveedor-demo.pdf',
          content_type: 'application/pdf',
          base64: buildDemoPdf().toString('base64'),
        },
      },
    });
  }

  let movement = await db.AccountingCashMovement.findOne({
    where: { clinic_id: clinicId, source_type: 'clinicaclick_demo', source_id: movementReference },
  });
  if (!movement) {
    movement = await accounting.createCashMovement({
      clinicId,
      actorId,
      payload: {
        movement_type: 'income',
        amount: 200,
        method: 'cash',
        description: 'Fondo de caja demo',
        source_type: 'clinicaclick_demo',
        source_id: movementReference,
        occurred_at: `${today}T09:00:00.000Z`,
      },
    });
  }

  let previousClosure = await db.AccountingCashClosure.findOne({
    where: { clinic_id: clinicId, business_date: previousDay },
  });
  if (!previousClosure) {
    previousClosure = await accounting.closeCash({
      clinicId,
      actorId,
      payload: {
        business_date: previousDay,
        opening_cash: 150,
        actual_cash: 150,
        notes: 'Cierre de demostración anterior para mostrar la continuidad de caja.',
      },
    });
  }

  const demoBudget = await economics.createBudget({
    patientIdentifier,
    clinicId,
    actorId,
    payload: {
      status: 'presented',
      source_system: 'clinicaclick_demo',
      source_reference: 'accounting-demo-multipayment-budget-v1',
      valid_until: new Date(Date.now() + 30 * 86400000).toISOString(),
      lines: [{
        key: 'demo-capilar-plan',
        code: 'DEMO-CAPILAR',
        name: 'Plan capilar personalizado',
        description: 'Tratamiento de demostración con alternativas de pago para el paciente.',
        product_type: 'treatment',
        area_code: 'capilar',
        quantity: 1,
        unit_label: 'tratamiento',
        unit_price: 2400,
        discount_percent: 0,
      }],
      payment_proposal: {
        included_modes: ['single', 'clinic_installments', 'external_financing'],
        single_payment: { savings: 120 },
        schedule: [
          { key: 'entry', label: 'Reserva', amount: 600, due_date: today },
          { key: 'procedure', label: 'Día del tratamiento', amount: 1200 },
          { key: 'follow-up', label: 'Seguimiento', amount: 600 },
        ],
        selected_financing_months: 24,
        financing_options: [
          {
            months: 12,
            provider: 'Financiera demo',
            entry: 0,
            opening_fee_percent: 0,
            interest_percent: 0,
            required_documents: ['DNI', 'Justificante de ingresos'],
            highlighted: false,
          },
          {
            months: 24,
            provider: 'Financiera demo',
            entry: 300,
            opening_fee_percent: 3,
            interest_percent: 0,
            conditions: 'Sujeto a aprobación de la entidad financiera.',
            required_documents: ['DNI', 'Justificante de ingresos'],
            highlighted: true,
          },
        ],
      },
      design_config: {
        template_id: 'builtin-young',
        header_variant: 'young',
        custom_title: 'Tu plan capilar',
        blocks: [
          'header',
          'patient',
          'services',
          'single_payment',
          'clinic_installments',
          'financing',
          'conditions',
        ],
        block_visibility: {
          header: true,
          patient: true,
          services: true,
          single_payment: true,
          clinic_installments: true,
          financing: true,
          conditions: true,
        },
        conditions: 'Alternativas sujetas a aceptación y, cuando corresponda, aprobación financiera.',
      },
      notes: 'Presupuesto multiopción de demostración.',
    },
  });

  const workspace = await accounting.getWorkspace({
    clinicId,
    query: { from: today.slice(0, 8) + '01', to: today, business_date: today },
  });
  process.stdout.write(`${JSON.stringify({
    clinic_id: clinicId,
    expense_id: expense.public_id || expense.id,
    movement_id: movement.public_id || movement.id,
    previous_closure_id: previousClosure.public_id || previousClosure.id,
    budget_id: demoBudget.id,
    budget_number: demoBudget.number,
    summary: workspace.summary,
    cash: workspace.cash.current,
    portal_url: `http://localhost:4203/gestoria`,
    accounting_url: `http://localhost:4203/contabilidad`,
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
