'use strict';
const assert=require('node:assert/strict'),Sequelize=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {relatedClinics}=require('../../lib/availability-realtime');
withIsolatedCampaignMysql(async({sql,report})=>{
  for(const statement of [
    'CREATE TABLE Instalaciones(id INT PRIMARY KEY,clinica_id INT NOT NULL,INDEX(clinica_id))',
    'CREATE TABLE InstallationPhysicalAliases(installation_id INT PRIMARY KEY,canonical_installation_id INT NOT NULL,INDEX(canonical_installation_id))',
    'CREATE TABLE DoctorClinicas(id INT PRIMARY KEY,doctor_id INT NOT NULL,clinica_id INT NOT NULL,activo BOOLEAN NOT NULL,recibe_citas BOOLEAN NOT NULL,INDEX(clinica_id,doctor_id),INDEX(doctor_id))',
    'CREATE TABLE BookingEquipment(id INT PRIMARY KEY,owner_clinic_id INT NOT NULL,INDEX(owner_clinic_id))',
    'CREATE TABLE BookingEquipmentClinics(equipment_id INT NOT NULL,clinic_id INT NOT NULL,PRIMARY KEY(equipment_id,clinic_id),INDEX(clinic_id))',
    'INSERT INTO Instalaciones VALUES(101,71),(102,72),(103,79),(105,71),(106,75),(107,76)',
    'INSERT INTO InstallationPhysicalAliases VALUES(102,101),(105,107),(106,107)',
    'INSERT INTO DoctorClinicas VALUES(1,10,71,1,1),(2,10,73,1,1),(3,11,71,1,1),(4,11,77,0,1),(5,11,79,1,0)',
    'INSERT INTO BookingEquipment VALUES(1,71),(2,78)',
    'INSERT INTO BookingEquipmentClinics VALUES(1,74),(2,71)',
  ])await sql.query(statement);
  const db={sequelize:sql,Sequelize};
  assert.deepEqual(await relatedClinics({db,clinicIds:[71]}),[72,73,74,75,76,78]);
  report.checks.push('one actual SQL query covers canonical room, alias-to-alias, shared doctor and both equipment ownership directions');
  assert.deepEqual(await relatedClinics({db,clinicIds:[80]}),[]);
  assert.deepEqual(await relatedClinics({db,clinicIds:[79]}),[71]);
  report.checks.push('unrelated clinic receives no signal; inactive/non-bookable peer memberships do not generate targets');
  await sql.query('DELETE FROM InstallationPhysicalAliases WHERE installation_id=102');
  await sql.query('DELETE FROM BookingEquipmentClinics WHERE equipment_id=1 AND clinic_id=74');
  assert.deepEqual(await relatedClinics({db,clinicIds:[71,73]}),[75,76,78]);
  report.checks.push('next batch immediately observes changed sharing metadata, excludes clinics already changed in that batch');
}).catch(e=>{console.error(e);process.exitCode=1;});
