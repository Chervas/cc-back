#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

const service = source('../../services/patientDirection.service.js');
const conversation = source('../../controllers/conversation.controller.js');
const appointments = source('../../controllers/citas.controller.js');
const flowEngine = source('../../services/flowEngineV2.service.js');
const webhook = source('../../routes/whatsapp-webhook.routes.js');
const workers = source('../../workers/queue.workers.js');
const personal = source('../../controllers/personal.controller.js');
const migration = source('../../../migrations/20260809190000-create-patient-direction-domain.js');
const profileMigration = source('../../../migrations/20260809213000-create-patient-direction-profiles.js');
const profileModel = source('../../../models/PatientDirectionProfile.js');
const routes = source('../../routes/patientDirection.routes.js');
const userClinicsRoutes = source('../../routes/userclinicas.routes.js');

assert.match(migration, /PatientDirectionSettings/);
assert.match(migration, /PatientDirectionAssignments/);
assert.match(migration, /PatientDirectionEvents/);
assert.match(migration, /clinicaclick_patient_direction_handoff/);
assert.match(migration, /Director de pacientes/);
assert.match(profileMigration, /PatientDirectionProfiles/);
assert.match(profileMigration, /DELETE FROM UsuarioClinica[\s\S]*?Director de pacientes/,
  'the global profile migration must remove legacy staff memberships');
assert.match(profileMigration, /MODIFY COLUMN subrol_clinica ENUM\([\s\S]*?'Gestoría'[\s\S]*?\) NULL/);
assert.doesNotMatch(
  profileMigration.slice(profileMigration.indexOf('MODIFY COLUMN subrol_clinica ENUM('), profileMigration.indexOf('async down')),
  /'Director de pacientes'/,
  'the migrated personnel enum must no longer include patient directors',
);
assert.match(profileModel, /whatsapp_phone_asset_id[\s\S]*?unique: true/);
assert.match(profileModel, /hasMany\(models\.PatientDirectionSetting/);
assert.match(routes, /get\('\/profiles\/:userId'/);
assert.match(routes, /put\('\/profiles\/:userId'/);
assert.match(userClinicsRoutes, /userRole: role/);
assert.match(userClinicsRoutes, /'patient_director'/);
assert.match(userClinicsRoutes, /PatientDirectionProfile\.findOne/);
assert.match(userClinicsRoutes, /PatientDirectionSetting/);
assert.match(conversation, /patientDirectionService\.getAssignedClinicIds\(userId\)/);
assert.match(conversation, /directorClinicIds:\s*\[\]/);
assert.match(conversation, /effectiveRole\s*=\s*selectedClinicBelongsToDirector/);
assert.doesNotMatch(
  userClinicsRoutes.slice(userClinicsRoutes.indexOf('const directorProfile'), userClinicsRoutes.indexOf('const scopedClinics')),
  /UsuarioClinica/,
  'the patient director navigation scope must not create or depend on personnel memberships',
);

assert.match(service, /patient-direction:\$\{assetId\}:\$\{normalized\.replace/,
  'active assignment uniqueness must be scoped to the director WhatsApp');
assert.match(service, /requireNoHumanContact[\s\S]*?hasHumanContact/,
  'existing leads with human contact must not be absorbed automatically');
assert.match(service, /automatic_first_contact/,
  'the first automatic outbound must start the assignment');
assert.match(service, /first_appointment_attended[\s\S]*?queueHandoff/,
  'attending the tracked first appointment must trigger the handoff');
assert.match(service, /service_disabled[\s\S]*?default_successor_user_id/,
  'disabling the service must transfer every active assignment to one successor');
assert.match(service, /isConsentPurpose[\s\S]*?mode: 'clinic_default'/,
  'consents must never use the director sender');
assert.match(service, /director_whatsapp_must_be_shared_across_clinics/);
assert.match(service, /director_and_clinic_whatsapp_must_differ/);
assert.match(service, /director_whatsapp_out_of_scope/);
assert.match(service, /async function syncProfileClinics/,
  'clinic assignments must have an explicit patient-direction sync boundary');
assert.match(service, /PatientDirectionSetting\.create\([\s\S]*?is_enabled:\s*false/,
  'assigning the role must not enable clinic routing implicitly');
assert.match(service, /patient_direction_active_clinic_cannot_unassign/,
  'an enabled clinic must require a handoff before removing the director');
assert.match(service, /asignado_a:\s*uid[\s\S]*?priority_items:\s*priorityItems/,
  'the director dashboard must summarize assigned leads in backend before an operational assignment exists');
assert.match(service, /\.slice\(0,\s*8\)/,
  'the director dashboard is a bounded summary, not a second lead-management list');
assert.doesNotMatch(
  service.slice(service.indexOf('async function syncProfileClinics'), service.indexOf('async function saveProfile')),
  /UsuarioClinica|DoctorClinica|DoctorHorario/,
  'assigning director clinics must not create personnel or schedule memberships',
);

assert.match(conversation, /patientDirectionTakeConfirmed/);
assert.match(conversation, /patient_direction_take_confirmation_required/);
assert.match(conversation, /enrichPatientDirectionAssignments/);
assert.match(flowEngine, /resolveOutboundPolicy[\s\S]*?automation: true/,
  'V2 automations must use the same sender policy as QuickChat');
assert.match(flowEngine, /patient_direction_assignment_id/,
  'scheduled automation jobs must snapshot the assignment');
assert.match(flowEngine, /const domain = toLowerSafe\(config\?\.domain \|\| context\?\.runtime\?\.domain\)/,
  'appointment automations must accept send nodes without an optional domain');
assert.doesNotMatch(flowEngine, /cleanString\(config\?\.domain \|\| context\?\.runtime\?\.domain\)\.toLowerCase\(\)/,
  'an absent optional domain must not fail before the WhatsApp request reaches Meta');
assert.match(webhook, /resolveInboundDestination/);
assert.match(webhook, /captureUnassignedInbound/);
assert.match(workers, /sendOldNumberNotice/);
assert.match(workers, /handleHandoffMessageStatus/);

assert.match(appointments, /attributes: \[[\s\S]*?'created_by'/,
  'the lightweight agenda endpoint must expose the appointment creator');
assert.match(appointments, /handleAppointmentChange/);

const guardIndex = personal.indexOf('patient_direction_is_not_clinic_staff');
const saveIndex = personal.indexOf('await user.save()', guardIndex);
assert.ok(guardIndex >= 0 && saveIndex > guardIndex,
  'patient director staff assignment must be rejected before personal data is saved');
assert.doesNotMatch(
  personal.slice(personal.indexOf('exports.buscarPersonal'), personal.indexOf('exports.invitarPersonal')),
  /assigningPatientDirector/,
  'plain personnel search must not depend on a role field that it does not receive',
);

console.log('patient direction contract: ok');
