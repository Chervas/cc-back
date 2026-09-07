'use strict';

// NOT activated by code deployment: migrate/review every shared-DB writer first,
// then enable BOOKING_PROFILES_ENABLED / BOOKING_MULTI_RESOURCE_ENABLED.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('InstallationPhysicalAliases', {
      installation_id: { type: Sequelize.INTEGER, primaryKey: true, allowNull: false, references: { model: 'Instalaciones', key: 'id' }, onDelete: 'RESTRICT' },
      canonical_installation_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Instalaciones', key: 'id' }, onDelete: 'RESTRICT' },
      group_id: { type: Sequelize.INTEGER, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('InstallationPhysicalAliases', ['canonical_installation_id'], { name: 'ipa_canonical' });
    await queryInterface.createTable('AppointmentBookingResources', {
      resource_key: { type: Sequelize.STRING(80), primaryKey: true, allowNull: false },
      resource_kind: { type: Sequelize.STRING(20), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.createTable('AppointmentBookingOccupancies', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      appointment_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'CitasPacientes', key: 'id_cita' }, onDelete: 'CASCADE' },
      phase_key: { type: Sequelize.STRING(64), allowNull: false },
      resource_kind: { type: Sequelize.STRING(20), allowNull: false },
      resource_key: { type: Sequelize.STRING(80), allowNull: false, references: { model: 'AppointmentBookingResources', key: 'resource_key' }, onDelete: 'RESTRICT' },
      installation_id: { type: Sequelize.INTEGER, allowNull: true },
      doctor_id: { type: Sequelize.INTEGER, allowNull: true },
      start_at: { type: Sequelize.DATE, allowNull: false },
      end_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('AppointmentBookingOccupancies', ['resource_key', 'start_at', 'end_at'], { name: 'abo_resource_range' });
    await queryInterface.addIndex('AppointmentBookingOccupancies', ['appointment_id'], { name: 'abo_appointment' });
  },
  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM AppointmentBookingOccupancies');
    if (Number(rows[0].count)) throw new Error('Hay reservas de citas: requiere rollback de datos aprobado antes de retirar la ocupación.');
    const [aliases] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM InstallationPhysicalAliases');
    if (Number(aliases[0].count)) throw new Error('Hay equivalencias de cabinas físicas: conserva y revisa el mapping antes de retirarlo.');
    await queryInterface.dropTable('AppointmentBookingOccupancies');
    await queryInterface.dropTable('AppointmentBookingResources');
    await queryInterface.dropTable('InstallationPhysicalAliases');
  },
};
