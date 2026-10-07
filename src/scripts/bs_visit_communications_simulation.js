#!/usr/bin/env node
'use strict';

// Offline evidence only. Reads selected pure runtime functions without loading
// the application. The visit/outbox model below is a proposal, not CRM behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const runtimePath = path.resolve(__dirname, '../services/appointmentAutomationV2Runtime.service.js');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
function extractFunction(name) {
  const start = runtimeSource.search(new RegExp(`\\nfunction ${name}\\(`));
  assert(start >= 0, `Runtime function missing: ${name}`);
  const rest = runtimeSource.slice(start + 1);
  const next = rest.search(/\n(?:async )?function \w+\(/);
  assert(next > 0, `Runtime function boundary missing: ${name}`);
  return rest.slice(0, next);
}
const runtime = { Date };
vm.createContext(runtime);
const importedFunctions = ['cleanString', 'buildIdempotencyKey', 'buildScheduledWindowIdentifier'];
vm.runInContext(importedFunctions.map(extractFunction).join('\n'), runtime, {
  filename: 'selected-pure-appointment-runtime-functions', timeout: 1000,
});

let assertionCount = 0;
function check(value, expected, label) {
  assert.deepEqual(value, expected, label);
  assertionCount += 1;
}
const trigger = 'appointment_reminder_window';
const window = runtime.buildScheduledWindowIdentifier({
  triggerType: trigger,
  triggerConfig: { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '10:00' },
  scheduledFor: new Date('2030-01-09T09:00:00.000Z'),
});
const runtimeKey = (citaId, templateVersionId = 77) => runtime.buildIdempotencyKey({
  triggerType: trigger, citaId, templateVersionId, windowIdentifier: window,
});
const oneAppointmentPhases = [runtimeKey(101), runtimeKey(101)];
const linkedReservations = [runtimeKey(101), runtimeKey(102)];
const publishedVersions = [runtimeKey(101, 77), runtimeKey(101, 78)];
check(oneAppointmentPhases[0], oneAppointmentPhases[1], 'One appointment keeps one runtime identity across phases');
check(linkedReservations[0] === linkedReservations[1], false, 'Linked reservation IDs still have distinct runtime identities');
check(publishedVersions[0] === publishedVersions[1], false, 'Published template versions change runtime identity');
check(runtimeKey(101), runtimeKey(101), 'Repeated runtime calls retain their key');

// Explicitly proposed in-memory repositories. No booking, eligibility or
// production transport is imported or represented as validated here.
function proposedRepository(visits) {
  const records = new Map(visits.map(visit => [visit.id, structuredClone(visit)]));
  const ownerByMember = new Map();
  for (const visit of records.values()) {
    assert(visit.validatedGrouping === true, 'Proposal requires an explicit validated visit grouping');
    for (const memberId of visit.members) {
      assert(!ownerByMember.has(memberId), 'A reservation cannot belong to two proposed visits');
      ownerByMember.set(memberId, visit.id);
    }
  }
  const outbox = new Map();
  function enqueue(memberId, options = {}) {
    const visit = records.get(ownerByMember.get(memberId));
    assert(visit, 'Unknown proposed visit member');
    const purpose = options.trigger || trigger;
    if (visit.status === 'cancelled') return { status: 'suppressed_cancelled' };
    if (visit.optOut) return { status: 'suppressed_opt_out' };
    if (purpose === 'appointment_rescheduled' && options.reason === 'administrative_error') {
      return { status: 'suppressed_administrative_reschedule' };
    }
    // Version means the communication revision of the visit. A template's
    // publication version is audited in the snapshot, not a new delivery right.
    const key = JSON.stringify([visit.id, purpose, visit.communicationRevision, options.window || window]);
    if (outbox.has(key)) return { status: 'deduplicated', message: outbox.get(key) };
    const message = {
      key, visitId: visit.id, revision: visit.communicationRevision, purpose,
      templateVersionId: options.templateVersionId || 77,
      arrival: visit.arrival, finish: visit.finish, patientId: visit.patientId,
      status: 'queued',
    };
    outbox.set(key, message);
    return { status: 'queued', message };
  }
  function assessDelivery(key) {
    const message = outbox.get(key);
    assert(message, 'Unknown proposed outbox record');
    const visit = records.get(message.visitId);
    if (visit.status === 'cancelled') return 'suppressed_cancelled';
    if (visit.optOut) return 'suppressed_opt_out';
    if (message.revision !== visit.communicationRevision) return 'suppressed_stale_revision';
    return 'eligible_in_proposal_only';
  }
  return { records, outbox, enqueue, assessDelivery };
}
function visit(id, patientId, members, extra = {}) {
  return {
    id, patientId, members, validatedGrouping: true, communicationRevision: 1,
    status: 'scheduled', optOut: false, phoneAlias: `synthetic-contact-${patientId}`,
    arrival: '2030-01-10T15:00:00.000Z', finish: '2030-01-10T15:45:00.000Z',
    ...extra,
  };
}

const owner = proposedRepository([visit('visit-1', 8, [101, 102])]);
const first = owner.enqueue(101);
const second = owner.enqueue(102);
check(owner.outbox.size, 1, 'Two members share one proposed communication owner');
check(first.message.key, second.message.key, 'Members share the visit/purpose/revision/window key');
check(owner.enqueue(102, { templateVersionId: 78 }).message.key, first.message.key, 'Template publication does not duplicate proposed delivery');
for (let attempt = 0; attempt < 3; attempt += 1) {
  check(owner.enqueue(101).message.key, first.message.key, 'Retries keep the same proposed outbox key');
}
check(first.message.arrival, '2030-01-10T15:00:00.000Z', 'Communicated arrival belongs to the visit, not the later phase');

const samePatient = proposedRepository([visit('visit-a', 8, [201]), visit('visit-b', 8, [202])]);
samePatient.enqueue(201); samePatient.enqueue(202);
check(samePatient.outbox.size, 2, 'Distinct visits for the same patient are not deduplicated');

const concurrentPreparations = proposedRepository([
  visit('prep-a', 8, [301]), visit('prep-b', 9, [302]), visit('prep-c', 10, [303]),
]);
for (const member of [301, 302, 303]) concurrentPreparations.enqueue(member);
check(concurrentPreparations.outbox.size, 3, 'Three visits at the same arrival time retain three communication identities');

const sharedPhone = proposedRepository([
  visit('family-a', 8, [401], { phoneAlias: 'synthetic-shared-family-phone' }),
  visit('family-b', 9, [402], { phoneAlias: 'synthetic-shared-family-phone' }),
]);
sharedPhone.enqueue(401); sharedPhone.enqueue(402);
check(sharedPhone.outbox.size, 2, 'A shared family phone does not merge visits or patients');

owner.records.get('visit-1').communicationRevision = 2;
owner.records.get('visit-1').arrival = '2030-01-10T16:00:00.000Z';
owner.records.get('visit-1').finish = '2030-01-10T16:45:00.000Z';
check(owner.assessDelivery(first.message.key), 'suppressed_stale_revision', 'A queued older revision cannot announce an obsolete arrival');
const moved = owner.enqueue(102);
check(moved.message.key === first.message.key, false, 'A rescheduled communication revision has its own key');
check(moved.message.arrival, '2030-01-10T16:00:00.000Z', 'New revision snapshots the revised arrival');
owner.records.get('visit-1').status = 'cancelled';
check(owner.assessDelivery(moved.message.key), 'suppressed_cancelled', 'Cancellation invalidates a queued visit communication');
check(owner.enqueue(101).status, 'suppressed_cancelled', 'Cancelled visits cannot enqueue another notification');

const silent = proposedRepository([visit('silent', 8, [501])]);
check(silent.enqueue(501, { trigger: 'appointment_rescheduled', reason: 'administrative_error' }).status,
  'suppressed_administrative_reschedule', 'Administrative correction does not enqueue a change notice');
const laterReminder = silent.enqueue(501);
check(laterReminder.status, 'queued', 'Administrative correction does not permanently mute later reminders');
silent.records.get('silent').optOut = true;
check(silent.assessDelivery(laterReminder.message.key), 'suppressed_opt_out', 'Opt-out also protects the final proposed delivery gate');
check(silent.enqueue(501).status, 'suppressed_opt_out', 'Opt-out blocks new proposed notifications');

process.stdout.write(JSON.stringify({
  simulation: 'offline_only_no_database_workers_network_or_transport',
  deterministic: true,
  productionValidated: false,
  assertionsPassed: assertionCount,
  runtime_vs_proposal: {
    runtime: {
      source: 'src/services/appointmentAutomationV2Runtime.service.js',
      sourceSha256: createHash('sha256').update(runtimeSource).digest('hex'),
      exactImportedFunctions: importedFunctions,
      oneAppointmentTwoPhases: { keys: oneAppointmentPhases, identities: 1 },
      twoLinkedReservations: { keys: linkedReservations, identities: 2 },
      templateVersions77And78: { keys: publishedVersions, identities: 2 },
      limitation: 'Distinct keys show independent runtime identities, not proof of real duplicate sends; eligibility and suppressions still apply.',
    },
    proposed: {
      implementation: 'in_memory_simulation_not_production_code',
      key: ['visit_id', 'trigger_or_purpose', 'communication_revision', 'window'],
      twoMembersOneOwner: 1,
      distinctVisitsSamePatient: samePatient.outbox.size,
      threeVisitsSameArrival: concurrentPreparations.outbox.size,
      distinctPatientsSharedPhone: sharedPhone.outbox.size,
      repeatedRetriesSameKey: true,
      templatePublicationDoesNotDuplicate: true,
      finalGuards: ['communication_revision', 'cancelled_visit', 'opt_out'],
      administrativeCorrection: 'silent_change_notice_with_later_reminders_preserved',
      arrivalSource: 'explicit_visit_snapshot_not_secondary_phase',
      limitations: ['No resource availability or clinical timing validation', 'No confirmation/cancellation/reschedule production implementation', 'No messages are transmitted'],
    },
  },
}, null, 2) + '\n');
