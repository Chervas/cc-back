'use strict';

const crypto = require('crypto');

const TABLE_NAME = 'Pacientes';
const COLUMN_NAME = 'public_id';
const INDEX_NAME = 'idx_pacientes_public_id';

function generatePublicId() {
  return `pac_${crypto.randomBytes(10).toString('hex')}`;
}

async function hasColumn(queryInterface, columnName) {
  const table = await queryInterface.describeTable(TABLE_NAME);
  return Object.prototype.hasOwnProperty.call(table, columnName);
}

async function hasIndex(queryInterface, indexName) {
  const indexes = await queryInterface.showIndex(TABLE_NAME).catch(() => []);
  return indexes.some((index) => index.name === indexName);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await hasColumn(queryInterface, COLUMN_NAME))) {
      await queryInterface.addColumn(TABLE_NAME, COLUMN_NAME, {
        type: Sequelize.STRING(64),
        allowNull: true,
        after: 'id_paciente',
      });
    }

    const rows = await queryInterface.sequelize.query(
      `
        SELECT id_paciente
        FROM Pacientes
        WHERE public_id IS NULL OR public_id = ''
        ORDER BY id_paciente ASC
      `,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );

    const used = new Set();
    for (const row of rows) {
      let publicId = generatePublicId();
      while (used.has(publicId)) {
        publicId = generatePublicId();
      }
      used.add(publicId);

      await queryInterface.sequelize.query(
        'UPDATE Pacientes SET public_id = :publicId WHERE id_paciente = :id',
        {
          replacements: {
            id: row.id_paciente,
            publicId,
          },
        }
      );
    }

    await queryInterface.changeColumn(TABLE_NAME, COLUMN_NAME, {
      type: Sequelize.STRING(64),
      allowNull: false,
    });

    if (!(await hasIndex(queryInterface, INDEX_NAME))) {
      await queryInterface.addIndex(TABLE_NAME, [COLUMN_NAME], {
        name: INDEX_NAME,
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    if (await hasIndex(queryInterface, INDEX_NAME)) {
      await queryInterface.removeIndex(TABLE_NAME, INDEX_NAME);
    }
    if (await hasColumn(queryInterface, COLUMN_NAME)) {
      await queryInterface.removeColumn(TABLE_NAME, COLUMN_NAME);
    }
  },
};
