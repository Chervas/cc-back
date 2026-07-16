#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const controller = fs.readFileSync(
  path.resolve(__dirname, '../../controllers/citas.controller.js'),
  'utf8'
);

assert.match(
  controller,
  /resolveAppointmentReadClinicIds[\s\S]*?getAccessibleClinicIdsForFeature[\s\S]*?featureKey: 'appointments\.view'/,
  'appointment list scope must be derived from effective appointments.view permissions'
);
for (const handler of ['getCitas', 'getCitasCalendar']) {
  const start = controller.indexOf(`exports.${handler} = asyncHandler`);
  const end = controller.indexOf('\nexports.', start + 1);
  assert.ok(start >= 0, `${handler} must exist`);
  const block = controller.slice(start, end >= 0 ? end : undefined);
  assert.match(
    block,
    /resolveAppointmentReadClinicIdsOrRespond[\s\S]*?clinica_id:[\s\S]*?Op\.in/,
    `${handler} must filter every query by the permitted clinic ids`
  );
}
assert.match(
  controller,
  /exports\.getCitaById[\s\S]*?denyAppointmentViewAccessIfNeeded\(req, res, cita\.clinica_id\)/,
  'appointment detail must enforce clinic read scope'
);
assert.match(
  controller,
  /exports\.getManualAttributionPreview[\s\S]*?denyAppointmentManageAccessIfNeeded\(req, res, clinicaId\)[\s\S]*?featureKey: 'leads\.sensitive\.view'[\s\S]*?patientBelongsToClinic\(patient, clinicaId\)[\s\S]*?actorCanReadPatientSensitive\(req, patient\)/,
  'manual attribution preview must not expose patient contact data outside appointment managers'
);
assert.match(
  controller,
  /const leadBelongsToClinic = leadClinicId === Number\(clinica_id\);[\s\S]*?if \(!leadBelongsToClinic && !unassignedLeadBelongsToGroup\)[\s\S]*?Lead no encontrado/,
  'appointment creation must reject an explicitly linked lead from another clinic or group'
);
assert.match(
  controller,
  /if \(explicitLeadIntakeId\)[\s\S]*?featureKey: 'leads\.manage'[\s\S]*?featureKey: 'leads\.sensitive\.view'[\s\S]*?No tienes permiso para vincular este lead/,
  'explicit lead linkage must require lead management and sensitive access in addition to appointment management',
);
const foreignDoctorConflict = controller.match(
  /if \(citasDocOtherClinics\.length\) \{[\s\S]*?details: \{ message: 'Doctor ocupado en otra clínica' \}[\s\S]*?\n\s*\}/
);
assert.ok(foreignDoctorConflict, 'foreign-clinic doctor conflicts must be represented');
assert.doesNotMatch(
  foreignDoctorConflict[0],
  /cita_ids|clinica_ids/,
  'foreign-clinic appointment and clinic ids must not be disclosed in availability conflicts'
);
assert.match(
  controller,
  /const explicitPatientIdentifier = datosPaciente\.id_paciente \|\| datosPaciente\.id;[\s\S]*?actorCanReadPatientSensitive\(req, explicitPatient\)[\s\S]*?Paciente no encontrado/,
  'appointment creation must not link and expose a patient that is only visible in another actor scope'
);
assert.match(
  controller,
  /appointmentPrivacyCapabilities[\s\S]*?patients\.sensitive\.view[\s\S]*?leads\.sensitive\.view[\s\S]*?consents\.view/,
  'appointment payload privacy must be evaluated independently for patient, lead and consent data',
);
assert.match(
  controller,
  /function protectAppointmentPayload[\s\S]*?redactAppointmentPatient[\s\S]*?redactAppointmentLead[\s\S]*?consent_summary = null/,
  'appointment payloads must redact data that appointments.view alone does not grant',
);
for (const responseExpression of [
  'res.json(await protectAppointmentsForRequest(req, citas))',
  'res.json(await protectAppointmentsForRequest(req, calendarRows))',
  'return res.json(await protectAppointmentsForRequest(req, cita || null))',
]) {
  assert.ok(controller.includes(responseExpression), `${responseExpression} must protect read responses`);
}

assert.match(
  controller,
  /PatientNutritionMeasurement\.findAll\(\{[\s\S]*?\[Op\.or\]: patientClinicPairs\.map\(\(\{ patientId, clinicId \}\)[\s\S]*?patient_id: patientId,[\s\S]*?clinic_id: clinicId/,
  'nutrition enrichment must query each shared patient together with the appointment clinic',
);
assert.match(
  controller,
  /attributes: \['id', 'patient_id', 'clinic_id'[\s\S]*?measurementsByPatientClinic\.get\(`\$\{patientId\}:\$\{clinicId\}`\)/,
  'a patient shared by two clinics must only receive the latest measurement from the appointment clinic',
);

console.log('appointment read scope contract: ok');
