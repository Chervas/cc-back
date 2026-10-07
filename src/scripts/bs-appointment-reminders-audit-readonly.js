#!/usr/bin/env node
'use strict';

// Explicit BS scope, one appointment day, SELECT-only snapshot. Never boot the
// application, claim jobs, retry messages, export tokens or change automation.
const fs = require('node:fs');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const object = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const madrid = value => value == null ? null : new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
}).format(new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z'));

async function run(output) {
    if (!output?.startsWith('/home/ubuntu/secure-imports/bs-today-reminders-20261007-') || fs.existsSync(output))
        throw Error('EXCLUSIVE_PRIVATE_OUTPUT_REQUIRED');
    const connection = await connectOperatorDatabase('crm');
    const yesterday = '2026-10-05 22:00:00', today = '2026-10-06 22:00:00', tomorrow = '2026-10-07 22:00:00';
    const cutoff = new Date().toISOString().slice(0, 19).replace('T', ' ');
    try {
        await connection.query('SET TRANSACTION READ ONLY');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        const query = async (sql, params = []) => (await connection.query(sql, params))[0];
        const appointments = await query(`SELECT a.id_cita,a.clinica_id,a.paciente_id,a.estado,a.inicio,a.fin,
            a.created_at,a.updated_at,a.source_system,a.es_provisional,a.import_metadata,p.nombre,p.apellidos
            FROM CitasPacientes a JOIN Pacientes p ON p.id_paciente=a.paciente_id
            WHERE a.clinica_id IN (66,72) AND a.inicio>=? AND a.inicio<? ORDER BY a.inicio,a.id_cita`, [today, tomorrow]);
        const ids = appointments.map(a => a.id_cita);
        const executions = ids.length ? await query(`SELECT e.id,e.clinic_id,e.trigger_entity_id,e.status,e.created_at,e.updated_at,
            e.current_node_id,e.wait_until,e.waiting_meta,e.last_error,e.template_version_id,t.template_key,t.trigger_config,
            JSON_UNQUOTE(JSON_EXTRACT(e.context,'$.appointment.inicio')) AS captured_start
            FROM FlowExecutionsV2 e LEFT JOIN AutomationFlowTemplatesV2 t ON t.id=e.template_version_id
            WHERE e.clinic_id IN (66,72) AND e.trigger_entity_type='appointment'
            AND e.trigger_type='appointment_reminder_window' AND e.trigger_entity_id IN (?)
            AND e.created_at>=? AND e.created_at<=? ORDER BY e.id`, [ids, yesterday, cutoff]) : [];
        const jobs = ids.length ? await query(`SELECT id,status,next_run_at,created_at,updated_at,payload,error_message
            FROM JobRequests WHERE origin='appointment_automation_schedule'
            AND CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.appointment_id')) AS UNSIGNED) IN (?)
            AND created_at>=? AND created_at<=? ORDER BY id`, [ids, yesterday, cutoff]) : [];
        const patientIds = [...new Set(appointments.map(a => a.paciente_id))];
        const messages = patientIds.length ? await query(`SELECT m.id,m.conversation_id,c.clinic_id,c.patient_id,m.direction,
            m.message_type,m.sender_id,m.status,m.createdAt,m.sent_at,
            JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')) AS execution_id,
            JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_name')) AS template_name,
            JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.error')) AS error,
            JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.status')) AS provider_status
            FROM Messages m JOIN Conversations c ON c.id=m.conversation_id
            WHERE c.clinic_id IN (66,72) AND c.patient_id IN (?) AND m.createdAt>=? AND m.createdAt<=?
            ORDER BY m.id`, [patientIds, yesterday, cutoff]) : [];
        const events = await query(`SELECT id,patient_id,clinic_id,actor_user_id,event_type,occurred_at,metadata
            FROM PatientOperationalEvents WHERE clinic_id IN (66,72) AND occurred_at>=? AND occurred_at<=?
            AND event_type LIKE 'appointment%' ORDER BY occurred_at,id`, [yesterday, cutoff]);
        const templates = await query(`SELECT id,clinic_id,template_key,trigger_config FROM AutomationFlowTemplatesV2
            WHERE clinic_id IN (66,72) AND trigger_type='appointment_reminder_window' AND is_active=1`);
        const executionIds = executions.map(e => e.id);
        const logs = executionIds.length ? await query(`SELECT flow_execution_id,node_id,node_type,status,error_message,started_at,finished_at
            FROM FlowExecutionLogsV2 WHERE flow_execution_id IN (?) ORDER BY id`, [executionIds]) : [];
        const rows = appointments.map(a => {
            const flows = executions.filter(e => String(e.trigger_entity_id) === String(a.id_cita));
            const outbound = messages.filter(m => m.direction === 'outbound' && flows.some(e => String(e.id) === String(m.execution_id)));
            const inbound = messages.filter(m => m.direction === 'inbound' && String(m.patient_id) === String(a.paciente_id) && m.clinic_id === a.clinica_id);
            const linkedEvents = events.filter(e => String(object(e.metadata).appointment_id) === String(a.id_cita));
            return { id: a.id_cita, clinic: a.clinica_id, patient: a.paciente_id,
                name: [a.nombre, a.apellidos].filter(Boolean).join(' '), state: a.estado,
                startMadrid: madrid(a.inicio), endMadrid: madrid(a.fin), createdMadrid: madrid(a.created_at),
                source: a.source_system, provisional: Boolean(a.es_provisional),
                suppression: object(a.import_metadata).notification_suppression || null,
                flows: flows.map(e => ({ ...e, trigger_config: object(e.trigger_config),
                    logs: logs.filter(l => l.flow_execution_id === e.id) })),
                jobs: jobs.filter(j => String(object(j.payload).appointment_id) === String(a.id_cita)),
                outbound, inbound, events: linkedEvents };
        });
        const report = { mode: 'select_only', databaseWrites: 0, messagesSent: 0,
            appointmentDayMadrid: '2026-10-07', reminderDayMadrid: '2026-10-06',
            observedAt: new Date().toISOString(), templates: templates.map(t => ({ ...t, trigger_config: object(t.trigger_config) })), appointments: rows };
        fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
        await connection.commit();
        // Timeline events are not WhatsApp deliveries. Count only the initial
        // day-before template here; follow-ups/retries remain in the evidence.
        const initialReminders = a => a.outbound.filter(m => m.message_type !== 'event'
            && /^clinicaclick_recordatorio_dia_antes_v/.test(m.template_name || ''));
        const states = {}, delivery = {};
        for (const a of rows) { states[a.state] = (states[a.state] || 0) + 1;
            for (const m of initialReminders(a)) delivery[m.status] = (delivery[m.status] || 0) + 1; }
        return { evidence: output, appointmentCount: rows.length, states, reminderMessageDelivery: delivery,
            remindersWithMessages: rows.filter(a => initialReminders(a).length).length,
            withoutLinkedReminder: rows.filter(a => !initialReminders(a).length).map(a => ({ id: a.id, clinic: a.clinic,
                state: a.state, start: a.startMadrid, created: a.createdMadrid,
                flows: a.flows.map(e => ({ id: e.id, status: e.status, error: e.last_error })),
                jobs: a.jobs.map(j => ({ id: j.id, status: j.status, error: j.error_message })) })),
            failed: rows.flatMap(a => a.outbound.filter(m => m.message_type !== 'event' && ['failed','error','undelivered'].includes(m.status))
                .map(m => ({ appointment: a.id, message: m.id, status: m.status, error: m.error }))) };
    } finally { await connection.end(); }
}
if (require.main === module) run(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.code || (/^[A-Z_]+$/.test(error.message) ? error.message : 'READ_ONLY_AUDIT_FAILED')); process.exitCode = 1; });
module.exports = { run };
