'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Limpiamos cualquier versión previa de la tabla para evitar conflictos de columnas
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS `WebScQueryDaily`;');

    await queryInterface.createTable('WebScQueryDaily', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      site_url: {
        type: Sequelize.STRING(512),
        allowNull: true
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      query: {
        type: Sequelize.STRING(1024),
        allowNull: false
      },
      query_hash: {
        type: Sequelize.CHAR(64),
        allowNull: false
      },
      page_url: {
        type: Sequelize.STRING(2048),
        allowNull: true
      },
      page_url_hash: {
        type: Sequelize.CHAR(64),
        allowNull: false
      },
      clicks: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      impressions: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      ctr: {
        type: Sequelize.DECIMAL(8, 6),
        allowNull: false,
        defaultValue: 0
      },
      position: {
        type: Sequelize.DECIMAL(8, 3),
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW')
      }
    });

    await queryInterface.addIndex('WebScQueryDaily', ['clinica_id', 'query_hash']);
    await queryInterface.addConstraint('WebScQueryDaily', {
      fields: ['clinica_id', 'date', 'query_hash', 'page_url_hash'],
      type: 'unique',
      name: 'uniq_webscquerydaily_clinic_date_query_pagehash'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('WebScQueryDaily');
  }
};
