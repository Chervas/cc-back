'use strict';
const TABLE='EconomicBudgetEvents', EVENT='appointment_linked';
function values(column) {
  const result=[...String(column?.type || '').matchAll(/'([a-z_]+)'/g)].map(match=>match[1]);
  if(!/^ENUM\(/i.test(String(column?.type)) || !result.length) throw Error('Expected budget event enum; refusing to replace an unknown schema.');
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
