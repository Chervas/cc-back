'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Clinicas');

    if (!table.telefono_fijo) {
      await queryInterface.addColumn('Clinicas', 'telefono_fijo', {
        type: Sequelize.STRING,
        allowNull: true,
        after: 'telefono',
      });
    }

    if (!table.telefono_movil) {
      await queryInterface.addColumn('Clinicas', 'telefono_movil', {
        type: Sequelize.STRING,
        allowNull: true,
        after: 'telefono_fijo',
      });
    }

    if (!table.telefono_whatsapp) {
      await queryInterface.addColumn('Clinicas', 'telefono_whatsapp', {
        type: Sequelize.STRING,
        allowNull: true,
        after: 'telefono_movil',
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE \`Clinicas\`
      SET \`telefono_fijo\` = \`telefono\`
      WHERE \`telefono_fijo\` IS NULL
        AND \`telefono\` IS NOT NULL
        AND \`telefono\` <> ''
    `);
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Clinicas');
    if (table.telefono_whatsapp) {
      await queryInterface.removeColumn('Clinicas', 'telefono_whatsapp');
    }
    if (table.telefono_movil) {
      await queryInterface.removeColumn('Clinicas', 'telefono_movil');
    }
    if (table.telefono_fijo) {
      await queryInterface.removeColumn('Clinicas', 'telefono_fijo');
    }
  },
};
