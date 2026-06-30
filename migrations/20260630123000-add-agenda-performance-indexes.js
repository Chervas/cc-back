'use strict';

async function hasIndex(queryInterface, tableName, indexName) {
  const rows = await queryInterface.sequelize.query(
    `SHOW INDEX FROM \`${tableName}\` WHERE Key_name = :indexName`,
    {
      replacements: { indexName },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function addIndexIfMissing(queryInterface, tableName, fields, options) {
  if (await hasIndex(queryInterface, tableName, options.name)) {
    return;
  }
  await queryInterface.addIndex(tableName, fields, options);
}

async function removeIndexIfExists(queryInterface, tableName, indexName) {
  if (!(await hasIndex(queryInterface, tableName, indexName))) {
    return;
  }
  await queryInterface.removeIndex(tableName, indexName);
}

module.exports = {
  async up(queryInterface) {
    await addIndexIfMissing(queryInterface, 'Messages', ['conversation_id', 'direction', 'createdAt'], {
      name: 'idx_messages_conversation_direction_created',
    });

    await addIndexIfMissing(queryInterface, 'Conversations', ['clinic_id', 'channel', 'patient_id'], {
      name: 'idx_conversations_clinic_channel_patient',
    });

    await addIndexIfMissing(queryInterface, 'Conversations', ['clinic_id', 'channel', 'contact_id'], {
      name: 'idx_conversations_clinic_channel_contact',
    });

    await addIndexIfMissing(queryInterface, 'CitasPacientes', ['clinica_id', 'inicio', 'fin'], {
      name: 'idx_citaspacientes_clinica_inicio_fin',
    });

    await addIndexIfMissing(queryInterface, 'CitasPacientes', ['doctor_id', 'inicio', 'fin'], {
      name: 'idx_citaspacientes_doctor_inicio_fin',
    });

    await addIndexIfMissing(queryInterface, 'CitasPacientes', ['instalacion_id', 'inicio', 'fin'], {
      name: 'idx_citaspacientes_instalacion_inicio_fin',
    });
  },

  async down(queryInterface) {
    await removeIndexIfExists(queryInterface, 'CitasPacientes', 'idx_citaspacientes_instalacion_inicio_fin');
    await removeIndexIfExists(queryInterface, 'CitasPacientes', 'idx_citaspacientes_doctor_inicio_fin');
    await removeIndexIfExists(queryInterface, 'CitasPacientes', 'idx_citaspacientes_clinica_inicio_fin');
    await removeIndexIfExists(queryInterface, 'Conversations', 'idx_conversations_clinic_channel_contact');
    await removeIndexIfExists(queryInterface, 'Conversations', 'idx_conversations_clinic_channel_patient');
    await removeIndexIfExists(queryInterface, 'Messages', 'idx_messages_conversation_direction_created');
  },
};
