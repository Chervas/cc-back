'use strict';
// Export exact, successful owned-fixture SQL bytes for a separately reviewed
// transport canary. Never delivers them or populates an operational SQL index.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async({models,report})=>{
  assert.equal(report.database,'campaign_optimization_qa');assert.deepEqual(report.rejected,[]);
  const file=process.env.PLATFORM_AUDIT_FIXTURE_EXPORT;assert(path.isAbsolute(file)&&file.endsWith('.json'));
  const parent=fs.realpathSync(path.dirname(file));assert(parent.startsWith('/home/ubuntu/qa-evidence/'));
  const {unpack}=require('../../../../services/platform-audit/src/event');
  const rows=await models.PlatformAuditEvent.findAll({attributes:['body','digest'],raw:true});
  const records=rows.filter(row=>[20,21,22,23,24].includes(JSON.parse(row.body).version));assert(records.length>0&&records.length<=1000);
  for(const record of records){const event=unpack(record).event;
    assert(['5','59','71'].includes(event.scope.id));assert(event.scope.type==='clinic'||event.scope.type==='group');
    assert.equal(event.subjectUserId||event.actor.id,'91002');
  }
  fs.writeFileSync(file,JSON.stringify({synthetic:true,sourceDatabase:report.database,sourceRoot:report.root,records},null,2)+'\n',{flag:'wx',mode:0o600});
  report.auditCanaryExport={path:file,records:records.length,versions:[...new Set(records.map(row=>JSON.parse(row.body).version))].sort(),delivered:false};
};
