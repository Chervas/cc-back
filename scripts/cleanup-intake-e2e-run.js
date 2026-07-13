'use strict';

const path = require('node:path');

/**
 * Verify and remove one explicitly marked intake E2E run.
 *
 * Safety model:
 * - dry-run is the default;
 * - every lead id and browser session id is explicit;
 * - every lead must carry the same CC-E2E-* marker and belong to the requested group;
 * - QuickChat conversations must contain only the hidden synthetic summary;
 * - appointments must be explicit, unlinked from a patient and carry the marker;
 * - in-flight Google uploads abort cleanup;
 * - successful/external Google attempts require a separate acknowledgement because
 *   deleting the local audit row does not retract a conversion from Google.
 *
 * Example:
 *   node scripts/cleanup-intake-e2e-run.js \
 *     --group-id=5 \
 *     --marker=CC-E2E-20260713-073000 \
 *     --lead-ids=7201,7202 \
 *     --session-ids=cc_session_one,cc_session_two
 *
 * Add --simulate to execute every DELETE and post-check inside a rolled-back
 * transaction. Add --apply only after the dry-run and simulation are clean.
 */

const DEFAULT_DOMAIN = 'www.propdental.es';
const MAX_LEADS = 10;
const MAX_SESSIONS = 12;
const MAX_APPOINTMENTS = 10;

function parseCli(argv) {
  const values = new Map();
  const flags = new Set();
  for (const raw of argv) {
    if (!raw.startsWith('--')) throw new Error(`Unknown positional argument: ${raw}`);
    const body = raw.slice(2);
    const separator = body.indexOf('=');
    if (separator === -1) {
      flags.add(body);
      continue;
    }
    const key = body.slice(0, separator);
    const value = body.slice(separator + 1);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }
  return { values, flags };
}

function singleArg(parsed, name, fallback = null) {
  const hits = parsed.values.get(name) || [];
  if (hits.length > 1) throw new Error(`--${name} may only be provided once`);
  return hits.length ? hits[0] : fallback;
}

function stringListArg(parsed, name) {
  return Array.from(new Set((parsed.values.get(name) || [])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean)));
}

function positiveInt(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== String(value).trim()) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function positiveIntList(parsed, name, { required = false, maximum = 10 } = {}) {
  const items = stringListArg(parsed, name).map((value) => positiveInt(value, `--${name}`));
  if (required && !items.length) throw new Error(`--${name} is required`);
  if (items.length > maximum) throw new Error(`--${name} accepts at most ${maximum} ids`);
  return Array.from(new Set(items));
}

function assertSyntheticMarker(marker) {
  const value = String(marker || '').trim();
  if (!/^CC-E2E-[A-Za-z0-9][A-Za-z0-9_-]{8,72}$/.test(value)) {
    throw new Error('--marker must be a unique CC-E2E-* value with at least 9 characters after the prefix');
  }
  return value;
}

function assertSessionId(value) {
  const sessionId = String(value || '').trim();
  if (sessionId.length < 12 || sessionId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(sessionId)) {
    throw new Error(`Unsafe browser session id: ${sessionId}`);
  }
  return sessionId;
}

