'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class DoctorClinica extends Model {
    static associate(models) {
      DoctorClinica.belongsTo(models.Usuario, { foreignKey: 'doctor_id', targetKey: 'id_usuario', as: 'doctor' });
      DoctorClinica.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      DoctorClinica.hasMany(models.DoctorHorario, { foreignKey: 'doctor_clinica_id', as: 'horarios' });
    }
  }
  DoctorClinica.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doctor_id: { type: DataTypes.INTEGER, allowNull: false },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    // Explicit presence calendar, per doctor. Null is independent; a shared
    // source points to itself. Membership is validated by the sharing service.
    shared_schedule_source_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    rol_en_clinica: DataTypes.STRING(64),
    // Eje 1: si el profesional recibe citas en esta clínica (agenda).
    recibe_citas: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    allow_overlap_confirmation: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Server-owned, per-clinic exception. Does not grant user permissions.
    agenda_flexible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Operator-owned compatibility confirmation; never releases occupied time.
    allow_legacy_attention_confirmation: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true }
  }, {
    sequelize,
    modelName: 'DoctorClinica',
    tableName: 'DoctorClinicas',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
  DoctorClinica.addHook('afterFind', 'projectSharedPresenceCalendar', async (found, options = {}) => {
    if (options.skipSharedScheduleProjection || !found) return;
    const rows = Array.isArray(found) ? found : [found];
    const candidates = rows.filter(row => row?.shared_schedule_source_id !== null && Array.isArray(row.horarios));
    if (!candidates.length) return;
    const sharing = require('../src/services/personalScheduleSharing.service');
    const db = { ...sequelize.models, Sequelize: sequelize.constructor, sequelize };
    const projected = await sharing.projectDoctorClinicas({ db, rows: candidates, transaction: options.transaction });
    candidates.forEach((row, index) => {
      const value = projected[index];
      if (typeof row.setDataValue === 'function') {
        // Sequelize's included hasMany serializer calls child.get(); preserve
        // model instances rather than installing a plain array into dataValues.
        const include = db.DoctorHorarioExcepcion ? [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] : [];
        const schedules = value.horarios.map(item => db.DoctorHorario.build(item, { isNewRecord: false, raw: true, include }));
        if (row.shared_schedule_source_id === undefined) row.setDataValue('shared_schedule_source_id', value.shared_schedule_source_id);
        row.setDataValue('horarios', schedules); row.horarios = schedules;
        row.setDataValue('shared_schedule', value.shared_schedule); row.shared_schedule = value.shared_schedule;
      } else { if (row.shared_schedule_source_id === undefined) row.shared_schedule_source_id = value.shared_schedule_source_id;
        row.horarios = value.horarios; row.shared_schedule = value.shared_schedule; }
    });
  });
  const unlinkRequired = () => Object.assign(Error('Desvincula primero el calendario compartido para conservar sus horarios y excepciones.'),
    { code: 'personal_schedule_sharing_unlink_required', status: 409, statusCode: 409 });
  const linkedInScope = async (where, options = {}) => DoctorClinica.findOne({
    where: { [sequelize.constructor.Op.and]: [where || {}, { shared_schedule_source_id: { [sequelize.constructor.Op.ne]: null } }] },
    attributes: ['id', 'shared_schedule_source_id'], transaction: options.transaction,
    ...(options.transaction?.LOCK ? { lock: options.transaction.LOCK.UPDATE } : {}), skipSharedScheduleProjection: true,
  });
  DoctorClinica.addHook('beforeUpdate', 'protectSharedPresenceDeactivation', async (row, options = {}) => {
    if (row.changed('activo') && ![true, 1].includes(row.activo)) {
      if (row.shared_schedule_source_id != null || row.previous('shared_schedule_source_id') != null
        || await linkedInScope({ id: row.id }, options)) throw unlinkRequired();
    }
  });
  DoctorClinica.addHook('beforeDestroy', 'protectSharedPresenceDeletion', async (row, options = {}) => {
    if (row.shared_schedule_source_id != null || await linkedInScope({ id: row.id }, options)) throw unlinkRequired();
  });
  // Bulk methods do not run instance hooks by default. Check their actual scope
  // too; a sharing operation only writes the source field and is unaffected.
  DoctorClinica.addHook('beforeBulkUpdate', 'protectSharedPresenceBulkDeactivation', async options => {
    if (Object.hasOwn(options.attributes || {}, 'activo') && ![true, 1].includes(options.attributes.activo)
      && await linkedInScope(options.where, options)) throw unlinkRequired();
  });
  DoctorClinica.addHook('beforeBulkDestroy', 'protectSharedPresenceBulkDeletion', async options => {
    if (await linkedInScope(options.where, options)) throw unlinkRequired();
  });
  return DoctorClinica;
};
