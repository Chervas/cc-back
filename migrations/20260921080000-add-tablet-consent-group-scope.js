'use strict';
// Explicit opt-in, never grants any existing device access to other clinics.
module.exports = {
    async up(q, Sequelize) {
        const existing = (await q.describeTable('ClinicTabletKiosks')).consent_group_id;
        if (existing) {
            if (!/^INT(?:\(\d+\))?$/i.test(existing.type) || !existing.allowNull || existing.defaultValue != null) throw Error('TABLET_GROUP_SCOPE_SCHEMA_INCOMPATIBLE');
            return;
        }
        await q.addColumn('ClinicTabletKiosks', 'consent_group_id', { type: Sequelize.INTEGER, allowNull: true, defaultValue: null });
    },
    async down(q) {
        if (!(await q.describeTable('ClinicTabletKiosks')).consent_group_id) return;
        const [rows] = await q.sequelize.query('SELECT COUNT(*) AS total FROM ClinicTabletKiosks WHERE consent_group_id IS NOT NULL');
        if (Number(rows[0]?.total)) throw Error('TABLET_GROUP_SCOPE_ROLLBACK_HAS_GRANTS');
        await q.removeColumn('ClinicTabletKiosks', 'consent_group_id');
    },
};
