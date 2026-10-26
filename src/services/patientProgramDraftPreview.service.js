'use strict';

// A draft is not an appointment, occupancy, entitlement or server reservation.
// Only this scoped purchased plan supplies identities, durations and resources.
const { domainError } = require('../lib/treatmentPrograms.contract');
const { bookingRequest, materializeSession, seriesIssues, schedulingMode } = require('../lib/program-booking');
const { civilLocal, civilMinute, localInstant } = require('../lib/program-reschedule');
const { addDays } = require('../lib/personal-schedule-recurring');
const { cloneProgramContext } = require('../lib/program-schedule-confirmation');
const { normalizePreferences, allowedInterval, preferredStart, timeWarning } = require('../lib/program-booking-preferences');
const { resumeInput, assertRevision, resumeSessions } = require('../lib/program-replan');
const fail = (message, code = 'program_draft_invalid', status = 400) => { throw domainError(status, code, message); };
const actions = ['initial', 'cascade', 'reset', 'previous_time', 'next_time', 'previous_day', 'next_day'];
function normalize(plan, payload, now) {
  const value = payload.draft_strategy;
  const resume = resumeInput(payload);
  if (resume) assertRevision(plan, resume.expected_plan_revision);
  const eligible = resume ? resumeSessions(plan, resume.replan_from_key, now)
    : plan.sessions.filter(row => row.scheduling_status === 'pending');
  if (!value || typeof value !== 'object' || Array.isArray(value) || !actions.includes(value.action)
    || Object.keys(value).some(key => !['action', 'pivot_key', 'start_local', 'sessions', 'preferences'].includes(key))
    || ['fixed_sessions', 'manual_sessions', 'session_keys', 'direction', 'reschedule_scope', 'reschedule_start_local', 'booking_preferences'].some(key => payload[key] != null)
    || !/^\d{4}-\d{2}-\d{2}$/.test(payload.from_date || '') || !Number.isInteger(payload.days ?? 90) || (payload.days ?? 90) < 1 || (payload.days ?? 90) > 180) {
    fail('Actualiza el borrador y revisa las sesiones que quieres proponer.');
  }
  const today = civilLocal(now, plan.timeZone).slice(0, 10);
  if (value.action === 'initial') {
    // This is a day-based search, not an appointment placement. Today remains
    // valid after the old client's hidden default hour has already passed.
    const date = new Date(payload.from_date + 'T12:00:00Z');
    if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== payload.from_date
      || payload.from_date < today
      || localInstant(payload.from_date + 'T00:00', plan.timeZone) - now > 366 * 86400000) {
      fail('Elige hoy o una fecha dentro del próximo año.');
    }
  }
  const sessions = eligible.slice(0, 30);
  const supplied = value.sessions || [];
  if (!Array.isArray(supplied) || supplied.length > 30 || new Set(supplied.map(row => row?.key)).size !== supplied.length
    || supplied.some(row => !row || !sessions.some(session => session.key === row.key)
      || Object.keys(row).some(key => !['key', 'start_at', 'selections', 'placed', 'duration_minutes', 'phase_durations', 'priority_acknowledged'].includes(key))
      || typeof row.placed !== 'boolean') || value.action !== 'initial' && supplied.length !== sessions.length) {
    fail('El borrador debe contener sólo las sesiones pendientes de esta ventana, sin reservas ya guardadas.');
  }
  const rows = sessions.map(session => {
    const input = supplied.find(row => row.key === session.key) || { key: session.key, placed: false };
    if (input.selections != null && (typeof input.selections !== 'object' || Array.isArray(input.selections)
      || Object.keys(input.selections).length > 12) || input.priority_acknowledged != null && typeof input.priority_acknowledged !== 'boolean') {
      fail('Selecciona cabina y profesional válidos.', 'program_booking_selection_invalid');
    }
    for (const [key, selection] of Object.entries(input.selections || {})) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || !selection || typeof selection !== 'object' || Array.isArray(selection)
        || Object.keys(selection).some(field => !['doctor_id', 'installation_id'].includes(field))
        || Object.values(selection).some(id => !Number.isSafeInteger(id) || id < 1)) {
        fail('Selecciona cabina y profesional válidos.', 'program_booking_selection_invalid');
      }
    }
    let choice = { key: session.key, selections: input.selections || {}, priority_acknowledged: input.priority_acknowledged === true };
    if (input.start_at != null) {
      choice = bookingRequest({ request_key: 'program-draft-preview', snapshot_sha256: plan.snapshot.sha256, sessions: [input] }).sessions[0];
      const start = new Date(choice.start_at);
      if (start <= now || start - now > 366 * 86400000) fail('Las fechas provisionales deben ser futuras y estar dentro del próximo año.');
      localInstant(civilLocal(start, plan.timeZone), plan.timeZone);
    } else if (input.placed) fail('Una sesión colocada debe tener una fecha provisional.');
    for (const [key, selection] of Object.entries(choice.selections)) {
      const phase = session.booking_profile.phases.find(row => row.key === key);
      if (!phase || selection.installation_id != null && !phase.installation_ids.includes(selection.installation_id)
        || selection.doctor_id != null && (phase.professionals.mode !== 'any' || !phase.professionals.ids.includes(selection.doctor_id))) {
        fail('La sala o el profesional no pertenece a esta sesión.', 'program_selection_invalid');
      }
    }
    let resolved = session;
    try { resolved = materializeSession(session, input); }
    catch (error) { if (error.code !== 'program_duration_required' || input.placed) throw error; }
    return { ...resolved, choice, placed: input.placed, original_start_at: choice.start_at || null };
  });
  const pivot = rows.find(row => row.key === value.pivot_key);
  if (!['initial', 'reset'].includes(value.action) && (!pivot || value.action !== 'cascade' && !pivot.original_start_at
    || value.action === 'cascade' && !value.start_local)) fail('Selecciona la propuesta de origen y su nueva fecha.');
  if (value.action === 'cascade' && !pivot.original_start_at && rows.some(row => row.position > pivot.position && row.original_start_at)) {
    fail('La sesión de origen todavía no tiene fecha. Colócala antes de desplazar fechas posteriores.', 'program_draft_origin_date_required');
  }
  if (pivot && pivot.duration_minutes == null) fail('Elige la duración de la sesión antes de cambiar su fecha.', 'program_duration_required');
  let startLocal = value.start_local;
  if (['cascade','initial'].includes(value.action) && value.start_local != null) {
    const instant = localInstant(value.start_local, plan.timeZone);
    if (value.action==='initial' && value.start_local.slice(0,10)!==payload.from_date) fail('La hora inicial debe pertenecer a la fecha elegida.');
    if (value.action === 'initial' && payload.from_date === today && instant <= now) startLocal = undefined;
    else if (instant <= now || instant - now > 366 * 86400000) fail('Elige una fecha futura dentro del próximo año.');
  } else if (value.start_local != null) fail('La nueva fecha sólo corresponde a un cambio explícito del borrador.');
  return { action: value.action, pivot, rows, start_local: startLocal, days: payload.days ?? 90, from_date: payload.from_date,
    preferences: normalizePreferences(value.preferences), resume, eligible_count: eligible.length };
}
function shiftedLocal(previous, next, original, timeZone) {
  const delta = civilMinute(localInstant(next, timeZone), timeZone) - civilMinute(previous, timeZone);
  return new Date((civilMinute(original, timeZone) + delta) * 60000).toISOString().slice(0, 16);
}

