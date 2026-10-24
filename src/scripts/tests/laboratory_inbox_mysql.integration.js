'use strict';
const assert=require('node:assert/strict');
const {DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async({sql,models:db,report})=>{
  db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},configuracion:D.JSON},{tableName:'Clinicas',timestamps:false});
  db.Paciente=sql.define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},public_id:D.STRING,clinica_id:D.INTEGER,nombre:D.STRING,apellidos:D.STRING},{tableName:'Pacientes',timestamps:false});
  db.PacienteClinica=sql.define('PacienteClinica',{id:{type:D.INTEGER,primaryKey:true,autoIncrement:true},paciente_id:D.INTEGER,clinica_id:D.INTEGER},{tableName:'PacienteClinicas',timestamps:false});
  db.DentalPlan=sql.define('DentalPlan',{id:{type:D.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},public_id:D.STRING,clinic_id:D.INTEGER,patient_id:D.INTEGER,state:D.JSON,status:D.STRING},{tableName:'DentalPlans',timestamps:false});
  db.DentalSupportingTools=require('../../../models/dentalsupportingtools')(sql,D);
  db.DentalSupportingToolsRevision=require('../../../models/dentalsupportingtoolsrevision')(sql,D);
  db.ClinicSupplier=require('../../../models/clinicsupplier')(sql,D);
  await sql.sync();
  await db.Clinica.bulkCreate([{id_clinica:72,configuracion:{disciplinas:['dental'],timezone:'Europe/Madrid'}},{id_clinica:73,configuracion:{timezone:'Atlantic/Canary'}}]);
  await db.Paciente.bulkCreate([
    {id_paciente:1,public_id:'owned-one',clinica_id:72,nombre:'Paciente',apellidos:'Ficticio'},
    {id_paciente:2,public_id:'owned-linked',clinica_id:73,nombre:'Vinculado',apellidos:'Ficticio'},
    {id_paciente:3,public_id:'foreign-unlinked',clinica_id:73,nombre:'Ajeno',apellidos:'Ficticio'},
  ]);
  // Duplicate memberships must never multiply the orders in summaries or pages.
  await db.PacienteClinica.bulkCreate([{paciente_id:2,clinica_id:72},{paciente_id:2,clinica_id:72}]);
  const C=require('../../lib/dental-supporting-tools-contract');
  const statuses=['draft','requested','received','rejected','approved'];
  const expected={draft:0,requested:0,received:0,rejected:0,approved:0,overdue:0,total:0};
  async function fixture(index,{clinic=72,patient=1,toolPatient=patient,valid=true,orders}={}){
    const status=statuses[index%statuses.length];
    const plan=await db.DentalPlan.create({public_id:'owned-plan-'+index,clinic_id:clinic,patient_id:patient,state:{title:'Plan ficticio '+index},status:'active'});
    const labs=orders||[{id:'owned-order-'+index,title:index===64?'Prótesis lejana %_!':'Trabajo ficticio '+index,laboratory:'Laboratorio sintético',status,
      act_ids:['act-'+index],expected_delivery_on:status==='requested'?(index%2?'2026-10-24':'2026-10-25'):null,
      needed_on:'2026-10-28',request_before:'2026-10-26',instructions:'PRIVATE_CLINICAL_INSTRUCTION',events:[{notes:'PRIVATE_CLINICAL_NOTES'}]}];
    await db.DentalSupportingTools.create({public_id:'owned-tools-'+index,plan_id:plan.id,clinic_id:clinic,patient_id:toolPatient,state:{...C.emptyState(),lab_orders:labs},version_number:3,created_by:7,updated_by:7});
    if(valid)for(const order of labs){expected[order.status]++;expected.total++;if(order.status==='requested'&&order.expected_delivery_on&&order.expected_delivery_on<'2026-10-25')expected.overdue++;}
  }
  for(let index=0;index<65;index++)await fixture(index);
  await fixture(65,{patient:2});
  await fixture(66,{orders:[{id:'owned-no-date',title:'Sin fecha confirmada',laboratory:'Laboratorio sintético',status:'requested',act_ids:[]}]});
  await fixture(67,{orders:[{id:'owned-multi-a',title:'Varios A',laboratory:'Laboratorio sintético',status:'draft',act_ids:[]},{id:'owned-multi-b',title:'Varios B',laboratory:'Laboratorio sintético',status:'received',act_ids:[]}]});
  await fixture(90,{patient:3,valid:false});
  await fixture(91,{clinic:73,patient:3,valid:false});
  await fixture(92,{patient:1,toolPatient:2,valid:false});
  const {createDentalSupportingToolsService}=require('../../services/dentalSupportingTools.service');
  const service=createDentalSupportingToolsService({db,now:()=>new Date('2026-10-24T23:30:00.000Z'),resolveRole:async()=> 'doctor',canAccess:async({actorId,featureKey})=>actorId===7||actorId===8&&['patients.view','patients.sensitive.view','appointments.manage'].includes(featureKey)});
  const scope={actorId:7,clinicId:72,status:'all',limit:7};
  const first=await service.laboratory(scope);
  assert.deepEqual(first.summary,expected);
  assert.equal(first.filtered_total,expected.total);assert.equal(first.today,'2026-10-25');assert.equal(first.timezone,'Europe/Madrid');
  assert.equal(first.items.length,7);assert(first.next_cursor);assert(first.items.every(order=>order.status==='requested'&&order.expected_delivery_on==='2026-10-24'));
  assert(!JSON.stringify(first).includes('PRIVATE_CLINICAL_'),'global logistics DTO must not expose instructions or clinical event notes');
  const seen=new Set();let page=first;
  for(;;){for(const order of page.items){const key=order.plan_id+':'+order.id;assert(!seen.has(key),'keyset pages cannot repeat orders');seen.add(key);}if(!page.next_cursor)break;page=await service.laboratory({...scope,cursor:page.next_cursor});assert.deepEqual(page.summary,expected);}
  assert.equal(seen.size,expected.total);assert(seen.has('owned-plan-64:owned-order-64'),'late plans are included beyond the former first 21 rows');
  assert(seen.has('owned-plan-65:owned-order-65'),'linked patient belongs to the authorized clinic');
  assert(!seen.has('owned-plan-90:owned-order-90'));assert(!seen.has('owned-plan-92:owned-order-92'));
  report.checks.push('All clinic orders across >65 plans counted and searched before keyset pagination; no duplicates, no first-plan cutoff, primary/shared membership enforced, mismatched plan-patient and foreign clinic excluded.');
  const lastSearch=await service.laboratory({...scope,q:'protesis sintetico'});assert.equal(lastSearch.items.length,1);assert.equal(lastSearch.items[0].id,'owned-order-64');assert.equal(lastSearch.filtered_total,1);assert.deepEqual(lastSearch.summary,expected);
  const literal=await service.laboratory({...scope,q:'%_!'});assert.equal(literal.items.length,1);assert.equal(literal.items[0].id,'owned-order-64');
  const injection=await service.laboratory({...scope,q:"' OR 1=1 --"});assert.equal(injection.filtered_total,0);assert.equal(injection.items.length,0);
  const received=await service.laboratory({...scope,status:'received'});assert.equal(received.filtered_total,expected.received);assert(received.items.every(order=>order.status==='received'));
  const pending=await service.laboratory({...scope,status:'pending',limit:100});assert.equal(pending.filtered_total,expected.total-expected.approved);assert(pending.items.every(order=>order.status!=='approved'));
  report.checks.push('Accent-insensitive multiword search covers late plans; LIKE wildcards remain literal, SQL-like input cannot alter scope, global counters independent of active query/status, filtered_total accurate.');
  for(const changed of [{q:'other'},{status:'pending'},{clinicId:73}])await assert.rejects(service.laboratory({...scope,...changed,cursor:first.next_cursor}),{code:'dental_tools_cursor_invalid'});
  for(const cursor of ['@@',Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(first.next_cursor,'base64url')),date:'2026-02-30'})).toString('base64url')])await assert.rejects(service.laboratory({...scope,cursor}),{code:'dental_tools_cursor_invalid'});
  await assert.rejects(service.laboratory({...scope,q:'a'.repeat(181)}),{code:'dental_tools_text_invalid'});
  await assert.rejects(service.laboratory({...scope,actorId:9}),{code:'dental_tools_forbidden'});
  assert.equal((await service.laboratory({...scope,actorId:8})).summary.total,expected.total);
  report.checks.push('Cursor binds clinic/status/search/civil day and validates dates. Madrid late-night civil date determines overdue; unconfirmed delivery is never overdue. Reception logistics permission reads without clinical permission; denied actor rejected.');
  const supplier=await db.ClinicSupplier.create({id:'owned-active-supplier',clinic_id:72,name:'Proveedor canónico ficticio',type:'distributor',active:true,version:1,created_by:7,updated_by:7});
  await db.ClinicSupplier.create({id:'owned-foreign-supplier',clinic_id:73,name:'Proveedor de otra clínica',type:'laboratory',active:true,version:1,created_by:7,updated_by:7});
  const linkedPlan=await db.DentalPlan.create({public_id:'owned-supplier-plan',clinic_id:72,patient_id:1,state:{acts:[],sessions:[],reservations:[]},status:'active'});
  const linkedScope={actorId:7,clinicId:72,planId:linkedPlan.public_id,patientIdentifier:1};
  const payload={expected_version:0,idempotency_key:'owned-supplier-lab-create',command:{type:'lab.create',order:{title:'Corona ficticia vinculada',supplier_id:supplier.id,laboratory:'Nombre manipulado'}}};
  const created=await service.command({...linkedScope,payload});const linkedId=created.item.lab_orders[0].id;
  assert.equal(created.item.lab_orders[0].supplier_id,supplier.id);assert.equal(created.item.lab_orders[0].laboratory,'Proveedor canónico ficticio');
  assert.equal((await service.command({...linkedScope,payload})).replayed,true);
  await supplier.update({name:'Nombre posterior',active:false});
  const retained=await service.command({...linkedScope,payload:{expected_version:1,idempotency_key:'owned-after-supplier-archive',command:{type:'message.add',text:'Seguimiento logístico ficticio',context:{kind:'lab_order',id:linkedId}}}});
  assert.equal(retained.item.lab_orders[0].laboratory,'Proveedor canónico ficticio','renaming supplier never rewrites the recorded historical name');
  for(const supplierId of [supplier.id,'owned-foreign-supplier'])await assert.rejects(service.command({...linkedScope,payload:{expected_version:2,idempotency_key:'owned-reject-'+supplierId,command:{type:'lab.create',order:{title:'No debe guardarse',supplier_id:supplierId,laboratory:'Manipulado'}}}}),{code:'dental_tools_supplier_scope'});
  assert.equal((await service.read(linkedScope)).item.version,2,'invalid supplier selection must not write a revision');
  await supplier.update({active:true});
  const rebound=await service.command({...linkedScope,payload:{expected_version:2,idempotency_key:'owned-reselect-supplier',command:{type:'lab.update',id:linkedId,patch:{supplier_id:supplier.id,laboratory:'Manipulado'}}}});
  assert.equal(rebound.item.lab_orders[0].laboratory,'Nombre posterior');
  const manual=await service.command({...linkedScope,payload:{expected_version:3,idempotency_key:'owned-manual-supplier-name',command:{type:'lab.update',id:linkedId,patch:{laboratory:'Proveedor antiguo escrito a mano'}}}});
  assert.equal(manual.item.lab_orders[0].supplier_id,null);
  const unlinked=await service.command({...linkedScope,payload:{expected_version:4,idempotency_key:'owned-explicit-supplier-clear',command:{type:'lab.update',id:linkedId,patch:{supplier_id:null}}}});
  assert.equal(unlinked.item.lab_orders[0].supplier_id,null);assert.equal(unlinked.item.lab_orders[0].laboratory,'Proveedor antiguo escrito a mano');
  const historical=await service.read({...linkedScope,version:1});assert.equal(historical.item.lab_orders[0].laboratory,'Proveedor canónico ficticio');assert.equal(historical.item.lab_orders[0].supplier_id,supplier.id);
  report.checks.push('Lab commands resolve active supplier in exact clinic, ignore forged name, preserve name/revision after rename/archive, reject inactive/foreign supplier transactionally, allow distributor components, explicitly unlink legacy manual names and preserve command replay.');
}).catch(error=>{console.error(error);process.exitCode=1;});