function parseOptions(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  const allowedValueKeys = new Set([
    'group-id',
    'marker',
    'lead-ids',
    'appointment-ids',
    'session-ids',
    'max-age-hours',
    'max-web-events',
    'domain',
  ]);
  for (const key of parsed.values.keys()) {
    if (!allowedValueKeys.has(key)) throw new Error(`Unknown option: --${key}`);
  }
  const allowedFlags = new Set([
    'apply',
    'simulate',
    'acknowledge-external-conversions-not-retracted',
  ]);
  for (const flag of parsed.flags) {
    if (!allowedFlags.has(flag)) throw new Error(`Unknown flag: --${flag}`);
  }

  const apply = parsed.flags.has('apply');
  const simulate = parsed.flags.has('simulate');
  if (apply && simulate) throw new Error('Use either --apply or --simulate, never both');

  const groupId = positiveInt(singleArg(parsed, 'group-id'), '--group-id');
  const marker = assertSyntheticMarker(singleArg(parsed, 'marker'));
  const leadIds = positiveIntList(parsed, 'lead-ids', { required: true, maximum: MAX_LEADS });
  const appointmentIds = positiveIntList(parsed, 'appointment-ids', { maximum: MAX_APPOINTMENTS });
  const sessionIds = stringListArg(parsed, 'session-ids').map(assertSessionId);
  if (!sessionIds.length) throw new Error('--session-ids is required');
  if (sessionIds.length > MAX_SESSIONS) throw new Error(`--session-ids accepts at most ${MAX_SESSIONS} ids`);

  const maxAgeHours = Number(singleArg(parsed, 'max-age-hours', '72'));
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 168) {
    throw new Error('--max-age-hours must be between 1 and 168');
  }

  const maxWebEvents = positiveInt(singleArg(parsed, 'max-web-events', '250'), '--max-web-events');
  if (maxWebEvents > 2000) throw new Error('--max-web-events cannot exceed 2000');

  const domain = String(singleArg(parsed, 'domain', DEFAULT_DOMAIN)).trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error('--domain is invalid');

  return {
    mode: simulate ? 'simulate' : (apply ? 'apply' : 'dry-run'),
    groupId,
    marker,
    leadIds,
    appointmentIds,
    sessionIds,
    maxAgeHours,
    maxWebEvents,
    domain,
    acknowledgeExternalConversions: parsed.flags.has('acknowledge-external-conversions-not-retracted'),
  };
}

function markerMatchesLead(lead, marker) {
  const needle = String(marker).toLowerCase();
  return ['event_id', 'nombre', 'email', 'notas', 'source_detail', 'external_id']
    .some((field) => String(lead?.[field] || '').toLowerCase().includes(needle));
}

