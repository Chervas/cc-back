'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { planRecipientRegistration, captureRecipientRegistration, applyRecipientRegistration } = require('../../lib/recipient-list-registration');
const { buildReviewRequestHistory, hasPriorReviewRequest, isRecordedReviewMessage, reviewItemBlocksRepeat, readReviewRequestHistory } = require('../../lib/review-request-history');
const { resolveLastAttendedAppointmentDate } = require('../../lib/marketing-template-variables');
const list = { id:40,clinica_id:56,objective_id:'mass_sends',source:'imported_file',status:'draft',criteria:{record_kind:'recipient_list'} };
const row = (id, phone, patch = {}) => ({ id,list_id:40,clinica_id:56,paciente_id:null,name:'TESTONLY PERSON',phone,
  custom_fields:{nombre:'TESTONLY',apellidos:'PERSON',fecha_ultimo_tratamiento:'21/10/2026'},...patch });
const patient = (id, phone, patch = {}) => ({ id_paciente:id,clinica_id:56,telefono_movil:phone,telefono_secundario:null,fecha_baja:null,...patch });
test('registration matches exact country-aware phones in the clinic and does not duplicate group or inactive patients', () => {
  const input = { list,rows:[row(1,'600000001'),row(2,'600000002'),row(3,'600000003'),row(4,'600000004'),row(5,'600000005'),row(6,'600000006')],
    patients:[patient(11,'+34 600 000 001'),patient(12,'+34600000002'),patient(13,'600000002'),
      patient(14,'600000003',{clinica_id:57}),patient(15,'600000004',{fecha_baja:'2026-01-01'}),
      patient(16,'600000005',{clinica_id:57}),patient(17,'+44600000006')],memberships:[{paciente_id:16,clinica_id:56}] };
  const before = JSON.stringify(input), plan = planRecipientRegistration(input);
  assert.deepEqual(plan.operations.map(op => op.action), ['link','review','review','review','link','create']);
  assert.equal(plan.operations[1].reason,'ambiguous_phone'); assert.equal(plan.operations[2].reason,'another_group_clinic');
  assert.equal(plan.operations[3].reason,'inactive_patient'); assert.equal(plan.operations[5].phone,'+34600000006');
  assert.equal(JSON.stringify(input),before);
});
test('registration preserves saved links, defers duplicate phones and bad names, and rejects campaign/foreign sources', () => {
  const make = patch => ({list,rows:[row(1,'600000001',patch)],patients:[patient(11,'600000001')],memberships:[]});
  assert.equal(planRecipientRegistration(make({paciente_id:11})).operations[0].action,'preserve');
  assert.equal(planRecipientRegistration(make({paciente_id:99})).operations[0].reason,'saved_link_mismatch');
  assert.equal(planRecipientRegistration(make({clinica_id:99})).operations[0].reason,'foreign_item');
  const input = make(); input.rows.push(row(2,'+34600000001'));
  assert(planRecipientRegistration(input).operations.every(op => op.reason === 'duplicate_source_phone'));
  assert.equal(planRecipientRegistration({list,rows:[row(1,'600000009',{name:'',custom_fields:{}})],patients:[],memberships:[]}).operations[0].reason,'invalid_name');
  for (const patch of [{status:'archived'},{source:'manual_list'},{criteria:{record_kind:'campaign'}},{clinica_id:null}]) {
    assert.throws(() => planRecipientRegistration({...make(),list:{...list,...patch}}),/RECIPIENT_SOURCE_REQUIRED/);
  }
});
test('history keeps accepted/held/queued/archived real sends but excludes unaccepted failures and test-only items', () => {
  for (const state of ['queued','sending','accepted','held_quality','sent','delivered','read','replied']) {
    assert(reviewItemBlocksRepeat({dispatch_status:state,list_status:'archived'}),state);
  }
  assert(reviewItemBlocksRepeat({dispatch_status:'failed',provider_message_id:'TESTONLY accepted'}));
  assert(!reviewItemBlocksRepeat({dispatch_status:'failed',status:'ready',selected:1,list_status:'completed'}));
  assert(reviewItemBlocksRepeat({status:'ready',selected:'1',list_status:'paused'}));
  assert(!reviewItemBlocksRepeat({status:'ready',selected:1,list_status:'archived'}));
  assert(!reviewItemBlocksRepeat({sent_at:new Date(),has_test_event:'1',has_real_event:'0'}));
  assert(reviewItemBlocksRepeat({sent_at:new Date(),has_test_event:'1',has_real_event:'1'}));
  assert(!reviewItemBlocksRepeat({sent_at:new Date(),app_message_id:1,message_metadata:{source:'marketing_bulk_sends',kind:'mass_campaign_test'}}));
  assert(reviewItemBlocksRepeat({sent_at:new Date(),has_test_event:'0',has_real_event:'0'}));
});
test('history deduplicates by patient and full phone identity, including mobile invitations and new patient IDs', () => {
  const history = buildReviewRequestHistory([{paciente_id:1,phone:'600000001',dispatch_status:'accepted'}],[
    {patient_id:null,contact_id:'+34600000002',status:'sent',metadata:{origin:'mobile_app'},content:'Haz click en este enlace que es para dejar la reseña. Si nos pones 5 estrellas estaremos contentos.'},
    {patient_id:3,contact_id:'600000003',status:'read',metadata:{template_usage:'solicitud_resena',test_send:true}},
    {patient_id:4,contact_id:'600000004',status:'failed',metadata:{kind:'mass_campaign_send',template_usage:'solicitud_resena'}},
    {patient_id:5,contact_id:'600000005',status:'pending',metadata:{dispatch_context:'review_request',wamid:'TESTONLY'}},
  ]);
  assert(hasPriorReviewRequest(history,{paciente_id:1,phone:'600000099'}));
  assert(hasPriorReviewRequest(history,{paciente_id:99,phone:'+34 600 000 002'}));
  assert(hasPriorReviewRequest(history,{phone:'600000005'}));
  assert(!hasPriorReviewRequest(history,{phone:'600000003'})); assert(!hasPriorReviewRequest(history,{phone:'600000004'}));
  assert(!hasPriorReviewRequest(history,{phone:'+44600000001'}));
  assert(!isRecordedReviewMessage({metadata:{origin:'mobile_app'},content:'La dirección está en Google, hasta mañana.'}));
  assert(!isRecordedReviewMessage({metadata:{kind:'appointment_preview',template_name:'preview_appointment'}}));
});
test('date exclusion uses the existing native last-treatment date resolver, not only appointment columns', () => {
  const source = fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'),'utf8');
  const start = source.indexOf('function getReviewRuleExclusionReason('), end = source.indexOf('\nfunction ',start+10);
  const fn = vm.runInNewContext(`(${source.slice(start,end)})`,{normalizeText:value=>String(value||''),normalizePhoneDigits:()=>null,resolveLastAttendedAppointmentDate});
  assert.equal(fn(row(1,'600000001'),{no_visit_date:true}),null);
  assert.equal(fn({custom_fields:{fecha_ultimo_tratamiento:'31/02/2026'}},{no_visit_date:true}),'Sin fecha de atención');
  assert.equal(fn({custom_fields:{}},{no_visit_date:true}),'Sin fecha de atención');
  assert.equal(fn(row(1,''),{no_phone:true,no_visit_date:true}),'Sin teléfono móvil');
});

