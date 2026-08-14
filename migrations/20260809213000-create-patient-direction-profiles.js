'use strict';

function tableNameOf(table) {
  return typeof table === 'string'
    ? table
    : (table?.tableName || table?.table_name || table?.name || '');
}

async function hasTable(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables.some((table) => tableNameOf(table).toLowerCase() === tableName.toLowerCase());
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!await hasTable(queryInterface, 'PatientDirectionProfiles')) {
      await queryInterface.createTable('PatientDirectionProfiles', {
        user_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          primaryKey: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        whatsapp_phone_asset_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          unique: true,
          references: { model: 'ClinicMetaAssets', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        created_by: { type: Sequelize.INTEGER, allowNull: true },
        updated_by: { type: Sequelize.INTEGER, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
      await queryInterface.addIndex('PatientDirectionProfiles', ['is_active'], {
        name: 'idx_patient_direction_profiles_active',
      });
    }

    if (await hasTable(queryInterface, 'UsuarioClinica')) {
      const hasSettings = await hasTable(queryInterface, 'PatientDirectionSettings');
      const directorAssetExpression = hasSettings
        ? `(
            SELECT pds.director_phone_asset_id
            FROM PatientDirectionSettings pds
            WHERE pds.director_user_id = uc.id_usuario
              AND pds.director_phone_asset_id IS NOT NULL
            ORDER BY pds.updated_at DESC, pds.id DESC
            LIMIT 1
          )`
        : 'NULL';
      await queryInterface.sequelize.query(`
        INSERT INTO PatientDirectionProfiles (
          user_id,
          is_active,
          whatsapp_phone_asset_id,
          created_at,
          updated_at
        )
        SELECT DISTINCT
          uc.id_usuario,
          1,
          ${directorAssetExpression},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM UsuarioClinica uc
        WHERE uc.subrol_clinica = 'Director de pacientes'
        ON DUPLICATE KEY UPDATE
          is_active = VALUES(is_active),
          whatsapp_phone_asset_id = COALESCE(
            PatientDirectionProfiles.whatsapp_phone_asset_id,
            VALUES(whatsapp_phone_asset_id)
          ),
          updated_at = CURRENT_TIMESTAMP
      `);

      // El perfil global y PatientDirectionSettings sustituyen estas filas.
      await queryInterface.sequelize.query(`
        DELETE FROM UsuarioClinica
        WHERE subrol_clinica = 'Director de pacientes'
      `);

      await queryInterface.sequelize.query(`
        ALTER TABLE UsuarioClinica
        MODIFY COLUMN subrol_clinica ENUM(
          'Auxiliares y enfermeros',
          'Doctores',
          'Administrativos',
          'Recepción / Comercial ventas',
          'Gestoría'
        ) NULL DEFAULT NULL
      `);
    }
  },

  async down(queryInterface) {
    if (await hasTable(queryInterface, 'UsuarioClinica')) {
      await queryInterface.sequelize.query(`
        ALTER TABLE UsuarioClinica
        MODIFY COLUMN subrol_clinica ENUM(
          'Auxiliares y enfermeros',
          'Doctores',
          'Administrativos',
          'Recepción / Comercial ventas',
          'Gestoría',
          'Director de pacientes'
        ) NULL DEFAULT NULL
      `);
    }
    if (await hasTable(queryInterface, 'PatientDirectionProfiles')) {
      await queryInterface.dropTable('PatientDirectionProfiles');
    }
  },
};
