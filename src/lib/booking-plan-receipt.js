'use strict';

const { createHash } = require('node:crypto');
const { normalizeBookingProfile } = require('./booking-profile');
const { normalizeAttentionPolicy } = require('./booking-attention');

// An optimistic comparison of the complete plan the user saw. This grants no
// availability/overlap permission; the canonical solver still runs under locks.
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
// Copy permission-relevant facts, not descriptions, names or administrative
// notes. Unknown clinical codes stay pinned conservatively. LABEL is the
// explicitly informational label warning; it never authorizes a reservation.
function semanticWarnings(warnings) {
  return (warnings || []).filter(warning => warning?.code !== 'LABEL').map(warning => {
    const facts = { code: warning.code };
    for (const [key, value] of Object.entries(warning)) {
      if (['phase_key', 'preferred_available', 'only_available_alternative', 'fallback_when', 'fallback_reason'].includes(key)
        || /(?:^|_)ids?$/.test(key)) facts[key] = Array.isArray(value) ? [...value].sort() : value;
    }
    if (warning.reasons != null) facts.reasons = [...warning.reasons].sort();
    return facts;
  }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function planChanged() {
  return Object.assign(new Error('El hueco o sus recursos han cambiado. Busca y confirma de nuevo el plan completo.'),
    { code: 'booking_plan_changed', status: 409, statusCode: 409, details: { can_force: false } });
}
// The writer freezes effective (including inherited machine/default) attention
// into the profile. Hash that same semantic representation on BOTH sides;
// otherwise a valid SQL snapshot cannot reproduce its own preview receipt.
function effectiveProfile(profile, solution) {
  const normalized = normalizeBookingProfile(profile);
  if (!solution.phases.some(phase => phase.staff_attention != null)) return normalized;
  return normalizeBookingProfile({ ...normalized, version: normalized.version === 4 ? 4 : 3,
    phases: normalized.phases.map((phase, index) => {
      const resolved = solution.phases[index];
      if (!resolved || resolved.key !== phase.key) throw planChanged();
      if (resolved.staff_attention == null) return phase;
      if (!Array.isArray(resolved.staff_attention)) throw planChanged();
      const attention = resolved.staff_attention.map(normalizeAttentionPolicy);
      // An explicit operator rule is not permission to overwrite it with a
      // contradictory resolved policy. Legitimate inheritance only fills absent
      // rules, and the frozen copy must match its original effective policy.
      if (phase.staff_attention && canonical(phase.staff_attention) !== canonical(attention)) throw planChanged();
      return { ...phase, staff_attention: attention };
    }),
  });
}
function bookingPlanHash(profile, solution) {
  const normalized = effectiveProfile(profile, solution);
  const instant = value => new Date(value).toISOString();
  const policies = normalized.phases.map(({ label: _label, ...phase }) => phase);
  const phases = solution.phases.map(phase => ({ key: phase.key,
    start_at: instant(phase.start_at), end_at: instant(phase.end_at),
    installation_id: Number(phase.installation_id), doctor_ids: phase.doctor_ids.map(Number).sort((a, b) => a - b),
    staff_time_scope: phase.staff_time_scope,
    staff_intervals: (phase.staff_intervals || []).map(row => ({ kind: row.kind,
      start_at: instant(row.start_at), end_at: instant(row.end_at) })),
    staff_attention: phase.staff_attention?.map(normalizeAttentionPolicy) || null,
    equipment: (phase.equipment || []).map(row => ({ id: Number(row.id), turnaround_minutes: row.turnaround_minutes }))
      .sort((a, b) => a.id - b.id),
  }));
  return createHash('sha256').update(canonical({ schema: 'booking-plan/2', profile_version: normalized.version,
    policies, start_at: instant(solution.start_at), end_at: instant(solution.end_at), phases,
    capacity_fully_verified: solution.capacity_fully_verified ?? null,
    attention_requirements_pending: solution.attention_requirements_pending || [],
    requires_priority_acknowledgement: solution.requires_priority_acknowledgement === true,
    requires_overlap_acknowledgement: solution.requires_overlap_acknowledgement === true,
    warnings: semanticWarnings(solution.warnings),
  })).digest('hex');
}
function assertBookingPlanReceipt(expected, profile, solution) {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || expected !== bookingPlanHash(profile, solution)) {
    throw planChanged();
  }
}
module.exports = { bookingPlanHash, assertBookingPlanReceipt };
