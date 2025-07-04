'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Cambiar url_publicidad_meta de VARCHAR(255) a TEXT
    await queryInterface.changeColumn('Clinicas', 'url_publicidad_meta', {
      type: Sequelize.TEXT,
      allowNull: true
    });
    
    // Cambiar url_publicidad_google de VARCHAR(255) a TEXT  
    await queryInterface.changeColumn('Clinicas', 'url_publicidad_google', {
      type: Sequelize.TEXT,
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    // Rollback: volver a VARCHAR(255) (solo si los datos caben)
    await queryInterface.changeColumn('Clinicas', 'url_publicidad_meta', {
      type: Sequelize.STRING(255),
      allowNull: true
    });
    
    await queryInterface.changeColumn('Clinicas', 'url_publicidad_google', {
      type: Sequelize.STRING(255),
      allowNull: true
    });
  }
};
