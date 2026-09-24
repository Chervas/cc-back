'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../../../models');
const bulkSends = require('../../services/marketingBulkSends.service');
const {
  formatMarketingDate,
  resolveLastAttendedAppointmentDate,
} = require('../../lib/marketing-template-variables');
const {
  buildWhatsappTemplateVariableContract,
} = require('../../lib/whatsapp-template-contract');

const REVIEW_TEMPLATE_BODY = [
  '¡Hola {{1}}! Soy {{2}} de {{3}}.',
  '',
  '¿Te puedo hacer una pregunta? Como viste, en la clínica somos una pequeña familia, y saber cómo te atendimos en tu visita del {{4}} y en general en la clínica, es importante para nosotros. ¿Cómo valorarías tu experiencia?',
  '',
  'Responde con un número:',
  '',
  '5 ⭐⭐⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '3 ⭐⭐⭐',
  '2 ⭐⭐',
  '1 ⭐',
  '',
  'Tu valoración nos ayuda mucho',
  '',
  '—',
].join('\n');

const REVIEW_TEMPLATE_VARIABLES = [
  { position: 1, name: 'nombre_paciente', example: 'María' },
  { position: 2, name: 'firma_resenas', example: 'Recepción' },
  { position: 3, name: 'nombre_clinica', example: 'Clínica Dental Centro' },
  { position: 4, name: 'fecha_ultima_cita_asistida', example: '21/05/2026' },
];

test('fecha_ultima_cita_asistida normaliza fechas importadas y prevalece sobre el contexto clínico', () => {
  const item = {
    last_visit_at: '2026-09-01T09:00:00.000Z',
    custom_fields: { fecha_ultima_cita_asistida: '5 de septiembre de 2026' },
  };
  assert.equal(resolveLastAttendedAppointmentDate(item), '05/09/2026');
  assert.equal(resolveLastAttendedAppointmentDate({ appointment_at: '2026-10-01T09:00:00.000Z' }), '');
  assert.equal(formatMarketingDate('2026-02-30'), '');
});

test('la plantilla de reseñas utility conserva las cuatro variables semánticas', () => {
  const body = REVIEW_TEMPLATE_BODY;
  const contract = buildWhatsappTemplateVariableContract({
    name: 'clinicaclick_solicitar_resena_v300',
    components: [{ type: 'BODY', text: body }],
    variables: REVIEW_TEMPLATE_VARIABLES,
  });
  assert.deepEqual(contract.map((variable) => variable.name), [
    'nombre_paciente',
    'firma_resenas',
    'nombre_clinica',
    'fecha_ultima_cita_asistida',
  ]);
  assert.match(body, /visita del \{\{4\}\}/);
});

test('un importado sin fecha usa la última cita completada del paciente dentro del scope', async (t) => {
  t.mock.method(db.CitaPaciente, 'findAll', async () => [
    { paciente_id: 41, ultima_cita_asistida: '2026-09-07T10:00:00.000Z' },
  ]);
  const [item] = await bulkSends.__testing.attachLatestAttendedAppointmentDate([
    {
      paciente_id: 41,
      appointment_at: '2026-10-01T09:00:00.000Z',
      custom_fields: {},
    },
  ], { clinicIds: [56] });
  assert.equal(item.custom_fields.fecha_ultima_cita_asistida, '07/09/2026');
  assert.equal(
    bulkSends.__testing.resolveVariableValue('fecha_ultima_cita_asistida', item, {}, {}),
    '07/09/2026',
  );
});