test('owned MySQL: scoped history, atomic registration, rollback, native history numbers and idempotent rerun', {
  skip: process.env.REVIEW_RECIPIENT_REGISTRATION_MYSQL_TEST !== '1',timeout:180000,
}, async () => {
  const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const { DataTypes } = require('sequelize');
    await sql.query('CREATE TABLE Clinicas (id_clinica INT PRIMARY KEY,grupoClinicaId INT)');
    await sql.query('CREATE TABLE LeadIntakes (id INT PRIMARY KEY)');
    await sql.query('INSERT INTO Clinicas VALUES (56,5),(57,5),(99,9)');
    await sql.query('CREATE TABLE PatientHistoryCounters (scope_key VARCHAR(64) PRIMARY KEY,next_number BIGINT NOT NULL)');
    const factories = ['paciente','pacienteclinica','patientcustomfield','patientoperationalevent','marketingpatientlist','marketingpatientlistitem','marketingpatientcontactevent','conversation','message','whatsapptemplate'];
    const models = Object.fromEntries(factories.map(name => [name,require('../../../models/'+name)(sql,DataTypes)]));
    for (const [name,model] of Object.entries(models)) {
      model.options.indexes?.forEach((index,i) => { index.name=`qa_reg_${name}_${i}`; });
      await model.sync();
    }
    const first = await models.paciente.create({public_id:'pac_TESTONLY1',nombre:'TESTONLY',apellidos:'EXISTING',telefono_movil:'+34600000001',clinica_id:56});
    const other = await models.paciente.create({public_id:'pac_TESTONLY2',nombre:'TESTONLY',apellidos:'OTHER',telefono_movil:'+34600000003',clinica_id:57});
    await models.marketingpatientlist.create({...list,name:'TESTONLY external',scope_type:'clinic'});
    await models.marketingpatientlistitem.bulkCreate([row(1,'600000001'),row(2,'600000002'),row(3,'600000003')]);
    const connection = await sql.connectionManager.getConnection();
    const mysql = connection.promise();
    try {
      const initial = await captureRecipientRegistration(mysql,{clinicId:56,listId:40});
      assert.deepEqual(initial.plan.counts,{link:1,create:1,another_group_clinic:1});
      const snapshot = async () => JSON.stringify([await models.paciente.findAll({raw:true,order:[['id_paciente','ASC']]}),await models.marketingpatientlistitem.findAll({raw:true,order:[['id','ASC']]}),(await sql.query('SELECT * FROM PatientHistoryCounters'))[0]]);
      const before = await snapshot();
      await assert.rejects(applyRecipientRegistration(mysql,{clinicId:56,listId:40,actorId:1,expectedSha256:initial.plan.sha256,beforeCommit:async()=>{throw Error('TESTONLY rollback');}}),/TESTONLY rollback/);
      assert.equal(await snapshot(),before);
      const result = await applyRecipientRegistration(mysql,{clinicId:56,listId:40,actorId:1,expectedSha256:initial.plan.sha256,beforeCommit:async journal=>{assert.equal(journal.snapshot.rows.length,3);}});
      assert.equal(result.created,1); assert.equal(result.linkedExisting,1); assert.equal(result.messagesSent,0);
      const created = await models.paciente.findByPk(result.newPatientIds[0],{raw:true});
      assert.equal(created.numero_historia,'3'); assert.equal(created.historia_scope,'group:5'); assert.match(created.public_id,/^pac_[a-f0-9]{20}$/);
      assert.equal(await models.patientcustomfield.count(),1); assert.equal(await models.patientoperationalevent.count(),1);
      assert.equal(await models.message.count(),0); assert.equal(await models.conversation.count(),0);
      const after = await captureRecipientRegistration(mysql,{clinicId:56,listId:40});
      assert.equal(after.plan.counts.preserve,2); assert.equal(after.plan.counts.another_group_clinic,1);
      await assert.rejects(applyRecipientRegistration(mysql,{clinicId:56,listId:40,actorId:1,expectedSha256:initial.plan.sha256,beforeCommit:async()=>{}}),/SOURCE_OR_IDENTITY_CHANGED/);
      const again = await applyRecipientRegistration(mysql,{clinicId:56,listId:40,actorId:1,expectedSha256:after.plan.sha256,beforeCommit:async()=>{}});
      assert.equal(again.created,0); assert.equal(again.linkedExisting,0); assert.equal(await models.paciente.count(),3);
      await models.marketingpatientlist.create({id:41,clinica_id:56,objective_id:'mass_sends',name:'TESTONLY review',source:'manual_list',status:'archived',criteria:{review_request:true}});
      await models.marketingpatientlistitem.bulkCreate([
        {id:10,list_id:41,clinica_id:56,name:'TESTONLY accepted',phone:'600000002',dispatch_status:'accepted',provider_message_id:'TESTONLY accepted'},
        {id:11,list_id:41,clinica_id:56,paciente_id:first.id_paciente,name:'TESTONLY test',phone:'600000001',dispatch_status:'read',sent_at:new Date()},
      ]);
      await models.marketingpatientcontactevent.create({list_id:41,item_id:11,event_type:'mass_campaign_test_sent',channel:'whatsapp'});
      const chat = await models.conversation.create({clinic_id:56,patient_id:other.id_paciente,channel:'whatsapp',contact_id:'+34600000003'});
      await models.message.create({conversation_id:chat.id,direction:'outbound',status:'sent',metadata:{origin:'mobile_app'},content:'Haz click en este enlace que es para dejar la reseña.'});
      const history = await readReviewRequestHistory({clinicIds:[56],query:async(query,replacements)=>(await sql.query(query,{replacements}))[0]});
      assert(hasPriorReviewRequest(history,{paciente_id:created.id_paciente,phone:'600000002'}));
      assert(hasPriorReviewRequest(history,{phone:'600000003'})); assert(!hasPriorReviewRequest(history,{phone:'600000001'}));
      const foreign = await readReviewRequestHistory({clinicIds:[99],query:async(query,replacements)=>(await sql.query(query,{replacements}))[0]});
      assert.equal(foreign.patientIds.size,0); assert.equal(foreign.phoneKeys.size,0);
      await models.marketingpatientlist.create({...list,id:42,name:'TESTONLY volume',scope_type:'clinic'});
      await models.marketingpatientlistitem.bulkCreate(Array.from({length:3658},(_,index) => row(10000+index,String(601000000+index),{list_id:42})));
      const volume = await captureRecipientRegistration(mysql,{clinicId:56,listId:42});
      assert.equal(volume.plan.counts.create,3658);
      const secondRaw = await sql.connectionManager.getConnection();
      try {
        const volumeResult = await applyRecipientRegistration(mysql,{clinicId:56,listId:42,actorId:1,expectedSha256:volume.plan.sha256,
          beforeCommit:async()=>{
            await assert.rejects(applyRecipientRegistration(secondRaw.promise(),{clinicId:56,listId:42,actorId:1,expectedSha256:volume.plan.sha256,beforeCommit:async()=>{}}),/REGISTRATION_BUSY/);
          }});
        assert.equal(volumeResult.created,3658); assert.equal(await models.paciente.count(),3661);
        assert.equal(await models.message.count(),1); assert.equal(await models.patientoperationalevent.count(),3659);
        const [numbers] = await sql.query('SELECT COUNT(*) AS n,COUNT(DISTINCT numero_historia) AS unique_numbers FROM Pacientes');
        assert.equal(Number(numbers[0].n),Number(numbers[0].unique_numbers));
        assert.equal((await captureRecipientRegistration(mysql,{clinicId:56,listId:42})).plan.counts.preserve,3658);
      } finally { await sql.connectionManager.releaseConnection(secondRaw); }
      report.checks.push('Atomic native-counter registration, group conflicts, failure rollback, immutable source, repeated invocation, actual scoped history SQL, old tests and mobile echoes; no providers/real patients.');
    } finally { await sql.connectionManager.releaseConnection(connection); }
  });
});
