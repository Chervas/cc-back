'use strict';
const TABLE='WhatsappPhoneActivations';
const hasColumn=(description,name)=>Object.hasOwn(description,name);
module.exports={
  async up(qi){
    let indexes=await qi.showIndex(TABLE);
    if(!indexes.some(i=>i.name==='idx_whatsapp_activation_asset_history'))
      await qi.addIndex(TABLE,['asset_id','state'],{name:'idx_whatsapp_activation_asset_history'});
    if(!indexes.some(i=>i.name==='idx_whatsapp_activation_phone_history'))
      await qi.addIndex(TABLE,['phone_id','state'],{name:'idx_whatsapp_activation_phone_history'});
    indexes=await qi.showIndex(TABLE);
    for(const name of ['asset_id','phone_id'])if(indexes.some(i=>i.name===name&&i.unique))await qi.removeIndex(TABLE,name);
    const columns=await qi.describeTable(TABLE);
    if(!hasColumn(columns,'active_phone_id'))await qi.sequelize.query(
      'ALTER TABLE `WhatsappPhoneActivations` ADD COLUMN `active_phone_id` varchar(30) GENERATED ALWAYS AS (CASE WHEN `state` = \'active\' THEN `phone_id` ELSE NULL END) STORED');
    indexes=await qi.showIndex(TABLE);
    if(!indexes.some(i=>i.name==='uniq_whatsapp_active_phone'))await qi.addIndex(TABLE,['active_phone_id'],{name:'uniq_whatsapp_active_phone',unique:true});
  },
  async down(qi){
    const [duplicates]=await qi.sequelize.query(
      'SELECT COUNT(*) AS n FROM ((SELECT `asset_id` FROM `WhatsappPhoneActivations` GROUP BY `asset_id` HAVING COUNT(*) > 1) UNION ALL (SELECT `phone_id` FROM `WhatsappPhoneActivations` GROUP BY `phone_id` HAVING COUNT(*) > 1)) AS duplicate_history');
    if(Number(duplicates[0].n))throw Error('Preserve WhatsApp activation history; rollback would discard renewal support');
    let indexes=await qi.showIndex(TABLE);
    if(indexes.some(i=>i.name==='uniq_whatsapp_active_phone'))await qi.removeIndex(TABLE,'uniq_whatsapp_active_phone');
    const columns=await qi.describeTable(TABLE);
    if(hasColumn(columns,'active_phone_id'))await qi.removeColumn(TABLE,'active_phone_id');
    indexes=await qi.showIndex(TABLE);
    if(!indexes.some(i=>i.name==='asset_id'&&i.unique))await qi.addIndex(TABLE,['asset_id'],{name:'asset_id',unique:true});
    if(!indexes.some(i=>i.name==='phone_id'&&i.unique))await qi.addIndex(TABLE,['phone_id'],{name:'phone_id',unique:true});
    indexes=await qi.showIndex(TABLE);
    for(const name of ['idx_whatsapp_activation_asset_history','idx_whatsapp_activation_phone_history'])
      if(indexes.some(i=>i.name===name))await qi.removeIndex(TABLE,name);
  },
};