function markerMatchesAppointment(appointment, marker) {
  const needle = String(marker).toLowerCase();
  return ['titulo', 'nota', 'motivo']
    .some((field) => String(appointment?.[field] || '').toLowerCase().includes(needle));
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function isTrue(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function validateQuickChatMessage(message, conversationLeadId) {
  const metadata = parseJsonObject(message?.metadata);
  return String(message?.message_type) === 'event'
    && String(message?.direction) === 'inbound'
    && String(metadata.kind) === 'quickchat_summary'
    && String(metadata.source_detail) === 'chatbot_quickchat'
    && isTrue(metadata.hidden_from_patient)
    && Number(metadata.lead_intake_id) === Number(conversationLeadId);
}

function conversionEventIds(leads, appointments) {
  const ids = [];
  for (const lead of leads) {
    if (lead.event_id) ids.push(String(lead.event_id));
    ids.push(`lead-${lead.id}`);
    ids.push(`lead-${lead.id}-qualified`);
  }
  for (const appointment of appointments) {
    ids.push(`appointment-${appointment.id_cita}`);
    ids.push(`appointment-${appointment.id_cita}-treatment-completed`);
  }
  return Array.from(new Set(ids));
}

function dateMs(value, label) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${label}`);
  return ms;
}

function sameNumberSet(actual, expected) {
  const a = Array.from(new Set(actual.map(Number))).sort((x, y) => x - y);
  const b = Array.from(new Set(expected.map(Number))).sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function placeholders(rows, key = 'id') {
  return rows.map((row) => Number(row[key])).filter(Number.isInteger);
}

function loadDb() {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  const originalLog = console.log;
  console.log = () => {};
  const db = require('../models');
  console.log = originalLog;
  db.sequelize.options.logging = false;
  return db;
}

async function selectRows(db, sql, replacements, transaction = null) {
  return db.sequelize.query(sql, {
    replacements,
    transaction,
    type: db.Sequelize.QueryTypes.SELECT,
  });
}

async function loadState(db, options, transaction = null, lock = false) {
  const lockClause = lock ? ' FOR UPDATE' : '';
  const common = { leadIds: options.leadIds, groupId: options.groupId };

  const leads = await selectRows(db, `
    SELECT id, clinica_id, grupo_clinica_id, source, source_detail, event_id,
           clinic_match_source, clinic_match_value,
           nombre, email, notas, external_id, created_at, gclid, gbraid, wbraid,
           callback_reminder_job_id
      FROM LeadIntakes
     WHERE id IN (:leadIds)
     ORDER BY id${lockClause}
  `, common, transaction);

  const groupClinics = await selectRows(db, `
    SELECT id_clinica
      FROM Clinicas
     WHERE grupoClinicaId = :groupId
     ORDER BY id_clinica${lockClause}
  `, { groupId: options.groupId }, transaction);

  const appointments = await selectRows(db, `
    SELECT id_cita, clinica_id, paciente_id, lead_intake_id, titulo, nota, motivo,
           estado, created_at, updated_at
      FROM CitasPacientes
     WHERE lead_intake_id IN (:leadIds)
     ORDER BY id_cita${lockClause}
  `, common, transaction);

  const appointmentHolds = await selectRows(db, `
    SELECT id, lead_intake_id, clinica_id, motivo, created_at, updated_at
      FROM AppointmentHolds
     WHERE lead_intake_id IN (:leadIds)
     ORDER BY id${lockClause}
  `, common, transaction);

  const conversations = await selectRows(db, `
    SELECT id, clinic_id, patient_id, lead_id, channel, createdAt, updatedAt
      FROM Conversations
     WHERE lead_id IN (:leadIds)
     ORDER BY id${lockClause}
  `, common, transaction);
  const conversationIds = placeholders(conversations);

  const messages = conversationIds.length ? await selectRows(db, `
    SELECT id, conversation_id, direction, message_type, status, metadata, createdAt
      FROM Messages
     WHERE conversation_id IN (:conversationIds)
     ORDER BY conversation_id, id${lockClause}
  `, { conversationIds }, transaction) : [];

  const conversationReads = conversationIds.length ? await selectRows(db, `
    SELECT id, conversation_id
      FROM ConversationReads
     WHERE conversation_id IN (:conversationIds)
     ORDER BY id${lockClause}
  `, { conversationIds }, transaction) : [];

  const marketingConversationRefs = conversationIds.length ? await selectRows(db, `
    SELECT id, conversation_id
      FROM MarketingPatientListItems
     WHERE conversation_id IN (:conversationIds)
     ORDER BY id${lockClause}
  `, { conversationIds }, transaction) : [];

  const whatsappOriginRefs = conversationIds.length ? await selectRows(db, `
    SELECT id, used_conversation_id
      FROM WhatsAppWebOrigins
     WHERE used_conversation_id IN (:conversationIds)
     ORDER BY id${lockClause}
  `, { conversationIds }, transaction) : [];

  const formSubmissions = await selectRows(db, `
    SELECT id, clinic_id, group_id, lead_intake_id, form_id, submitted_at, created_at
      FROM FormSubmissionEvents
     WHERE lead_intake_id IN (:leadIds)
     ORDER BY id${lockClause}
  `, common, transaction);

  const webEvents = await selectRows(db, `
    SELECT id, clinic_id, group_id, event_name, event_id, session_id, domain,
           occurred_at, created_at
      FROM WebEvents
     WHERE session_id IN (:sessionIds)
     ORDER BY id${lockClause}
  `, { sessionIds: options.sessionIds }, transaction);

  const eventIds = conversionEventIds(leads, appointments);
  const conversionAttempts = eventIds.length ? await selectRows(db, `
    SELECT id, clinica_id, grupo_clinica_id, event_name, event_id, status,
           provider_request_id, attempted_at, completed_at
      FROM GoogleAdsConversionUploadAttempts
     WHERE event_id IN (:eventIds)
     ORDER BY id${lockClause}
  `, { eventIds }, transaction) : [];

  const attributionAudits = await selectRows(db, `
    SELECT id, lead_intake_id
      FROM LeadAttributionAudits
     WHERE lead_intake_id IN (:leadIds)
     ORDER BY id${lockClause}
  `, common, transaction);
  const contactAttempts = await selectRows(db, `
    SELECT id, lead_intake_id
      FROM LeadContactAttempts
     WHERE lead_intake_id IN (:leadIds)
     ORDER BY id${lockClause}
  `, common, transaction);
  const flowInstances = await selectRows(db, `
    SELECT id, lead_id
      FROM LeadFlowInstances
     WHERE lead_id IN (:leadIds)
     ORDER BY id${lockClause}
  `, common, transaction);

  return {
    leads,
    groupClinics,
    appointments,
    appointmentHolds,
    conversations,
    messages,
    conversationReads,
    marketingConversationRefs,
    whatsappOriginRefs,
    formSubmissions,
    webEvents,
    conversionAttempts,
    attributionAudits,
    contactAttempts,
    flowInstances,
    eventIds,
  };
}

function validateState(state, options, now = new Date()) {
  if (!sameNumberSet(state.leads.map((row) => row.id), options.leadIds)) {
    throw new Error('The requested lead ids do not resolve to exactly the expected rows');
  }

  const nowMs = dateMs(now, 'current time');
  const cutoffMs = nowMs - options.maxAgeHours * 60 * 60 * 1000;
  const clinicIds = new Set(state.groupClinics.map((row) => Number(row.id_clinica)));
  if (!clinicIds.size) throw new Error(`Group ${options.groupId} has no clinics`);

  const leadsById = new Map();
  for (const lead of state.leads) {
    if (Number(lead.grupo_clinica_id) !== options.groupId) {
      throw new Error(`Lead ${lead.id} is outside group ${options.groupId}`);
    }
    if (!clinicIds.has(Number(lead.clinica_id))) {
      throw new Error(`Lead ${lead.id} is not routed to a clinic in group ${options.groupId}`);
    }
    if (!markerMatchesLead(lead, options.marker)) {
      throw new Error(`Lead ${lead.id} does not carry marker ${options.marker}`);
    }
    const createdMs = dateMs(lead.created_at, `created_at for lead ${lead.id}`);
    if (createdMs < cutoffMs || createdMs > nowMs + 60_000) {
      throw new Error(`Lead ${lead.id} is outside the allowed E2E time window`);
    }
    if (lead.callback_reminder_job_id) {
      throw new Error(`Lead ${lead.id} has a callback job and cannot be test-cleaned safely`);
    }
    leadsById.set(Number(lead.id), { ...lead, createdMs });
  }

  const actualAppointmentIds = state.appointments.map((row) => Number(row.id_cita));
  if (!sameNumberSet(actualAppointmentIds, options.appointmentIds)) {
    throw new Error(`Pass every linked appointment explicitly with --appointment-ids (found: ${actualAppointmentIds.join(',') || 'none'})`);
  }
  for (const appointment of state.appointments) {
    const lead = leadsById.get(Number(appointment.lead_intake_id));
    if (!lead || !clinicIds.has(Number(appointment.clinica_id))) {
      throw new Error(`Appointment ${appointment.id_cita} is outside the verified lead scope`);
    }
    if (appointment.paciente_id !== null && appointment.paciente_id !== undefined) {
      throw new Error(`Appointment ${appointment.id_cita} is linked to a patient; refusing automatic cleanup`);
    }
    if (!markerMatchesAppointment(appointment, options.marker)) {
      throw new Error(`Appointment ${appointment.id_cita} does not carry marker ${options.marker}`);
    }
    if (dateMs(appointment.created_at, `created_at for appointment ${appointment.id_cita}`) < cutoffMs) {
      throw new Error(`Appointment ${appointment.id_cita} is outside the E2E time window`);
    }
  }

  for (const hold of state.appointmentHolds) {
    if (!leadsById.has(Number(hold.lead_intake_id)) || !clinicIds.has(Number(hold.clinica_id))) {
      throw new Error(`Appointment hold ${hold.id} is outside the verified scope`);
    }
    if (!String(hold.motivo || '').toLowerCase().includes(options.marker.toLowerCase())) {
      throw new Error(`Appointment hold ${hold.id} does not carry marker ${options.marker}`);
    }
    if (dateMs(hold.created_at, `created_at for appointment hold ${hold.id}`) < cutoffMs) {
      throw new Error(`Appointment hold ${hold.id} is outside the E2E time window`);
    }
  }

  const messagesByConversation = new Map();
  for (const message of state.messages) {
    const key = Number(message.conversation_id);
    if (!messagesByConversation.has(key)) messagesByConversation.set(key, []);
    messagesByConversation.get(key).push(message);
  }
  for (const conversation of state.conversations) {
    const lead = leadsById.get(Number(conversation.lead_id));
    if (!lead || !clinicIds.has(Number(conversation.clinic_id))) {
      throw new Error(`Conversation ${conversation.id} is outside the verified lead scope`);
    }
    if (conversation.patient_id !== null && conversation.patient_id !== undefined) {
      throw new Error(`Conversation ${conversation.id} is linked to a patient`);
    }
    const createdMs = dateMs(conversation.createdAt, `createdAt for conversation ${conversation.id}`);
    if (createdMs < lead.createdMs - 5 * 60_000 || createdMs > nowMs + 60_000) {
      throw new Error(`Conversation ${conversation.id} was not created with the synthetic lead`);
    }
    const conversationMessages = messagesByConversation.get(Number(conversation.id)) || [];
    if (conversationMessages.length !== 1
      || !validateQuickChatMessage(conversationMessages[0], conversation.lead_id)) {
      throw new Error(`Conversation ${conversation.id} is not an isolated hidden QuickChat summary`);
    }
  }
  if (state.marketingConversationRefs.length) {
    throw new Error('A synthetic conversation is referenced by a marketing patient list');
  }
  if (state.whatsappOriginRefs.length) {
    throw new Error('A synthetic conversation is referenced by a WhatsApp web origin');
  }

  for (const form of state.formSubmissions) {
    if (!leadsById.has(Number(form.lead_intake_id))
      || Number(form.group_id) !== options.groupId
      || !clinicIds.has(Number(form.clinic_id))) {
      throw new Error(`Form submission ${form.id} is outside the verified scope`);
    }
    if (dateMs(form.created_at, `created_at for form submission ${form.id}`) < cutoffMs) {
      throw new Error(`Form submission ${form.id} is outside the E2E time window`);
    }
  }

  if (state.webEvents.length > options.maxWebEvents) {
    throw new Error(`Refusing to delete ${state.webEvents.length} web events; raise --max-web-events explicitly if expected`);
  }
  const webSessions = new Map(options.sessionIds.map((sessionId) => [sessionId, 0]));
  for (const event of state.webEvents) {
    if (!webSessions.has(String(event.session_id))) {
      throw new Error(`Unexpected web session on event ${event.id}`);
    }
    if (Number(event.group_id) !== options.groupId) {
      throw new Error(`Web event ${event.id} is outside group ${options.groupId}`);
    }
    if (String(event.domain || '').toLowerCase() !== options.domain) {
      throw new Error(`Web event ${event.id} belongs to another domain`);
    }
    if (event.clinic_id !== null && event.clinic_id !== undefined && !clinicIds.has(Number(event.clinic_id))) {
      throw new Error(`Web event ${event.id} belongs to another clinic`);
    }
    if (dateMs(event.occurred_at, `occurred_at for web event ${event.id}`) < cutoffMs) {
      throw new Error(`Web event ${event.id} is outside the E2E time window`);
    }
    webSessions.set(String(event.session_id), webSessions.get(String(event.session_id)) + 1);
  }
  for (const [sessionId, count] of webSessions) {
    if (count === 0) throw new Error(`No web events found for session ${sessionId}`);
  }

  const hasClickId = state.leads.some((lead) => lead.gclid || lead.gbraid || lead.wbraid);
  if (hasClickId && !state.conversionAttempts.length) {
    throw new Error('A click-attributed test lead has no conversion audit yet; wait for conversion processing before cleanup');
  }

  let externalConversionRows = 0;
  for (const attempt of state.conversionAttempts) {
    if (Number(attempt.grupo_clinica_id) !== options.groupId) {
      throw new Error(`Conversion attempt ${attempt.id} is outside group ${options.groupId}`);
    }
    if (attempt.clinica_id !== null && attempt.clinica_id !== undefined
      && !clinicIds.has(Number(attempt.clinica_id))) {
      throw new Error(`Conversion attempt ${attempt.id} belongs to another clinic`);
    }
    if (!state.eventIds.includes(String(attempt.event_id))) {
      throw new Error(`Conversion attempt ${attempt.id} has an unexpected event id`);
    }
    if (['pending', 'accepted'].includes(String(attempt.status))) {
      throw new Error(`Conversion attempt ${attempt.id} is still ${attempt.status}; wait for a terminal diagnostic`);
    }
    if (dateMs(attempt.attempted_at, `attempted_at for conversion ${attempt.id}`) < cutoffMs) {
      throw new Error(`Conversion attempt ${attempt.id} is outside the E2E time window`);
    }
    if (['succeeded', 'partial_success'].includes(String(attempt.status)) || attempt.provider_request_id) {
      externalConversionRows += 1;
    }
  }
  if (externalConversionRows
    && options.mode !== 'dry-run'
    && !options.acknowledgeExternalConversions) {
    throw new Error(
      `${externalConversionRows} conversion attempt(s) may exist in Google; `
      + 'deleting local rows will not retract them. Re-run only after review with '
      + '--acknowledge-external-conversions-not-retracted'
    );
  }

  return {
    externalConversionRows,
    clinicIds: Array.from(clinicIds).sort((a, b) => a - b),
  };
}

function summaryFor(state, options, validation) {
  return {
    mode: options.mode,
    marker: options.marker,
    group_id: options.groupId,
    lead_ids: state.leads.map((row) => Number(row.id)),
    session_ids: options.sessionIds,
    appointment_ids: state.appointments.map((row) => Number(row.id_cita)),
    routing: state.leads.map((row) => ({
      lead_id: Number(row.id),
      clinic_id: Number(row.clinica_id),
      group_id: Number(row.grupo_clinica_id),
      source_detail: row.source_detail,
      clinic_match_source: row.clinic_match_source,
      clinic_match_value: row.clinic_match_value,
    })),
    conversion_event_ids: state.eventIds,
    counts: {
      leads: state.leads.length,
      attribution_audits: state.attributionAudits.length,
      contact_attempts: state.contactAttempts.length,
      flow_instances: state.flowInstances.length,
      conversations: state.conversations.length,
      messages: state.messages.length,
      conversation_reads: state.conversationReads.length,
      form_submissions: state.formSubmissions.length,
      web_events: state.webEvents.length,
      conversion_attempts: state.conversionAttempts.length,
      appointments: state.appointments.length,
      appointment_holds: state.appointmentHolds.length,
    },
    external_conversion_rows_not_retracted: validation.externalConversionRows,
  };
}

async function deleteIds(db, table, key, ids, transaction) {
  if (!ids.length) return;
  await db.sequelize.query(
    `DELETE FROM \`${table}\` WHERE \`${key}\` IN (:ids)`,
    { replacements: { ids }, transaction },
  );
}

