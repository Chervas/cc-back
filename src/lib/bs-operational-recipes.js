'use strict';

// Authoring helpers, not automatic activation or a migration of appointments.
// Resource IDs are supplied by the scoped operator; never inferred from names.
const { normalizeBookingProfile, bookingProfileDurationMinutes } = require('./booking-profile');
const staff = id => ({ mode: 'any', ids: [id], preferred_id: id });
const equipment = id => [{ equipment_ids: [id] }];

function prpLedRecipe({ doctorId, applicationDoctorId, extractionRoomId, applicationRoomId, ledId }) {
  // CAP-17: 8 extraction/centrifugation + 5 anaesthesia, then 12 application
  // including LED + 5 registration. These are booking spans, not new clinical
  // instructions. No extra ten-minute LED session or second appointment.
  return normalizeBookingProfile({ version: 4, phases: [
    { key: 'prp_extraction', label: 'PRP · extracción y preparación', start_offset_minutes: 0,
      duration_minutes: 13, installation_ids: [extractionRoomId], professionals: staff(doctorId) },
    { key: 'prp_application', label: 'PRP · aplicación, LED y registro', start_offset_minutes: 13,
      duration_minutes: 17, installation_ids: [applicationRoomId], professionals: staff(applicationDoctorId),
      equipment_requirements: equipment(ledId) },
  ] });
}

function indibaPrpRecipe(resources) {
  const prp = prpLedRecipe(resources);
  return normalizeBookingProfile({ version: 4, phases: [
    { key: 'indiba_capilar', label: 'INDIBA capilar', start_offset_minutes: 0, duration_minutes: 20,
      installation_ids: [resources.indibaRoomId], professionals: staff(resources.applicationDoctorId),
      equipment_requirements: equipment(resources.indibaId) },
    ...prp.phases.map(phase => ({ ...phase, start_offset_minutes: phase.start_offset_minutes + 20 })),
  ] });
}

function sharedPreparationRecipe(profile, { continuousAfterPreparation = false } = {}) {
  if (profile?.phases?.length !== 1) throw Error('BS_SHARED_PREPARATION_SINGLE_TECHNIQUE_REQUIRED');
  const phase = profile.phases[0];
  if (phase.professionals?.mode !== 'any' || phase.professionals.ids.length !== 1
    || phase.duration_minutes < 15) throw Error('BS_SHARED_PREPARATION_RESOURCES_REQUIRED');
  return normalizeBookingProfile({ version: 4, phases: [{ ...phase, start_offset_minutes: 0,
    staff_attention: [{ mode: continuousAfterPreparation ? 'start_continuous' : 'start_only',
      start_minutes: 5, start_window_minutes: 15 }], preparation_sharing: { mode: 'same_start' },
  }] });
}

module.exports = { prpLedRecipe, indibaPrpRecipe, sharedPreparationRecipe, bookingProfileDurationMinutes };
