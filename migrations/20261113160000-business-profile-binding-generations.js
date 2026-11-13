'use strict';
// This release changes no association, pointer or historical observation.
const grammar = '^(accounts/[1-9][0-9]{0,29}/)?(locations/)?[1-9][0-9]{0,29}$';
module.exports = {
  async up(q, D) {
    // CHECK and canonical uniqueness are installed before removing the old
    // index. Invalid rows/aliases fail with the original uniqueness intact.
    await q.createTable('BusinessProfileBrokerBindingGenerations', {
      generation_id: { type: D.CHAR(36), primaryKey: true, allowNull: false },
      mapping_id: { type: D.INTEGER, allowNull: false, unique: true },
      external_location_id: { type: D.STRING(30), allowNull: false },
      clinica_id: { type: D.INTEGER, allowNull: false }, google_connection_id: { type: D.INTEGER, allowNull: false },
      connection_ref: { type: D.STRING(128), allowNull: false }, asset_ref: { type: D.STRING(128), allowNull: false }, scope_ref: { type: D.STRING(128), allowNull: false },
      previous_asset_ref: { type: D.STRING(128), allowNull: true },
      state: { type: D.ENUM('staged','active','retired'), allowNull: false, defaultValue: 'staged' },
      association_attempt_id: { type: D.CHAR(36), allowNull: false, unique: true }, source_fingerprint: { type: D.CHAR(64), allowNull: false },
      predecessor: { type: D.JSON, allowNull: false }, reassociation: { type: D.JSON, allowNull: true }, proof_digest: { type: D.CHAR(64), allowNull: true },
      created_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false },
    });
    await q.addIndex('BusinessProfileBrokerBindingGenerations', ['external_location_id','state'], { name: 'cc_gbp_generation_location' });
    await q.addIndex('BusinessProfileBrokerBindingGenerations', ['google_connection_id','clinica_id'], { name: 'cc_gbp_generation_scope' });
    await q.addColumn('BusinessProfileBrokerBindings', 'current_generation_id', { type: D.CHAR(36), allowNull: true, defaultValue: null });
    await q.addIndex('BusinessProfileBrokerBindings', ['current_generation_id'], { name: 'cc_gbp_generation_head', unique: true });
    await q.sequelize.query("ALTER TABLE ClinicBusinessLocations ADD COLUMN canonical_location_id VARCHAR(30) GENERATED ALWAYS AS (SUBSTRING_INDEX(location_id,'/',-1)) STORED, ADD COLUMN active_canonical_location_id VARCHAR(30) GENERATED ALWAYS AS (CASE WHEN is_active=1 THEN SUBSTRING_INDEX(location_id,'/',-1) ELSE NULL END) STORED, ADD CONSTRAINT cc_gbp_location_grammar CHECK (REGEXP_LIKE(location_id,'" + grammar + "','c') AND is_active IN (0,1))");
    await q.addIndex('ClinicBusinessLocations', ['active_canonical_location_id'], { name: 'cc_gbp_active_canonical', unique: true });
    await q.addIndex('ClinicBusinessLocations', ['canonical_location_id'], { name: 'cc_gbp_location_history' });
    await q.removeIndex('ClinicBusinessLocations', 'uniq_clinicbusiness_locationid');
    await q.addIndex('ClinicBusinessLocations', ['location_id'], { name: 'idx_clinicbusiness_locationid' });
  },
  async down(q) {
    const [rows] = await q.sequelize.query('SELECT (SELECT COUNT(*) FROM BusinessProfileBrokerBindingGenerations)+(SELECT COUNT(*) FROM BusinessProfileBrokerBindings WHERE current_generation_id IS NOT NULL) AS n');
    const [duplicates] = await q.sequelize.query('SELECT location_id FROM ClinicBusinessLocations GROUP BY location_id HAVING COUNT(*)>1 LIMIT 1');
    if (Number(rows[0].n) || duplicates.length) throw Error('gbp_generation_preserve_history');
    await q.addIndex('ClinicBusinessLocations', ['location_id'], { name: 'uniq_clinicbusiness_locationid', unique: true });
    await q.removeIndex('ClinicBusinessLocations', 'idx_clinicbusiness_locationid');
    await q.removeIndex('ClinicBusinessLocations', 'cc_gbp_active_canonical'); await q.removeIndex('ClinicBusinessLocations', 'cc_gbp_location_history');
    await q.sequelize.query('ALTER TABLE ClinicBusinessLocations DROP CHECK cc_gbp_location_grammar, DROP COLUMN active_canonical_location_id, DROP COLUMN canonical_location_id');
    await q.removeIndex('BusinessProfileBrokerBindings', 'cc_gbp_generation_head'); await q.removeColumn('BusinessProfileBrokerBindings', 'current_generation_id');
    await q.dropTable('BusinessProfileBrokerBindingGenerations');
  },
};
