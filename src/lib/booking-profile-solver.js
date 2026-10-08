'use strict';

const { normalizeBookingProfile, bookingPhaseOffsets, bookingProfileDurationMinutes, pendingAttentionRequirements } = require('./booking-profile');
const { installationAllowsStaff } = require('./installation-professionals');
const { attentionVisitsAllowStep, legacyAttentionConfirmationIds } = require('./booking-attention-origin');
const { professionalFallbackAllowed } = require('./booking-professional-fallback');
const { legacyProtectedAttentionResource, flexibleVersion4PhaseDoctor, flexibleVersion4StaffResource, flexibleVersion4RoomResource } = require('./flexible-agenda');
const { normalizeAttentionPolicy, isDefaultAttention, requiresVersion4Attention, planStaffAttention, assessStaffAttentionSteps, resourceForConfirmedOverlap, ordinaryPhaseCanOverlap } = require('./booking-attention');

const overlap = (start, end, interval) => start < new Date(interval.end) && new Date(interval.start) < end;

function isFree(resource, start, end) {
  return !!resource && resource.windows.some((window) => new Date(window.start) <= start && end <= new Date(window.end))
    && !(resource.busy || []).some((interval) => overlap(start, end, interval));
}

/**
 * No Cartesian product: alternatives are independent within a sequential phase.
 * ALL staff are required for the entire appointment, not merely their phase.
 * Inputs contain only schedules/occupancy, never patients or clinical notes.
 */
