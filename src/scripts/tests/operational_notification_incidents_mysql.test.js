'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {createIncidentNotifier}=require('../../lib/operationalNotificationIncidents');
const {archiveReviewedNotices}=require('../../lib/whatsappTemplateNoticeArchive');
test('actual MySQL locks survive concurrent sweeps, transactional failure and administrative archive',async()=>{
 await withIsolatedCampaignMysql(async({sql,report})=>{
  const D=require('sequelize').DataTypes;
  await sql.query('CREATE TABLE WhatsappInboxAdminSync (receipt CHAR(36),waba_id VARCHAR(30),reconciled_at DATETIME(3),PRIMARY KEY(receipt,waba_id))');
  const migration=require('../../../migrations/20261003090000-operational-notification-incidents');
  await migration.up(sql.getQueryInterface());await migration.up(sql.getQueryInterface());
  const Incident=require('../../../models/systemnotificationincident')(sql,D);
  await sql.query('CREATE TABLE SyntheticNotificationOutbox (id INT AUTO_INCREMENT PRIMARY KEY,channel VARCHAR(24),phase VARCHAR(16))');
  let fail=false;
  const create=()=>createIncidentNotifier({sequelize:sql,Incident,namespace:'synthetic',now:()=>Date.parse('2026-10-03T10:00:00Z'),
   channels:()=>['email'],queue:async({transaction,metadata})=>{
    await sql.query('INSERT INTO SyntheticNotificationOutbox(channel,phase) VALUES(?,?)',{replacements:['email',metadata.incident_phase],transaction});
    if(fail)throw Error('synthetic_enqueue_failure');return {created:[{channel:'email'}],skipped:[]};
   }});
  const a={eventKey:'whatsapp.reception_attention',payload:{severity:'critical',title:'Synthetic',detail:'4 inbound; 6 echoes'},
   metadata:{incident_scope:'clinic:72',incident_impact:['reception_delayed']}};
  await Promise.all(Array.from({length:8},()=>create().sync([a])));
  assert.equal((await sql.query('SELECT COUNT(*) n FROM SyntheticNotificationOutbox'))[0][0].n,1);
  await create().sync([a]);assert.equal(await Incident.count(),1);
  fail=true;await assert.rejects(create().sync([{...a,metadata:{...a.metadata,incident_scope:'clinic:66'}}]),/synthetic_enqueue_failure/);
  assert.equal(await Incident.count(),1);assert.equal((await sql.query('SELECT COUNT(*) n FROM SyntheticNotificationOutbox'))[0][0].n,1);
  fail=false;
  await create().sync([{...a,metadata:{...a.metadata,incident_scope:'clinic:66'}}]);
  const shared={...a,metadata:{...a.metadata,incident_scope:'review:shared-synthetic',clinic_ids:[72,66],supersedes_scopes:['clinic:72','clinic:66']}};
  await create().sync([shared]);
  assert.equal((await sql.query('SELECT COUNT(*) n FROM SyntheticNotificationOutbox'))[0][0].n,2);
  assert.equal(await Incident.count({where:{state:'superseded'}}),2);
  assert.equal(await Incident.count({where:{state:'open'}}),1);
  const receipts=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  for(const receipt of receipts)await sql.query('INSERT INTO WhatsappInboxAdminSync(receipt,waba_id) VALUES(?,?)',{replacements:[receipt,'synthetic']});
  await sql.transaction(async transaction=>{
   const result=await archiveReviewedNotices({receipts,reason:'historical_cleanup_20261003',
    query:async(query,params)=>(await sql.query(query,{replacements:params,transaction}))[0]});
   assert.equal(result.archived,2);
  });
  const [archived]=await sql.query('SELECT archived_at,reconciled_at FROM WhatsappInboxAdminSync');
  assert(archived.every(row=>row.archived_at&&row.reconciled_at===null));
  report.checks.push('Eight concurrent sweeps enqueue once; restart deduplicates; rollback is atomic; shared incidents inherit existing notification clocks without fake recovery; archive preserves unreconciled evidence');
 });
});
