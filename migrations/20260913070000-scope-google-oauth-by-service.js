'use strict';
// Metadata-only expansion. Apply in an approved cut before the new model/code,
// even with OAuth gates disabled. MySQL DDL is not one atomic transaction.
module.exports = {
  async up(qi, D) {
    // Validate the old uniqueness boundaries before the first irreversible DDL.
    const indexes = await qi.showIndex('GoogleOAuthBrokerBindings');
    const old = new Map();
    for (const field of ['google_connection_id', 'connection_ref']) {
      const matches = indexes.filter(index => index.unique && !index.primary && index.fields.length === 1 && index.fields[0].attribute === field);
      if (matches.length !== 1) throw Error('google_oauth_schema_unexpected');
      old.set(field, matches[0].name);
    }
    const primary = indexes.filter(index => index.primary);
    if (primary.length !== 1 || primary[0].fields.length !== 1 || primary[0].fields[0].attribute !== 'google_user_id') throw Error('google_oauth_schema_unexpected');
    const cohort = () => ({ type: D.ENUM('business_profile', 'search_console', 'analytics'), allowNull: false, defaultValue: 'business_profile' });
    await qi.addColumn('GoogleOAuthBrokerBindings', 'cohort', cohort());
    await qi.addColumn('GoogleOAuthBrokerRequests', 'cohort', cohort());
    await qi.addColumn('GoogleOAuthBrokerRequests', 'policy_version', { type: D.STRING(64), allowNull: false, defaultValue: 'google-oauth-pinned-v1' });
    await qi.addColumn('GoogleOAuthBrokerRequests', 'request_scope_key', { type: D.STRING(64), allowNull: true });
    for (const field of ['google_connection_id', 'connection_ref']) {
      await qi.addIndex('GoogleOAuthBrokerBindings', [field, 'cohort'], { unique: true, name: 'cc_oauth_' + field + '_cohort' });
      await qi.removeIndex('GoogleOAuthBrokerBindings', old.get(field));
    }
    await qi.sequelize.query('ALTER TABLE GoogleOAuthBrokerBindings DROP PRIMARY KEY, ADD PRIMARY KEY (google_user_id,cohort)');
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT (SELECT COUNT(*) FROM GoogleOAuthBrokerBindings) + (SELECT COUNT(*) FROM GoogleOAuthBrokerRequests) AS n');
    if (Number(rows[0].n)) throw Error('google_oauth_preserve_cohort_history');
    await qi.sequelize.query('ALTER TABLE GoogleOAuthBrokerBindings DROP PRIMARY KEY, ADD PRIMARY KEY (google_user_id)');
    for (const field of ['google_connection_id', 'connection_ref']) {
      await qi.removeIndex('GoogleOAuthBrokerBindings', 'cc_oauth_' + field + '_cohort');
      await qi.addIndex('GoogleOAuthBrokerBindings', [field], { unique: true, name: field });
    }
    await qi.removeColumn('GoogleOAuthBrokerBindings', 'cohort');
    for (const field of ['cohort', 'policy_version', 'request_scope_key']) await qi.removeColumn('GoogleOAuthBrokerRequests', field);
  },
};
