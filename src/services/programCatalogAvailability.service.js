'use strict';

// A read-only, versioned projection of ONE catalog session. No voucher,
// enrollment, program snapshot supplied by the browser or calendar write is
// involved. The ordinary availability reader/solver checks the whole profile.
const { domainError, positiveInteger, boundedText } = require('../lib/treatmentPrograms.contract');
const { programBookingEnabled, composeAppointmentProfile, materializeSession } = require('../lib/program-booking');
const { assertOperationalBookingProfile, bookingCapabilities } = require('./treatmentBookingProfile.service');

function hasProgramPreviewQuery(query = {}) {
  return ['program_id', 'program_version', 'program_session_key'].some(key => Object.hasOwn(query, key));
}

function programPreviewReference(query = {}) {
  if (!hasProgramPreviewQuery(query)) return null;
  const fail = (message) => { throw domainError(400, 'program_preview_invalid', message); };
  if (['tratamiento_id', 'ignore_cita_id', 'duration_minutes', 'phase_durations', 'booking_profile', 'profile',
    'ignoreAppointmentIds', 'ignore_appointment_ids', 'selections', 'force'].some(key => query[key] != null)) {
    fail('La disponibilidad del programa utiliza su composición vigente; vuelve a seleccionar el programa.');
  }
  if ((typeof query.program_version !== 'number' && typeof query.program_version !== 'string')
    || !/^[1-9]\d*$/.test(String(query.program_version))) fail('Actualiza la versión del programa antes de consultar su disponibilidad.');
  const programId = boundedText(query.program_id, 'program_id', 36, true);
  const version = positiveInteger(query.program_version, 'program_version');
  const sessionKey = boundedText(query.program_session_key, 'program_session_key', 64);
  if (sessionKey && !/^[a-zA-Z0-9_-]+$/.test(sessionKey)) fail('Selecciona una sesión válida del programa.');
  return { programId, version, sessionKey };
}

function createProgramCatalogAvailabilityService({ programs, enabled = programBookingEnabled, capabilities = bookingCapabilities } = {}) {
  async function resolve({ clinicId, query }) {
    const reference = programPreviewReference(query);
    if (!reference) return null;
    clinicId = positiveInteger(clinicId, 'clinic_id');
    if (!enabled()) throw domainError(503, 'program_booking_disabled', 'La reserva de programas aún no está habilitada en este entorno.');
    const catalog = programs || require('./treatmentPrograms.service');
    const { item } = await catalog.get({ id: reference.programId, clinicId });
    if (!item || Number(item.clinic_id) !== clinicId || item.id !== reference.programId) {
      throw domainError(404, 'program_not_found', 'Programa o bono no encontrado en esta clínica.');
    }
    if (Number(item.version) !== reference.version) throw domainError(409, 'program_version_conflict', 'El catálogo ha cambiado. Vuelve a seleccionar el programa.');
    if (item.status !== 'active' || item.purchase_enabled !== true || item.commercial_ready !== true
      || !['program', 'voucher'].includes(item.kind) || item.summary?.issues?.length) {
      throw domainError(422, 'program_not_ready', 'Este programa o bono ya no está disponible para nuevas reservas. Revisa su configuración.');
    }
    const index = reference.sessionKey ? item.appointments.findIndex(row => row.key === reference.sessionKey) : 0;
    const appointment = item.appointments[index];
    if (!appointment) throw domainError(404, 'program_session_not_found', 'La sesión ya no pertenece al programa seleccionado.');
    const composed = composeAppointmentProfile(appointment, { allowMissingDuration: true });
    // Missing minutes require a deliberate choice in the native planner. The
    // generic slot granularity/duracion_min can never fill clinical durations.
    const session = materializeSession({ key: appointment.key, booking_profile: composed.profile });
    assertOperationalBookingProfile(session.booking_profile, { capabilities: capabilities() });
    return { profile: session.booking_profile, metadata: { program_id: item.id, program_version: Number(item.version),
      session_key: appointment.key, position: index + 1, label: appointment.label, duration_minutes: session.duration_minutes } };
  }
  return { resolve };
}

const defaultService = createProgramCatalogAvailabilityService();
module.exports = { hasProgramPreviewQuery, programPreviewReference, createProgramCatalogAvailabilityService,
  resolveProgramCatalogPreview: options => defaultService.resolve(options) };
