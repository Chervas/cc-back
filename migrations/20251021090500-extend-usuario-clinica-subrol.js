'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE UsuarioClinica
      MODIFY COLUMN subrol_clinica ENUM(
        'Auxiliares y enfermeros',
        'Doctores',
        'Administrativos',
        'Recepción / Comercial ventas'
      ) NULL DEFAULT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE UsuarioClinica
      MODIFY COLUMN subrol_clinica ENUM(
        'Auxiliares y enfermeros',
        'Doctores',
        'Administrativos'
      ) NULL DEFAULT NULL;
    `);
  }
};
