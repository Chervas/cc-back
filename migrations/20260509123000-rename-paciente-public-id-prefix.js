'use strict';

const TABLE_NAME = 'Pacientes';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE ${TABLE_NAME}
      SET public_id = CONCAT('pac_', SUBSTRING(public_id, 5))
      WHERE LEFT(public_id, 4) = 'pat_'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE ${TABLE_NAME}
      SET public_id = CONCAT('pat_', SUBSTRING(public_id, 5))
      WHERE LEFT(public_id, 4) = 'pac_'
    `);
  },
};
