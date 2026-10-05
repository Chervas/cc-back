'use strict';
const TABLE='EconomicBudgetEvents', EVENT='appointment_linked';
function values(column) {
  const type=String(column?.type || '');
  // Preserve every existing value, including future names with digits/hyphens.
  // Exotic escaped schemas must fail closed, never silently lose audit types.
  if(!/^ENUM\('[^'\\]*'(?:,\s*'[^'\\]*')*\)$/i.test(type)) throw Error('Expected budget event enum; refusing to replace an unknown schema.');
  const result=[...type.matchAll(/'([^']*)'/g)].map(match=>match[1]);
  return result;
}
module.exports={
  async up(queryInterface,Sequelize) {
    const current=values((await queryInterface.describeTable(TABLE)).event_type);
    if(current.includes(EVENT))return;
    await queryInterface.changeColumn(TABLE,'event_type',{type:Sequelize.ENUM(...current,EVENT),allowNull:false});
  },
  async down(queryInterface,Sequelize) {
    const current=values((await queryInterface.describeTable(TABLE)).event_type);
    if(!current.includes(EVENT))return;
    const [rows]=await queryInterface.sequelize.query('SELECT COUNT(*) AS total FROM `EconomicBudgetEvents` WHERE `event_type` = :event',{replacements:{event:EVENT}});
    if(Number(rows[0]?.total)>0)throw Error('Appointment links exist; rollback would erase audit history.');
    await queryInterface.changeColumn(TABLE,'event_type',{type:Sequelize.ENUM(...current.filter(value=>value!==EVENT)),allowNull:false});
  },
};