function solveStrictBookingProfile({ profile: input, start, doctors, installations, equipment = null, clinicWindows = null, selections = {}, allowOverlap = false, attentionValidation = 'clinical' }) {
  const profile = normalizeBookingProfile(input);
  if (profile.version === 4) return solveVersion4BookingProfile({ profile, start, doctors, installations, equipment, clinicWindows, selections, allowOverlap, attentionValidation });
  doctors = new Map([...doctors].map(([id, resource]) => [id, legacyProtectedAttentionResource(resource)]));
  const appointmentStart = new Date(start);
  const appointmentEnd = new Date(appointmentStart.getTime()
    + profile.phases.reduce((sum, phase) => sum + phase.duration_minutes, 0) * 60000);
  if (!Number.isFinite(appointmentStart.getTime())) return null;
  if (clinicWindows && !isFree({ windows: clinicWindows }, appointmentStart, appointmentEnd)) return null;
  let phaseStart = appointmentStart;
  const phases = [];
  const warnings = [];
  const usedEquipment = new Map();
  for (const phase of profile.phases) {
    const phaseEnd = new Date(phaseStart.getTime() + phase.duration_minutes * 60000);
    const selection = selections[phase.key] || {};
    const installationIds = selection.installation_id == null ? phase.installation_ids
      : phase.installation_ids.filter((id) => id === Number(selection.installation_id));
    const equipmentChoices = new Map();
    const requirements = phase.equipment_requirements || [];
    const confirmOrdinaryOverlap = allowOverlap && ordinaryPhaseCanOverlap(phase);
    const freeInstallations = installationIds.filter((id) => {
      if (!isFree(resourceForConfirmedOverlap(installations.get(id), phaseStart, phaseEnd, confirmOrdinaryOverlap), phaseStart, phaseEnd)) return false;
      if (!requirements.length) return true;
      if (!equipment) return false;
      const chosen = [];
      for (const group of requirements) {
        const unit = group.equipment_ids.map(eid => equipment.get(eid)).find(candidate => {
          if (!candidate || candidate.status !== 'available' || !candidate.installation_ids.has(id)) return false;
          const bufferedEnd = new Date(phaseEnd.getTime() + candidate.turnaround_minutes * 60000);
          if (candidate.busy.some(interval => overlap(phaseStart, bufferedEnd, interval))) return false;
          const previous = usedEquipment.get(candidate.id);
          return !previous || previous.resource_key === installations.get(id).resource_key
            || previous.end + candidate.turnaround_minutes * 60000 <= phaseStart.getTime();
        });
        if (!unit) return false;
        chosen.push(unit);
      }
      equipmentChoices.set(id, chosen);
      return true;
    });
    let installationId;
    const staff = phase.professionals;
    let doctorIds;
    let attentionPolicies = null;
    let staffIntervals = null;
    if (staff.mode === 'all') {
      if ((selection.doctor_id != null && (staff.ids.length !== 1 || Number(selection.doctor_id) !== staff.ids[0]))
        || !staff.ids.every((id) => isFree(doctors.get(id), appointmentStart, appointmentEnd))) return null;
      doctorIds = [...staff.ids];
      installationId = freeInstallations.find(id => installationAllowsStaff(installations.get(id), doctorIds));
      if (!installationId) return null;
    } else {
      const preferredFirst = [staff.preferred_id, ...staff.ids.filter((id) => id !== staff.preferred_id)].filter(Boolean);
      const eligible = selection.doctor_id == null ? preferredFirst
        : preferredFirst.filter((id) => id === Number(selection.doctor_id));
      const attentionFor = roomId => {
        const policies = phase.staff_attention || (equipmentChoices.get(roomId) || []).map(unit => normalizeAttentionPolicy(unit.attention_policy));
        if (policies.some(requiresVersion4Attention)) throw Object.assign(new Error('Esta configuración de intervención requiere un perfil de agenda de versión 4.'),
          { code: 'booking_profile_invalid', statusCode: 400, details: { field: 'version' } });
        return policies;
      };
      const plans = new Map();
      const fitsRoom = (id, roomId) => {
        if (!installationAllowsStaff(installations.get(roomId), [id])) return false;
        const policies = attentionFor(roomId);
        if (!policies.some(policy => !isDefaultAttention(policy))) {
          return isFree(resourceForConfirmedOverlap(doctors.get(id), phaseStart, phaseEnd, confirmOrdinaryOverlap), phaseStart, phaseEnd);
        }
        const plan = planStaffAttention({ resource: doctors.get(id), start: phaseStart, end: phaseEnd, policies });
        if (!plan) return false;
        plans.set(`${id}:${roomId}`, plan);
        return true;
      };
      const fits = id => freeInstallations.some(roomId => fitsRoom(id, roomId));
      const doctorId = eligible.find(fits);
      if (!doctorId) return null;
      doctorIds = [doctorId];
      installationId = freeInstallations.find(roomId => fitsRoom(doctorId, roomId));
      staffIntervals = plans.get(`${doctorId}:${installationId}`) || null;
      if (staffIntervals) attentionPolicies = attentionFor(installationId);
      if (staff.preferred_id && doctorId !== staff.preferred_id) {
        warnings.push({
          code: 'NON_PREFERRED_PROFESSIONAL', phase_key: phase.key, doctor_id: doctorId,
          preferred_doctor_id: staff.preferred_id,
          preferred_available: fits(staff.preferred_id),
          // Do not say "the only one" if several alternatives actually fit.
          only_available_alternative: staff.ids.filter(fits).length === 1,
        });
      }
    }
    phases.push({ key: phase.key, label: phase.label, start_at: phaseStart.toISOString(), end_at: phaseEnd.toISOString(),
      installation_id: installationId, installation_name: installations.get(installationId)?.name || '',
      doctor_ids: doctorIds, doctor_names: doctorIds.map((id) => doctors.get(id)?.name || ''),
      staff_time_scope: staff.mode === 'all' ? 'appointment' : 'phase',
      ...(staffIntervals ? { staff_intervals: staffIntervals, staff_attention: attentionPolicies } : {}),
      ...(requirements.length ? { equipment: equipmentChoices.get(installationId).map(unit => ({
        id: unit.id, name: unit.name, turnaround_minutes: unit.turnaround_minutes,
      })) } : {}) });
    for (const unit of equipmentChoices.get(installationId) || []) usedEquipment.set(unit.id, {
      resource_key: installations.get(installationId).resource_key, end: phaseEnd.getTime(),
    });
    phaseStart = phaseEnd;
  }
  return { start_at: appointmentStart.toISOString(), end_at: appointmentEnd.toISOString(), phases, warnings,
    requires_priority_acknowledgement: warnings.length > 0,
    ...(allowOverlap ? { requires_overlap_acknowledgement: phases.some(phase =>
      !isFree(installations.get(phase.installation_id), new Date(phase.start_at), new Date(phase.end_at))
      || (!phase.staff_intervals && phase.doctor_ids.some(id => !isFree(doctors.get(id), new Date(phase.start_at), new Date(phase.end_at))))) } : {}) };
}

