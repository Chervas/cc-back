'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const originalConsoleLog = console.log;
console.log = () => {};
const db = require('../../../models');
console.log = originalConsoleLog;

const consentimientosService = require('../../services/consentimientos.service');

const CLINIC_ID = Number(process.env.CC_DEMO_CONSENTS_CLINIC_ID || 66);
const FRONTEND_URL = (process.env.CC_DEMO_FRONTEND_URL || 'http://localhost:4203').replace(/\/+$/, '');
const TABLET_USERNAME = process.env.CC_DEMO_TABLET_USERNAME || 'demo-tablet-bs-capilar';
const TABLET_PASSWORD = process.env.CC_DEMO_TABLET_PASSWORD || 'DemoTablet2026!';
const PUBLIC_TOKEN_SECRET = process.env.CONSENT_PUBLIC_TOKEN_SECRET || process.env.JWT_SECRET || 'clinicaclick-dev-consentimientos';

const TEMPLATE_MICRO_PUBLIC_ID = 'cclin_demo_20260722_bscapilar_microinjerto';
const TEMPLATE_PHOTOS_PUBLIC_ID = 'cclin_demo_20260722_bscapilar_photos';
const PENDING_PACKAGE_PUBLIC_ID = 'cpkg_demo_20260722_bscapilar_tablet_pending';
const SIGNED_PACKAGE_PUBLIC_ID = 'cpkg_demo_20260723_bscapilar_signed';
const PENDING_DOCUMENT_PUBLIC_IDS = [
  'cdoc_demo_20260722_bscapilar_microinjerto_pending',
  'cdoc_demo_20260722_bscapilar_photos_pending',
];

const SIGNATURE_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180" viewBox="0 0 640 180">
  <rect width="640" height="180" fill="white"/>
  <path d="M52 115 C106 70, 132 145, 185 98 S276 82, 310 106 S374 138, 426 91 S520 70, 586 104" fill="none" stroke="#111827" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M82 136 H560" stroke="#CBD5E1" stroke-width="2" stroke-linecap="round"/>
</svg>
`).toString('base64')}`;

