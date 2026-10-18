'use strict';

function ownedMysqlTestEntry(env, { allowSkip = false } = {}) {
  // These entrypoints can start only their own fixture. An arbitrary test-named
  // schema or opt-in flag must never authorize a shared server connection.
  if (String(env.WEB_EDITOR_TEST_MYSQL_URL || '').trim()
    || !['', 'false', '0'].includes(String(env.WEB_RUNTIME_TEST_MYSQL_USE_EXISTING_DATABASE || '').trim().toLowerCase())) {
    throw Error('External MySQL targets and existing databases are forbidden; use the owned MySQL fixture');
  }
  if (env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1') {
    if (allowSkip) return false;
    throw Error('Explicit CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 is required for the owned MySQL fixture');
  }
  return true;
}

module.exports = { ownedMysqlTestEntry };
