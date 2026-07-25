#!/usr/bin/env node
'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const bcrypt = require('bcryptjs');
const sharp = require('sharp');

const db = require('../../../models');
const accounting = require('../../services/accounting.service');
const accountingFirms = require('../../services/accountingFirms.service');
const accountingIngestion = require('../../services/accountingIngestion.service');
const appointmentClinicalReports = require('../../services/appointmentClinicalReports.service');
const clinicalPrivateStorage = require('../../services/clinicalPrivateStorage.service');
const consentimientosService = require('../../services/consentimientos.service');
const economics = require('../../services/patientEconomics.service');
const nutritionWorkspace = require('../../services/nutritionWorkspace.service');

const DEMO_KEY = 'bs-medical-accounting-demo-v1';
const DEMO_NAME = 'BS Medical · DEMO';
const DEMO_PATIENT_PUBLIC_ID = 'demo_bsmedical_accounting_v1';
const DEMO_NUTRITION_PATIENT_PUBLIC_ID = 'demo_bsmedical_nutrition_v1';
const DEMO_CAPILLARY_PATIENT_PUBLIC_ID = 'demo_bsmedical_capillary_v1';
const DEMO_RECEPTION_EMAIL = 'recepcion+bs-medical-demo@invalid.clinicaclick.local';
const DEMO_RECEPTION_CARGO = `Recepción demo · ${DEMO_KEY}`;
const DEMO_DOCTOR_EMAIL = 'doctora+bs-medical-demo@invalid.clinicaclick.local';
const DEMO_DOCTOR_CARGO = `Doctora demo · ${DEMO_KEY}`;
const DEMO_DOCTOR_PASSWORD = 'DemoDoctor2026!';
const DEMO_TABLET_USERNAME = 'bs-medical-demo-tablet';
const DEMO_TABLET_PASSWORD = 'DemoTablet2026!';
const DEMO_TABLET_PUBLIC_ID = 'kiosk_bsmedical_demo_v1';
const DEMO_CONSENT_IDS = Object.freeze({
  clinicalTemplate: 'cclin_bsmedical_demo_capillary_v1',
  photosTemplate: 'cclin_bsmedical_demo_photos_v1',
  pendingPackage: 'cpkg_bsmedical_demo_capillary_pending_v1',
  signedPackage: 'cpkg_bsmedical_demo_capillary_signed_v1',
});
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

const SIGNATURE_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180" viewBox="0 0 640 180">
  <rect width="640" height="180" fill="white"/>
  <path d="M52 115 C106 70, 132 145, 185 98 S276 82, 310 106 S374 138, 426 91 S520 70, 586 104" fill="none" stroke="#111827" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M82 136 H560" stroke="#CBD5E1" stroke-width="2" stroke-linecap="round"/>
