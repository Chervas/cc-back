'use strict';

const { bookingVisibility } = require('../lib/treatment-booking-visibility');
const { addDays } = require('../lib/personal-schedule-recurring');
const { formatDateLocal, resolveClinicTimezone } = require('../lib/availability-calendar');
const { loadScopedTreatment, requireOperationalProfile } = require('./treatmentBookingProfile.service');
const { searchTreatmentSlots } = require('./appointmentBookingAvailability.service');

const normalize = (value) =>
  String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, ' ')
    .trim();
const contains = (phrase, name) => !!name && (' ' + phrase + ' ').includes(' ' + name + ' ');

function bookingRequest(text) {
  const value = normalize(text);
  return (
    !/\b(?:no (?:quiero|necesito|puedo)|cancelar|anular|cambiar mi cita|ya tengo (?:una )?cita|no (?:me |nos )?(?:des|deis|desearia|agendes|reserv(?:es|eis))|no me reserves)\b/.test(
      value
    ) &&
    /\b(?:reservar|agendar|concertar|pedir (?:una )?cita|darme (?:una )?cita|(?:puedes|pueden|podeis) (?:darme|dar) (?:una )?cita|me (?:puedes|pueden|podeis) dar (?:una )?cita|(?:teneis|hay) (?:citas?|sitio)|me gustaria (?:una )?(?:cita|primera visita)|quiero (?:una )?cita|quisiera (?:una )?cita|me (?:das|dais) (?:una )?cita|huecos?|disponibilidad|horas? (?:libres?|disponibles?)|cuando (?:puedo ir|pueden atenderme|teneis cita))\b/.test(
      value
    )
  );
}

function selection(text, slots, selected) {
  const value = normalize(text);
  if (
    !value ||
    /\b(?:no|ni|quizas|tal vez|espera|luego|otro|otra|mejor|cancelar|cambiar|pero|aunque|si hay|si fuera)\b/.test(
      value
    )
  )
    return null;
  const ordinals = ['primera', 'segunda', 'tercera'];
  const ord =
    '(?:la |el )?(?:opcion |cita |hueco )?(1|2|3|primera?|primer|segunda?|segundo|tercera?|tercero)';
  const ending = '(?: por favor| gracias)?';
  const accepted = value.match(
    new RegExp(
      '^(?:si |vale )?(?:te )?(?:confirmo|reserva(?:me)?|agendame|me quedo con) ' + ord + ending + '$'
    )
  );
  const choice =
    accepted ||
    value.match(
      new RegExp(
        '^(?:si |vale )?(?:me (?:va|viene) bien |prefiero |quiero |elijo )?' +
          ord +
          '(?: me (?:va|viene) bien)?' +
          ending +
          '$'
      )
    );
  if (choice) {
    const word = choice[1];
    const index = /^[123]$/.test(word)
      ? Number(word) - 1
      : ordinals.findIndex((v) => v.slice(0, 3) === word.slice(0, 3));
    return slots[index] ? { index, confirmed: !!accepted } : null;
  }
  if (
    Number.isInteger(selected) &&
    slots[selected] &&
    /^(?:si|confirmo|confirmado|de acuerdo|si confirmo|si por favor|si gracias|si confirmo la cita)$/.test(
      value
    )
  ) {
    return { index: selected, confirmed: true };
  }
  // A clock time can identify an option but never grants consent on its own.
  const time = value.match(/^(?:la de |a las |a la |me va bien a las )?(\d{1,2}):(\d{2})$/);
  if (!time) return null;
  const matches = slots
    .map((s, i) => (s.local.slice(11, 16) === time[1].padStart(2, '0') + ':' + time[2] ? i : -1))
    .filter((i) => i >= 0);
  return matches.length === 1 ? { index: matches[0], confirmed: false } : null;
}

function requestedCalendar(text, timezone, now) {
  const raw = String(text || '');
  const value = normalize(raw);
  const today = formatDateLocal(now, timezone);
  const monthNames = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  const iso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const numeric = raw.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}|\d{2}))?\b/);
  const named = value.match(
    new RegExp('\\b(\\d{1,2}) (?:de )?(' + monthNames.join('|') + ')(?: (?:de )?(\\d{4}))?\\b')
  );
  const weekday = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'].findIndex(
    (day) => contains(value, day)
  );
  const currentYear = Number(today.slice(0, 4));
  let date = today,
    days = 7;
  if (iso || numeric || named) {
    if (iso) date = iso[1];
    else {
      const input = numeric || named;
      const month = numeric ? Number(input[2]) : monthNames.indexOf(input[2]) + 1;
      const suffix = '-' + String(month).padStart(2, '0') + '-' + input[1].padStart(2, '0');
      const year = input[3]
        ? (input[3].length === 2 ? 2000 : 0) + Number(input[3])
        : currentYear + (currentYear + suffix < today ? 1 : 0);
      date = year + suffix;
    }
    const parsed = new Date(date + 'T12:00:00Z');
    if (
      !Number.isFinite(+parsed) ||
      parsed.toISOString().slice(0, 10) !== date ||
      date < today ||
      (weekday >= 0 && parsed.getUTCDay() !== weekday)
    )
      return null;
    days = 1;
  } else if (contains(value, 'pasado manana')) {
    date = addDays(today, 2);
    days = 1;
  } else if (contains(value.replace(/(?:por la|de la|esta) manana/g, ''), 'manana')) {
    date = addDays(today, 1);
    days = 1;
  } else if (contains(value, 'hoy') || contains(value, 'esta tarde') || contains(value, 'esta manana'))
    days = 1;
  else if (weekday >= 0) {
    date = addDays(today, (7 + weekday - new Date(today + 'T12:00:00Z').getUTCDay()) % 7);
    days = 1;
  } else if (/\b(?:proxima semana|semana que viene)\b/.test(value)) {
    const current = new Date(today + 'T12:00:00Z').getUTCDay();
    date = addDays(today, current === 0 ? 1 : 8 - current);
  } else if (/\b(?:mes que viene|proximo mes|fin de semana|en \d+ dias|dia \d+)\b/.test(value)) return null;
  const period = value.match(/\b(?:por la|de la|esta) (manana|tarde)\b/);
  const time = value.match(/\b(a partir de|desde|antes de|hasta|a) (?:las? )?(\d{1,2})(?::(\d{2}))?\b/);
  let hourMinute = null;
  if (time) {
    let hour = Number(time[2]),
      minute = Number(time[3] || 0);
    if (hour > 23 || minute > 59) return null;
    if (period?.[1] === 'tarde' && hour < 12) hour += 12;
    hourMinute = {
      value: hour * 60 + minute,
      kind: time[1] === 'a' ? 'at' : ['antes de', 'hasta'].includes(time[1]) ? 'before' : 'after',
    };
  }
  return { date, days, period: period?.[1] || null, hourMinute };
}

