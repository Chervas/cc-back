'use strict';

const OLD_EMPTY_PATIENT_MESSAGE = 'El paciente tiene cita ahora, pero no queda claro que la haya confirmado';
const NEW_EMPTY_PATIENT_MESSAGE = 'El paciente no ha confirmado claramente la cita o propone otra disponibilidad. Revisa la conversación y responde desde la clínica.';

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkUpdate(
      'Notifications',
      { message: NEW_EMPTY_PATIENT_MESSAGE },
      { message: OLD_EMPTY_PATIENT_MESSAGE }
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkUpdate(
      'Notifications',
      { message: OLD_EMPTY_PATIENT_MESSAGE },
      { message: NEW_EMPTY_PATIENT_MESSAGE }
    );
  },
};
