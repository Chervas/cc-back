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

test('recupera la cita completada antes de aplicar la exclusión por fecha', async (t) => {
  t.mock.method(db.CitaPaciente, 'findAll', async () => [
    { paciente_id: 41, ultima_cita_asistida: '2026-09-07T10:00:00.000Z' },
  ]);
  const [item] = await bulkSends.__testing.prepareReviewItemsForExclusions([
    {
      paciente_id: 41,
      status: 'ready',
      selected: true,
      phone: '+34617560236',
      custom_fields: {},
    },
  ], { clinicIds: [56] }, {
    review_exclusion_rules: { no_visit_date: true },
  });

  assert.equal(item.status, 'ready');
  assert.equal(item.selected, true);
  assert.equal(item.custom_fields.fecha_ultima_cita_asistida, '07/09/2026');
});

test('las reseñas separan los contactos sin fecha en vez de bloquear toda la tanda', () => {
  const template = {
    name: 'cc_solicitud_de_opinion_tras_visita_test',
    components: [{ type: 'BODY', text: REVIEW_TEMPLATE_BODY }],
    variables: REVIEW_TEMPLATE_VARIABLES,
  };
  const withDate = {
    id: 1,
    status: 'ready',
    selected: true,
    name: 'Paciente con fecha',
    custom_fields: { fecha_ultima_cita_asistida: '21/05/2026' },
  };
  const withoutDate = {
    id: 2,
    status: 'ready',
    selected: true,
    name: 'Paciente sin fecha',
    custom_fields: {},
  };

  const result = bulkSends.__testing.partitionItemsByTemplateVariableAvailability({
    template,
    items: [withDate, withoutDate],
    list: { criteria: { review_sender_name: 'Vero', review_display_clinic_name: 'Propdental' } },
    clinic: { nombre_clinica: 'Propdental Sant Martí' },
  });

  assert.deepEqual(result.eligibleItems.map((item) => item.id), [1]);
  assert.deepEqual(result.excludedItems.map(({ item }) => item.id), [2]);
  assert.deepEqual(
    result.excludedItems[0].missingVariables.map((item) => item.variable),
    ['fecha_ultima_cita_asistida'],
  );
});

test('una exclusión por variables se revalida al cambiar de plantilla', () => {
  assert.deepEqual(
    bulkSends.__testing.buildItemChannelEligibilityPatch({
      status: 'excluded_missing_variables',
      selected: false,
      name: 'Paciente',
      phone: '+34617560236',
      email: null,
      sent_at: null,
      dispatch_status: null,
    }, ['whatsapp']),
    {
      status: 'ready',
      reason: 'Contacto listo para los destinos seleccionados',
      exclusion_reason: null,
      selected: true,
    },
  );
});

test('persiste la exclusión aunque la selección haya convertido la fila en objeto plano', async (t) => {
  const updates = [];
  t.mock.method(db.MarketingPatientListItem, 'update', async (patch, options) => {
    updates.push({ patch, options });
    return [1];
  });
  const missingVariables = [{
    variable: 'fecha_ultima_cita_asistida',
    token: '{{fecha_ultima_cita_asistida}}',
    missing_count: 1,
    total_ready: 1,
    sample_item_ids: [823275],
  }];

  await bulkSends.__testing.persistMissingVariableExclusion({
    item: { id: 823275, status: 'ready', selected: true },
    missingVariables,
    listId: 820,
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.status, 'excluded_missing_variables');
  assert.equal(updates[0].patch.selected, false);
  assert.deepEqual(updates[0].patch.missing_variables, missingVariables);
  assert.deepEqual(updates[0].options.where, { id: 823275, list_id: 820 });
});