/** Relative steps of a single visit. Search is bounded and read-only. It never
 * moves previously saved staff intervals or increases a physical capacity.
 * v1–3 deliberately keep their old sequential/team semantics above. */
function solveVersion4BookingProfile({ profile, start, doctors, installations, equipment = null, clinicWindows = null, selections = {},
  allowOverlap = false, attentionValidation = 'clinical', allowFlexibleAgenda = false }) {
  if (profile.phases.some(phase => (phase.equipment_requirements || []).length > 1)) throw Object.assign(new Error(
    'Define un paso por técnica para conservar la atención de cada máquina. Esta fase tiene varios equipos y todavía no puede reservarse de forma segura.'),
  { code: 'booking_profile_attention_ambiguous', statusCode: 409 });
  if (!['clinical', 'preview'].includes(attentionValidation)) throw Object.assign(new Error('Elige validación clínica o una vista previa no clínica.'),
    { code: 'booking_profile_invalid', statusCode: 400, details: { field: 'attentionValidation' } });
  const pending = pendingAttentionRequirements(profile);
  if (pending.length && attentionValidation === 'clinical') throw Object.assign(new Error('Falta definir la intervención del profesional. La vista previa no garantiza la capacidad clínica de esta visita.'),
    { code: 'pending_attention_requirements', statusCode: 409, details: { requirements: pending } });
  const appointmentStart = new Date(start), duration = bookingProfileDurationMinutes(profile);
  if (!Number.isFinite(+appointmentStart) || duration == null) return null;
  const appointmentEnd = new Date(+appointmentStart + duration * 60000);
  if (!allowFlexibleAgenda && clinicWindows && !isFree({ windows: clinicWindows }, appointmentStart, appointmentEnd)) return null;
  const offsets = bookingPhaseOffsets(profile);
  const timings = profile.phases.map((phase, index) => ({ start: new Date(+appointmentStart + offsets[index] * 60000),
    end: new Date(+appointmentStart + (offsets[index] + phase.duration_minutes) * 60000) }));
  const selected = [], equipmentHolds = [], plans = new Map();
  // Scoped to this one immutable context/start. A doctor's effective resource
  // depends on the phase and selected staff, not on the room or unit identity.
  // Those identities still go through all physical checks below. Cache only
  // the exact ordered staff steps/policies, never a prior visit or calendar.
  const staffEligibility = new Map(), staffDecisions = new Map();
  let explored = 0, solution = null;
  // Aliased rooms in a group are a physical resource, not separate capacity.
  const physicalRooms = new Map();
  for (const [id, room] of installations) {
    const key = room.resource_key || `installation:${id}`;
    if (!physicalRooms.has(key)) physicalRooms.set(key, []);
    physicalRooms.get(key).push(...(room.busy || []));
  }
  function roomResource(id) {
    const room = installations.get(id);
    return room && { ...room, busy: physicalRooms.get(room.resource_key || `installation:${id}`) || [] };
  }
  function flexibleDoctor(phase, doctorIds) {
    return allowFlexibleAgenda && allowOverlap ? flexibleVersion4PhaseDoctor(phase, doctorIds, doctors, selections) : null;
  }
  function assignmentRoom(installationId, { phase, timing, doctorIds }) {
    const original = roomResource(installationId), id = flexibleDoctor(phase, doctorIds);
    return id ? flexibleVersion4RoomResource(original, timing.start, timing.end, id) : original;
  }
  function assignmentStaff(assignment, id) {
    const { phase, timing, doctorIds } = assignment;
    const original = doctors.get(id);
    const effective = flexibleDoctor(phase, doctorIds) === id ? flexibleVersion4StaffResource(original, timing.start, timing.end)
      : original?.absence_windows?.length ? { ...original, busy: [...(original.busy || []), ...original.absence_windows] } : original;
    return resourceForConfirmedOverlap(effective, timing.start, timing.end, allowOverlap && ordinaryPhaseCanOverlap(phase)
      && !(phase.attention_requirements_pending || []).length);
  }
  function clinicFitsAssignments(assignments) {
    if (!clinicWindows || isFree({ windows: clinicWindows }, appointmentStart, appointmentEnd)) return true;
    if (!allowFlexibleAgenda || assignments.some(row => !flexibleDoctor(row.phase, row.doctorIds)
      && !isFree({ windows: clinicWindows }, row.timing.start, row.timing.end))) return false;
    // Do not let a flexible phase hide a non-flexible phase or an uncovered
    // gap in the patient envelope. Every closed instant needs explicit scope.
    const coverage = [...clinicWindows, ...assignments.filter(row => flexibleDoctor(row.phase, row.doctorIds)).map(row => row.timing)]
      .filter(window => Number.isFinite(+new Date(window.start)) && Number.isFinite(+new Date(window.end)))
      .sort((a, b) => +new Date(a.start) - +new Date(b.start));
    let covered = +appointmentStart;
    for (const window of coverage) if (+new Date(window.start) <= covered) covered = Math.max(covered, +new Date(window.end));
    return covered >= +appointmentEnd;
  }
  function unitFits(unit, roomId, timing, units) {
    if (!unit || unit.status !== 'available' || !unit.installation_ids.has(roomId) || units.some(chosen => chosen.id === unit.id)) return false;
    const bufferedEnd = new Date(+timing.end + unit.turnaround_minutes * 60000);
    if ((unit.busy || []).some(interval => overlap(timing.start, bufferedEnd, interval))) return false;
    const roomKey = installations.get(roomId).resource_key || `installation:${roomId}`;
    return equipmentHolds.filter(hold => hold.id === unit.id).every(hold => {
      // The same patient may retain a unit through consecutive steps in one
      // physical room, but cannot run two overlapping acts on the same unit.
      if (timing.start < hold.end && hold.start < timing.end) return false;
      if (hold.roomKey === roomKey) return true;
      return hold.end.getTime() + hold.turnaround * 60000 <= +timing.start
        || +timing.end + unit.turnaround_minutes * 60000 <= +hold.start;
    });
  }
  function policiesFor(phase, units) {
    return phase.staff_attention || (units.length ? units.map(unit => normalizeAttentionPolicy(unit.attention_policy)) : [normalizeAttentionPolicy(null)]);
  }
  function staffStepsForAssignments(assignments) {
    const byDoctor = new Map();
    for (const assignment of assignments) {
      const { phase, timing, doctorIds, policies } = assignment;
      const signature = JSON.stringify([phase.key, doctorIds, policies]);
      if (!staffEligibility.has(signature)) {
        const eligible = !(phase.professionals.mode === 'any' && doctorIds[0] !== phase.professionals.preferred_id
          && !professionalFallbackAllowed({ profileVersion: 4, professionals: phase.professionals,
            primary: doctors.get(phase.professionals.preferred_id), start: timing.start, end: timing.end, policies }))
          && doctorIds.every(id => attentionVisitsAllowStep(doctors.get(id), { phase, visitStart: appointmentStart,
            start: timing.start, end: timing.end, policies: phase.professionals.mode === 'all' ? [normalizeAttentionPolicy(null)] : policies,
            allowLegacyAttentionConfirmation: flexibleDoctor(phase, doctorIds) === id }));
        staffEligibility.set(signature, eligible);
      }
      if (!staffEligibility.get(signature)) return null;
      for (const id of doctorIds) {
        if (!byDoctor.has(id)) byDoctor.set(id, []);
        byDoctor.get(id).push({ signature, key: phase.key, start: timing.start, end: timing.end,
          policies: phase.professionals.mode === 'all' ? [normalizeAttentionPolicy(null)] : policies,
          resource: assignmentStaff(assignment, id) });
      }
    }
    return byDoctor;
  }
  function staffDecision(id, steps) {
    const key = JSON.stringify([id, steps.map(step => step.signature)]);
    if (!staffDecisions.has(key)) {
      // Every task retains its original/explicitly relaxed windows and
      // protected occupancy. Do not freeze a greedy preparation interval.
      staffDecisions.set(key, assessStaffAttentionSteps({ resource: doctors.get(id), steps }));
    }
    return staffDecisions.get(key);
  }
  function partialStaffFits(assignments) {
    // Reject only constraints that later assignments cannot repair. A later
    // flexible phase may cover a closed envelope gap, so the complete clinic
    // coverage check remains in finish(). Its own non-flexible closed phase,
    // unlike an envelope gap, can already be rejected here.
    if (allowFlexibleAgenda && clinicWindows && assignments.some(row => !flexibleDoctor(row.phase, row.doctorIds)
      && !isFree({ windows: clinicWindows }, row.timing.start, row.timing.end))) return false;
    const byDoctor = staffStepsForAssignments(assignments);
    if (!byDoctor) return false;
    for (const [id, steps] of byDoctor) {
      const decision = staffDecision(id, steps);
      if (decision.status === 'infeasible' || decision.status === 'invalid') return false;
      // A bounded search limit is NOT a proof of impossibility. Additional
      // tasks can change pruning/order, so do not discard that branch here.
    }
    return true;
  }
  function buildStaffPlans(assignments) {
    const byDoctor = staffStepsForAssignments(assignments);
    if (!byDoctor) return null;
    const result = new Map();
    for (const [id, steps] of byDoctor) {
      // One clinician still has one joint timeline. Each task retains its own
      // original/explicitly relaxed windows and protected external occupancy.
      const decision = staffDecision(id, steps);
      if (decision.status !== 'planned') return null;
      result.set(id, new Map(decision.steps.map(row => [row.key, row.staff_intervals])));
    }
    return result;
  }
  function finish() {
    if (!clinicFitsAssignments(selected)) return false;
    const candidatePlans = buildStaffPlans(selected);
    if (!candidatePlans) return false;
    plans.clear();
    for (const [id, plan] of candidatePlans) plans.set(id, plan);
    const warnings = pending.length ? [{ code: 'PENDING_ATTENTION_REQUIREMENTS',
      message: 'La preparación calculada no acredita toda la atención clínica; hay intervenciones pendientes de definir.', requirements: pending }] : [];
    for (const assignment of selected) {
      const staff = assignment.phase.professionals;
      if (staff.mode !== 'any' || !staff.preferred_id || assignment.doctorIds[0] === staff.preferred_id) continue;
      const feasibleAlternatives = staff.ids.filter(id => {
        const alternative = { ...assignment, doctorIds: [id] }, room = assignmentRoom(assignment.installationId, alternative);
        const assignments = selected.map(row => row === assignment ? alternative : row);
        return room && installationAllowsStaff(room, [id]) && clinicFitsAssignments(assignments) && buildStaffPlans(assignments);
      });
      warnings.push({ code: 'NON_PREFERRED_PROFESSIONAL', phase_key: assignment.phase.key, doctor_id: assignment.doctorIds[0],
        preferred_doctor_id: staff.preferred_id, preferred_available: feasibleAlternatives.includes(staff.preferred_id),
        only_available_alternative: feasibleAlternatives.length === 1, fallback_when: staff.fallback_when,
        fallback_reason: staff.fallback_when === 'absence_only' ? 'absence' : 'unavailable' });
    }
    for (const assignment of selected) {
      const { phase, timing, installationId, doctorIds } = assignment;
      const id = flexibleDoctor(phase, doctorIds);
      if (!id) continue;
      const room = roomResource(installationId), original = doctors.get(id), reasons = [];
      if (clinicWindows && !isFree({ windows: clinicWindows }, timing.start, timing.end)) reasons.push('clinic_schedule');
      if (!isFree({ windows: room.windows || [] }, timing.start, timing.end)) reasons.push('installation_schedule');
      if (!installationAllowsStaff(room, [id])) reasons.push('room_staff_incompatible');
      if (plans.get(id).get(phase.key).some(interval => !isFree({ windows: original.windows || [] },
        new Date(interval.start_at), new Date(interval.end_at)))) reasons.push('staff_schedule');
      if (reasons.length) warnings.push({ code: 'FLEXIBLE_AGENDA', phase_key: phase.key, doctor_id: id, reasons,
        message: 'Esta fase requiere confirmar una excepción de horario o de profesional permitido en la sala. Las reservas, ausencias, intervenciones y máquinas siguen protegidas.' });
      const appointmentIds = legacyAttentionConfirmationIds(original, { start: timing.start, end: timing.end,
        allowLegacyAttentionConfirmation: true });
      if (appointmentIds.length) warnings.push({ code: 'FLEXIBLE_AGENDA', phase_key: phase.key, doctor_id: id,
        reasons: ['legacy_attention_origin'], appointment_ids: [...new Set(appointmentIds)].sort((a, b) => a - b),
        message: 'Esta cita coincide con una reserva importada que conserva la configuración anterior. Los minutos de atención necesarios sí caben sin solaparse. Confirma la excepción para reservar; no se mueve ninguna cita ni se libera tiempo ya ocupado.' });
    }
    const phases = selected.map(({ phase, timing, installationId, doctorIds, units, policies }) => ({
      key: phase.key, label: phase.label, start_at: timing.start.toISOString(), end_at: timing.end.toISOString(),
      start_offset_minutes: phase.start_offset_minutes, installation_id: installationId, installation_name: installations.get(installationId)?.name || '',
      doctor_ids: doctorIds, doctor_names: doctorIds.map(id => doctors.get(id)?.name || ''), staff_time_scope: 'phase',
      ...(phase.professionals.mode === 'any' ? { staff_intervals: plans.get(doctorIds[0]).get(phase.key), staff_attention: policies } : {}),
      ...(phase.attention_requirements_pending ? { attention_requirements_pending: phase.attention_requirements_pending } : {}),
      ...(phase.preparation_sharing ? { preparation_sharing: phase.preparation_sharing } : {}),
      ...(units.length ? { equipment: units.map(unit => ({ id: unit.id, name: unit.name, turnaround_minutes: unit.turnaround_minutes })) } : {}),
    }));
    const overlapAcknowledgement = allowOverlap && selected.some(({ phase, timing, installationId, doctorIds }) => ordinaryPhaseCanOverlap(phase)
      && (!isFree(roomResource(installationId), timing.start, timing.end)
        || doctorIds.some(id => !isFree(doctors.get(id), timing.start, timing.end))));
    solution = { start_at: appointmentStart.toISOString(), end_at: appointmentEnd.toISOString(), phases, warnings,
      capacity_fully_verified: !pending.length, attention_requirements_pending: pending,
      requires_priority_acknowledgement: warnings.some(warning => warning.code === 'NON_PREFERRED_PROFESSIONAL'),
      ...(allowOverlap ? { requires_overlap_acknowledgement: !!overlapAcknowledgement || warnings.some(row => row.code === 'FLEXIBLE_AGENDA') } : {}) };
    return true;
  }
  function visit(index) {
    if (index === profile.phases.length) return finish();
    const phase = profile.phases[index], timing = timings[index], selection = selections[phase.key] || {}, staff = phase.professionals;
    const preferredFirst = staff.mode === 'any' ? [staff.preferred_id, ...staff.ids.filter(id => id !== staff.preferred_id)].filter(Boolean) : [];
    const doctorChoices = staff.mode === 'all'
      ? ((selection.doctor_id == null || (staff.ids.length === 1 && Number(selection.doctor_id) === staff.ids[0])) ? [staff.ids] : [])
      : preferredFirst.filter(id => selection.doctor_id == null || Number(selection.doctor_id) === id).map(id => [id]);
    const roomIds = phase.installation_ids.filter(id => selection.installation_id == null || Number(selection.installation_id) === id);
    for (const doctorIds of doctorChoices) for (const installationId of roomIds) {
      if (++explored > 4096) return false;
      const room = assignmentRoom(installationId, { phase, timing, doctorIds }), ordinary = ordinaryPhaseCanOverlap(phase) && !phase.attention_requirements_pending?.length;
      if (!installationAllowsStaff(room, doctorIds) || !isFree(resourceForConfirmedOverlap(room, timing.start, timing.end, allowOverlap && ordinary), timing.start, timing.end)) continue;
      if (staff.mode === 'all' && doctorIds.some(id => !isFree(doctors.get(id), timing.start, timing.end))) continue;
      const units = [];
      function chooseEquipment(groupIndex) {
        const groups = phase.equipment_requirements || [];
        if (groupIndex === groups.length) {
          const policies = policiesFor(phase, units);
          const assignment = { phase, timing, installationId, doctorIds, units: [...units], policies };
          const beforeHolds = equipmentHolds.length;
          equipmentHolds.push(...units.map(unit => ({ id: unit.id, start: timing.start, end: timing.end,
            roomKey: room.resource_key || `installation:${installationId}`, turnaround: unit.turnaround_minutes })));
          selected.push(assignment);
          const fitted = partialStaffFits(selected) && visit(index + 1);
          selected.pop(); equipmentHolds.length = beforeHolds;
          return fitted;
        }
        if (!equipment) return false;
        for (const unitId of groups[groupIndex].equipment_ids) {
          if (++explored > 4096) return false;
          const unit = equipment.get(unitId);
          if (!unitFits(unit, installationId, timing, units)) continue;
          units.push(unit);
          if (chooseEquipment(groupIndex + 1)) return true;
          units.pop();
        }
        return false;
      }
      if (chooseEquipment(0)) return true;
    }
    return false;
  }
  return visit(0) ? solution : null;
}

