#!/usr/bin/env node
'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const sharp = require('sharp');

const db = require('../../../models');
const accounting = require('../../services/accounting.service');
const accountingFirms = require('../../services/accountingFirms.service');
const accountingIngestion = require('../../services/accountingIngestion.service');
const clinicalPrivateStorage = require('../../services/clinicalPrivateStorage.service');
const economics = require('../../services/patientEconomics.service');

const DEMO_KEY = 'bs-medical-accounting-demo-v1';
const DEMO_NAME = 'BS Medical · DEMO';
const DEMO_PATIENT_PUBLIC_ID = 'demo_bsmedical_accounting_v1';
const SOURCE_CLINIC_ID = Number(process.env.BS_MEDICAL_DEMO_SOURCE_CLINIC_ID || 72);
const ACTOR_ID = Number(process.env.BS_MEDICAL_DEMO_ACTOR_ID || 1);
const ACCESS_USER_IDS = String(process.env.BS_MEDICAL_DEMO_USER_IDS || '1,44')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

const REFERENCES = Object.freeze({
  budget: `${DEMO_KEY}:budget`,
  payment: `${DEMO_KEY}:payment`,
  voucher: `${DEMO_KEY}:voucher`,
  expense: `${DEMO_KEY}:expense`,
  payroll: `${DEMO_KEY}:payroll`,
  ingestionProvider: 'clinicaclick_demo',
  ingestionModel: `${DEMO_KEY}:fixture`,
});

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function shiftedDate(base, days) {
  const result = new Date(`${base}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return dateOnly(result);
}

function addMonths(base, months) {
  const result = new Date(`${base}T12:00:00.000Z`);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result.toISOString();
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pdfText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[()\\]/g, (match) => `\\${match}`)
    .replace(/[^\x20-\x7E]/g, '');
}

function buildDemoPdf({ title, lines }) {
  const contentLines = [
    'BT',
    '/F1 18 Tf',
    `72 760 Td (${pdfText(title)}) Tj`,
    '/F1 11 Tf',
    ...lines.flatMap((line) => [
      '0 -24 Td',
      `(${pdfText(line)}) Tj`,
    ]),
    'ET',
  ];
  const stream = `${contentLines.join('\n')}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
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

async function buildPendingInvoicePng() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
      <rect width="900" height="1200" fill="#ffffff"/>
      <rect width="900" height="18" fill="#4f46e5"/>
      <text x="72" y="105" font-family="Arial, sans-serif" font-size="42" font-weight="700" fill="#111827">Factura de proveedor</text>
      <text x="72" y="157" font-family="Arial, sans-serif" font-size="22" fill="#64748b">Documento de demostracion pendiente de revisar</text>
      <line x1="72" y1="205" x2="828" y2="205" stroke="#cbd5e1" stroke-width="2"/>
      <text x="72" y="270" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#111827">Laboratorio Demo Mediterraneo SL</text>
      <text x="72" y="310" font-family="Arial, sans-serif" font-size="20" fill="#475569">B76543210 · FACT-DEMO-2026-081</text>
      <text x="72" y="350" font-family="Arial, sans-serif" font-size="20" fill="#475569">Material de consulta y consumibles</text>
      <rect x="72" y="430" width="756" height="76" rx="8" fill="#f8fafc" stroke="#cbd5e1"/>
      <text x="96" y="477" font-family="Arial, sans-serif" font-size="21" fill="#334155">Base imponible</text>
      <text x="716" y="477" text-anchor="end" font-family="Arial, sans-serif" font-size="21" fill="#0f172a">200,00 EUR</text>
      <rect x="72" y="515" width="756" height="76" rx="8" fill="#f8fafc" stroke="#cbd5e1"/>
      <text x="96" y="562" font-family="Arial, sans-serif" font-size="21" fill="#334155">IVA 21%</text>
      <text x="716" y="562" text-anchor="end" font-family="Arial, sans-serif" font-size="21" fill="#0f172a">42,00 EUR</text>
      <rect x="72" y="620" width="756" height="112" rx="8" fill="#eef2ff" stroke="#818cf8" stroke-width="2"/>
      <text x="96" y="676" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#312e81">TOTAL</text>
      <text x="790" y="688" text-anchor="end" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#312e81">242,00 EUR</text>
      <text x="72" y="1110" font-family="Arial, sans-serif" font-size="18" fill="#94a3b8">Datos sinteticos para QA. No es una factura real.</text>
    </svg>
  `;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function demoMarker(clinic) {
  return cleanObject(cleanObject(clinic?.configuracion).qa_demo);
}

async function ensureDemoClinic(sourceClinic, businessDate) {
  let clinic = await db.Clinica.findOne({ where: { nombre_clinica: DEMO_NAME } });
  if (clinic && demoMarker(clinic).key !== DEMO_KEY) {
    throw new Error(`La clínica "${DEMO_NAME}" ya existe y no pertenece a este seed.`);
  }

  const sourceConfig = cleanObject(sourceClinic.configuracion);
  const disciplinas = Array.isArray(sourceConfig.disciplinas) && sourceConfig.disciplinas.length
    ? sourceConfig.disciplinas
    : ['estetica', 'nutricion'];
  const configuracion = {
    disciplinas,
    timezone: 'Europe/Madrid',
    qa_demo: {
      key: DEMO_KEY,
      batch_id: DEMO_KEY,
      source_clinic_id: SOURCE_CLINIC_ID,
      synthetic_data_only: true,
      prepared_for_date: businessDate,
    },
  };
  const payload = {
    nombre_clinica: DEMO_NAME,
    fecha_creacion: clinic?.fecha_creacion || new Date(),
    url_avatar: sourceClinic.url_avatar || null,
    url_fondo: sourceClinic.url_fondo || null,
    descripcion: 'Clínica aislada de demostración. Todos sus datos son sintéticos y eliminables.',
    email: 'demo-bsmedical@invalid.clinicaclick.local',
    direccion: 'Calle Demostración 1',
    codigo_postal: '03001',
    ciudad: 'Alicante',
    provincia: 'Alicante',
    pais: 'España',
    estado_clinica: true,
    configuracion,
    datos_fiscales_clinica: {
      denominacion_social: 'BS Medical Demo SL',
      nif: 'B00000000',
      direccion: 'Calle Demostración 1',
      codigo_postal: '03001',
      ciudad: 'Alicante',
      provincia: 'Alicante',
      pais: 'España',
      email: 'facturacion-demo@invalid.clinicaclick.local',
    },
    grupoClinicaId: null,
  };

  if (!clinic) {
    clinic = await db.Clinica.create(payload);
  } else {
    await clinic.update(payload);
  }
  return clinic;
}

async function ensureDemoAccess(clinicId) {
  const users = await db.Usuario.findAll({
    where: { id_usuario: ACCESS_USER_IDS },
    attributes: ['id_usuario'],
  });
  for (const user of users) {
    await db.UsuarioClinica.findOrCreate({
      where: { id_usuario: user.id_usuario, id_clinica: clinicId },
      defaults: {
        rol_clinica: 'propietario',
        subrol_clinica: null,
        estado_invitacion: 'aceptada',
        invitado_por: ACTOR_ID,
        fecha_invitacion: new Date(),
        responded_at: new Date(),
      },
    });
  }
}

async function ensureDemoPatient(clinicId) {
  let patient = await db.Paciente.findOne({ where: { public_id: DEMO_PATIENT_PUBLIC_ID } });
  if (patient && Number(patient.clinica_id) !== clinicId) {
    throw new Error(`El paciente ${DEMO_PATIENT_PUBLIC_ID} ya pertenece a otra clínica.`);
  }
  const payload = {
    public_id: DEMO_PATIENT_PUBLIC_ID,
    nombre: 'Paciente',
    apellidos: 'Demo BS Medical',
    dni: '00000000T',
    telefono_movil: null,
    email: 'paciente-demo@invalid.clinicaclick.local',
    fecha_nacimiento: new Date('1988-05-12T00:00:00.000Z'),
    sexo: 'Mujer',
    fecha_alta: new Date(),
    idioma_preferido: 'es',
    paciente_conocido: true,
    clinica_id: clinicId,
  };
  if (!patient) patient = await db.Paciente.create(payload);
  else await patient.update(payload);
  await db.PacienteClinica.findOrCreate({
    where: { paciente_id: patient.id_paciente, clinica_id: clinicId },
    defaults: { es_principal: true },
  });
  return patient;
}

async function ensureTreatment(clinicId, payload) {
  const where = { clinica_id: clinicId, codigo: payload.codigo };
  const [treatment] = await db.Tratamiento.findOrCreate({
    where,
    defaults: { ...payload, clinica_id: clinicId },
  });
  await treatment.update({ ...payload, clinica_id: clinicId });
  return treatment;
}

async function ensureDemoTreatments(clinicId) {
  const facial = await ensureTreatment(clinicId, {
    codigo: 'DEMO-EST-FACIAL',
    nombre: 'Limpieza facial profunda',
    descripcion: 'Tratamiento facial sintético para probar agenda y presupuestos.',
    disciplina: 'estetica',
    especialidad: 'Estética facial',
    categoria: 'Facial',
    duracion_min: 60,
    precio_base: 95,
    color: '#4f46e5',
    origen: 'clinica',
    sesiones_defecto: 1,
    requiere_pieza: false,
    requiere_zona: true,
    activo: true,
    clinical_config: {
      medical_area_code: 'estetica',
      product_type: 'treatment',
      commercial: { product_type: 'treatment', unit_label: 'tratamiento', recommended: true },
      financing: { enabled: false },
    },
  });
  const voucher = await ensureTreatment(clinicId, {
    codigo: 'DEMO-EST-BONO-5',
    nombre: 'Bono 5 sesiones de radiofrecuencia',
    descripcion: 'Bono reutilizable de demostración para venta y control de sesiones.',
    disciplina: 'estetica',
    especialidad: 'Estética corporal',
    categoria: 'Corporal',
    duracion_min: 45,
    precio_base: 350,
    color: '#0f766e',
    origen: 'clinica',
    sesiones_defecto: 5,
    requiere_pieza: false,
    requiere_zona: true,
    activo: true,
    clinical_config: {
      medical_area_code: 'estetica',
      product_type: 'voucher',
      commercial: { product_type: 'voucher', unit_label: 'sesiones', recommended: true },
      voucher: { activation_rule: 'on_first_payment' },
      financing: { enabled: true },
    },
  });
  const nutrition = await ensureTreatment(clinicId, {
    codigo: 'DEMO-NUT-PROGRAMA',
    nombre: 'Programa nutricional trimestral',
    descripcion: 'Consulta inicial y tres seguimientos de demostración.',
    disciplina: 'nutricion',
    especialidad: 'Nutrición clínica',
    categoria: 'Programas',
    duracion_min: 50,
    precio_base: 320,
    color: '#0891b2',
    origen: 'clinica',
    sesiones_defecto: 4,
    requiere_pieza: false,
    requiere_zona: false,
    activo: true,
    clinical_config: {
      medical_area_code: 'nutricion',
      product_type: 'pack',
      commercial: { product_type: 'pack', unit_label: 'sesiones', recommended: true },
      financing: { enabled: false },
      nutrition: {
        service_kind: 'nutrition_plan_pack',
        measurement_profile_code: 'express_isak',
        generate_report: true,
        compare_previous: true,
      },
    },
  });
  return { facial, voucher, nutrition };
}

async function ensureBudgetAndPayment({ clinicId, patient, treatments, businessDate }) {
  const budget = await economics.createBudget({
    patientIdentifier: patient.public_id,
    clinicId,
    actorId: ACTOR_ID,
    payload: {
      status: 'presented',
      source_system: 'clinicaclick_demo',
      source_reference: REFERENCES.budget,
      valid_until: shiftedDate(businessDate, 30),
      lines: [
        {
          key: 'demo-facial',
          treatment_id: treatments.facial.id_tratamiento,
          code: treatments.facial.codigo,
          name: treatments.facial.nombre,
          description: treatments.facial.descripcion,
          product_type: 'treatment',
          area_code: 'estetica',
          quantity: 1,
          unit_label: 'tratamiento',
          unit_price: 95,
          discount_percent: 0,
        },
        {
          key: 'demo-bono-radiofrecuencia',
          treatment_id: treatments.voucher.id_tratamiento,
          code: treatments.voucher.codigo,
          name: treatments.voucher.nombre,
          description: treatments.voucher.descripcion,
          product_type: 'voucher',
          area_code: 'estetica',
          quantity: 5,
          unit_label: 'sesiones',
          unit_price: 70,
          discount_percent: 0,
          activation_rule: 'on_first_payment',
          expires_in_months: 12,
        },
      ],
      payment_proposal: {
        included_modes: ['single', 'clinic_installments', 'external_financing'],
        single_payment: { savings: 20 },
        schedule: [
          { key: 'entry', label: 'Reserva', amount: 150, due_date: businessDate },
          { key: 'treatment', label: 'Inicio del tratamiento', amount: 150, due_date: shiftedDate(businessDate, 15) },
          { key: 'final', label: 'Último pago', amount: 145, due_date: shiftedDate(businessDate, 45) },
        ],
        selected_financing_months: 12,
        financing_options: [
          {
            months: 12,
            provider: 'Financiera demo',
            entry: 0,
            opening_fee_percent: 0,
            interest_percent: 0,
            required_documents: ['DNI', 'Justificante de ingresos'],
            highlighted: true,
          },
          {
            months: 24,
            provider: 'Financiera demo',
            entry: 50,
            opening_fee_percent: 3,
            interest_percent: 0,
            conditions: 'Sujeto a aprobación de la entidad financiera.',
            required_documents: ['DNI', 'Justificante de ingresos'],
            highlighted: false,
          },
        ],
      },
      design_config: {
        template_id: 'builtin-young',
        header_variant: 'young',
        custom_title: 'Tu plan de cuidado',
        blocks: ['header', 'patient', 'services', 'single_payment', 'clinic_installments', 'financing', 'conditions'],
        block_visibility: {
          header: true,
          patient: true,
          services: true,
          single_payment: true,
          clinic_installments: true,
          financing: true,
          conditions: true,
        },
        conditions: 'Documento de demostración. Las condiciones no constituyen una oferta financiera real.',
      },
      notes: 'Presupuesto sintético de la clínica demo.',
      internal_notes: DEMO_KEY,
    },
  });

  const budgetRow = await db.EconomicBudget.findOne({
    where: {
      clinic_id: clinicId,
      source_system: 'clinicaclick_demo',
      source_reference: REFERENCES.budget,
    },
  });
  if (budgetRow.status === 'presented') {
    await economics.transitionBudget({
      publicId: budgetRow.public_id,
      actorId: ACTOR_ID,
      action: 'accept',
    });
    await budgetRow.reload();
  }

  let payment = await db.EconomicPayment.findOne({
    where: { clinic_id: clinicId, reference: REFERENCES.payment },
  });
  if (!payment) {
    await economics.createPayment({
      publicId: budgetRow.public_id,
      actorId: ACTOR_ID,
      payload: {
        amount: 150,
        method: 'cash',
        reference: REFERENCES.payment,
        allocations: [{
          target_type: 'budget',
          line_key: null,
          amount: 150,
          label: 'Reserva del tratamiento',
        }],
        notes: 'Cobro sintético para probar caja y facturación.',
        paid_at: `${businessDate}T10:30:00.000Z`,
      },
    });
    payment = await db.EconomicPayment.findOne({
      where: { clinic_id: clinicId, reference: REFERENCES.payment },
    });
  }
  return { budget, budgetRow, payment };
}

async function ensureFiscalDocument({ clinicId, patient, payment, businessDate }) {
  const number = `DEMO-FAC-${businessDate.slice(0, 4)}-0001`;
  let document = await db.PatientFiscalDocument.findOne({
    where: { clinic_id: clinicId, number },
  });
  if (!document) {
    await economics.createPatientFiscalDocument({
      patientIdentifier: patient.public_id,
      clinicId,
      actorId: ACTOR_ID,
      payload: {
        source_type: 'payment',
        source_id: payment.public_id,
        document_type: 'invoice',
        status: 'issued',
        issue_date: businessDate,
        series: 'DEMO',
        number,
        issuer: {
          legal_name: 'BS Medical Demo SL',
          name: 'BS Medical · DEMO',
          tax_id: 'B00000000',
          address: 'Calle Demostración 1',
          postal_code: '03001',
          city: 'Alicante',
          province: 'Alicante',
          country: 'España',
          email: 'facturacion-demo@invalid.clinicaclick.local',
        },
        recipient: {
          legal_name: 'Paciente Demo BS Medical',
          name: 'Paciente Demo BS Medical',
          tax_id: '00000000T',
          address: 'Avenida de Pruebas 10',
          postal_code: '03002',
          city: 'Alicante',
          province: 'Alicante',
          country: 'España',
          email: 'paciente-demo@invalid.clinicaclick.local',
        },
        lines: [{
          key: 'demo-reserva',
          description: 'Entrega a cuenta de tratamiento',
          quantity: 1,
          unit_price: 150,
          discount_percent: 0,
          tax_percent: 0,
          exemption_reason: 'Documento de demostración sin validez fiscal.',
        }],
        template_id: 'builtin-invoice-standard',
        notes: 'Factura sintética para validación visual. Sin validez fiscal.',
      },
    });
    document = await db.PatientFiscalDocument.findOne({
      where: { clinic_id: clinicId, number },
    });
  }
  return document;
}

async function ensureExpense({ clinicId, businessDate }) {
  let expense = await db.AccountingExpenseDocument.findOne({
    where: {
      clinic_id: clinicId,
      source_system: 'clinicaclick_demo',
      source_reference: REFERENCES.expense,
    },
  });
  if (!expense) {
    const attachment = buildDemoPdf({
      title: 'Factura proveedor demo',
      lines: [
        'Suministros Sanitarios Demo SL',
        `Documento: PROV-DEMO-${businessDate.replaceAll('-', '')}`,
        'Material fungible de consulta',
        'Base: 30.00 EUR',
        'IVA: 6.30 EUR',
        'Total: 36.30 EUR',
        'Datos sinteticos sin validez fiscal',
      ],
    });
    await accounting.createExpense({
      clinicId,
      actorId: ACTOR_ID,
      payload: {
        supplier_name: 'Suministros Sanitarios Demo SL',
        supplier_tax_id: 'B12345678',
        supplier_address: 'Avenida de la Demostración 10, Alicante',
        document_number: `PROV-DEMO-${businessDate.replaceAll('-', '')}`,
        issue_date: businessDate,
        due_date: businessDate,
        category: 'Material clínico',
        payment_method: 'cash',
        status: 'paid',
        taxable_base: 30,
        tax_amount: 6.30,
        withholding_amount: 0,
        total: 36.30,
        paid_at: `${businessDate}T11:15:00.000Z`,
        notes: 'Factura sintética para probar gastos y caja.',
        source_system: 'clinicaclick_demo',
        source_reference: REFERENCES.expense,
        attachment: {
          filename: 'factura-proveedor-demo.pdf',
          content_type: 'application/pdf',
          base64: attachment.toString('base64'),
        },
      },
    });
    expense = await db.AccountingExpenseDocument.findOne({
      where: {
        clinic_id: clinicId,
        source_system: 'clinicaclick_demo',
        source_reference: REFERENCES.expense,
      },
    });
  }
  return expense;
}

async function ensureIngestionReview({ clinicId, businessDate }) {
  let job = await db.AccountingIngestionJob.findOne({
    where: {
      clinic_id: clinicId,
      provider: REFERENCES.ingestionProvider,
      model: REFERENCES.ingestionModel,
    },
  });
  if (!job) {
    const image = await buildPendingInvoicePng();
    const queued = await accountingIngestion.enqueue({
      clinicId,
      actorId: ACTOR_ID,
      attachment: {
        filename: 'factura-pendiente-demo.png',
        content_type: 'image/png',
        base64: image.toString('base64'),
      },
    });
    job = await db.AccountingIngestionJob.findOne({
      where: { public_id: queued.id, clinic_id: clinicId },
    });
    await job.update({
      status: 'review',
      provider: REFERENCES.ingestionProvider,
      model: REFERENCES.ingestionModel,
      extracted_data: {
        supplier_name: 'Laboratorio Demo Mediterráneo SL',
        supplier_tax_id: 'B76543210',
        supplier_address: 'Calle del Laboratorio 20, Alicante',
        document_number: 'FACT-DEMO-2026-081',
        issue_date: businessDate,
        due_date: shiftedDate(businessDate, 30),
        category: 'Laboratorio',
        payment_method: 'transfer',
        taxable_base: 200,
        tax_amount: 42,
        withholding_amount: 0,
        total: 242,
        currency: 'EUR',
        confidence: 0.94,
        warnings: ['Datos sintéticos preparados para revisión manual.'],
      },
      confidence: 0.94,
      attempts: 1,
      processed_at: new Date(),
    });
  }
  return job;
}

async function ensureOpeningCash({ clinicId, businessDate }) {
  const previousDay = shiftedDate(businessDate, -1);
  let closure = await db.AccountingCashClosure.findOne({
    where: { clinic_id: clinicId, business_date: previousDay },
  });
  if (!closure) {
    closure = await db.AccountingCashClosure.create({
      public_id: crypto.randomUUID(),
      clinic_id: clinicId,
      business_date: previousDay,
      opening_cash: 150,
      cash_receipts: 0,
      cash_outflows: 0,
      expected_cash: 150,
      actual_cash: 150,
      denomination_breakdown: { 50: 3 },
      tender_reconciliation: {},
      difference: 0,
      notes: 'Fondo sintético dejado para la apertura del día siguiente.',
      snapshot: {
        business_date: previousDay,
        opening_cash: 150,
        patient_receipts: 0,
        manual_income: 0,
        expense_outflows: 0,
        manual_outflows: 0,
        adjustments: 0,
        cash_receipts: 0,
        cash_outflows: 0,
        expected_cash: 150,
        tender_reconciliation: {},
        source_ids: { payments: [], expenses: [], movements: [] },
        demo_seed: DEMO_KEY,
      },
      closed_by: ACTOR_ID,
      closed_at: new Date(`${previousDay}T18:00:00.000Z`),
    });
  }
  return closure;
}

async function ensureCurrentCashSession({ clinicId, businessDate }) {
  const existing = await db.AccountingCashSession.findOne({
    where: { clinic_id: clinicId, business_date: businessDate },
  });
  if (existing) return existing;
  await accounting.openCash({
    clinicId,
    actorId: ACTOR_ID,
    payload: {
      business_date: businessDate,
      notes: 'Caja abierta por el seed sintético de BS Medical.',
    },
  });
  return db.AccountingCashSession.findOne({
    where: { clinic_id: clinicId, business_date: businessDate },
  });
}

async function ensurePayroll({ clinicId, businessDate }) {
  const periodMonth = `${businessDate.slice(0, 7)}-01`;
  let payroll = await db.AccountingPayrollPeriod.findOne({
    where: { clinic_id: clinicId, period_month: periodMonth },
  });
  if (payroll) return payroll;
  const attachment = buildDemoPdf({
    title: 'Resumen de nominas demo',
    lines: [
      `Periodo: ${businessDate.slice(0, 7)}`,
      'Salarios brutos: 4600.00 EUR',
      'Seguridad Social empresa: 1420.00 EUR',
      'Otros costes: 120.00 EUR',
      'Coste total de personal: 6140.00 EUR',
      'Documento agregado sintetico. Sin datos de empleados.',
    ],
  });
  await accounting.createPayroll({
    clinicId,
    actorId: ACTOR_ID,
    payload: {
      period_month: periodMonth,
      gross_salaries: 4600,
      employee_social_security: 295,
      irpf_withholding: 795,
      net_paid: 3510,
      employer_social_security: 1420,
      other_costs: 120,
      status: 'paid',
      paid_at: `${businessDate}T08:15:00.000Z`,
      notes: `${REFERENCES.payroll}. Datos sintéticos agregados para la demo.`,
      attachment: {
        filename: `resumen-nominas-demo-${businessDate.slice(0, 7)}.pdf`,
        content_type: 'application/pdf',
        base64: attachment.toString('base64'),
      },
    },
  });
  payroll = await db.AccountingPayrollPeriod.findOne({
    where: { clinic_id: clinicId, period_month: periodMonth },
  });
  return payroll;
}

async function ensureAccountingFirm({ clinicId }) {
  let firm = await accountingFirms.getFirm({ clinicId });
  let credentials = null;
  if (!firm.access.configured) {
    firm = await accountingFirms.issueCredentials({
      clinicId,
      actorId: ACTOR_ID,
    });
    credentials = firm.credentials;
  }
  return { firm, credentials };
}

async function prepare() {
  if (!Number.isInteger(SOURCE_CLINIC_ID) || SOURCE_CLINIC_ID <= 0) {
    throw new Error('BS_MEDICAL_DEMO_SOURCE_CLINIC_ID debe ser un entero positivo.');
  }
  const [sourceClinic, actor] = await Promise.all([
    db.Clinica.findByPk(SOURCE_CLINIC_ID),
    db.Usuario.findByPk(ACTOR_ID),
  ]);
  if (!sourceClinic) throw new Error(`No existe la clínica origen ${SOURCE_CLINIC_ID}.`);
  if (!actor) throw new Error(`No existe el usuario actor ${ACTOR_ID}.`);

  const businessDate = process.env.BS_MEDICAL_DEMO_BUSINESS_DATE || dateOnly(new Date());
  const clinic = await ensureDemoClinic(sourceClinic, businessDate);
  const clinicId = Number(clinic.id_clinica);
  await ensureDemoAccess(clinicId);
  const patient = await ensureDemoPatient(clinicId);
  const treatments = await ensureDemoTreatments(clinicId);
  const economicsState = await ensureBudgetAndPayment({
    clinicId,
    patient,
    treatments,
    businessDate,
  });
  const fiscalDocument = await ensureFiscalDocument({
    clinicId,
    patient,
    payment: economicsState.payment,
    businessDate,
  });
  const expense = await ensureExpense({ clinicId, businessDate });
  const ingestion = await ensureIngestionReview({ clinicId, businessDate });
  const closure = await ensureOpeningCash({ clinicId, businessDate });
  const cashSession = await ensureCurrentCashSession({ clinicId, businessDate });
  const payroll = await ensurePayroll({ clinicId, businessDate });
  const firmState = await ensureAccountingFirm({ clinicId });
  const workspace = await accounting.getWorkspace({
    clinicId,
    includePayroll: true,
    query: {
      from: `${businessDate.slice(0, 8)}01`,
      to: businessDate,
      business_date: businessDate,
    },
  });
  const patientWorkspace = await economics.getWorkspace({
    patientIdentifier: patient.public_id,
    clinicId,
  });

  process.stdout.write(`${JSON.stringify({
    demo_key: DEMO_KEY,
    clinic: {
      id: clinicId,
      name: clinic.nombre_clinica,
      group_id: clinic.grupoClinicaId,
      synthetic_data_only: true,
    },
    patient: {
      id: patient.public_id,
      name: `${patient.nombre} ${patient.apellidos}`,
    },
    treatments: Object.values(treatments).map((item) => ({
      id: item.id_tratamiento,
      code: item.codigo,
      name: item.nombre,
    })),
    budget: {
      id: economicsState.budgetRow.public_id,
      number: economicsState.budgetRow.number,
      status: economicsState.budgetRow.status,
    },
    payment: {
      id: economicsState.payment.public_id,
      amount: Number(economicsState.payment.amount),
      method: economicsState.payment.method,
    },
    voucher_count: patientWorkspace.vouchers.length,
    fiscal_document: {
      id: fiscalDocument.public_id,
      number: fiscalDocument.number,
      status: fiscalDocument.status,
    },
    expense: {
      id: expense.public_id,
      document_number: expense.document_number,
      attachment_asset_id: expense.attachment_asset_id,
    },
    ingestion: {
      id: ingestion.public_id,
      status: ingestion.status,
    },
    previous_closure: {
      id: closure.public_id,
      business_date: closure.business_date,
      actual_cash: Number(closure.actual_cash),
    },
    cash_session: {
      id: cashSession.public_id,
      business_date: cashSession.business_date,
      opening_cash: Number(cashSession.opening_cash),
      status: cashSession.status,
    },
    payroll: {
      id: payroll.public_id,
      period_month: payroll.period_month,
      total_personnel_cost: Number(payroll.total_personnel_cost),
      document_asset_id: payroll.document_asset_id,
    },
    accounting_firm: {
      id: firmState.firm.id,
      name: firmState.firm.name,
      email: firmState.firm.access.email,
      portal_url: firmState.firm.portal_url,
      credentials_issued_now: firmState.credentials,
    },
    accounting: {
      summary: workspace.summary,
      cash: workspace.cash.current,
    },
    urls: {
      accounting: 'http://localhost:4203/contabilidad',
      patient: `http://localhost:4203/pacientes/detalle/${patient.public_id}/presupuestos`,
    },
    cleanup: 'node src/scripts/qa/prepare-bs-medical-demo-clinic.js --cleanup',
  }, null, 2)}\n`);
}

async function removePrivateFiles(assets) {
  const removed = [];
  const failed = [];
  for (const asset of assets) {
    try {
      const filePath = clinicalPrivateStorage.__testing.objectPathForKey(asset.object_key);
      await fs.rm(filePath, { force: true });
      removed.push(asset.public_id);
    } catch (error) {
      failed.push({ id: asset.public_id, error: error.message });
    }
  }
  return { removed, failed };
}

async function cleanup() {
  const clinic = await db.Clinica.findOne({ where: { nombre_clinica: DEMO_NAME } });
  if (!clinic) {
    process.stdout.write(`${JSON.stringify({ removed: false, reason: 'demo_clinic_not_found' })}\n`);
    return;
  }
  if (demoMarker(clinic).key !== DEMO_KEY) {
    throw new Error('Se rechaza el borrado: la clínica no conserva el marcador esperado.');
  }
  const clinicId = Number(clinic.id_clinica);
  const patientRows = await db.Paciente.findAll({
    where: { clinica_id: clinicId },
    attributes: ['id_paciente'],
    raw: true,
  });
  const patientIds = patientRows.map((row) => Number(row.id_paciente));
  const budgets = await db.EconomicBudget.findAll({
    where: { clinic_id: clinicId },
    attributes: ['id'],
    raw: true,
  });
  const budgetIds = budgets.map((row) => Number(row.id));
  const vouchers = await db.PatientVoucher.findAll({
    where: { clinic_id: clinicId },
    attributes: ['id'],
    raw: true,
  });
  const voucherIds = vouchers.map((row) => Number(row.id));
  const firmAssignments = await db.AccountingFirmClinicAssignment.findAll({
    where: { clinic_id: clinicId },
    attributes: ['firm_id'],
    raw: true,
  });
  const firmIds = [...new Set(firmAssignments.map((row) => Number(row.firm_id)).filter(Boolean))];
  const firmUsers = firmIds.length
    ? await db.AccountingFirmUser.findAll({
      where: { firm_id: firmIds },
      attributes: ['user_id'],
      raw: true,
    })
    : [];
  const firmUserIds = [...new Set(firmUsers.map((row) => Number(row.user_id)).filter(Boolean))];
  const remittances = await db.AccountingRemittance.findAll({
    where: { clinic_id: clinicId },
    attributes: ['id'],
    raw: true,
  });
  const remittanceIds = remittances.map((row) => Number(row.id));
  const assets = await db.ClinicalPrivateAsset.findAll({
    where: { clinic_id: clinicId },
    attributes: ['id', 'public_id', 'object_key'],
    raw: true,
  });

  await db.sequelize.transaction(async (transaction) => {
    if (voucherIds.length) {
      await db.PatientVoucherMovement.destroy({
        where: { voucher_id: voucherIds },
        transaction,
      });
    }
    await db.PatientVoucher.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.PatientWalletEntry.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.PatientFiscalDocument.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.EconomicPayment.destroy({ where: { clinic_id: clinicId }, transaction });
    if (budgetIds.length) {
      await db.EconomicBudgetEvent.destroy({ where: { budget_id: budgetIds }, transaction });
      await db.EconomicBudgetVersion.destroy({ where: { budget_id: budgetIds }, transaction });
    }
    await db.EconomicBudget.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.AccountingIngestionJob.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.AccountingExpenseDocument.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.AccountingPayrollPeriod.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.AccountingCashMovement.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.AccountingCashSession.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.AccountingCashClosure.destroy({ where: { clinic_id: clinicId }, transaction });
    if (remittanceIds.length) {
      await db.AccountingRemittanceItem.destroy({
        where: { remittance_id: remittanceIds },
        transaction,
      });
    }
    await db.AccountingRemittance.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.AccountingSepaMandate.destroy({ where: { clinic_id: clinicId }, transaction });
    if (firmIds.length) {
      await db.AccountingFirmUser.destroy({ where: { firm_id: firmIds }, transaction });
    }
    await db.AccountingFirmClinicAssignment.destroy({ where: { clinic_id: clinicId }, transaction });
    for (const firmId of firmIds) {
      const remainingAssignments = await db.AccountingFirmClinicAssignment.count({
        where: { firm_id: firmId },
        transaction,
      });
      if (!remainingAssignments) {
        await db.AccountingFirm.destroy({ where: { id: firmId, primary_clinic_id: clinicId }, transaction });
      }
    }
    await db.ClinicEconomicTemplate.destroy({ where: { clinic_id: clinicId }, transaction });

    const treatmentRows = await db.Tratamiento.findAll({
      where: { clinica_id: clinicId },
      attributes: ['id_tratamiento'],
      raw: true,
      transaction,
    });
    const treatmentIds = treatmentRows.map((row) => Number(row.id_tratamiento));
    if (treatmentIds.length) {
      await db.DependenciaTratamiento.destroy({
        where: {
          [db.Sequelize.Op.or]: [
            { id_tratamiento_origen: treatmentIds },
            { id_tratamiento_destino: treatmentIds },
          ],
        },
        transaction,
      });
    }
    await db.Tratamiento.destroy({ where: { clinica_id: clinicId }, transaction });

    if (patientIds.length) {
      await db.PacienteClinica.destroy({ where: { paciente_id: patientIds }, transaction });
    }
    await db.PacienteClinica.destroy({ where: { clinica_id: clinicId }, transaction });
    await db.ClinicalPrivateAsset.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.UsuarioClinica.destroy({ where: { id_clinica: clinicId }, transaction });
    await db.Paciente.destroy({ where: { clinica_id: clinicId }, transaction });
    await db.Clinica.destroy({ where: { id_clinica: clinicId }, transaction });
    if (firmUserIds.length) {
      await db.Usuario.destroy({ where: { id_usuario: firmUserIds }, transaction });
    }
  });

  const privateFiles = await removePrivateFiles(assets);
  process.stdout.write(`${JSON.stringify({
    removed: true,
    demo_key: DEMO_KEY,
    clinic_id: clinicId,
    patients: patientIds.length,
    private_files: privateFiles,
  }, null, 2)}\n`);
}

const action = process.argv.includes('--cleanup') ? cleanup : prepare;

action()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