async function removeState(db, state, options, transaction) {
  await deleteIds(db, 'GoogleAdsConversionUploadAttempts', 'id', placeholders(state.conversionAttempts), transaction);
  await deleteIds(db, 'WebEvents', 'id', placeholders(state.webEvents), transaction);
  await deleteIds(db, 'FormSubmissionEvents', 'id', placeholders(state.formSubmissions), transaction);
  await deleteIds(db, 'Conversations', 'id', placeholders(state.conversations), transaction);
  await deleteIds(db, 'AppointmentHolds', 'id', placeholders(state.appointmentHolds), transaction);
  await deleteIds(db, 'CitasPacientes', 'id_cita', placeholders(state.appointments, 'id_cita'), transaction);
  await deleteIds(db, 'LeadIntakes', 'id', options.leadIds, transaction);
}

async function postcheck(db, state, options, transaction = null) {
  const conversationIds = placeholders(state.conversations);
  const checks = [
    ['leads', 'SELECT COUNT(*) AS count FROM LeadIntakes WHERE id IN (:leadIds)', { leadIds: options.leadIds }],
    ['forms', 'SELECT COUNT(*) AS count FROM FormSubmissionEvents WHERE lead_intake_id IN (:leadIds)', { leadIds: options.leadIds }],
    ['conversations', 'SELECT COUNT(*) AS count FROM Conversations WHERE lead_id IN (:leadIds)', { leadIds: options.leadIds }],
    ['web_events', 'SELECT COUNT(*) AS count FROM WebEvents WHERE session_id IN (:sessionIds)', { sessionIds: options.sessionIds }],
    ['conversion_attempts', 'SELECT COUNT(*) AS count FROM GoogleAdsConversionUploadAttempts WHERE event_id IN (:eventIds)', { eventIds: state.eventIds }],
    ['appointments', 'SELECT COUNT(*) AS count FROM CitasPacientes WHERE lead_intake_id IN (:leadIds)', { leadIds: options.leadIds }],
    ['appointment_holds', 'SELECT COUNT(*) AS count FROM AppointmentHolds WHERE lead_intake_id IN (:leadIds)', { leadIds: options.leadIds }],
    ['attribution_audits', 'SELECT COUNT(*) AS count FROM LeadAttributionAudits WHERE lead_intake_id IN (:leadIds)', { leadIds: options.leadIds }],
    ['contact_attempts', 'SELECT COUNT(*) AS count FROM LeadContactAttempts WHERE lead_intake_id IN (:leadIds)', { leadIds: options.leadIds }],
    ['flow_instances', 'SELECT COUNT(*) AS count FROM LeadFlowInstances WHERE lead_id IN (:leadIds)', { leadIds: options.leadIds }],
  ];
  if (conversationIds.length) {
    checks.push(
      ['messages', 'SELECT COUNT(*) AS count FROM Messages WHERE conversation_id IN (:conversationIds)', { conversationIds }],
      ['conversation_reads', 'SELECT COUNT(*) AS count FROM ConversationReads WHERE conversation_id IN (:conversationIds)', { conversationIds }],
    );
  }
  const result = {};
  for (const [name, sql, replacements] of checks) {
    const rows = await selectRows(db, sql, replacements, transaction);
    result[name] = Number(rows[0]?.count || 0);
  }
  const remaining = Object.entries(result).filter(([, count]) => count !== 0);
  if (remaining.length) throw new Error(`Cleanup post-check failed: ${JSON.stringify(Object.fromEntries(remaining))}`);
  return result;
}

async function main() {
  const options = parseOptions();
  const db = loadDb();
  let transaction = null;
  try {
    if (options.mode !== 'dry-run') {
      transaction = await db.sequelize.transaction({
        isolationLevel: db.Sequelize.Transaction.ISOLATION_LEVELS.SERIALIZABLE,
      });
    }

    const state = await loadState(db, options, transaction, Boolean(transaction));
    const validation = validateState(state, options);
    const summary = summaryFor(state, options, validation);

    if (options.mode === 'dry-run') {
      summary.status = 'verified_no_changes';
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    await removeState(db, state, options, transaction);
    summary.transaction_postcheck = await postcheck(db, state, options, transaction);

    if (options.mode === 'simulate') {
      await transaction.rollback();
      transaction = null;
      summary.status = 'simulation_rolled_back';
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    await transaction.commit();
    transaction = null;
    summary.status = 'cleaned';
    summary.committed_postcheck = await postcheck(db, state, options);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    if (transaction) await transaction.rollback();
    throw error;
  } finally {
    await db.sequelize.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  assertSessionId,
  assertSyntheticMarker,
  conversionEventIds,
  markerMatchesAppointment,
  markerMatchesLead,
  parseOptions,
  validateQuickChatMessage,
  validateState,
};
