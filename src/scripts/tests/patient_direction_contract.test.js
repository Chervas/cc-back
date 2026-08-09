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

assert.match(migration, /PatientDirectionSettings/);
assert.match(migration, /PatientDirectionAssignments/);
assert.match(migration, /PatientDirectionEvents/);
assert.match(migration, /clinicaclick_patient_direction_handoff/);
assert.match(migration, /Director de pacientes/);

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

assert.match(conversation, /patientDirectionTakeConfirmed/);
assert.match(conversation, /patient_direction_take_confirmation_required/);
assert.match(conversation, /enrichPatientDirectionAssignments/);
assert.match(flowEngine, /resolveOutboundPolicy[\s\S]*?automation: true/,
  'V2 automations must use the same sender policy as QuickChat');
assert.match(flowEngine, /patient_direction_assignment_id/,
  'scheduled automation jobs must snapshot the assignment');
assert.match(webhook, /resolveInboundDestination/);
assert.match(webhook, /captureUnassignedInbound/);
assert.match(workers, /sendOldNumberNotice/);
assert.match(workers, /handleHandoffMessageStatus/);

assert.match(appointments, /attributes: \[[\s\S]*?'created_by'/,
  'the lightweight agenda endpoint must expose the appointment creator');
assert.match(appointments, /handleAppointmentChange/);

const guardIndex = personal.indexOf('patient_direction_role_assignment_forbidden');
const saveIndex = personal.indexOf('await user.save()', guardIndex);
assert.ok(guardIndex >= 0 && saveIndex > guardIndex,
  'patient director role authorization must happen before personal data is saved');
assert.doesNotMatch(
  personal.slice(personal.indexOf('exports.buscarPersonal'), personal.indexOf('exports.invitarPersonal')),
  /assigningPatientDirector/,
  'plain personnel search must not depend on a role field that it does not receive',
);

console.log('patient direction contract: ok');
