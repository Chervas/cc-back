'use strict';

// Additive, optional infrastructure. Does not create machines, enable clinics,
// rewrite appointments or enable reminders. Apply to every writer before opt-in.
module.exports = {
  async up(q, S) {
    const timestamps = () => ({ created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } });
    const columns = await q.describeTable('Clinicas');
    if (!columns.equipment_booking_enabled) await q.addColumn('Clinicas', 'equipment_booking_enabled', { type: S.BOOLEAN, allowNull: false, defaultValue: false });
    const tables = (await q.showAllTables()).map(t => typeof t === 'string' ? t : t.tableName);
    if (!tables.includes('BookingEquipment')) await q.createTable('BookingEquipment', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      owner_clinic_id: { type: S.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      group_id: { type: S.INTEGER, allowNull: true },
      name: { type: S.STRING(120), allowNull: false }, family_key: { type: S.STRING(64), allowNull: false },
      aliases: { type: S.JSON, allowNull: true }, mobility: { type: S.STRING(12), allowNull: false },
      status: { type: S.STRING(16), allowNull: false }, turnaround_minutes: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      home_installation_id: { type: S.INTEGER, allowNull: true, references: { model: 'Instalaciones', key: 'id' }, onDelete: 'RESTRICT' },
      revision: { type: S.INTEGER, allowNull: false, defaultValue: 1 }, ...timestamps(),
    });
    if (!tables.includes('BookingEquipmentClinics')) await q.createTable('BookingEquipmentClinics', {
      equipment_id: { type: S.INTEGER, primaryKey: true, allowNull: false, references: { model: 'BookingEquipment', key: 'id' }, onDelete: 'RESTRICT' },
      clinic_id: { type: S.INTEGER, primaryKey: true, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      ...timestamps(),
    });
    if (!tables.includes('BookingEquipmentRoomPolicies')) await q.createTable('BookingEquipmentRoomPolicies', {
      installation_id: { type: S.INTEGER, primaryKey: true, allowNull: false, references: { model: 'Instalaciones', key: 'id' }, onDelete: 'RESTRICT' },
      mode: { type: S.STRING(12), allowNull: false, defaultValue: 'none' }, equipment_ids: { type: S.JSON, allowNull: true },
      revision: { type: S.INTEGER, allowNull: false, defaultValue: 1 }, ...timestamps(),
    });
    const indexes = await q.showIndex('BookingEquipmentClinics');
    if (!indexes.some(i => i.name === 'bec_clinic')) await q.addIndex('BookingEquipmentClinics', ['clinic_id', 'equipment_id'], { name: 'bec_clinic' });
  },
  async down() {
    throw new Error('Conserva esta DDL aditiva: retirar equipos o restricciones necesita una revisión del historial y un rollback aprobado.');
  },
};