function solveBookingProfile(options) {
  const strict = solveStrictBookingProfile(options);
  if (strict || !options.allowOverlap) return strict;
  const profile = normalizeBookingProfile(options.profile);
  // Relative phases never use the legacy global relaxation. A v4 exception
  // belongs only to its explicitly selected flexible clinician and phase.
  if (profile.version === 4) return solveVersion4BookingProfile({ ...options, profile, allowFlexibleAgenda: true });
  const relaxed = require('./flexible-agenda').flexibleProfileContext({ ...options, profile });
  if (!relaxed) return null;
  const solution = solveStrictBookingProfile({ ...options, ...relaxed });
  if (!solution) return null;
  const conflict = require('./booking-grid-diagnostics').explainUnavailableStart({
    profile, context: options, start: new Date(options.start), selections: options.selections,
  });
  solution.warnings.push({ code: 'FLEXIBLE_AGENDA', message: conflict?.details?.message
    || 'Hay un conflicto de agenda. Confirma que quieres reservar igualmente.' });
  solution.requires_overlap_acknowledgement = true;
  return solution;
}

function occupancyForSolution(solution, installationKeys = new Map()) {
  const rows = [];
  solution.phases.forEach((phase) => {
    rows.push({ phase_key: phase.key, resource_kind: 'installation', resource_key: installationKeys.get(phase.installation_id) || `installation:${phase.installation_id}`,
      installation_id: phase.installation_id, doctor_id: null, start_at: phase.start_at, end_at: phase.end_at });
    phase.doctor_ids.forEach((doctorId) => (phase.staff_intervals || [{
      start_at: phase.staff_time_scope === 'appointment' ? solution.start_at : phase.start_at,
      end_at: phase.staff_time_scope === 'appointment' ? solution.end_at : phase.end_at,
    }]).forEach(interval => rows.push({ phase_key: phase.key, resource_kind: 'doctor', resource_key: `doctor:${doctorId}`,
      doctor_id: doctorId, installation_id: null,
      start_at: interval.start_at, end_at: interval.end_at })));
    (phase.equipment || []).forEach(unit => rows.push({ phase_key: phase.key, resource_kind: 'equipment', resource_key: `equipment:${unit.id}`,
      installation_id: null, doctor_id: null, start_at: phase.start_at,
      end_at: new Date(new Date(phase.end_at).getTime() + unit.turnaround_minutes * 60000).toISOString() }));
  });
  // Retain phase references in the DTO; duplicate team rows need not occupy twice.
  return rows.filter((row, index) => rows.findIndex((candidate) => candidate.resource_key === row.resource_key
    && candidate.start_at === row.start_at && candidate.end_at === row.end_at) === index);
}

module.exports = { isFree, solveBookingProfile, occupancyForSolution };
