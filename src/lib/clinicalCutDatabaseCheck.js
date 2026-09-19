'use strict';
const assert = require('node:assert/strict');
const schema = require('./securitySchemaContract');
const meta = require('./metaClinicalSchemaRelease');
const { clinicalCutActivity, pendingJobFingerprint } = require('./clinicalCutActivity');
const historicalSql = "SELECT type,status,COUNT(*) n FROM JobRequests WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.__runtime_namespace'))='gateway' AND status IN ('pending','waiting','running') GROUP BY type,status ORDER BY type,status";
async function clinicalCutDatabaseCheck({ connect, plan, info, policy=meta, admissionClosed=false, stopped=false, expectedPending }) {
  const connection = await connect();
  const query = async(sql, values=[]) => (await connection.query({sql, values, timeout:10000}))[0];
  try {
    assert.equal((await query('SELECT DATABASE() db'))[0].db,plan.database,'clinical_cut_database_changed');
    await query('SET TRANSACTION READ ONLY');await connection.beginTransaction();
    const counts=await clinicalCutActivity(query,{admissionClosed});
    const others=Number((await query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=? AND ID<>CONNECTION_ID()',[plan.database]))[0].n);
    if(stopped)assert.equal(others,0,'clinical_cut_other_connections');
    const actual=await schema.snapshot(query),rows=await policy.rowFingerprints(query,plan.columns);
    policy.validate(plan,actual,rows,info,plan.database);
    const columns=plan.before.columns.filter(c=>c.TABLE_NAME==='JobRequests').map(c=>c.COLUMN_NAME);
    const pendingJobs=await pendingJobFingerprint(query,columns);
    if(expectedPending)assert.deepEqual(pendingJobs,expectedPending,'clinical_cut_pending_jobs_changed');
    const historicalGatewayDigest=schema.digest(await query(historicalSql));await connection.commit();
    return {counts,otherClinicalConnections:others,schemaDigest:schema.digest(actual),rows,pendingJobs,historicalGatewayDigest};
  } finally {await connection.end();}
}
module.exports={clinicalCutDatabaseCheck,historicalSql};