function addDays(days, hour = 10, minute = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function minutesAfter(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function publicPackageUrl(packageRow, ttlHours = 72) {
  const plain = packageRow && typeof packageRow.toJSON === 'function' ? packageRow.toJSON() : packageRow;
  const token = jwt.sign({
    type: 'consent_signature_package',
    package_public_id: plain.public_id,
    package_id: plain.id,
    channel: 'tablet',
  }, PUBLIC_TOKEN_SECRET, { expiresIn: `${ttlHours}h` });
  return `${FRONTEND_URL}/tablet/consentimientos/${encodeURIComponent(token)}`;
}

function cleanSnapshotForPending(snapshot) {
  const next = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? { ...snapshot } : {};
  delete next.signature_evidence;
  delete next.professional_signature_evidence;
  delete next.revocation_evidence;
  delete next.signed_copy;
  return next;
}

async function requireClinic() {
  const clinic = await db.Clinica.findByPk(CLINIC_ID);
  if (!clinic) throw new Error(`clinic_not_found:${CLINIC_ID}`);
  return clinic;
}

async function ensureTreatment() {
  let treatment = await db.Tratamiento.findOne({
    where: { clinica_id: CLINIC_ID, codigo: 'CCIMP-1452759' },
  });
  if (!treatment) {
    treatment = await db.Tratamiento.findOne({
      where: { clinica_id: CLINIC_ID, nombre: 'IM CAPILAR' },
    });
  }
  if (!treatment) {
    treatment = await db.Tratamiento.create({
      nombre: 'Microinjerto capilar demo',
      codigo: 'DEMO-CONSENT-CAPILAR',
      descripcion: 'Tratamiento demo para flujo de consentimientos y tablet.',
      disciplina: 'capilar',
      especialidad: 'Capilar',
      categoria: 'Capilar',
      duracion_min: 90,
      precio_base: 0,
      origen: 'clinica',
      clinica_id: CLINIC_ID,
      activo: true,
      requiere_zona: true,
    });
  }
  return treatment;
}

async function ensurePatient({ publicId, nombre, apellidos, email, phone }) {
  const payload = {
    nombre,
    apellidos,
    dni: null,
    telefono_movil: phone,
    email,
    fecha_nacimiento: new Date('1988-05-14T00:00:00.000Z'),
    idioma_preferido: 'es',
    paciente_conocido: true,
    clinica_id: CLINIC_ID,
  };
  let patient = await db.Paciente.findOne({ where: { public_id: publicId } });
  if (!patient) {
    patient = await db.Paciente.create({ public_id: publicId, ...payload });
  } else {
    await patient.update(payload);
  }
  return patient;
}

async function ensureAppointment({ patient, treatment, title, start }) {
  let appointment = await db.CitaPaciente.findOne({
    where: {
      clinica_id: CLINIC_ID,
      paciente_id: patient.id_paciente,
      tratamiento_id: treatment.id_tratamiento,
      titulo: title,
    },
  });
  const payload = {
    clinica_id: CLINIC_ID,
    paciente_id: patient.id_paciente,
    tratamiento_id: treatment.id_tratamiento,
    titulo: title,
    motivo: title,
    tipo_cita: 'primera_con_trat',
    estado: 'recordatorio_confirmado',
    inicio: start,
    fin: minutesAfter(start, 60),
  };
  if (!appointment) {
    appointment = await db.CitaPaciente.create(payload);
  } else {
    await appointment.update(payload);
  }
  return appointment;
}

async function ensureTemplate({ publicId, name, purpose, blockingPolicy, validityMode, requiresProfessionalSignature, bodyHtml, variableSchema }) {
  const payload = {
    clinic_id: CLINIC_ID,
    name,
    description: 'Plantilla demo para validar el flujo de firma en tablet.',
    purpose,
    status: 'active',
    blocking_policy: blockingPolicy,
    validity_mode: validityMode,
    is_default: false,
    requires_patient_signature: true,
    requires_representative_when_minor: true,
    requires_professional_signature: requiresProfessionalSignature,
    catalog_key: publicId,
  };
  let template = await db.ClinicConsentTemplate.findOne({ where: { public_id: publicId } });
  if (!template) {
    template = await db.ClinicConsentTemplate.create({ public_id: publicId, ...payload });
  } else {
    await template.update(payload);
  }

  let version = await db.ClinicConsentTemplateVersion.findOne({
    where: { clinic_template_id: template.id, locale: 'es' },
    order: [['version', 'DESC'], ['id', 'DESC']],
  });
  const versionPayload = {
    clinic_template_id: template.id,
    version: version?.version || 1,
    locale: 'es',
    title: name.replace(/^DEMO - /, ''),
    body_json: null,
    body_html: bodyHtml,
    variable_schema: variableSchema,
    status: 'published',
    published_at: new Date(),
    created_by: null,
  };
  if (!version) {
    version = await db.ClinicConsentTemplateVersion.create(versionPayload);
  } else {
    await version.update(versionPayload);
  }
  return template;
}

async function ensureRequirements(treatment, templates) {
  for (const [index, template] of templates.entries()) {
    const rows = await db.TreatmentConsentRequirement.findAll({
      where: {
        tratamiento_id: treatment.id_tratamiento,
        clinica_id: CLINIC_ID,
        clinic_template_id: template.id,
      },
      order: [['id', 'ASC']],
    });
    const payload = {
      tratamiento_id: treatment.id_tratamiento,
      clinica_id: CLINIC_ID,
      clinic_template_id: template.id,
      catalog_template_id: null,
      requirement_scope: 'treatment',
      condition_key: null,
      required: true,
      blocking_policy: index === 0 ? 'hard' : 'soft',
      sort_order: index,
    };
    if (rows.length) {
      await rows[0].update(payload);
      for (const duplicate of rows.slice(1)) await duplicate.destroy();
    } else {
      await db.TreatmentConsentRequirement.create(payload);
    }
  }
}

async function ensureKiosk() {
  const passwordHash = await bcrypt.hash(TABLET_PASSWORD, 12);
  let kiosk = await db.ClinicTabletKiosk.findOne({ where: { username: TABLET_USERNAME } });
  const payload = {
    public_id: 'kiosk_demo_20260722_bs_capilar',
    clinic_id: CLINIC_ID,
    username: TABLET_USERNAME,
    password_hash: passwordHash,
    display_name: 'Demo tablet BS Capilar',
    status: 'active',
    created_by: null,
  };
  if (!kiosk) {
    const byPublicId = await db.ClinicTabletKiosk.findOne({ where: { public_id: payload.public_id } });
    kiosk = byPublicId || await db.ClinicTabletKiosk.create(payload);
  }
  await kiosk.update(payload);
  return kiosk;
}

async function packageByPublicId(publicId) {
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

async function deletePackageByPublicId(publicId) {
  const packageRow = await db.ConsentSignaturePackage.findOne({ where: { public_id: publicId } });
  if (!packageRow) return;
  const docs = await db.PatientConsentDocument.findAll({
    where: { package_id: packageRow.id },
    attributes: ['id'],
    raw: true,
  });
  const docIds = docs.map((doc) => doc.id);
  if (docIds.length) {
    await db.ConsentDeliveryEvent.destroy({
      where: { patient_consent_document_id: { [db.Sequelize.Op.in]: docIds } },
    });
    await db.PatientConsentDocument.destroy({ where: { id: { [db.Sequelize.Op.in]: docIds } } });
  }
  await db.ConsentDeliveryEvent.destroy({ where: { package_id: packageRow.id } });
  await packageRow.destroy();
}

async function ensurePackagePublicId(packageRow, publicId) {
  if (!packageRow || packageRow.public_id === publicId) return packageRow;
  const conflict = await db.ConsentSignaturePackage.findOne({
    where: { public_id: publicId, id: { [db.Sequelize.Op.ne]: packageRow.id } },
  });
  if (conflict) return conflict;
  await packageRow.update({ public_id: publicId });
  return packageRow;
}

async function assignDocumentPublicIds(packageId, publicIds) {
  const docs = await db.PatientConsentDocument.findAll({
    where: { package_id: packageId },
    order: [['id', 'ASC']],
  });
  for (let index = 0; index < docs.length && index < publicIds.length; index += 1) {
    const publicId = publicIds[index];
    const conflict = await db.PatientConsentDocument.findOne({
      where: { public_id: publicId, id: { [db.Sequelize.Op.ne]: docs[index].id } },
    });
    if (!conflict) {
      await docs[index].update({ public_id: publicId });
    }
  }
}

async function resetPackageToPending(packageRow) {
  const documents = await db.PatientConsentDocument.findAll({ where: { package_id: packageRow.id } });
  for (const doc of documents) {
    await doc.update({
      status: 'viewed',
      signed_at: null,
      signed_by_patient_id: null,
      signed_by_representative_id: null,
      professional_signed_by: null,
      professional_signed_at: null,
      revoked_at: null,
      channel: 'tablet',
      delivery_status: 'queued',
      snapshot_json: cleanSnapshotForPending(doc.snapshot_json),
    });
    const existingEvent = await db.ConsentDeliveryEvent.findOne({
      where: {
        package_id: packageRow.id,
        patient_consent_document_id: doc.id,
        channel: 'tablet',
        status: 'queued',
      },
    });
    if (!existingEvent) {
      await db.ConsentDeliveryEvent.create({
        package_id: packageRow.id,
        patient_consent_document_id: doc.id,
        channel: 'tablet',
        status: 'queued',
        recipient: 'tablet_clinica',
        event_payload: {
          event: 'demo_package_queued',
          created_at: new Date().toISOString(),
        },
      });
    }
  }
  await packageRow.update({
    status: 'pending',
    signed_count: 0,
    required_count: documents.filter((doc) => doc.required).length,
    due_at: addDays(1, 10, 30),
    expires_at: addDays(30, 23, 59),
    trigger_source: 'demo_tablet',
  });
}

async function ensurePackageForAppointment({ appointment, publicId, triggerSource }) {
  let packageRow = await packageByPublicId(publicId);
  if (!packageRow) {
    packageRow = await consentimientosService.createPackageForAppointment(appointment.id_cita, { triggerSource });
    packageRow = await ensurePackagePublicId(packageRow, publicId);
  }
  return packageByPublicId(packageRow.public_id);
}

async function ensureSignedPackage({ appointment }) {
  let packageRow = await ensurePackageForAppointment({
    appointment,
    publicId: SIGNED_PACKAGE_PUBLIC_ID,
    triggerSource: 'demo_signed',
  });

  const documents = await db.PatientConsentDocument.findAll({ where: { package_id: packageRow.id } });
  for (const doc of documents) {
    if (doc.status !== 'signed') {
      await consentimientosService.signConsentDocument(doc.public_id, {
        signer_name: 'Paciente Demo Firmado',
        signer_role: 'patient',
        signature_data_url: SIGNATURE_DATA_URL,
        accepted_statement: true,
        method: 'tablet_signature',
        device_label: 'Demo tablet BS Capilar',
      }, {
        ip: '127.0.0.1',
        userAgent: 'ClinicaClick consent demo seed',
      });
    }

    const refreshed = await db.PatientConsentDocument.findByPk(doc.id);
    const snapshot = refreshed?.snapshot_json && typeof refreshed.snapshot_json === 'object' ? refreshed.snapshot_json : {};
    if (snapshot.template?.requires_professional_signature && !refreshed.professional_signed_at) {
      await consentimientosService.signProfessionalConsentDocument(refreshed.public_id, {
        professional_name: 'Dra. Demo Capilar',
        accepted_statement: true,
        method: 'professional_confirmation',
      }, null, {
        ip: '127.0.0.1',
        userAgent: 'ClinicaClick consent demo seed',
      });
    }
  }

  packageRow = await packageByPublicId(SIGNED_PACKAGE_PUBLIC_ID);
  return packageRow;
}

async function main() {
  const clinic = await requireClinic();
  const treatment = await ensureTreatment();
  const templates = await Promise.all([
    ensureTemplate({
      publicId: TEMPLATE_MICRO_PUBLIC_ID,
      name: 'DEMO - Consentimiento informado microinjerto capilar',
      purpose: 'clinical',
      blockingPolicy: 'hard',
      validityMode: 'single_act',
      requiresProfessionalSignature: true,
      bodyHtml: [
        '<h2>Consentimiento informado para microinjerto capilar</h2>',
        '<p>Paciente: {{paciente.nombre_completo}}</p>',
        '<p>Clínica: {{clinica.nombre}}</p>',
        '<p>Tratamiento: {{tratamiento.nombre}}</p>',
        '<p>El paciente declara haber recibido información comprensible sobre la técnica propuesta, preparación previa, anestesia local, cuidados posteriores, posibles molestias, sangrado, infección, inflamación, cicatrización, pérdida parcial de unidades foliculares y necesidad de controles evolutivos.</p>',
        '<p>Se han explicado alternativas, tiempos de evolución esperados, limitaciones del resultado y la posibilidad de requerir sesiones adicionales.</p>',
      ].join('\n'),
      variableSchema: {
        signing_timing: { mode: 'at_least_24h_before', recommended_min_hours_before: 24 },
        clinical_policy: { signing_timing: 'at_least_24h_before' },
      },
    }),
    ensureTemplate({
      publicId: TEMPLATE_PHOTOS_PUBLIC_ID,
      name: 'DEMO - Autorización fotografías clínicas privadas',
      purpose: 'clinical_image',
      blockingPolicy: 'soft',
      validityMode: 'treatment_episode',
      requiresProfessionalSignature: false,
      bodyHtml: [
        '<h2>Autorización de fotografías clínicas privadas</h2>',
        '<p>Paciente: {{paciente.nombre_completo}}</p>',
        '<p>Autorizo la toma de fotografías clínicas privadas para documentar diagnóstico, planificación, evolución y comparación antes/después dentro de mi historia clínica.</p>',
        '<p>Estas imágenes no se usarán en redes sociales, publicidad ni material comercial sin una autorización específica separada.</p>',
      ].join('\n'),
      variableSchema: {
        signing_timing: { mode: 'before_treatment' },
        clinical_policy: { signing_timing: 'before_treatment' },
      },
    }),
  ]);
  await ensureRequirements(treatment, templates);
  await ensureKiosk();

  const pendingPatient = await ensurePatient({
    publicId: 'pac_demo_consentimientos_tablet_pendiente',
    nombre: 'Demo Tablet',
    apellidos: 'Consentimientos',
    email: 'demo.tablet.consentimientos@clinicaclick.invalid',
    phone: '+34666000001',
  });
  const signedPatient = await ensurePatient({
    publicId: 'pac_demo_consentimientos_firmado',
    nombre: 'Demo Firmado',
    apellidos: 'Consentimientos',
    email: 'demo.firmado.consentimientos@clinicaclick.invalid',
    phone: '+34666000002',
  });

  const pendingAppointment = await ensureAppointment({
    patient: pendingPatient,
    treatment,
    title: 'DEMO consentimientos - tablet pendiente',
    start: addDays(1, 10, 30),
  });
  const signedAppointment = await ensureAppointment({
    patient: signedPatient,
    treatment,
    title: 'DEMO consentimientos - firmado',
    start: addDays(-1, 10, 30),
  });

  await deletePackageByPublicId(PENDING_PACKAGE_PUBLIC_ID);
  let pendingPackage = await ensurePackageForAppointment({
    appointment: pendingAppointment,
    publicId: PENDING_PACKAGE_PUBLIC_ID,
    triggerSource: 'demo_tablet',
  });
  await assignDocumentPublicIds(pendingPackage.id, PENDING_DOCUMENT_PUBLIC_IDS);
  await resetPackageToPending(pendingPackage);
  pendingPackage = await packageByPublicId(PENDING_PACKAGE_PUBLIC_ID);

  const signedPackage = await ensureSignedPackage({ appointment: signedAppointment });
  const tabletSession = await consentimientosService.createTabletSession(pendingPackage.id, {
    base_url: FRONTEND_URL,
    ttl_hours: 72,
  });

  const pendingDocuments = await db.PatientConsentDocument.findAll({
    where: { package_id: pendingPackage.id },
    attributes: ['id', 'public_id', 'title', 'status'],
    order: [['id', 'ASC']],
    raw: true,
  });
  const signedDocuments = await db.PatientConsentDocument.findAll({
    where: { package_id: signedPackage.id },
    attributes: ['id', 'public_id', 'title', 'status', 'signed_at', 'professional_signed_at'],
    order: [['id', 'ASC']],
    raw: true,
  });

  const result = {
    clinic: {
      id: clinic.id_clinica,
      name: clinic.nombre_clinica,
    },
    tablet: {
      url: `${FRONTEND_URL}/tablet`,
      username: TABLET_USERNAME,
      password: TABLET_PASSWORD,
    },
    pendingFlow: {
      dashboardUrl: `${FRONTEND_URL}/consentimientos?tab=pendientes&clinica_id=${CLINIC_ID}`,
      patientUrl: `${FRONTEND_URL}/pacientes/detalle/${pendingPatient.public_id}/consentimientos?clinica_id=${CLINIC_ID}`,
      directSignatureUrl: tabletSession.public_url,
      packageId: pendingPackage.id,
      documents: pendingDocuments,
    },
    signedFlow: {
      patientUrl: `${FRONTEND_URL}/pacientes/detalle/${signedPatient.public_id}/consentimientos?clinica_id=${CLINIC_ID}`,
      tabletPreviewUrl: publicPackageUrl(signedPackage),
      packageId: signedPackage.id,
      documents: signedDocuments.map((doc) => ({
        ...doc,
        renderUrl: `${FRONTEND_URL}/api/consentimientos/documents/${doc.id}/render`,
        pdfUrl: `${FRONTEND_URL}/api/consentimientos/documents/${doc.id}/pdf`,
      })),
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close().catch(() => {});
  });
