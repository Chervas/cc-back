'use strict';
module.exports={
  async up(qi){
    await qi.sequelize.query('ALTER TABLE MetaMarketingBrokerBindings ADD COLUMN enrollment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, ADD INDEX cc_meta_binding_enrollment (enrollment_id)');
  },
  async down(qi){
    const [rows]=await qi.sequelize.query('SELECT COUNT(*) n FROM MetaMarketingBrokerBindings WHERE enrollment_id IS NOT NULL');
    if(Number(rows[0].n))throw Error('Preserve enrollment ownership on populated Meta bindings');
    await qi.removeIndex('MetaMarketingBrokerBindings','cc_meta_binding_enrollment');
    await qi.removeColumn('MetaMarketingBrokerBindings','enrollment_id');
  },
};
