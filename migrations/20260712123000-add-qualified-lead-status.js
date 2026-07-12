'use strict';

const LEAD_STATUSES_WITH_QUALIFIED = [
  'nuevo',
  'contactado',
  'esperando_info',
  'info_recibida',
  'cualificado',
  'citado',
  'acudio_cita',
  'convertido',
  'descartado',
];

const LEGACY_LEAD_STATUSES = LEAD_STATUSES_WITH_QUALIFIED.filter((status) => status !== 'cualificado');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('LeadIntakes', 'status_lead', {
      type: Sequelize.ENUM(...LEAD_STATUSES_WITH_QUALIFIED),
      allowNull: false,
      defaultValue: 'nuevo',
    });
  },

  async down(queryInterface, Sequelize) {
    // La reversión conserva los leads: el hito nuevo vuelve al estado operativo
    // inmediatamente anterior en vez de eliminar filas o dejar un ENUM inválido.
    await queryInterface.sequelize.query(
      "UPDATE `LeadIntakes` SET `status_lead` = 'info_recibida' WHERE `status_lead` = 'cualificado'"
    );
    await queryInterface.changeColumn('LeadIntakes', 'status_lead', {
      type: Sequelize.ENUM(...LEGACY_LEAD_STATUSES),
      allowNull: false,
      defaultValue: 'nuevo',
    });
  },
};
