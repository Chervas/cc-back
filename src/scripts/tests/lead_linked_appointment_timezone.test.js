'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const sourceFile = require.resolve('../../controllers/intake.controller');
const availabilityFile = require.resolve('../../lib/availability-calendar');
const snippet = fs.readFileSync(sourceFile, 'utf8').split('const buildLinkedAppointmentSummary =')[1]
  .split('\nconst enrichLeadsWithAttributionView =')[0];
assert(snippet, 'Actual summary/enrichment controller source is required');
const worker = `
  const assert=require('node:assert/strict');
  const {resolveClinicTimezone}=require(${JSON.stringify(availabilityFile)});
  const cleanString=v=>String(v??'').trim()||null, parseInteger=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
  const toPlain=v=>v?.toJSON?v.toJSON():v, Clinica={},Paciente={},db={},Op=require('sequelize').Op;
  const LEAD_ACTIVE_APPOINTMENT_STATES=new Set(['pendiente','info_enviada','info_confirmada','recordatorio_enviado','recordatorio_confirmado','cambio_solicitado','reprogramada']);
  let appointment;
  const CitaPaciente={async findAll(q){assert(q.include.find(i=>i.as==='clinica').attributes.includes('configuracion'));return [appointment];}};
  const buildLinkedAppointmentSummary = ${snippet}
  (async()=>{
    const out=[];
    for(const [zone,start,expected] of [['Europe/Madrid','2026-11-17T12:00:00Z','13:00'],['Atlantic/Canary','2026-11-17T12:00:00Z','12:00'],['Europe/Madrid','2026-07-17T12:00:00Z','14:00']]){
      appointment={id_cita:79686,clinica_id:72,paciente_id:68484,lead_intake_id:8339,estado:'no_asistio',inicio:new Date(start),clinica:{nombre_clinica:'Clínica ficticia',configuracion:{timezone:zone}}};
      const [lead]=await enrichLeadsWithLinkedAppointments([{id:8339,status_lead:'info_recibida',call_outcome_appointment_id:null}]);
      assert.equal(lead.status_lead,'info_recibida');assert.equal(lead.linked_appointment,null);
      assert.equal(lead.recent_appointment.hora,expected);assert.equal(lead.recent_appointment.time_zone,zone);
      out.push({zone,start,hora:lead.recent_appointment.hora,time_zone:lead.recent_appointment.time_zone});
    }
    console.log(JSON.stringify(out));
  })().catch(e=>{console.error(e);process.exitCode=1;});
`;
let baseline;
for (const hostZone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) test('linked and recent appointment times use the clinic timezone with host ' + hostZone, () => {
  const result = spawnSync('/usr/bin/node', ['-e', worker], { cwd: __dirname, env: { PATH: '/usr/bin:/bin', TZ: hostZone }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
  if (baseline) assert.deepEqual(output, baseline); else baseline = output;
});
