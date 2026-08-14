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

    if (!await hasTable(queryInterface, 'PatientDirectionSettings')) {
      await queryInterface.createTable('PatientDirectionSettings', {
        id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
        clinic_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          unique: true,
          references: { model: 'Clinicas', key: 'id_clinica' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        is_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        director_user_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        director_phone_asset_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'ClinicMetaAssets', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        clinic_phone_asset_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'ClinicMetaAssets', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        default_successor_user_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        enabled_by: { type: Sequelize.INTEGER, allowNull: true },
        enabled_at: { type: Sequelize.DATE, allowNull: true },
        disabled_by: { type: Sequelize.INTEGER, allowNull: true },
        disabled_at: { type: Sequelize.DATE, allowNull: true },
        config: { type: Sequelize.JSON, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
      await queryInterface.addIndex('PatientDirectionSettings', ['is_enabled', 'director_user_id'], {
        name: 'idx_patient_direction_settings_enabled_director',
      });
      await queryInterface.addIndex('PatientDirectionSettings', ['director_phone_asset_id'], {
        name: 'idx_patient_direction_settings_director_phone',
      });
    }

    if (!await hasTable(queryInterface, 'PatientDirectionAssignments')) {
      await queryInterface.createTable('PatientDirectionAssignments', {
        id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
        clinic_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Clinicas', key: 'id_clinica' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        director_user_id: { type: Sequelize.INTEGER, allowNull: false },
        director_phone_asset_id: { type: Sequelize.INTEGER, allowNull: false },
        clinic_phone_asset_id: { type: Sequelize.INTEGER, allowNull: true },
        successor_user_id: { type: Sequelize.INTEGER, allowNull: true },
        lead_intake_id: { type: Sequelize.INTEGER, allowNull: true },
        conversation_id: { type: Sequelize.INTEGER, allowNull: true },
        patient_id: { type: Sequelize.INTEGER, allowNull: true },
        first_appointment_id: { type: Sequelize.INTEGER, allowNull: true },
        phone_e164: { type: Sequelize.STRING(32), allowNull: false },
        active_phone_key: {
          type: Sequelize.STRING(64),
          allowNull: true,
          unique: true,
          comment: 'Evita dos asignaciones activas para el mismo teléfono dentro del WhatsApp compartido del director.',
        },
        status: {
          type: Sequelize.ENUM(
            'unassigned',
            'active',
            'handoff_pending',
            'handed_off',
            'ended_attended',
            'ended_discarded',
            'ended_service_disabled'
          ),
          allowNull: false,
          defaultValue: 'active',
        },
        start_reason: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'manual' },
        started_by: { type: Sequelize.INTEGER, allowNull: true },
        started_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        end_reason: { type: Sequelize.STRING(64), allowNull: true },
        ended_by: { type: Sequelize.INTEGER, allowNull: true },
        ended_at: { type: Sequelize.DATE, allowNull: true },
        handoff_state: {
          type: Sequelize.ENUM('not_required', 'pending', 'queued', 'sent', 'failed'),
          allowNull: false,
          defaultValue: 'not_required',
        },
        handoff_message_id: { type: Sequelize.INTEGER, allowNull: true },
        old_number_notice_state: {
          type: Sequelize.ENUM('not_required', 'pending', 'sent', 'failed'),
          allowNull: false,
          defaultValue: 'not_required',
        },
        metadata: { type: Sequelize.JSON, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
      await queryInterface.addIndex('PatientDirectionAssignments', ['clinic_id', 'status', 'updated_at'], {
        name: 'idx_patient_direction_assignments_clinic_status',
      });
      await queryInterface.addIndex('PatientDirectionAssignments', ['director_user_id', 'status', 'updated_at'], {
        name: 'idx_patient_direction_assignments_director_status',
      });
      await queryInterface.addIndex('PatientDirectionAssignments', ['conversation_id'], {
        name: 'idx_patient_direction_assignments_conversation',
      });
      await queryInterface.addIndex('PatientDirectionAssignments', ['lead_intake_id'], {
        name: 'idx_patient_direction_assignments_lead',
      });
    }

    if (!await hasTable(queryInterface, 'PatientDirectionEvents')) {
      await queryInterface.createTable('PatientDirectionEvents', {
        id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
        assignment_id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          references: { model: 'PatientDirectionAssignments', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        clinic_id: { type: Sequelize.INTEGER, allowNull: true },
        event_type: { type: Sequelize.STRING(64), allowNull: false },
        actor_user_id: { type: Sequelize.INTEGER, allowNull: true },
        payload: { type: Sequelize.JSON, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
      await queryInterface.addIndex('PatientDirectionEvents', ['assignment_id', 'created_at'], {
        name: 'idx_patient_direction_events_assignment_date',
      });
      await queryInterface.addIndex('PatientDirectionEvents', ['clinic_id', 'event_type', 'created_at'], {
        name: 'idx_patient_direction_events_clinic_type_date',
      });
    }

    if (await hasTable(queryInterface, 'WhatsappTemplateCatalog')) {
      const familyKey = 'clinicaclick_patient_direction_handoff';
      const [rows] = await queryInterface.sequelize.query(
        'SELECT id FROM WhatsappTemplateCatalog WHERE family_key = :familyKey AND locale = \'es\' LIMIT 1',
        { replacements: { familyKey } }
      );
      if (!rows.length) {
        const now = new Date();
        const variables = [
          { position: 1, name: 'director_nombre', example: 'Graci', description: 'Nombre del Director de pacientes' },
          { position: 2, name: 'responsable_nombre', example: 'Marta', description: 'Nombre del responsable de continuidad' },
          { position: 3, name: 'clinica_nombre', example: 'Clínica Centro', description: 'Nombre de la clínica' },
        ];
        const body = '¡Hola! Has hablado con mi compañera {{1}}. Soy {{2}} de {{3}}. Sigamos la conversación por este número, que es el de atención al paciente de la clínica. ¿Te parece bien?';
        await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
          name: 'clinicaclick_patient_direction_handoff',
          family_key: familyKey,
          locale: 'es',
          display_name: 'Continuar tras Director de pacientes',
          category: 'UTILITY',
          body_text: body,
          variables: JSON.stringify(variables),
          components: JSON.stringify([{ type: 'BODY', text: body, example: { body_text: [variables.map((item) => item.example)] } }]),
          is_generic: true,
          is_active: true,
          created_at: now,
          updated_at: now,
        }]);
      }
    }
  },

  async down(queryInterface) {
    if (await hasTable(queryInterface, 'PatientDirectionEvents')) {
      await queryInterface.dropTable('PatientDirectionEvents');
    }
    if (await hasTable(queryInterface, 'PatientDirectionAssignments')) {
      await queryInterface.dropTable('PatientDirectionAssignments');
    }
    if (await hasTable(queryInterface, 'PatientDirectionSettings')) {
      await queryInterface.dropTable('PatientDirectionSettings');
    }
    if (await hasTable(queryInterface, 'WhatsappTemplateCatalog')) {
      await queryInterface.bulkDelete('WhatsappTemplateCatalog', {
        family_key: 'clinicaclick_patient_direction_handoff',
        locale: 'es',
      });
    }
    if (await hasTable(queryInterface, 'UsuarioClinica')) {
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
};