function authorizedNames(booking) {
  return [
    ...new Set(
      String(booking || '')
        .split(/\r?\n/)
        .map((line) =>
          line
            .trim()
            .match(
              /^(?:[-*]\s*)?(?:(?:servicio|tratamiento) de agenda|servei d[’']agenda|calendar service)\s*:\s*(.{1,255})$/i
            )?.[1]
            ?.trim()
        )
        .filter(Boolean)
    ),
  ];
}

async function services(db, clinic, fields, offer) {
  const names = authorizedNames(fields.booking);
  const visibility = await db.Tratamiento.findAll({
    where: {
      activo: true,
      [db.Sequelize.Op.or]: [
        { clinica_id: clinic.id_clinica, origen: 'clinica' },
        { origen: 'sistema' },
        ...(clinic.grupoClinicaId ? [{ origen: 'grupo', grupo_clinica_id: clinic.grupoClinicaId }] : []),
      ],
    },
    attributes: ['id_tratamiento', 'nombre', 'codigo', 'eliminado_por_clinica'],
    raw: true,
  });
  const source = normalize([fields.booking, offer?.title, offer?.description].filter(Boolean).join(' '));
  const exact = names.map(normalize);
  return visibility
    .filter(
      (row) =>
        !Array.isArray(row.eliminado_por_clinica) ||
        !row.eliminado_por_clinica.map(Number).includes(Number(clinic.id_clinica))
    )
    .filter((row) =>
      [row.nombre, row.codigo]
        .filter(Boolean)
        .map(normalize)
        .some((alias) =>
          exact.length ? exact.includes(alias) : alias.length >= 3 && contains(source, alias)
        )
    )
    .map((row) => ({ id: row.id_tratamiento, name: row.nombre, code: row.codigo || null }));
}

function pickTreatment(choices, text, offer, previous) {
  const matching = (source) =>
    choices.filter((c) =>
      [c.name, c.code].filter(Boolean).some((n) => contains(normalize(source), normalize(n)))
    );
  for (const value of [text, [offer?.title, offer?.description].filter(Boolean).join(' ')]) {
    const matches = matching(value);
    if (matches.length) return matches.length === 1 ? matches[0] : null;
  }
  return choices.find((c) => c.id === previous) || (choices.length === 1 ? choices[0] : null);
}

function display(slot, timezone) {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(slot.start));
}

async function available({
  db,
  clinic,
  treatment,
  calendar,
  patientId,
  professionalId,
  now = new Date(),
  capabilities,
}) {
  const current = await loadScopedTreatment({ db, treatmentId: treatment.id, clinic });
  // A continuation-only catalogue entry needs clinical proof. The assistant only books first-contact services.
  if (bookingVisibility(current) || !current.activo) return [];
  requireOperationalProfile(current, { capabilities });
  const result = await searchTreatmentSlots({
    db,
    clinic,
    treatmentId: treatment.id,
    patientId: patientId || null,
    startingDoctorId: professionalId || null,
    date: calendar.date,
    days: calendar.days,
    stepMinutes: 15,
    limit: 500,
    now,
    capabilities,
  });
  const seen = new Set(),
    candidates = [];
  for (const slot of result.slots) {
    const hour = Number(slot.start_local.slice(11, 13));
    const minutes = hour * 60 + Number(slot.start_local.slice(14, 16));
    const time = calendar.hourMinute;
    if (
      time &&
      ((time.kind === 'at' && minutes !== time.value) ||
        (time.kind === 'after' && minutes < time.value) ||
        (time.kind === 'before' && minutes >= time.value))
    )
      continue;
    if (
      slot.requires_priority_acknowledgement ||
      slot.requires_overlap_acknowledgement ||
      slot.requires_restriction_acknowledgement ||
      slot.capacity_fully_verified === false ||
      seen.has(slot.start_at) ||
      (calendar.period === 'manana' && hour >= 14) ||
      (calendar.period === 'tarde' && hour < 14)
    )
      continue;
    seen.add(slot.start_at);
    candidates.push({
      start: slot.start_at,
      end: slot.end_at,
      local: slot.start_local,
      doctorId: slot.doctor_id,
      roomId: slot.installation_id,
      receipt: slot.booking_plan_sha256,
      selections: Object.fromEntries(
        slot.phases.map((p) => [p.key, { doctor_id: p.doctor_ids[0], installation_id: p.installation_id }])
      ),
    });
    if (candidates.length === 3) break;
  }
  return candidates;
}

module.exports = {
  normalize,
  bookingRequest,
  selection,
  requestedCalendar,
  services,
  pickTreatment,
  display,
  available,
  resolveClinicTimezone,
};
