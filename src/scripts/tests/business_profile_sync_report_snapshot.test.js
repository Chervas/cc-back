'use strict';
require('./fixtures/scheduled_jobs.fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Sequelize,DataTypes,QueryTypes}=require('sequelize');
const db=require('../../../models');
const {MetaSyncJobs}=require('../../jobs/sync.jobs');

// Use Sequelize's real instance.update/save, JSON dirty tracking and MySQL
// query serializer. Only the final SQL dispatch is an offline acknowledgement.
// Queue/socket/production-model access remains forbidden by the fixture above.
for(const method of ['executeBusinessProfileSync','executeBusinessProfileReviewsSync']){
  test(method+' freezes progress and serializes the final partial-failure report',async t=>{
    const sql=new Sequelize('offline','offline','fictitious',{dialect:'mysql',logging:false});
    const Model=sql.define('OfflineGbpSyncLog',{id:{type:DataTypes.INTEGER,primaryKey:true},job_type:DataTypes.STRING,
      status:DataTypes.STRING,records_processed:DataTypes.INTEGER,status_report:DataTypes.JSON,
      error_message:DataTypes.STRING,start_time:DataTypes.DATE,end_time:DataTypes.DATE},{timestamps:false});
    const updates=[],queries=[];
    sql.query=async(statement,options)=>{
      assert.equal(options.type,QueryTypes.UPDATE);
      const query=typeof statement==='string'?statement:statement.query;
      assert.match(query,/^UPDATE `OfflineGbpSyncLogs` SET /);
      const bind=typeof statement==='string'?options.bind:statement.bind;
      queries.push({query,bind:structuredClone(bind)});
      return [options.instance,1];
    };
    const originals={findAll:db.ClinicBusinessLocation.findAll,create:db.SyncLog.create,
      binding:db.BusinessProfileBrokerBinding.findByPk,revocation:db.BusinessProfileBrokerRevocation.findByPk};
    const locations=[1,2,3].map(id=>({id,location_id:'locations/'+id,clinica_id:66,google_connection_id:9,
      update:async()=>{}}));
    db.ClinicBusinessLocation.findAll=async()=>locations;
    db.BusinessProfileBrokerBinding.findByPk=async()=>null;
    db.BusinessProfileBrokerRevocation.findByPk=async()=>null;
    db.SyncLog.create=async values=>{
      const row=Model.build({id:701,status_report:null,...values},{isNewRecord:false,raw:true});
      const update=row.update.bind(row);
      row.update=async patch=>{updates.push(patch);return update(patch);};
      return row;
    };
    const quiet={log:console.log,warn:console.warn,error:console.error};
    console.log=console.warn=console.error=()=>{};
    t.after(async()=>{
      db.ClinicBusinessLocation.findAll=originals.findAll;db.SyncLog.create=originals.create;
      db.BusinessProfileBrokerBinding.findByPk=originals.binding;db.BusinessProfileBrokerRevocation.findByPk=originals.revocation;
      Object.assign(console,quiet);await sql.close();
    });
    const jobs=new MetaSyncJobs();jobs.config.local.betweenLocationsSleepMs=0;
    jobs._ensureGoogleAccessToken=async()=>({accessToken:'FICTITIOUS_OFFLINE_TOKEN'});
    jobs._syncBusinessProfileLocationDetails=async()=>({});
    jobs._syncBusinessProfileVoiceOfMerchantState=async()=>({hasVoiceOfMerchant:true});
    jobs._syncBusinessProfileMetrics=async()=>1;jobs._syncBusinessProfilePosts=async()=>0;
    jobs._syncBusinessProfileMedia=async()=>0;jobs._mergeBusinessProfileLocation=async()=>{};
    jobs._syncBusinessProfileReviews=async location=>{if(location.id===3)throw Error('provider_failed');return 2;};
    const result=await jobs[method]();
    assert.equal(result.status,'failed');assert.equal(result.processed,2);assert.equal(result.report.errors.length,1);
    assert.equal(result.report.failedLocations,1);
    assert.equal(updates[0].status_report.processed,1);assert.deepEqual(updates[0].status_report.errors,[]);
    assert.equal(updates[1].status_report.processed,2);assert.deepEqual(updates[1].status_report.errors,[]);
    assert.notEqual(updates[0].status_report,updates[1].status_report);
    assert.notEqual(updates.at(-1).status_report,result.report);
    assert.deepEqual(updates.at(-1).status_report,result.report);
    assert.equal(queries.length,3);
    const serialized=queries.map(({bind})=>Object.values(bind).find(value=>typeof value==='string'&&value.startsWith('{')));
    assert(serialized.every(Boolean),'Every progress/final SQL UPDATE must include a serialized JSON snapshot');
    const snapshots=serialized.map(value=>JSON.parse(value));
    assert.equal(snapshots[0].processed,1);assert.deepEqual(snapshots[0].errors,[]);
    assert.deepEqual(snapshots.at(-1),result.report);
    assert.equal(snapshots.at(-1).errors[0].message,'provider_failed');
  });
}
