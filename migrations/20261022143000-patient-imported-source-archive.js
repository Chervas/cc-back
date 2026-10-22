'use strict';
module.exports={
  async up(q,S){
    await q.createTable('ImportedClinicalCatalogs',{
      id:{type:S.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true,allowNull:false},
      clinic_id:{type:S.INTEGER,allowNull:false,references:{model:'Clinicas',key:'id_clinica'},onDelete:'RESTRICT'},
      source_system:{type:S.STRING(32),allowNull:false},source_instance:{type:S.STRING(100),allowNull:false},
      bundle_sha256:{type:S.CHAR(64),allowNull:false},source_zip_sha256:{type:S.CHAR(64),allowNull:false},catalog_sha256:{type:S.CHAR(64),allowNull:false},
      context_json:{type:S.TEXT('medium'),allowNull:false},imported_at:{type:S.DATE,allowNull:false},actor_user_id:{type:S.INTEGER,allowNull:false},
    });
    await q.addIndex('ImportedClinicalCatalogs',['clinic_id','source_instance','bundle_sha256'],{unique:true,name:'imported_clinical_catalog_batch_unique'});
    await q.addIndex('ImportedClinicalCatalogs',['id','clinic_id'],{unique:true,name:'imported_clinical_catalog_owner_unique'});
    await q.createTable('PatientImportedIdentities',{
      id:{type:S.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true,allowNull:false},
      catalog_id:{type:S.BIGINT.UNSIGNED,allowNull:false,references:{model:'ImportedClinicalCatalogs',key:'id'},onDelete:'RESTRICT'},
      patient_id:{type:S.INTEGER,allowNull:false,references:{model:'Pacientes',key:'id_paciente'},onDelete:'RESTRICT'},
      clinic_id:{type:S.INTEGER,allowNull:false,references:{model:'Clinicas',key:'id_clinica'},onDelete:'RESTRICT'},
      source_system:{type:S.STRING(32),allowNull:false},source_instance:{type:S.STRING(100),allowNull:false},source_patient_id:{type:S.STRING(80),allowNull:false},
      source_history_number:{type:S.STRING(100),allowNull:true},bundle_sha256:{type:S.CHAR(64),allowNull:false},
      messages_hold:{type:S.BOOLEAN,allowNull:false,defaultValue:true},
      imported_at:{type:S.DATE,allowNull:false},actor_user_id:{type:S.INTEGER,allowNull:false},
    });
    await q.addConstraint('PatientImportedIdentities',{fields:['catalog_id','clinic_id'],type:'foreign key',name:'patient_imported_identity_catalog_owner_fk',references:{table:'ImportedClinicalCatalogs',fields:['id','clinic_id']},onDelete:'RESTRICT',onUpdate:'RESTRICT'});
    await q.addIndex('PatientImportedIdentities',['source_system','source_instance','source_patient_id'],{unique:true,name:'patient_imported_identity_source_unique'});
    await q.addIndex('PatientImportedIdentities',['id','patient_id','clinic_id'],{unique:true,name:'patient_imported_identity_owner_unique'});
    await q.addIndex('PatientImportedIdentities',['patient_id','clinic_id'],{name:'patient_imported_identity_patient_clinic'});
    await q.addIndex('PatientImportedIdentities',['patient_id','messages_hold'],{name:'patient_imported_identity_messages_hold'});
    await q.createTable('PatientImportedSourceRecords',{
      id:{type:S.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true,allowNull:false},
      identity_id:{type:S.BIGINT.UNSIGNED,allowNull:false,references:{model:'PatientImportedIdentities',key:'id'},onDelete:'RESTRICT'},
      patient_id:{type:S.INTEGER,allowNull:false,references:{model:'Pacientes',key:'id_paciente'},onDelete:'RESTRICT'},
      clinic_id:{type:S.INTEGER,allowNull:false,references:{model:'Clinicas',key:'id_clinica'},onDelete:'RESTRICT'},
      source_key:{type:S.CHAR(64),allowNull:false},source_database:{type:S.STRING(120),allowNull:false},source_table:{type:S.STRING(80),allowNull:false},
      category:{type:S.STRING(32),allowNull:false},record_date:{type:S.DATEONLY,allowNull:true},
      row_sha256:{type:S.CHAR(64),allowNull:false},database_sha256:{type:S.CHAR(64),allowNull:false},bundle_sha256:{type:S.CHAR(64),allowNull:false},
      record_json:{type:S.TEXT('medium'),allowNull:false},imported_at:{type:S.DATE,allowNull:false},
    });
    await q.addConstraint('PatientImportedSourceRecords',{fields:['identity_id','patient_id','clinic_id'],type:'foreign key',name:'patient_imported_record_identity_owner_fk',references:{table:'PatientImportedIdentities',fields:['id','patient_id','clinic_id']},onDelete:'RESTRICT',onUpdate:'RESTRICT'});
    await q.addIndex('PatientImportedSourceRecords',['identity_id','source_key'],{unique:true,name:'patient_imported_record_source_unique'});
    await q.addIndex('PatientImportedSourceRecords',['patient_id','clinic_id','record_date','id'],{name:'patient_imported_record_patient_date'});
    await q.addIndex('PatientImportedSourceRecords',['patient_id','clinic_id','category'],{name:'patient_imported_record_category'});
  },
  async down(){throw Error('IMPORTED_CLINICAL_ARCHIVE_REQUIRES_REVIEWED_RECOVERY');},
};