</svg>
`).toString('base64')}`;

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function shiftedDate(base, days) {
  const result = new Date(`${base}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return dateOnly(result);
}

function dateTimeAt(base, days, hour, minute = 0) {
  const result = new Date(`${base}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  result.setUTCHours(hour, minute, 0, 0);
  return result;
}

function minutesAfter(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addMonths(base, months) {
  const result = new Date(`${base}T12:00:00.000Z`);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result.toISOString();
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readablePassword() {
  return crypto.randomBytes(18).toString('base64url').match(/.{1,4}/g).join('-');
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

  const configuracion = {
    disciplinas: ['estetica', 'nutricion', 'capilar'],
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

  let reception = await db.Usuario.findOne({
    where: { email_usuario: DEMO_RECEPTION_EMAIL },
  });
  let credentials = null;
  if (reception && reception.cargo_usuario !== DEMO_RECEPTION_CARGO) {
    throw new Error(`El correo sintético ${DEMO_RECEPTION_EMAIL} ya pertenece a otro usuario.`);
  }
  if (!reception) {
    const password = readablePassword();
    reception = await db.Usuario.create({
      nombre: 'Laura',
      apellidos: 'Recepción Demo',
      email_usuario: DEMO_RECEPTION_EMAIL,
      email_factura: DEMO_RECEPTION_EMAIL,
      email_notificacion: DEMO_RECEPTION_EMAIL,
      password_usuario: await bcrypt.hash(password, 10),
      cargo_usuario: DEMO_RECEPTION_CARGO,
      estado_cuenta: 'activo',
      es_provisional: false,
      creado_por: ACTOR_ID,
    });
    credentials = {
      email: DEMO_RECEPTION_EMAIL,
      password,
    };
  }
  const [membership] = await db.UsuarioClinica.findOrCreate({
    where: { id_usuario: reception.id_usuario, id_clinica: clinicId },
    defaults: {
      rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Recepción / Comercial ventas',
      estado_invitacion: 'aceptada',
      invitado_por: ACTOR_ID,
      fecha_invitacion: new Date(),
      responded_at: new Date(),
    },
  });
  if (
    membership.rol_clinica !== 'personaldeclinica'
    || membership.subrol_clinica !== 'Recepción / Comercial ventas'
    || membership.estado_invitacion !== 'aceptada'
  ) {
    await membership.update({
      rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Recepción / Comercial ventas',
      estado_invitacion: 'aceptada',
      responded_at: new Date(),
    });
  }
  return { user: reception, credentials };
}

async function ensureDemoDoctor(clinicId) {
  let doctor = await db.Usuario.findOne({
    where: { email_usuario: DEMO_DOCTOR_EMAIL },
  });
  if (doctor && doctor.cargo_usuario !== DEMO_DOCTOR_CARGO) {
    throw new Error(`El correo sintético ${DEMO_DOCTOR_EMAIL} ya pertenece a otro usuario.`);
  }
  const payload = {
    nombre: 'Marta',
    apellidos: 'López · Demo',
    email_usuario: DEMO_DOCTOR_EMAIL,
    email_factura: DEMO_DOCTOR_EMAIL,
    email_notificacion: DEMO_DOCTOR_EMAIL,
    password_usuario: await bcrypt.hash(DEMO_DOCTOR_PASSWORD, 10),
    cargo_usuario: DEMO_DOCTOR_CARGO,
    telefono: '+34600000083',
    isProfesional: true,
    estado_cuenta: 'activo',
    es_provisional: false,
    creado_por: ACTOR_ID,
  };
  if (!doctor) doctor = await db.Usuario.create(payload);
  else await doctor.update(payload);

  const [membership] = await db.UsuarioClinica.findOrCreate({
    where: { id_usuario: doctor.id_usuario, id_clinica: clinicId },
    defaults: {
      rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Doctores',
      estado_invitacion: 'aceptada',
      invitado_por: ACTOR_ID,
      fecha_invitacion: new Date(),
      responded_at: new Date(),
    },
  });
  await membership.update({
    rol_clinica: 'personaldeclinica',
    subrol_clinica: 'Doctores',
    estado_invitacion: 'aceptada',
    responded_at: new Date(),
  });

  const [link] = await db.DoctorClinica.findOrCreate({
    where: { doctor_id: doctor.id_usuario, clinica_id: clinicId },
    defaults: {
      rol_en_clinica: 'Medicina estética, nutrición y capilar',
      recibe_citas: true,
      activo: true,
    },
  });
  await link.update({
    rol_en_clinica: 'Medicina estética, nutrición y capilar',
    recibe_citas: true,
    activo: true,
  });
  for (let day = 0; day <= 6; day += 1) {
    const [schedule] = await db.DoctorHorario.findOrCreate({
      where: { doctor_clinica_id: link.id, dia_semana: day },
      defaults: {
        activo: day !== 0,
        hora_inicio: '08:00',
        hora_fin: day === 6 ? '20:00' : '21:00',
      },
    });
    await schedule.update({
      activo: day !== 0,
      hora_inicio: '08:00',
      hora_fin: day === 6 ? '20:00' : '21:00',
      fecha_inicio_vigencia: null,
      fecha_fin_vigencia: null,
      rrule: null,
    });
  }
  return doctor;
}

async function ensureDemoClinicSchedule(clinicId) {
  for (let day = 0; day <= 6; day += 1) {
    const [schedule] = await db.ClinicaHorario.findOrCreate({
      where: { clinica_id: clinicId, dia_semana: day },
      defaults: {
        activo: day !== 0,
        hora_inicio: '08:00',
        hora_fin: day === 6 ? '20:00' : '21:00',
      },
    });
    await schedule.update({
      activo: day !== 0,
      hora_inicio: '08:00',
      hora_fin: day === 6 ? '20:00' : '21:00',
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
  await ensurePatientArea(patient, clinicId, 'estetica');
  return patient;
}

async function ensurePatientArea(patient, clinicId, areaCode) {
  const [row] = await db.PatientCustomField.findOrCreate({
    where: {
      paciente_id: patient.id_paciente,
      clinica_id: clinicId,
      field_key: 'cliniccloud_demo_area',
    },
    defaults: {
      label: 'Área médica del caso demo',
      value: areaCode,
      value_type: 'text',
      source: 'qa_seed',
      source_column: DEMO_KEY,
      last_imported_at: new Date(),
    },
  });
  await row.update({
    label: 'Área médica del caso demo',
    value: areaCode,
    value_type: 'text',
    source: 'qa_seed',
    source_column: DEMO_KEY,
    last_imported_at: new Date(),
  });
}

async function ensureClinicalDemoPatient(clinicId, payload) {
  let patient = await db.Paciente.findOne({ where: { public_id: payload.public_id } });
  if (patient && Number(patient.clinica_id) !== clinicId) {
    throw new Error(`El paciente ${payload.public_id} ya pertenece a otra clínica.`);
  }
  const values = {
    nombre: payload.nombre,
    apellidos: payload.apellidos,
    dni: payload.dni,
    telefono_movil: payload.telefono,
    email: payload.email,
    fecha_nacimiento: new Date(payload.fecha_nacimiento),
    sexo: payload.sexo,
    fecha_alta: patient?.fecha_alta || new Date(),
    idioma_preferido: 'es',
    paciente_conocido: true,
    clinica_id: clinicId,
  };
  if (!patient) patient = await db.Paciente.create({ public_id: payload.public_id, ...values });
  else await patient.update(values);
  await db.PacienteClinica.findOrCreate({
    where: { paciente_id: patient.id_paciente, clinica_id: clinicId },
    defaults: { es_principal: true },
  });
  await ensurePatientArea(patient, clinicId, payload.area_code);
  return patient;
}

async function ensureClinicalDemoPatients(clinicId) {
  const nutrition = await ensureClinicalDemoPatient(clinicId, {
    public_id: DEMO_NUTRITION_PATIENT_PUBLIC_ID,
    nombre: 'Daniel',
    apellidos: 'Moreno · Demo Nutrición',
    dni: '00000001R',
    telefono: '+34600000081',
    email: 'nutricion-demo@invalid.clinicaclick.local',
    fecha_nacimiento: '1990-03-18T00:00:00.000Z',
    sexo: 'Hombre',
    area_code: 'nutricion',
  });
  const capillary = await ensureClinicalDemoPatient(clinicId, {
    public_id: DEMO_CAPILLARY_PATIENT_PUBLIC_ID,
    nombre: 'Javier',
    apellidos: 'Ruiz · Demo Capilar',
    dni: '00000002W',
    telefono: '+34600000082',
    email: 'capilar-demo@invalid.clinicaclick.local',
    fecha_nacimiento: '1985-09-02T00:00:00.000Z',
    sexo: 'Hombre',
    area_code: 'capilar',
  });
  return { nutrition, capillary };
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
  const peeling = await ensureTreatment(clinicId, {
    codigo: 'DEMO-EST-PEELING',
    nombre: 'Peeling químico facial',
    descripcion: 'Renovación cutánea facial con control de evolución y consentimiento previo.',
    disciplina: 'estetica',
    especialidad: 'Estética facial',
    categoria: 'Facial',
    duracion_min: 45,
    precio_base: 140,
    color: '#db2777',
    origen: 'clinica',
    sesiones_defecto: 1,
    requiere_pieza: false,
    requiere_zona: true,
    activo: true,
    clinical_config: {
      medical_area_code: 'estetica',
      product_type: 'treatment',
      commercial: { product_type: 'treatment', unit_label: 'sesión', recommended: true },
      financing: { enabled: false },
    },
  });
  const filler = await ensureTreatment(clinicId, {
    codigo: 'DEMO-EST-HIALURONICO',
    nombre: 'Ácido hialurónico facial',
    descripcion: 'Servicio estético facial apto para presupuesto y seguimiento por zonas.',
    disciplina: 'estetica',
    especialidad: 'Medicina estética',
    categoria: 'Facial',
    duracion_min: 50,
    precio_base: 390,
    color: '#7c3aed',
    origen: 'clinica',
    sesiones_defecto: 1,
    requiere_pieza: false,
    requiere_zona: true,
    activo: true,
    clinical_config: {
      medical_area_code: 'estetica',
      product_type: 'treatment',
      commercial: { product_type: 'treatment', unit_label: 'tratamiento', recommended: true },
      financing: { enabled: true },
    },
  });
  const nutritionStudy = await ensureTreatment(clinicId, {
    codigo: 'DEMO-NUT-ANTROP',
    nombre: 'Estudio antropométrico completo',
    descripcion: 'Medición completa, comparación evolutiva e informe clínico para el paciente.',
    disciplina: 'nutricion',
    especialidad: 'Nutrición clínica',
    categoria: 'Valoración corporal',
    duracion_min: 60,
    precio_base: 85,
    color: '#0284c7',
    origen: 'clinica',
    sesiones_defecto: 1,
    requiere_pieza: false,
    requiere_zona: false,
    activo: true,
    clinical_config: {
      medical_area_code: 'nutricion',
      product_type: 'treatment',
      commercial: { product_type: 'treatment', unit_label: 'estudio', recommended: true },
      financing: { enabled: false },
      nutrition: {
        service_kind: 'isak_study',
        measurement_profile_code: 'express_isak',
        generate_report: true,
        compare_previous: true,
      },
    },
  });
  const capillaryPrp = await ensureTreatment(clinicId, {
    codigo: 'DEMO-CAP-PRP',
    nombre: 'PRP capilar',
    descripcion: 'Sesión de plasma rico en plaquetas con control fotográfico privado.',
    disciplina: 'capilar',
    especialidad: 'Medicina capilar',
    categoria: 'Regeneración capilar',
    duracion_min: 50,
    precio_base: 220,
    color: '#0f766e',
    origen: 'clinica',
    sesiones_defecto: 3,
    requiere_pieza: false,
    requiere_zona: true,
    activo: true,
    clinical_config: {
      medical_area_code: 'capilar',
      product_type: 'pack',
      commercial: { product_type: 'pack', unit_label: 'sesiones', recommended: true },
      financing: { enabled: false },
    },
  });
  const capillaryGraft = await ensureTreatment(clinicId, {
    codigo: 'DEMO-CAP-INJERTO',
    nombre: 'Injerto capilar',
    descripcion: 'Procedimiento capilar con valoración, consentimiento y controles posteriores.',
    disciplina: 'capilar',
    especialidad: 'Cirugía capilar',
    categoria: 'Injerto capilar',
    duracion_min: 240,
    precio_base: 4200,
    color: '#0369a1',
    origen: 'clinica',
    sesiones_defecto: 1,
    requiere_pieza: false,
    requiere_zona: true,
    activo: true,
    clinical_config: {
      medical_area_code: 'capilar',
      product_type: 'treatment',
      commercial: { product_type: 'treatment', unit_label: 'procedimiento', recommended: true },
      financing: { enabled: true },
    },
  });
  return {
    facial,
    voucher,
    nutrition,
    peeling,
    filler,
    nutritionStudy,
    capillaryPrp,
    capillaryGraft,
  };
}

async function ensureDemoInstallations(clinicId) {
  const definitions = [
    {
      key: 'consultation',
      nombre: 'Consulta clínica · DEMO',
      tipo: 'consulta',
      descripcion: 'Valoraciones, revisiones, nutrición y controles clínicos del entorno demo.',
      color: '#0284c7',
      default_duracion_minutos: 45,
      orden_visualizacion: 1,
    },
    {
      key: 'treatmentRoom',
      nombre: 'Sala de tratamientos · DEMO',
      tipo: 'sala',
      descripcion: 'Procedimientos de estética y capilar del entorno demo.',
      color: '#0f766e',
      default_duracion_minutos: 60,
      orden_visualizacion: 2,
    },
  ];
  const result = {};
  for (const definition of definitions) {
    let installation = await db.Instalacion.findOne({
      where: { clinica_id: clinicId, nombre: definition.nombre },
    });
    const payload = {
      clinica_id: clinicId,
      nombre: definition.nombre,
      tipo: definition.tipo,
      descripcion: definition.descripcion,
      color: definition.color,
      capacidad: 1,
      activo: true,
      requiere_preparacion: false,
      tiempo_preparacion_minutos: 0,
      es_exclusiva: true,
      default_duracion_minutos: definition.default_duracion_minutos,
      especialidades_permitidas: ['estetica', 'nutricion', 'capilar'],
      tratamientos_exclusivos: [],
      equipamiento: [],
      orden_visualizacion: definition.orden_visualizacion,
    };
    if (!installation) installation = await db.Instalacion.create(payload);
    else await installation.update(payload);

    for (let day = 0; day <= 6; day += 1) {
      const [schedule] = await db.InstalacionHorario.findOrCreate({
        where: { instalacion_id: installation.id, dia_semana: day },
        defaults: {
          activo: day !== 0,
          hora_inicio: '08:00',
          hora_fin: day === 6 ? '20:00' : '21:00',
        },
      });
      await schedule.update({
        activo: day !== 0,
        hora_inicio: '08:00',
        hora_fin: day === 6 ? '20:00' : '21:00',
      });
    }
    result[definition.key] = installation;
  }
  return result;
}

async function ensureAppointment({
  clinicId,
  patient,
  treatment,
  installation,
  doctor,
  title,
  start,
  durationMinutes,
  state,
  type = 'continuacion',
}) {
  let appointment = await db.CitaPaciente.findOne({
    where: {
      clinica_id: clinicId,
      paciente_id: patient.id_paciente,
      titulo: title,
    },
  });
  const payload = {
    clinica_id: clinicId,
    paciente_id: patient.id_paciente,
    doctor_id: doctor?.id_usuario || ACTOR_ID,
    instalacion_id: installation?.id || null,
    tratamiento_id: treatment?.id_tratamiento || null,
    created_by: ACTOR_ID,
    updated_by: ACTOR_ID,
    titulo: title,
    nota: `${DEMO_KEY}. Datos clínicos sintéticos y eliminables.`,
    motivo: title,
    tipo_cita: type,
    estado: state,
    inicio: start,
    fin: minutesAfter(start, durationMinutes),
    es_provisional: false,
  };
  if (!appointment) appointment = await db.CitaPaciente.create(payload);
  else await appointment.update(payload);
  return appointment;
}

async function ensureClinicalReport(appointment, payload) {
  let report = await db.AppointmentClinicalReport.findOne({
    where: { appointment_id: appointment.id_cita },
  });
  if (!report) {
    await appointmentClinicalReports.save({
      appointmentId: appointment.id_cita,
      actorId: ACTOR_ID,
      payload,
      finalize: true,
    });
    report = await db.AppointmentClinicalReport.findOne({
      where: { appointment_id: appointment.id_cita },
    });
  }
  return report;
}

function clinicalImageSvg({ kind, stage }) {
  const isAfter = stage === 'after';
  const accent = isAfter ? '#0f766e' : '#d97706';
  const soft = isAfter ? '#ccfbf1' : '#fef3c7';
  const label = isAfter ? 'CONTROL DE EVOLUCIÓN' : 'REGISTRO INICIAL';
  const synthetic = 'IMAGEN CLÍNICA SINTÉTICA';
  if (kind === 'capillary') {
    const follicles = Array.from({ length: isAfter ? 52 : 23 }, (_, index) => {
      const column = index % 9;
      const row = Math.floor(index / 9);
      const x = 372 + (column * 57) + ((row % 2) * 18);
      const y = 270 + (row * 58);
      return `<path d="M${x} ${y + 15} q 8 -25 20 -34" fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round"/>`;
    }).join('');
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
        <rect width="1200" height="900" fill="#f8fafc"/>
        <rect x="48" y="48" width="1104" height="804" rx="24" fill="#ffffff" stroke="#cbd5e1" stroke-width="3"/>
        <text x="92" y="112" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#334155">${synthetic}</text>
        <text x="92" y="154" font-family="Arial, sans-serif" font-size="18" fill="#64748b">${label} · CASO CAPILAR DEMO</text>
        <ellipse cx="600" cy="468" rx="300" ry="250" fill="${soft}" stroke="#334155" stroke-width="8"/>
        <path d="M358 540 C425 670, 775 670, 842 540" fill="none" stroke="#334155" stroke-width="8"/>
        <path d="M418 300 C505 210, 695 210, 782 300" fill="none" stroke="#94a3b8" stroke-width="5" stroke-dasharray="12 12"/>
        ${follicles}
        <circle cx="600" cy="468" r="18" fill="${accent}"/>
        <text x="600" y="785" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#0f172a">${isAfter ? 'Mayor densidad visual en zona superior' : 'Zona superior seleccionada para seguimiento'}</text>
      </svg>
    `;
  }
  const marks = isAfter
    ? '<circle cx="500" cy="470" r="16" fill="#14b8a6"/><circle cx="700" cy="470" r="16" fill="#14b8a6"/>'
    : '<circle cx="500" cy="470" r="26" fill="#f59e0b"/><circle cx="700" cy="470" r="26" fill="#f59e0b"/><path d="M470 510 Q600 560 730 510" fill="none" stroke="#f59e0b" stroke-width="12" opacity=".55"/>';
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
      <rect width="1200" height="900" fill="#f8fafc"/>
      <rect x="48" y="48" width="1104" height="804" rx="24" fill="#ffffff" stroke="#cbd5e1" stroke-width="3"/>
      <text x="92" y="112" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#334155">${synthetic}</text>
      <text x="92" y="154" font-family="Arial, sans-serif" font-size="18" fill="#64748b">${label} · CASO DE ESTÉTICA DEMO</text>
      <ellipse cx="600" cy="445" rx="220" ry="270" fill="#f1f5f9" stroke="#334155" stroke-width="8"/>
      <path d="M420 690 Q600 770 780 690" fill="#e2e8f0" stroke="#334155" stroke-width="8"/>
      <path d="M520 395 Q555 370 590 395 M610 395 Q645 370 680 395" fill="none" stroke="#334155" stroke-width="8" stroke-linecap="round"/>
      <path d="M548 570 Q600 600 652 570" fill="none" stroke="#334155" stroke-width="8" stroke-linecap="round"/>
      <path d="M600 420 L580 520 L620 520" fill="none" stroke="#64748b" stroke-width="6" stroke-linecap="round"/>
      ${marks}
      <text x="600" y="815" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#0f172a">${isAfter ? 'Control posterior con evolución favorable' : 'Registro basal antes del procedimiento'}</text>
    </svg>
  `;
}

async function buildClinicalImagePng(options) {
  return sharp(Buffer.from(clinicalImageSvg(options))).png().toBuffer();
}

async function setPrivateAssetTimestamp(asset, timestamp) {
  await db.ClinicalPrivateAsset.update({
    created_at: timestamp,
    updated_at: timestamp,
  }, {
    where: { id: asset.id },
    silent: true,
  });
  await asset.reload();
  return asset;
}

async function ensureClinicalAsset({
  clinicId,
  patient,
  ownerId,
  filename,
  contentType,
  buffer,
  timestamp,
  metadata,
}) {
  let asset = await db.ClinicalPrivateAsset.findOne({
    where: {
      clinic_id: clinicId,
      patient_id: patient.id_paciente,
      owner_type: 'qa_demo_clinical_case',
      owner_id: ownerId,
      purpose: 'clinical_attachment',
      original_filename: filename,
    },
  });
  if (!asset) {
    asset = await clinicalPrivateStorage.storeClinicalPrivateAsset({
      clinicId,
      patientId: patient.id_paciente,
      ownerType: 'qa_demo_clinical_case',
      ownerId,
      purpose: 'clinical_attachment',
      originalFilename: filename,
      contentType,
      buffer,
      metadata: {
        demo_seed: DEMO_KEY,
        synthetic: true,
        ...metadata,
      },
      createdBy: ACTOR_ID,
    });
    await setPrivateAssetTimestamp(asset, timestamp);
  }
  return asset;
}

async function ensureGeneralClinicalCases({
  clinicId,
  aestheticPatient,
  capillaryPatient,
  treatments,
  installations,
  doctor,
  businessDate,
}) {
  const aestheticCompleted = await ensureAppointment({
    clinicId,
    patient: aestheticPatient,
    treatment: treatments.peeling,
    installation: installations.treatmentRoom,
    doctor,
    title: 'Peeling facial · control realizado',
    start: dateTimeAt(businessDate, -21, 10, 0),
    durationMinutes: 45,
    state: 'completada',
    type: 'primera_con_trat',
  });
  const aestheticToday = await ensureAppointment({
    clinicId,
    patient: aestheticPatient,
    treatment: treatments.facial,
    installation: installations.treatmentRoom,
    doctor,
    title: 'Control de evolución facial',
    start: dateTimeAt(businessDate, 0, 16, 0),
    durationMinutes: 40,
    state: 'recordatorio_confirmado',
    type: 'revision',
  });
  await ensureClinicalReport(aestheticCompleted, {
    reason: 'Control posterior a peeling químico facial.',
    summary: 'Evolución favorable, textura más uniforme y ausencia de complicaciones.',
    findings: 'Eritema leve resuelto. Piel íntegra y correctamente hidratada.',
    interventions: 'Revisión fotográfica privada y ajuste de cuidados domiciliarios.',
    outcome: 'Respuesta clínica dentro de lo esperado.',
    plan: 'Mantener fotoprotección y control en cuatro semanas.',
    next_steps: 'Comparar con registro fotográfico inicial en la próxima visita.',
    private_notes: `${DEMO_KEY}:aesthetic-report`,
  });
  await ensureClinicalAsset({
    clinicId,
    patient: aestheticPatient,
    ownerId: `${DEMO_KEY}:aesthetic:before`,
    filename: 'Estética facial · antes.png',
    contentType: 'image/png',
    buffer: await buildClinicalImagePng({ kind: 'aesthetic', stage: 'before' }),
    timestamp: dateTimeAt(businessDate, -28, 10, 0),
    metadata: { area_code: 'estetica', stage: 'before' },
  });
  await ensureClinicalAsset({
    clinicId,
    patient: aestheticPatient,
    ownerId: `${DEMO_KEY}:aesthetic:after`,
    filename: 'Estética facial · control.png',
    contentType: 'image/png',
    buffer: await buildClinicalImagePng({ kind: 'aesthetic', stage: 'after' }),
    timestamp: dateTimeAt(businessDate, -7, 10, 0),
    metadata: { area_code: 'estetica', stage: 'after' },
  });
  await ensureClinicalAsset({
    clinicId,
    patient: aestheticPatient,
    ownerId: `${DEMO_KEY}:aesthetic:care`,
    filename: 'Cuidados posteriores · peeling facial.pdf',
    contentType: 'application/pdf',
    buffer: buildDemoPdf({
      title: 'Cuidados posteriores - demo',
      lines: [
        'Caso sintetico de estetica facial',
        'Fotoproteccion diaria',
        'Hidratacion pautada por el profesional',
        'Consultar ante molestias no esperadas',
        'Documento de demostracion sin validez clinica',
      ],
    }),
    timestamp: dateTimeAt(businessDate, -20, 12, 0),
    metadata: { area_code: 'estetica', document_kind: 'aftercare' },
  });

  const capillaryCompleted = await ensureAppointment({
    clinicId,
    patient: capillaryPatient,
    treatment: treatments.capillaryGraft,
    installation: installations.treatmentRoom,
    doctor,
    title: 'Valoración e injerto capilar · realizado',
    start: dateTimeAt(businessDate, -90, 9, 0),
    durationMinutes: 240,
    state: 'completada',
    type: 'primera_con_trat',
  });
  const capillaryAttendancePending = await ensureAppointment({
    clinicId,
    patient: capillaryPatient,
    treatment: treatments.capillaryPrp,
    installation: installations.consultation,
    doctor,
    title: 'Control capilar pendiente de cerrar',
    start: dateTimeAt(businessDate, 0, 8, 30),
    durationMinutes: 45,
    state: 'recordatorio_confirmado',
    type: 'revision',
  });
  const capillaryFuture = await ensureAppointment({
    clinicId,
    patient: capillaryPatient,
    treatment: treatments.capillaryGraft,
    installation: installations.consultation,
    doctor,
    title: 'Control capilar y firma en tablet',
    start: dateTimeAt(businessDate, 1, 10, 30),
    durationMinutes: 60,
    state: 'recordatorio_confirmado',
    type: 'revision',
  });
  await ensureClinicalReport(capillaryCompleted, {
    reason: 'Procedimiento de injerto capilar y planificación de controles.',
    summary: 'Procedimiento completado sin incidencias y seguimiento fotográfico iniciado.',
    findings: 'Zona donante y receptora dentro de los parámetros previstos.',
    interventions: 'Implantación según planificación y entrega de cuidados posteriores.',
    outcome: 'Alta de procedimiento con revisión programada.',
    plan: 'Control evolutivo, registro fotográfico privado y valoración de PRP.',
    next_steps: 'Revisión de densidad y adherencia a cuidados.',
    private_notes: `${DEMO_KEY}:capillary-report`,
  });
  await ensureClinicalAsset({
    clinicId,
    patient: capillaryPatient,
    ownerId: `${DEMO_KEY}:capillary:before`,
    filename: 'Zona capilar · antes.png',
    contentType: 'image/png',
    buffer: await buildClinicalImagePng({ kind: 'capillary', stage: 'before' }),
    timestamp: dateTimeAt(businessDate, -90, 8, 30),
    metadata: { area_code: 'capilar', stage: 'before' },
  });
  await ensureClinicalAsset({
    clinicId,
    patient: capillaryPatient,
    ownerId: `${DEMO_KEY}:capillary:after`,
    filename: 'Zona capilar · evolución.png',
    contentType: 'image/png',
    buffer: await buildClinicalImagePng({ kind: 'capillary', stage: 'after' }),
    timestamp: dateTimeAt(businessDate, -14, 11, 0),
    metadata: { area_code: 'capilar', stage: 'after' },
  });
  await ensureClinicalAsset({
    clinicId,
    patient: capillaryPatient,
    ownerId: `${DEMO_KEY}:capillary:care`,
    filename: 'Cuidados posteriores · injerto capilar.pdf',
    contentType: 'application/pdf',
    buffer: buildDemoPdf({
      title: 'Cuidados posteriores - demo',
      lines: [
        'Caso sintetico de injerto capilar',
        'Seguir las indicaciones del profesional',
        'Evitar friccion sobre la zona tratada',
        'Acudir a los controles programados',
        'Documento de demostracion sin validez clinica',
      ],
    }),
    timestamp: dateTimeAt(businessDate, -89, 12, 0),
    metadata: { area_code: 'capilar', document_kind: 'aftercare' },
  });

  return {
    aesthetic: {
      completed: aestheticCompleted,
      today: aestheticToday,
    },
    capillary: {
      completed: capillaryCompleted,
      attendancePending: capillaryAttendancePending,
      future: capillaryFuture,
    },
  };
}

function nutritionValues(overrides = {}) {
  return {
    stature_cm: 178,
    hip_cm: 102,
    arm_flexed_tensed_cm: 36,
    arm_relaxed_cm: 33,
    forearm_cm: 29,
    thigh_cm: 58,
    calf_cm: 40,
    chest_cm: 104,
    head_cm: 56,
    sitting_height_cm: 92,
    skinfold_triceps_mm: 18,
    skinfold_subscapular_mm: 20,
    skinfold_biceps_mm: 9,
    skinfold_iliac_crest_mm: 24,
    skinfold_supraspinale_mm: 20,
    skinfold_abdominal_mm: 28,
    skinfold_front_thigh_mm: 25,
    skinfold_medial_calf_mm: 14,
    breadth_humerus_cm: 7.2,
    breadth_femur_cm: 9.8,
    breadth_biacromial_cm: 42,
    breadth_biiliocristal_cm: 30,
    depth_chest_ap_cm: 21,
    breadth_chest_transverse_cm: 30,
    weight_kg: 85,
    waist_cm: 96,
    objective: 'Mejorar composición corporal y hábitos de forma sostenible.',
    ...overrides,
  };
}

async function ensureNutritionMeasurement({
  clinicId,
  patient,
  treatment,
  appointment,
  measuredAt,
  key,
  values,
}) {
  const notes = `${DEMO_KEY}:nutrition:${key}`;
  let row = await db.PatientNutritionMeasurement.findOne({
    where: {
      patient_id: patient.id_paciente,
      clinic_id: clinicId,
      notes,
    },
  });
  if (!row) {
    await nutritionWorkspace.createNutritionMeasurement(patient.public_id, {
      clinic_id: clinicId,
      professional_id: ACTOR_ID,
      appointment_id: appointment.id_cita,
      treatment_id: treatment.id_tratamiento,
      profile_code: 'express_isak',
      measured_at: measuredAt.toISOString(),
      raw_values: values,
      notes,
    }, ACTOR_ID);
    row = await db.PatientNutritionMeasurement.findOne({
      where: {
        patient_id: patient.id_paciente,
        clinic_id: clinicId,
        notes,
      },
    });
  }
  if (!row) throw new Error(`No se pudo crear la medición demo ${key}.`);
  return row;
}

async function ensureNutritionCase({ clinicId, patient, treatment, installation, doctor, businessDate }) {
  const baselineAppointment = await ensureAppointment({
    clinicId,
    patient,
    treatment,
    installation,
    doctor,
    title: 'Estudio antropométrico inicial',
    start: dateTimeAt(businessDate, -56, 11, 0),
    durationMinutes: 60,
    state: 'completada',
    type: 'primera_con_trat',
  });
  const followUpAppointment = await ensureAppointment({
    clinicId,
    patient,
    treatment,
    installation,
    doctor,
    title: 'Seguimiento antropométrico',
    start: dateTimeAt(businessDate, -7, 11, 0),
    durationMinutes: 60,
    state: 'completada',
    type: 'continuacion',
  });
  const todayAppointment = await ensureAppointment({
    clinicId,
    patient,
    treatment,
    installation,
    doctor,
    title: 'Revisión del plan nutricional',
    start: dateTimeAt(businessDate, 0, 17, 0),
    durationMinutes: 45,
    state: 'info_confirmada',
    type: 'revision',
  });
  const baseline = await ensureNutritionMeasurement({
    clinicId,
    patient,
    treatment,
    appointment: baselineAppointment,
    measuredAt: dateTimeAt(businessDate, -56, 11, 15),
    key: 'baseline',
    values: nutritionValues(),
  });
  await nutritionWorkspace.finalizeNutritionMeasurementReportSnapshot(
    patient.public_id,
    baseline.id,
    ACTOR_ID,
  );
  const followUp = await ensureNutritionMeasurement({
    clinicId,
    patient,
    treatment,
    appointment: followUpAppointment,
    measuredAt: dateTimeAt(businessDate, -7, 11, 15),
    key: 'follow-up',
    values: nutritionValues({
      weight_kg: 82.5,
      waist_cm: 91,
      hip_cm: 100,
      arm_flexed_tensed_cm: 36.4,
      arm_relaxed_cm: 33.2,
      thigh_cm: 57,
      calf_cm: 39.5,
      chest_cm: 102,
      skinfold_triceps_mm: 16,
      skinfold_subscapular_mm: 18,
      skinfold_biceps_mm: 8,
      skinfold_iliac_crest_mm: 20,
      skinfold_supraspinale_mm: 17,
      skinfold_abdominal_mm: 23,
      skinfold_front_thigh_mm: 22,
      skinfold_medial_calf_mm: 12,
      objective: 'Consolidar la pérdida de grasa manteniendo masa muscular.',
    }),
  });
  await nutritionWorkspace.finalizeNutritionMeasurementReportSnapshot(
    patient.public_id,
    followUp.id,
    ACTOR_ID,
  );
  await ensureClinicalReport(followUpAppointment, {
    reason: 'Revisión de evolución nutricional y composición corporal.',
    summary: 'Descenso progresivo de peso y perímetro de cintura con buena adherencia.',
    findings: 'Evolución favorable en medidas comparables y mantenimiento funcional.',
    interventions: 'Ajuste del plan nutricional y revisión del informe antropométrico.',
    outcome: 'Objetivo intermedio alcanzado.',
    plan: 'Continuar cuatro semanas y repetir medición comparable.',
    next_steps: 'Revisar tendencia y adherencia en la próxima cita.',
    private_notes: `${DEMO_KEY}:nutrition-report`,
  });
  return {
    baseline,
    followUp,
    appointments: {
      baseline: baselineAppointment,
      followUp: followUpAppointment,
      today: todayAppointment,
    },
  };
}

async function ensureConsentTemplate({
  clinicId,
  publicId,
  name,
  purpose,
  blockingPolicy,
  requiresProfessionalSignature,
  bodyHtml,
}) {
  const payload = {
    clinic_id: clinicId,
    name,
    description: `Plantilla clínica sintética del seed ${DEMO_KEY}.`,
    purpose,
    status: 'active',
    blocking_policy: blockingPolicy,
    validity_mode: purpose === 'clinical_image' ? 'treatment_episode' : 'single_act',
    is_default: false,
    requires_patient_signature: true,
    requires_representative_when_minor: true,
    requires_professional_signature: requiresProfessionalSignature,
    catalog_key: publicId,
  };
  let template = await db.ClinicConsentTemplate.findOne({ where: { public_id: publicId } });
  if (!template) template = await db.ClinicConsentTemplate.create({ public_id: publicId, ...payload });
  else await template.update(payload);

  let version = await db.ClinicConsentTemplateVersion.findOne({
    where: { clinic_template_id: template.id, locale: 'es' },
    order: [['version', 'DESC'], ['id', 'DESC']],
  });
  const versionPayload = {
    clinic_template_id: template.id,
    version: version?.version || 1,
    locale: 'es',
    title: name,
    body_json: null,
    body_html: bodyHtml,
    variable_schema: {
      signing_timing: { mode: purpose === 'clinical_image' ? 'before_treatment' : 'at_least_24h_before' },
      clinical_policy: {
        signing_timing: purpose === 'clinical_image' ? 'before_treatment' : 'at_least_24h_before',
      },
      demo_seed: DEMO_KEY,
    },
    status: 'published',
    published_at: new Date(),
    created_by: ACTOR_ID,
  };
  if (!version) version = await db.ClinicConsentTemplateVersion.create(versionPayload);
  else await version.update(versionPayload);
  return template;
}

async function ensureConsentRequirement(clinicId, treatment, template, options = {}) {
  const rows = await db.TreatmentConsentRequirement.findAll({
    where: {
      tratamiento_id: treatment.id_tratamiento,
      clinica_id: clinicId,
      clinic_template_id: template.id,
    },
    order: [['id', 'ASC']],
  });
  const payload = {
    tratamiento_id: treatment.id_tratamiento,
    clinica_id: clinicId,
    clinic_template_id: template.id,
    catalog_template_id: null,
    requirement_scope: 'treatment',
    condition_key: null,
    required: options.required !== false,
    blocking_policy: options.blockingPolicy || 'hard',
    sort_order: Number(options.sortOrder || 0),
  };
  if (!rows.length) return db.TreatmentConsentRequirement.create(payload);
  await rows[0].update(payload);
  for (const duplicate of rows.slice(1)) await duplicate.destroy();
  return rows[0];
}

async function ensureDemoTablet(clinicId) {
  const passwordHash = await bcrypt.hash(DEMO_TABLET_PASSWORD, 12);
  let kiosk = await db.ClinicTabletKiosk.findOne({
    where: { username: DEMO_TABLET_USERNAME },
  });
  if (kiosk && Number(kiosk.clinic_id) !== clinicId) {
    throw new Error(`El usuario tablet ${DEMO_TABLET_USERNAME} pertenece a otra clínica.`);
  }
  const payload = {
    public_id: DEMO_TABLET_PUBLIC_ID,
    clinic_id: clinicId,
    username: DEMO_TABLET_USERNAME,
    password_hash: passwordHash,
    display_name: 'Tablet recepción · BS Medical DEMO',
    status: 'active',
    created_by: ACTOR_ID,
  };
  if (!kiosk) kiosk = await db.ClinicTabletKiosk.create(payload);
  else await kiosk.update(payload);
  return kiosk;
}

async function consentPackageByPublicId(publicId) {
  return db.ConsentSignaturePackage.findOne({
    where: { public_id: publicId },
    include: [
      { model: db.PatientConsentDocument, as: 'documents', required: false },
      { model: db.Paciente, as: 'paciente', required: false },
      { model: db.Tratamiento, as: 'tratamiento', required: false },
      { model: db.CitaPaciente, as: 'cita', required: false },
    ],
  });
}

async function ensureConsentPackage(appointment, publicId, triggerSource) {
  let packageRow = await consentPackageByPublicId(publicId);
  if (packageRow) return packageRow;
  packageRow = await consentimientosService.createPackageForAppointment(
    appointment.id_cita,
    { triggerSource },
  );
  if (packageRow.public_id !== publicId) {
    const conflict = await db.ConsentSignaturePackage.findOne({
      where: {
        public_id: publicId,
        id: { [db.Sequelize.Op.ne]: packageRow.id },
      },
    });
    if (conflict) return consentPackageByPublicId(publicId);
    await packageRow.update({ public_id: publicId });
  }
  return consentPackageByPublicId(publicId);
}

function clearConsentSignatureSnapshot(snapshot) {
  const next = cleanObject(snapshot);
  const sanitized = { ...next };
  delete sanitized.signature_evidence;
  delete sanitized.professional_signature_evidence;
  delete sanitized.revocation_evidence;
  delete sanitized.signed_copy;
  return sanitized;
}

async function resetConsentPackagePending(packageRow, businessDate) {
  const documents = await db.PatientConsentDocument.findAll({
    where: { package_id: packageRow.id },
  });
  for (const document of documents) {
    await document.update({
      status: 'viewed',
      signed_at: null,
      signed_by_patient_id: null,
      signed_by_representative_id: null,
      professional_signed_by: null,
      professional_signed_at: null,
      revoked_at: null,
      channel: 'tablet',
      delivery_status: 'queued',
      snapshot_json: clearConsentSignatureSnapshot(document.snapshot_json),
    });
  }
  await packageRow.update({
    status: 'pending',
    signed_count: 0,
    required_count: documents.filter((document) => document.required).length,
    due_at: dateTimeAt(businessDate, 1, 10, 30),
    expires_at: dateTimeAt(businessDate, 30, 23, 59),
    trigger_source: `${DEMO_KEY}:tablet-pending`,
  });
  return consentPackageByPublicId(packageRow.public_id);
}

async function ensureConsentPackageSigned(packageRow) {
  const documents = await db.PatientConsentDocument.findAll({
    where: { package_id: packageRow.id },
  });
  for (const document of documents) {
    if (document.status !== 'signed') {
      await consentimientosService.signConsentDocument(document.public_id, {
        signer_name: 'Javier Ruiz · Demo Capilar',
        signer_role: 'patient',
        signature_data_url: SIGNATURE_DATA_URL,
        accepted_statement: true,
        method: 'tablet_signature',
        device_label: 'Tablet recepción · BS Medical DEMO',
      }, {
        ip: '127.0.0.1',
        userAgent: 'ClinicaClick BS Medical demo seed',
      });
    }
    const refreshed = await db.PatientConsentDocument.findByPk(document.id);
    if (
      cleanObject(refreshed?.snapshot_json).template?.requires_professional_signature
      && !refreshed.professional_signed_at
    ) {
      await consentimientosService.signProfessionalConsentDocument(refreshed.public_id, {
        professional_name: 'Dr. Carlos Demo',
        accepted_statement: true,
        method: 'professional_confirmation',
      }, ACTOR_ID, {
        ip: '127.0.0.1',
        userAgent: 'ClinicaClick BS Medical demo seed',
      });
    }
  }
  return consentPackageByPublicId(packageRow.public_id);
}

async function ensureConsentAndTabletDemo({
  clinicId,
  treatments,
  appointments,
  businessDate,
}) {
  const clinicalTemplate = await ensureConsentTemplate({
    clinicId,
    publicId: DEMO_CONSENT_IDS.clinicalTemplate,
    name: 'Consentimiento informado · injerto capilar DEMO',
    purpose: 'clinical',
    blockingPolicy: 'hard',
    requiresProfessionalSignature: true,
    bodyHtml: [
      '<h2>Consentimiento informado para injerto capilar</h2>',
      '<p>Paciente: {{paciente.nombre_completo}}</p>',
      '<p>Clínica: {{clinica.nombre}}</p>',
      '<p>Tratamiento: {{tratamiento.nombre}}</p>',
      '<p>El paciente declara haber recibido información comprensible sobre preparación, procedimiento, alternativas, cuidados, evolución esperada y posibles complicaciones.</p>',
      '<p>Texto sintético para demostración. La clínica debe validar jurídicamente su versión definitiva.</p>',
    ].join('\n'),
  });
  const photosTemplate = await ensureConsentTemplate({
    clinicId,
    publicId: DEMO_CONSENT_IDS.photosTemplate,
    name: 'Autorización de imágenes clínicas privadas · DEMO',
    purpose: 'clinical_image',
    blockingPolicy: 'soft',
    requiresProfessionalSignature: false,
    bodyHtml: [
      '<h2>Autorización de imágenes clínicas privadas</h2>',
      '<p>Paciente: {{paciente.nombre_completo}}</p>',
      '<p>Autorizo la toma de imágenes privadas para diagnóstico, planificación y comparación de la evolución dentro de mi historia clínica.</p>',
      '<p>Estas imágenes no se usarán con fines publicitarios sin una autorización separada.</p>',
    ].join('\n'),
  });
  await ensureConsentRequirement(clinicId, treatments.capillaryGraft, clinicalTemplate, {
    blockingPolicy: 'hard',
    sortOrder: 0,
  });
  await ensureConsentRequirement(clinicId, treatments.capillaryGraft, photosTemplate, {
    blockingPolicy: 'soft',
    sortOrder: 1,
  });
  await ensureConsentRequirement(clinicId, treatments.peeling, photosTemplate, {
    blockingPolicy: 'soft',
    sortOrder: 0,
  });
  await ensureDemoTablet(clinicId);

  let signedPackage = await ensureConsentPackage(
    appointments.completed,
    DEMO_CONSENT_IDS.signedPackage,
    `${DEMO_KEY}:signed`,
  );
  signedPackage = await ensureConsentPackageSigned(signedPackage);
  let pendingPackage = await ensureConsentPackage(
    appointments.future,
    DEMO_CONSENT_IDS.pendingPackage,
    `${DEMO_KEY}:tablet-pending`,
  );
  pendingPackage = await resetConsentPackagePending(pendingPackage, businessDate);
  const tabletSession = await consentimientosService.createTabletSession(pendingPackage.id, {
    base_url: 'http://localhost:4203',
    ttl_hours: 72,
  });
  const signedDocuments = await db.PatientConsentDocument.findAll({
    where: { package_id: signedPackage.id },
    attributes: ['id', 'public_id', 'title', 'status', 'signed_at', 'professional_signed_at'],
    order: [['id', 'ASC']],
    raw: true,
  });
  const pendingDocuments = await db.PatientConsentDocument.findAll({
    where: { package_id: pendingPackage.id },
    attributes: ['id', 'public_id', 'title', 'status'],
    order: [['id', 'ASC']],
    raw: true,
  });
  return {
    signedPackage,
    pendingPackage,
    signedDocuments,
    pendingDocuments,
    tabletSession,
  };
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
  const access = await ensureDemoAccess(clinicId);
  const doctor = await ensureDemoDoctor(clinicId);
  await ensureDemoClinicSchedule(clinicId);
  const patient = await ensureDemoPatient(clinicId);
  const clinicalPatients = await ensureClinicalDemoPatients(clinicId);
  const treatments = await ensureDemoTreatments(clinicId);
  const installations = await ensureDemoInstallations(clinicId);
  const clinicalCases = await ensureGeneralClinicalCases({
    clinicId,
    aestheticPatient: patient,
    capillaryPatient: clinicalPatients.capillary,
    treatments,
    installations,
    doctor,
    businessDate,
  });
  const nutritionCase = await ensureNutritionCase({
    clinicId,
    patient: clinicalPatients.nutrition,
    treatment: treatments.nutritionStudy,
    installation: installations.consultation,
    doctor,
    businessDate,
  });
  const consentDemo = await ensureConsentAndTabletDemo({
    clinicId,
    treatments,
    appointments: clinicalCases.capillary,
    businessDate,
  });
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
    clinical_cases: {
      aesthetic: {
        patient_id: patient.public_id,
        patient_name: `${patient.nombre} ${patient.apellidos}`,
        history_url: `http://localhost:4203/pacientes/detalle/${patient.public_id}/historia-clinica?clinica_id=${clinicId}`,
        private_assets: 3,
      },
      nutrition: {
        patient_id: clinicalPatients.nutrition.public_id,
        patient_name: `${clinicalPatients.nutrition.nombre} ${clinicalPatients.nutrition.apellidos}`,
        workspace_url: `http://localhost:4203/pacientes/detalle/${clinicalPatients.nutrition.public_id}/nutricion?clinica_id=${clinicId}`,
        measurements: [nutritionCase.baseline.id, nutritionCase.followUp.id],
      },
      capillary: {
        patient_id: clinicalPatients.capillary.public_id,
        patient_name: `${clinicalPatients.capillary.nombre} ${clinicalPatients.capillary.apellidos}`,
        history_url: `http://localhost:4203/pacientes/detalle/${clinicalPatients.capillary.public_id}/historia-clinica?clinica_id=${clinicId}`,
        private_assets: 3,
      },
    },
    treatments: Object.values(treatments).map((item) => ({
      id: item.id_tratamiento,
      code: item.codigo,
      name: item.nombre,
    })),
    installations: Object.values(installations).map((item) => ({
      id: item.id,
      name: item.nombre,
      type: item.tipo,
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
    reception: {
      user_id: access.user.id_usuario,
      email: access.user.email_usuario,
      role: 'Recepción / Comercial ventas',
      credentials_issued_now: access.credentials,
      expected_access: ['Caja'],
      forbidden_access: ['Resumen contable', 'Gastos', 'Nóminas', 'Gestoría'],
    },
    doctor: {
      user_id: doctor.id_usuario,
      email: DEMO_DOCTOR_EMAIL,
      password: DEMO_DOCTOR_PASSWORD,
      role: 'Doctores',
      expected_access: ['Panel médico', 'Agenda', 'Historias clínicas y consentimientos de sus pacientes'],
    },
    consents_and_tablet: {
      tablet: {
        url: 'http://localhost:4203/tablet',
        username: DEMO_TABLET_USERNAME,
        password: DEMO_TABLET_PASSWORD,
      },
      pending: {
        package_id: consentDemo.pendingPackage.public_id,
        direct_signature_url: consentDemo.tabletSession.public_url,
        documents: consentDemo.pendingDocuments,
      },
      signed: {
        package_id: consentDemo.signedPackage.public_id,
        patient_url: `http://localhost:4203/pacientes/detalle/${clinicalPatients.capillary.public_id}/consentimientos?clinica_id=${clinicId}`,
        documents: consentDemo.signedDocuments,
      },
      dashboard_url: `http://localhost:4203/consentimientos?tab=pendientes&clinica_id=${clinicId}`,
    },
    accounting: {
      summary: workspace.summary,
      cash: workspace.cash.current,
    },
    urls: {
      accounting: 'http://localhost:4203/contabilidad',
      reception_cash: 'http://localhost:4203/contabilidad?section=cash',
      patient: `http://localhost:4203/pacientes/detalle/${patient.public_id}/presupuestos`,
      treatments: 'http://localhost:4203/catalogo-tratamientos',
      medical_areas: 'http://localhost:4203/areas-medicas-admin',
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
  const receptionUser = await db.Usuario.findOne({
    where: {
      email_usuario: DEMO_RECEPTION_EMAIL,
      cargo_usuario: DEMO_RECEPTION_CARGO,
    },
    attributes: ['id_usuario'],
    raw: true,
  });
  const receptionUserId = Number(receptionUser?.id_usuario) || null;
  const doctorUser = await db.Usuario.findOne({
    where: {
      email_usuario: DEMO_DOCTOR_EMAIL,
      cargo_usuario: DEMO_DOCTOR_CARGO,
    },
    attributes: ['id_usuario'],
    raw: true,
  });
  const doctorUserId = Number(doctorUser?.id_usuario) || null;
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
  const clinicalReports = await db.AppointmentClinicalReport.findAll({
    where: { clinic_id: clinicId },
    attributes: ['id'],
    raw: true,
  });
  const clinicalReportIds = clinicalReports.map((row) => Number(row.id));
  const consentPackages = await db.ConsentSignaturePackage.findAll({
    where: { clinica_id: clinicId },
    attributes: ['id'],
    raw: true,
  });
  const consentPackageIds = consentPackages.map((row) => Number(row.id));
  const consentDocuments = await db.PatientConsentDocument.findAll({
    where: { clinica_id: clinicId },
    attributes: ['id'],
    raw: true,
  });
  const consentDocumentIds = consentDocuments.map((row) => Number(row.id));
  const consentTemplates = await db.ClinicConsentTemplate.findAll({
    where: { clinic_id: clinicId },
    attributes: ['id'],
    raw: true,
  });
  const consentTemplateIds = consentTemplates.map((row) => Number(row.id));

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

    if (consentDocumentIds.length) {
      await db.ConsentDeliveryEvent.destroy({
        where: { patient_consent_document_id: consentDocumentIds },
        transaction,
      });
    }
    if (consentPackageIds.length) {
      await db.ConsentDeliveryEvent.destroy({
        where: { package_id: consentPackageIds },
        transaction,
      });
    }
    await db.PatientConsentDocument.destroy({ where: { clinica_id: clinicId }, transaction });
    await db.ConsentSignaturePackage.destroy({ where: { clinica_id: clinicId }, transaction });
    await db.TreatmentConsentRequirement.destroy({ where: { clinica_id: clinicId }, transaction });
    if (consentTemplateIds.length) {
      await db.ClinicConsentTemplateVersion.destroy({
        where: { clinic_template_id: consentTemplateIds },
        transaction,
      });
    }
    await db.ClinicConsentTemplate.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.ClinicTabletKiosk.destroy({ where: { clinic_id: clinicId }, transaction });

    await db.PatientNutritionReport.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.PatientNutritionMeasurement.destroy({ where: { clinic_id: clinicId }, transaction });
    if (clinicalReportIds.length) {
      await db.AppointmentClinicalReportRevision.destroy({
        where: { report_id: clinicalReportIds },
        transaction,
      });
    }
    await db.AppointmentClinicalReport.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.CitaPaciente.destroy({ where: { clinica_id: clinicId }, transaction });

    const doctorLinks = await db.DoctorClinica.findAll({
      where: { clinica_id: clinicId },
      attributes: ['id'],
      raw: true,
      transaction,
    });
    const doctorLinkIds = doctorLinks.map((row) => Number(row.id));
    if (doctorLinkIds.length) {
      const doctorSchedules = await db.DoctorHorario.findAll({
        where: { doctor_clinica_id: doctorLinkIds },
        attributes: ['id'],
        raw: true,
        transaction,
      });
      const doctorScheduleIds = doctorSchedules.map((row) => Number(row.id));
      if (doctorScheduleIds.length && db.DoctorHorarioExcepcion) {
        await db.DoctorHorarioExcepcion.destroy({
          where: { doctor_horario_id: doctorScheduleIds },
          transaction,
        });
      }
      await db.DoctorHorario.destroy({
        where: { doctor_clinica_id: doctorLinkIds },
        transaction,
      });
      await db.DoctorClinica.destroy({
        where: { id: doctorLinkIds },
        transaction,
      });
    }
    if (doctorUserId && db.DoctorBloqueo) {
      const doctorBlocks = await db.DoctorBloqueo.findAll({
        where: { doctor_id: doctorUserId },
        attributes: ['id'],
        raw: true,
        transaction,
      });
      const doctorBlockIds = doctorBlocks.map((row) => Number(row.id));
      if (doctorBlockIds.length && db.DoctorBloqueoExcepcion) {
        await db.DoctorBloqueoExcepcion.destroy({
          where: { doctor_bloqueo_id: doctorBlockIds },
          transaction,
        });
      }
      await db.DoctorBloqueo.destroy({
        where: { doctor_id: doctorUserId },
        transaction,
      });
    }

    const installationRows = await db.Instalacion.findAll({
      where: { clinica_id: clinicId },
      attributes: ['id'],
      raw: true,
      transaction,
    });
    const installationIds = installationRows.map((row) => Number(row.id));
    if (installationIds.length) {
      await db.InstalacionBloqueo.destroy({
        where: { instalacion_id: installationIds },
        transaction,
      });
      await db.InstalacionHorario.destroy({
        where: { instalacion_id: installationIds },
        transaction,
      });
    }
    await db.Instalacion.destroy({ where: { clinica_id: clinicId }, transaction });

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
      await db.PatientCustomField.destroy({ where: { paciente_id: patientIds }, transaction });
      await db.PacienteClinica.destroy({ where: { paciente_id: patientIds }, transaction });
    }
    await db.PacienteClinica.destroy({ where: { clinica_id: clinicId }, transaction });
    await db.ClinicalPrivateAsset.destroy({ where: { clinic_id: clinicId }, transaction });
    await db.UsuarioClinica.destroy({ where: { id_clinica: clinicId }, transaction });
    await db.Paciente.destroy({ where: { clinica_id: clinicId }, transaction });
    await db.ClinicaHorario.destroy({ where: { clinica_id: clinicId }, transaction });
    await db.Clinica.destroy({ where: { id_clinica: clinicId }, transaction });
    if (firmUserIds.length) {
      await db.Usuario.destroy({ where: { id_usuario: firmUserIds }, transaction });
    }
    if (receptionUserId) {
      const remainingMemberships = await db.UsuarioClinica.count({
        where: { id_usuario: receptionUserId },
        transaction,
      });
      if (!remainingMemberships) {
        await db.Usuario.destroy({
          where: {
            id_usuario: receptionUserId,
            email_usuario: DEMO_RECEPTION_EMAIL,
            cargo_usuario: DEMO_RECEPTION_CARGO,
          },
          transaction,
        });
      }
    }
    if (doctorUserId) {
      const remainingMemberships = await db.UsuarioClinica.count({
        where: { id_usuario: doctorUserId },
        transaction,
      });
      if (!remainingMemberships) {
        await db.Usuario.destroy({
          where: {
            id_usuario: doctorUserId,
            email_usuario: DEMO_DOCTOR_EMAIL,
            cargo_usuario: DEMO_DOCTOR_CARGO,
          },
          transaction,
        });
      }
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
