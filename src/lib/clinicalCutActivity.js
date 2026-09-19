'use strict';
const { digest } = require('./securitySchemaContract');
const SQL = Object.freeze({
  jobs: "SELECT COUNT(*) n FROM JobRequests WHERE status='running'",
  emails: "SELECT COUNT(*) n FROM EmailMessages WHERE status='sending'",
  flows: "SELECT COUNT(*) n FROM FlowExecutionsV2 WHERE status='running'",
  dueStaging: "SELECT COUNT(*) n FROM JobRequests WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.__runtime_namespace'))='staging' AND status IN ('pending','waiting') AND (next_run_at IS NULL OR next_run_at<=NOW())",
});
async function clinicalCutActivity(query, { admissionClosed = false } = {}) {
  const counts = {};
  for (const [name, sql] of Object.entries(SQL)) {
    const value = Number((await query(sql))[0].n);
    if (!Number.isSafeInteger(value) || value < 0) throw Error('clinical_cut_activity_count_invalid');
    counts[name] = value;
    if (value && !(name === 'dueStaging' && admissionClosed)) throw Error('clinical_cut_active_work_' + name);
  }
  return counts;
}
async function pendingJobFingerprint(query, columns) {
  if (!Array.isArray(columns) || !columns.includes('id') || !columns.includes('payload')
    || columns.some(c => !/^[A-Za-z][A-Za-z0-9_]*$/.test(c))) throw Error('clinical_cut_job_columns_invalid');
  const fields = columns.map(c => "'" + c + "',`" + c + '`').join(',');
  const rows = await query('SELECT SHA2(CAST(JSON_OBJECT(' + fields + ') AS CHAR CHARACTER SET utf8mb4),256) row_digest FROM JobRequests'
    + " WHERE status IN ('pending','waiting','queued') ORDER BY id");
  return { count: rows.length, digest: digest(rows.map(row => row.row_digest)) };
}
module.exports = { clinicalCutActivity, pendingJobFingerprint };
