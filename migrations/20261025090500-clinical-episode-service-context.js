'use strict';
module.exports = {
  async up(q, S) {
    const columns = await q.describeTable('AppointmentClinicalReports');
    if (!columns.service_ref) await q.addColumn('AppointmentClinicalReports', 'service_ref', { type: S.JSON, allowNull: true });
  },
  async down() { throw Error('clinical_service_context_history_preserved_rollback_code_only'); },
};
