'use strict';
const assert=require('node:assert/strict');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {fixture}=require('./cliniccloud_catalog_retirement.test');
const {prepare,verifyAfter}=require('../../lib/cliniccloud-import/catalog-retirement');
const {capture,execute,directReferences,snapshots}=require('../cliniccloud-import-catalog-retirement');
const {hash}=require('../../lib/cliniccloud-import/adapter');

withIsolatedCampaignMysql(async({sql,report})=>{
 const mysql=require('mysql2/promise'),socketPath=sql.options.dialectOptions.socketPath;
 const connect=()=>mysql.createConnection({user:'root',socketPath,database:'campaign_optimization_qa',dateStrings:true,timezone:'Z'});
 const c=await connect();try{
  await c.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY,grupoClinicaId INT)');
  await c.query('CREATE TABLE Tratamientos(id_tratamiento INT PRIMARY KEY,id_tratamiento_base INT,codigo VARCHAR(64),nombre VARCHAR(255),clinica_id INT,origen VARCHAR(20),activo INT,precio_base DECIMAL(10,2),descripcion TEXT,duracion_min INT,clinical_config JSON,updatedAt DATETIME)');
  await c.query('CREATE TABLE CitasPacientes(id_cita INT PRIMARY KEY,clinica_id INT,tratamiento_id INT,inicio DATETIME,estado VARCHAR(30),import_metadata JSON)');
  const tables=new Map();
  for(const[table,column]of directReferences){if(table==='Tratamientos')continue;if(!tables.has(table))tables.set(table,new Map());tables.get(table).set(column,'INT');}
  for(const[table,column]of snapshots){if(!tables.has(table))tables.set(table,new Map());tables.get(table).set(column,'JSON');}
  for(const[table,columns]of tables)await c.query(`CREATE TABLE \`${table}\`(id INT PRIMARY KEY,${[...columns].map(([name,type])=>`\`${name}\` ${type}`).join(',')})`);
  await c.query('INSERT INTO Clinicas VALUES(66,29),(72,29)');
  const f=fixture();
  for(const row of f.before.treatments)await c.query('INSERT INTO Tratamientos SET ?',[{...row,clinical_config:JSON.stringify(row.clinical_config)}]);
  await c.query("INSERT INTO CitasPacientes VALUES(1,72,1,'2020-01-01 10:00:00','pendiente',?)",[JSON.stringify({source_system:'cliniccloud',raw:{clinical_text:'Synthetic history'},automation_policy:'hold'})]);
  const before=await capture(c),pkg=prepare({...f,before});assert.equal(pkg.operations.length,2);
  const journal={events:[],async append(v){this.events.push(v);}};
  let r=await execute({c,pkg,journal,dryRun:true});assert.equal(r.status,'rolled_back_and_verified');assert.equal(hash(await capture(c)),pkg.before_sha256);
  report.checks.push('Real SQL retirement dry-run rolls back both old catalogue rows and retains all history bytes.');
  const failing={async append(v){if(v.stage==='retirement_verified_before_commit')throw Error('disk unavailable');}};
  await assert.rejects(execute({c,pkg,journal:failing,dryRun:true}),/disk unavailable/);assert.equal(hash(await capture(c)),pkg.before_sha256);
  await c.query('INSERT INTO PatientVouchers(id,treatment_id) VALUES(1,1)');
  await assert.rejects(execute({c,pkg,journal,dryRun:true}),/AFTER_CHANGED|DEPENDENCIES_CHANGED/);
  await c.query('DELETE FROM PatientVouchers WHERE id=1'); // Synthetic fixture only.
  await c.query('INSERT INTO EconomicBudgetVersions(id,`lines`) VALUES(1,?)',[JSON.stringify([{program:{appointments:[{treatment_ids:[1]}]}}])]);
  const dependent=prepare({...f,before:await capture(c)});assert.deepEqual(dependent.operations.map(o=>o.id),[2]);
  await c.query('DELETE FROM EconomicBudgetVersions WHERE id=1');
  report.checks.push('Journal failure rolls back; new voucher invalidates the old package; nested programme line protects its original treatment.');
  // An in-flight canonical booking already holding the clinic SHARE lock
  // completes before the operator captures; the stale package must abort.
  const other=await connect();try{
   await other.beginTransaction();await other.query('SELECT * FROM Clinicas WHERE id_clinica=72 FOR SHARE');
   await other.query("INSERT INTO CitasPacientes VALUES(2,72,1,'2026-10-01 10:00:00','pendiente',NULL)");
   const running=execute({c,pkg,journal,dryRun:true});const outcome=running.then(v=>({v}),e=>({e}));
   await other.commit();const result=await outcome;assert(result.e);assert.match(result.e.message,/AFTER_CHANGED|DEPENDENCIES_CHANGED/);
  }finally{await other.end();}
  const protectedPackage=prepare({...f,before:await capture(c)});assert.deepEqual(protectedPackage.operations.map(o=>o.id),[2]);
  await c.query("INSERT INTO CitasPacientes VALUES(3,72,NULL,'2026-09-20 22:30:00','pendiente',?)",[JSON.stringify({source_service_id:'9002'})]);
  assert.equal(prepare({...f,before:await capture(c)}).operations.length,0);
  await c.query('DELETE FROM CitasPacientes WHERE id_cita=3');
  r=await execute({c,pkg:protectedPackage,journal,independentFactory:connect});assert.equal(r.retired,1);
  verifyAfter(await capture(c),protectedPackage);
  r=await execute({c,pkg:protectedPackage,journal,independentFactory:connect});assert.deepEqual(r,{status:'replay_preserved',retired:0});
  assert.equal((await c.query('SELECT activo FROM Tratamientos WHERE id_tratamiento=1'))[0][0].activo,1);
  assert.equal((await c.query('SELECT COUNT(*) n FROM CitasPacientes'))[0][0].n,2);
  report.checks.push('Earlier clinic-locked booking is captured and preserved; one independent retirement commits and readback/replay preserve appointments, old price and source.');
  await c.query('ALTER TABLE PatientVouchers ADD COLUMN extra_treatment_id INT');
  await assert.rejects(capture(c),/REFERENCE_SCHEMA_CHANGED/);
  report.checks.push('An unreviewed direct treatment consumer blocks the operator instead of silently retiring its references.');
 }finally{await c.end();}
}).catch(e=>{console.error(e);process.exitCode=1;});
