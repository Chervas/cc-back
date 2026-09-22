'use strict';
module.exports={
  async up(qi,S){
    const [columns]=await qi.sequelize.query("SHOW COLUMNS FROM `ClinicMetaAssets` LIKE 'metaConnectionId'");
    if(columns.length!==1||columns[0].Type!=='int')throw Error('whatsapp_catalog_schema_mismatch');
    const [authorization]=await qi.sequelize.query("SHOW COLUMNS FROM `ClinicMetaAssets` LIKE 'whatsappAuthorizationId'");
    if(!authorization.length){
      if(columns[0].Null!=='NO')throw Error('whatsapp_catalog_schema_mismatch');
      await qi.sequelize.query('ALTER TABLE `ClinicMetaAssets` ADD COLUMN `whatsappAuthorizationId` varchar(36) NULL, MODIFY COLUMN `metaConnectionId` int NULL, ADD UNIQUE INDEX `uniq_whatsapp_authorization_asset` (`whatsappAuthorizationId`)');
    }else{
      const indexes=await qi.showIndex('ClinicMetaAssets');
      if(columns[0].Null!=='YES'||authorization[0].Type!=='varchar(36)'||!indexes.some(i=>i.name==='uniq_whatsapp_authorization_asset'&&i.unique))throw Error('whatsapp_catalog_schema_mismatch');
    }
    // MySQL disallows CHECK on a column participating in a cascading FK.
    // Keep that historical FK unchanged and enforce the independent identity
    // on explicit writes with narrow insert/update guards.
    for(const operation of ['INSERT','UPDATE']){
      const name='guard_whatsapp_catalog_'+operation.toLowerCase();
      const [triggers]=await qi.sequelize.query('SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=:name',{replacements:{name}});
      const body="BEGIN IF NEW.metaConnectionId IS NULL AND (NEW.assetType <> 'whatsapp_phone_number' OR NEW.whatsappAuthorizationId IS NULL) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='whatsapp_catalog_identity_required'; END IF; END";
      if(!triggers.length)await qi.sequelize.query('CREATE TRIGGER `'+name+'` BEFORE '+operation+' ON `ClinicMetaAssets` FOR EACH ROW '+body);
      else if(triggers[0].ACTION_STATEMENT!==body)throw Error('whatsapp_catalog_schema_mismatch');
    }
    await qi.createTable('WhatsappPhoneActivations',{
      authorization_id:{type:S.STRING(36),primaryKey:true,allowNull:false},
      asset_id:{type:S.INTEGER,allowNull:false,unique:true,references:{model:'ClinicMetaAssets',key:'id'},onDelete:'RESTRICT',onUpdate:'CASCADE'},
      scope_type:{type:S.STRING(16),allowNull:false},scope_id:{type:S.INTEGER,allowNull:false},clinic_ids:{type:S.JSON,allowNull:false},
      connection_ref:{type:S.STRING(128),allowNull:false,unique:true},phone_id:{type:S.STRING(30),allowNull:false,unique:true},waba_id:{type:S.STRING(30),allowNull:false},
      state:{type:S.STRING(32),allowNull:false},profile:{type:S.JSON,allowNull:false},
      message_not_before:{type:S.DATE(3),allowNull:false},updated_by:{type:S.INTEGER,allowNull:false},
      created_at:{type:S.DATE(3),allowNull:false},updated_at:{type:S.DATE(3),allowNull:false},
    });
    if(!(await qi.showIndex('WhatsappPhoneActivations')).some(i=>i.name==='idx_whatsapp_activation_scope'))
      await qi.addIndex('WhatsappPhoneActivations',['scope_type','scope_id'],{name:'idx_whatsapp_activation_scope'});
  },
  async down(qi){
    const [rows]=await qi.sequelize.query('SELECT COUNT(*) AS n FROM `WhatsappPhoneActivations`');
    const [assets]=await qi.sequelize.query('SELECT COUNT(*) AS n FROM `ClinicMetaAssets` WHERE `whatsappAuthorizationId` IS NOT NULL OR `metaConnectionId` IS NULL');
    if(Number(rows[0].n)||Number(assets[0].n))throw Error('Preserve WhatsApp activations; rollback must retain the catalog');
    await qi.dropTable('WhatsappPhoneActivations');
    for(const operation of ['insert','update'])await qi.sequelize.query('DROP TRIGGER `guard_whatsapp_catalog_'+operation+'`');
    await qi.sequelize.query('ALTER TABLE `ClinicMetaAssets` DROP INDEX `uniq_whatsapp_authorization_asset`, DROP COLUMN `whatsappAuthorizationId`, MODIFY COLUMN `metaConnectionId` int NOT NULL');
  },
};
