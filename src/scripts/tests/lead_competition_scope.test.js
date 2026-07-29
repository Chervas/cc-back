'use strict';

const assert = require('node:assert/strict');
const { resolveLeadCompetitionPeerScope } = require('../../lib/leadCompetitionScope');

function run() {
  const receptionist = resolveLeadCompetitionPeerScope({
    groupClinicIds: [35, 52, 53, 54, 55, 56, 57, 89],
    directlyAccessibleClinicIds: [35],
    manageableClinicIds: [35],
    selectedClinicId: 35,
  });
  assert.equal(receptionist.ready, true);
  assert.deepEqual(receptionist.clinicIds, [35, 52, 53, 54, 55, 56, 57, 89]);

  const doctor = resolveLeadCompetitionPeerScope({
    groupClinicIds: [35, 52],
    directlyAccessibleClinicIds: [35],
    manageableClinicIds: [],
    selectedClinicId: 35,
  });
  assert.equal(doctor.ready, false);
  assert.equal(doctor.reason, 'lead_competition_forbidden');

  const unrelatedStaff = resolveLeadCompetitionPeerScope({
    groupClinicIds: [35, 52],
    directlyAccessibleClinicIds: [],
    manageableClinicIds: [],
    selectedClinicId: 35,
  });
  assert.equal(unrelatedStaff.ready, false);
  assert.equal(unrelatedStaff.reason, 'selected_clinic_forbidden');

  const singleClinicGroup = resolveLeadCompetitionPeerScope({
    groupClinicIds: [35],
    directlyAccessibleClinicIds: [35],
    manageableClinicIds: [35],
    selectedClinicId: 35,
  });
  assert.equal(singleClinicGroup.ready, false);
  assert.equal(singleClinicGroup.reason, 'not_enough_peer_clinics');

  console.log('lead competition scope contract: ok');
}

run();
