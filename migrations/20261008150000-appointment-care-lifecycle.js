'use strict';

const { DataTypes } = require('sequelize');

module.exports = {
  async up(qi) {
    const columns = await qi.describeTable('CitasPacientes');
    for (const [name, type] of [['care_completed_at', DataTypes.DATE], ['care_completed_by', DataTypes.INTEGER]]) {
      if (!columns[name]) await qi.addColumn('CitasPacientes', name, { type, allowNull: true });
    }
    if (!columns.care_legacy_attendance) await qi.addColumn('CitasPacientes', 'care_legacy_attendance', {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
    });
    const existing = [...String(columns.estado.type).matchAll(/'([^']+)'/g)].map(match => match[1]);
    if (!existing.includes('pendiente') || !existing.includes('completada')) throw Error('appointment_status_schema_unexpected');
    const values = [...existing];
    for (const value of ['ha_acudido', 'en_atencion']) if (!values.includes(value)) values.push(value);
    if (values.length !== existing.length) await qi.changeColumn('CitasPacientes', 'estado', {
      type: DataTypes.ENUM(...values), allowNull: false, defaultValue: 'pendiente',
    });
    // Apply with appointment writers stopped. Preserve source, timestamps, actors,
    // booking/economic ledgers and history; raw SQL never emits automation events.
    await qi.sequelize.transaction(async transaction => {
      await qi.sequelize.query("UPDATE CitasPacientes SET estado='ha_acudido', care_legacy_attendance=1, updated_at=updated_at WHERE estado='completada' AND care_completed_at IS NULL", { transaction });
      await qi.sequelize.query("UPDATE CitasPacientes SET estado=IF(care_started_at IS NULL,'ha_acudido','en_atencion'), updated_at=updated_at WHERE care_legacy_attendance=0 AND estado IN ('pendiente','info_enviada','info_confirmada','recordatorio_enviado','recordatorio_confirmado','reprogramada') AND arrived_at IS NOT NULL AND care_schedule_start=inicio", { transaction });
    });
  },
  async down() {
    throw Error('Preserve arrival and clinical evidence; rollback requires an explicit compatibility plan.');
  },
};
