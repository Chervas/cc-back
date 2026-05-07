'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('MarketingPatientListItems', 'treatment_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Tratamientos', key: 'id_tratamiento' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('MarketingPatientListItems', {
      name: 'idx_marketing_patient_list_items_treatment',
      fields: ['treatment_id'],
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('MarketingPatientListItems', 'idx_marketing_patient_list_items_treatment');
    await queryInterface.removeColumn('MarketingPatientListItems', 'treatment_id');
  },
};