async function preview({ plan, payload, actorId, now, contextFor, dto, solve, slots, addVirtualBusy, supportIds, supportAvailable, assessment }) {
  const draft = normalize(plan, payload, now), { rows, pivot } = draft;
  const projectionOptions = { resumeFromKey: draft.resume?.replan_from_key || null };
  // Only reservations in the canonical affected suffix may be ignored while
  // searching their replacement. Prefix and unrelated occupancies stay fixed.
  const ignored = draft.resume ? rows.filter(row => row.scheduling_status === 'reserved')
    .map(row => Number(row.appointment.id_cita)) : [];
  if (!rows.length) return { ...dto(plan, projectionOptions), proposals: [], unproposed_count: 0,
    draft_strategy: { action: draft.action, applied: true, affected_keys: [], placed_keys: [] } };
  const from = localInstant(draft.from_date + 'T00:00', plan.timeZone);
  const starts = rows.filter(row => row.original_start_at).map(row => new Date(row.original_start_at).getTime());
  if (draft.start_local) starts.push(+localInstant(draft.start_local, plan.timeZone));
  const lower = new Date(Math.max(+now, Math.min(+from, ...starts) - draft.days * 86400000));
  const upper = new Date(Math.min(+now + 366 * 86400000, Math.max(+from, ...starts) + (draft.days + 1) * 86400000));
  const operational = rows.filter(row => row.duration_minutes != null);
  const base = operational.length ? await contextFor(plan, operational, lower, upper, null, false, ignored) : null;
  const originPosition = pivot?.position ?? rows[0].position;
  const affected = draft.action === 'reset' ? rows.filter(row => !row.placed) : draft.action === 'initial' ? rows : rows.filter(row => row.position >= originPosition);
  const withinYear = instant => new Date(instant) > now && new Date(instant) < new Date(+now + 366 * 86400000);
  function run(newPivotLocal = null, unchanged = false) {
    const context = base ? cloneProgramContext(base) : null, solutions = new Map(), restrictions = new Map(), requested = new Map(), warnings = new Map(), hardExcluded = new Set(), preferredDoctors = new Map();
    // Existing effective assignments are soft continuity references, never a
    // new resource authorization. A phase's frozen profile still decides.
    if (draft.preferences?.keep_professional) for (const row of plan.sessions.filter(item=>['reserved','completed'].includes(item.scheduling_status)).sort((a,b)=>a.position-b.position)) {
      let metadata=row.appointment?.import_metadata;
      if (typeof metadata==='string') { try { metadata=JSON.parse(metadata); } catch { metadata=null; } }
      for (const phase of metadata?.booking?.phases || []) if (!preferredDoctors.has(phase.key) && Array.isArray(phase.doctor_ids)) preferredDoctors.set(phase.key,phase.doctor_ids);
    }
    const dates = new Map(plan.sessions.filter(row => row.start_at && !rows.some(item => item.key === row.key)).map(row => [row.key, row]));
    function validSeries(row, solution) {
      const candidate = { ...row, start_at: solution.start_at, end_at: solution.end_at };
      return !seriesIssues(plan.sessions.map(item => item.key === row.key ? candidate : dates.get(item.key)
        || (rows.some(pending => pending.key === item.key) ? { ...item, start_at: null, end_at: null } : item)), plan.snapshot.cadence, plan.timeZone).length;
    }
    function accept(row, solution) {
      if (!solution || !withinYear(solution.start_at) || !allowedInterval(draft.preferences, solution.start_at, solution.end_at, plan.timeZone)
        || !supportAvailable(context, solution, supportIds(row)) || !validSeries(row, solution)
        || context.patientBusy.some(busy => +new Date(busy.start) < +new Date(solution.end_at) && +new Date(busy.end) > +new Date(solution.start_at))) return false;
      const messages=timeWarning(draft.preferences,solution,plan.timeZone);
      if (draft.preferences?.keep_professional) for (const phase of solution.phases) {
        const before=preferredDoctors.get(phase.key), after=phase.doctor_ids.slice().sort((a,b)=>a-b);
        if (before && JSON.stringify(before.slice().sort((a,b)=>a-b))!==JSON.stringify(after)
          && !messages.some(message=>message.code==='program_preference_professional_fallback')) messages.push({code:'program_preference_professional_fallback',message:'No se ha podido mantener el mismo profesional en esta sesión.'});
        if (!before) preferredDoctors.set(phase.key,after);
      }
      if (messages.length) warnings.set(row.key,messages);
      solutions.set(row.key, { ...solution, start_local: civilLocal(solution.start_at, plan.timeZone), end_local: civilLocal(solution.end_at, plan.timeZone) });
      dates.set(row.key, { ...row, start_at: solution.start_at, end_at: solution.end_at });
      addVirtualBusy(context, solution, supportIds(row), row.booking_profile); return true;
    }
    function preferredSelections(row) {
      const selections=structuredClone(row.choice.selections);
      if (draft.preferences?.keep_professional) for (const phase of row.booking_profile.phases) {
        const prior=preferredDoctors.get(phase.key);
        if (phase.professionals.mode==='any' && prior?.length===1 && phase.professionals.ids.includes(prior[0]) && selections[phase.key]?.doctor_id==null)
          selections[phase.key]={...(selections[phase.key] || {}),doctor_id:prior[0]};
      }
      return selections;
    }
    function preservesPriority(solution,row) {
      return solution && !(solution.warnings || []).some(warning=>warning.code==='NON_PREFERRED_PROFESSIONAL' && warning.preferred_available
        && row.choice.selections[warning.phase_key]?.doctor_id==null);
    }
    function candidates(row,day,calendar=context) {
      if (draft.preferences?.exclude_weekdays?.includes(new Date(day+'T12:00:00Z').getUTCDay())) return [];
      const preferred=preferredSelections(row), choices=JSON.stringify(preferred)===JSON.stringify(row.choice.selections) ? [preferred] : [preferred,row.choice.selections];
      const ranked=choices.flatMap((selections,rank)=>slots({profile:row.booking_profile,context:calendar,date:day,days:1,stepMinutes:15,limit:96,now,selections})
        .filter(solution=>allowedInterval(draft.preferences,solution.start_at,solution.end_at,plan.timeZone)
          && (rank || choices.length===1 || preservesPriority(solution,row))).map(solution=>({solution,rank})));
      ranked.sort((a,b)=> Number(!preferredStart(draft.preferences,a.solution.start_at,plan.timeZone))
        -Number(!preferredStart(draft.preferences,b.solution.start_at,plan.timeZone))
        || a.rank-b.rank || +new Date(a.solution.start_at)-+new Date(b.solution.start_at));
      return ranked.map(row=>row.solution);
    }
    const exact = (row, local, allowException = true) => {
      requested.set(row.key, local);
      if (!context || row.duration_minutes == null) return false;
      let instant;
      try { instant = localInstant(local, plan.timeZone); } catch { return false; }
      if (!allowedInterval(draft.preferences,instant,new Date(+instant+row.duration_minutes*60000),plan.timeZone)) { hardExcluded.add(row.key); return false; }
      const preferred=preferredSelections(row), primary=solve({ profile: row.booking_profile, ...context, start: instant, selections: preferred });
      let solution = (JSON.stringify(preferred)===JSON.stringify(row.choice.selections) || preservesPriority(primary,row) ? primary : null)
        || solve({ profile: row.booking_profile, ...context, start: instant, selections: row.choice.selections });
      if (!solution && allowException) {
        const exception = assessment(plan, { ...row, choice: row.choice, start_at: instant.toISOString(),
          end_at: new Date(+instant + row.duration_minutes * 60000).toISOString() }, context, actorId);
        if (exception) { solution = exception.solution; restrictions.set(row.key, exception.restrictions); }
      }
      return accept(row, solution);
    };
    // Retained provisional placements constrain all searches, including rows
    // earlier than a later placed one. They are never ignored as occupancies.
    const fixed = rows.filter(row => unchanged || draft.action === 'reset' && row.placed
      || !['initial', 'reset'].includes(draft.action) && row.position < originPosition);
    for (const row of fixed) if (row.original_start_at) exact(row, civilLocal(row.original_start_at, plan.timeZone));
    for (const row of rows) {
      if (fixed.includes(row)) continue;
      if (unchanged) continue;
      if (newPivotLocal && row.original_start_at) {
        exact(row, row.key === pivot.key ? newPivotLocal : shiftedLocal(pivot.original_start_at, newPivotLocal, row.original_start_at, plan.timeZone));
        continue;
      }
      if (newPivotLocal && row.key === pivot.key) { exact(row, newPivotLocal); continue; }
      if (!context || row.duration_minutes == null || schedulingMode(plan.snapshot) === 'manual') continue;
      const anchors = plan.sessions.filter(item => item.position < row.position && dates.has(item.key)).sort((a,b) => b.position-a.position);
      const anchor = anchors[0], anchorDate = anchor ? dates.get(anchor.key).start_at : null;
      const gap = anchor && row.offset_days != null && anchor.offset_days != null ? row.offset_days - anchor.offset_days : anchor && plan.snapshot.cadence ? plan.snapshot.cadence.min_days_between : 0;
      if (anchor && !plan.snapshot.cadence && (row.offset_days == null || anchor.offset_days == null)) continue;
      let day = anchorDate ? addDays(civilLocal(anchorDate, plan.timeZone).slice(0,10), gap) : draft.from_date;
      if (day < civilLocal(now, plan.timeZone).slice(0,10)) day = civilLocal(now, plan.timeZone).slice(0,10);
      for (let offset = 0; offset < draft.days && !solutions.has(row.key); offset++) {
        for (const solution of candidates(row,addDays(day,offset))) {
          if (draft.action==='initial' && row===rows[0] && draft.start_local && civilLocal(solution.start_at,plan.timeZone)<draft.start_local) continue;
          if (accept(row, solution)) break;
        }
      }
    }
    const proposals = rows.map(row => ({ key: row.key, label: row.label, solution: solutions.get(row.key) || null, placed: row.placed && solutions.has(row.key),
      selections: row.choice.selections, priority_acknowledged: row.choice.priority_acknowledged,
      ...(row.duration_selection || {}), ...(requested.has(row.key) ? { requested_start_local: requested.get(row.key) } : {}),
      duration_required: row.duration_minutes == null,
      reason_code: solutions.has(row.key) ? null : hardExcluded.has(row.key) ? 'program_booking_preference_conflict' : row.duration_minutes == null ? 'program_duration_required' : 'program_booking_unavailable',
      reason: solutions.has(row.key) ? null : hardExcluded.has(row.key) ? 'La fecha coincide con un día excluido por el paciente.' : row.duration_minutes == null ? 'Elige la duración antes de proponer esta sesión.' : 'No hay un hueco disponible que respete la pauta y los recursos.',
      ...(warnings.has(row.key) ? {preference_warnings:warnings.get(row.key)} : {}),
      ...(solutions.has(row.key) && restrictions.has(row.key) ? { requires_schedule_confirmation: true, schedule_restrictions: restrictions.get(row.key) } : {}) }));
    return { proposals, candidates, allAffectedAvailable: [...affected, ...fixed.filter(row => row.original_start_at)].every(row => solutions.has(row.key)) };
  }
  let result, applied = true;
  if (draft.action === 'cascade') result = run(draft.start_local);
  else if (['previous_time','next_time','previous_day','next_day'].includes(draft.action)) {
    const local = civilLocal(pivot.original_start_at, plan.timeZone), date = local.slice(0,10), previous = draft.action.startsWith('previous');
    const sameDay = draft.action.endsWith('time');
    const directionContext=run(null,true);
    for (let dayOffset = sameDay ? 0 : 1; dayOffset < (sameDay ? 1 : draft.days + 1) && !result; dayOffset++) {
      const day = addDays(date, dayOffset * (previous ? -1 : 1));
      if (day < civilLocal(now, plan.timeZone).slice(0,10)) break;
      const candidates = directionContext.candidates(pivot,day,base).filter(slot => !sameDay || (previous ? +new Date(slot.start_at) < +new Date(pivot.original_start_at) : +new Date(slot.start_at) > +new Date(pivot.original_start_at)));
      candidates.sort((a,b) => Number(!preferredStart(draft.preferences,a.start_at,plan.timeZone))
        -Number(!preferredStart(draft.preferences,b.start_at,plan.timeZone))
        || (sameDay ? (previous ? +new Date(b.start_at)-+new Date(a.start_at) : +new Date(a.start_at)-+new Date(b.start_at))
          : Math.abs(civilMinute(a.start_at,plan.timeZone)%1440-civilMinute(pivot.original_start_at,plan.timeZone)%1440)-Math.abs(civilMinute(b.start_at,plan.timeZone)%1440-civilMinute(pivot.original_start_at,plan.timeZone)%1440)));
      for (const candidate of candidates) { const trial = run(civilLocal(candidate.start_at, plan.timeZone)); if (trial.allAffectedAvailable) { result = trial; break; } }
    }
    if (!result) { applied = false; result = run(null, true); }
  } else result = run();
  return { ...dto(plan, projectionOptions), proposals: result.proposals, unproposed_count: draft.eligible_count - rows.length,
    draft_strategy: { action: draft.action, ...(pivot ? { pivot_key: pivot.key } : {}), applied, affected_keys: affected.map(row=>row.key), placed_keys: result.proposals.filter(row=>row.placed).map(row=>row.key),
      ...(draft.preferences ? {preferences:draft.preferences} : {}),
      ...(!applied ? { reason_code: 'program_draft_no_candidate' } : {}) } };
}
module.exports = { normalize, shiftedLocal, preview };
