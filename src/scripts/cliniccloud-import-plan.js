#!/usr/bin/env node
'use strict';

// Intentionally no --apply/--execute/--activate path, Sequelize or application
// bootstrap. Loading this script cannot enqueue jobs or mutate the live DB.
const path = require('path');
const { readBytes, readCsv, readAlerts, writePrivateJson, parseArgs } = require('../lib/cliniccloud-import/io');
const { normalizeContacts, normalizeAppointments, normalizeAlerts } = require('../lib/cliniccloud-import/adapter');
const { buildPlan } = require('../lib/cliniccloud-import/planner');

function run(args) {
  const options = parseArgs(args, ['--contacts', '--appointments', '--alerts', '--historical-dir', '--local-snapshot', '--source-account', '--coverage-start', '--coverage-end', '--priority-date', '--private-output']);
  for (const key of ['--contacts', '--appointments', '--source-account', '--coverage-start', '--coverage-end']) if (!options[key]) throw new Error('MISSING_REQUIRED_CLI_ARGUMENT');
  const contacts = readCsv(options['--contacts'], 'contacts', ['IDCONTACTO', 'NUM', 'NOMBRE', 'APELLIDOS']);
  const appointments = readCsv(options['--appointments'], 'appointments', ['IDCONTACTO', 'FECHA', 'HORA INICIO', 'HORA FIN', 'ESTADO', 'TIPO SERVICIO', 'AGENDA', 'SERVICIOS']);
  const files = [contacts.file, appointments.file];
  let oldContacts = [], oldAppointments = [], oldAlerts = [];
  if (options['--historical-dir']) {
    const load = (filename, role) => { const value = readCsv(path.join(options['--historical-dir'], filename), role); files.push(value.file); return value; };
    const agendas = load('agenda_1.csv', 'historic_agendas');
    const services = load('servicio_1.csv', 'historic_services');
    const serviceTypes = load('tiposervicio_1.csv', 'historic_service_types');
    const historicContacts = load('contacto_1.csv', 'historic_contacts');
    oldContacts = normalizeContacts(historicContacts.rows, historicContacts.file.sha256, true);
    oldAlerts = load('aviso_1.csv', 'historic_alerts').rows;
    for (const suffix of ['1', '2']) {
      const source = load(`cita_${suffix}.csv`, `historic_appointments_${suffix}`);
      oldAppointments.push(...normalizeAppointments(source.rows, source.file.sha256, { historical: true, agendas: agendas.rows, services: services.rows, serviceTypes: serviceTypes.rows }));
    }
  }
  const normalizedContacts = normalizeContacts(contacts.rows, contacts.file.sha256);
  let alerts = [];
  if (options['--alerts']) {
    const source = readAlerts(options['--alerts']); files.push(source.file);
    alerts = normalizeAlerts(source.rows, source.file.sha256, normalizedContacts, oldAlerts);
  }
  const snapshot = options['--local-snapshot'] ? JSON.parse(readBytes(options['--local-snapshot']).toString('utf8')) : null;
  const plan = buildPlan({ sourceAccount: options['--source-account'], coverage: { start: options['--coverage-start'], end: options['--coverage-end'] }, priorityDate: options['--priority-date'], files, contacts: normalizedContacts, appointments: normalizeAppointments(appointments.rows, appointments.file.sha256), alerts, historicalContacts: oldContacts, historicalAppointments: oldAppointments, snapshot });
  if (options['--private-output']) writePrivateJson(options['--private-output'], plan);
  return { manifest: plan.manifest, plan_sha256: plan.plan_sha256, summary: plan.summary, private_plan_written: Boolean(options['--private-output']) };
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) {
    // Codes only. Error messages from parsers/OS/JSON can contain patient data.
    const safe = /^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'CLINICCLOUD_PLAN_FAILED';
    process.stderr.write(`${safe}\n`); process.exitCode = 1;
  }
}
module.exports = { run };
