'use strict';
const { Op } = require('sequelize');
const db = require('../../models');
const parse = value => { if (typeof value !== 'string') return value || {}; try { return JSON.parse(value); } catch (_) { return {}; } };
const round = value => Math.round(value * 100) / 100;
function pendingAmount(budget, payments, wallet) {
  const paid = payments.filter(row => row.status === 'confirmed').reduce((sum, row) => sum + (parse(row.application).allocations || [])
    .filter(item => ['budget', 'budget_line'].includes(item.target_type)).reduce((n, item) => n + Number(item.amount || 0), 0), 0);
  const balance = wallet.filter(row => row.status === 'confirmed' && Number(row.amount) < 0).reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
  return Math.max(0, round(Number(budget.accepted_amount || 0) - paid - balance));
}
async function attach(appointments, models = db) {
  if (!appointments.length) return;
  const rows = appointments.map(row => row.toJSON ? row.toJSON() : row);
  const ids = [...new Set(rows.map(row => Number(row.id_cita || row.appointment_id)).filter(Boolean))];
  if (!ids.length || !models.EconomicBudgetEvent || !models.PatientVoucher) return;
  const voucherIds = [...new Set(rows.map(row => Number(row.voucher_id)).filter(Boolean))];
  const [links, vouchers] = await Promise.all([
    models.EconomicBudgetEvent.findAll({ where: { event_type:'appointment_linked', metadata:{ appointment_id:{ [Op.in]:ids } } }, raw:true }),
    voucherIds.length ? models.PatientVoucher.findAll({ where:{ id:{ [Op.in]:voucherIds } }, attributes:['id','budget_id','clinic_id','patient_id'], raw:true }) : [],
  ]);
  const budgetIds = [...new Set([...links.map(row => row.budget_id), ...vouchers.map(row => row.budget_id)].filter(Boolean))];
  if (!budgetIds.length) return;
  const [budgets, payments, wallet, events] = await Promise.all([
    models.EconomicBudget.findAll({ where:{ id:{ [Op.in]:budgetIds }, status:{ [Op.in]:['accepted','partially_accepted'] } }, raw:true }),
    models.EconomicPayment.findAll({ where:{ budget_id:{ [Op.in]:budgetIds }, status:'confirmed' }, attributes:['budget_id','status','application'], raw:true }),
    models.PatientWalletEntry.findAll({ where:{ budget_id:{ [Op.in]:budgetIds }, status:'confirmed' }, attributes:['budget_id','status','amount'], raw:true }),
    models.EconomicBudgetEvent.findAll({ where:{ budget_id:{ [Op.in]:budgetIds }, event_type:{ [Op.in]:['accepted','partially_accepted'] } }, order:[['id','DESC']], raw:true }),
  ]);
  for (let index=0; index<rows.length; index++) {
    const row=rows[index], link=links.find(item => Number(parse(item.metadata).appointment_id) === Number(row.id_cita));
    const voucher=vouchers.find(item => Number(item.id) === Number(row.voucher_id));
    const budget=budgets.find(item => Number(item.id) === Number(link?.budget_id || voucher?.budget_id)
      && Number(item.clinic_id) === Number(row.clinica_id) && String(item.patient_id) === String(row.paciente_id));
    if (!budget || (link && Number(parse(link.metadata).budget_version) !== Number(budget.current_version))) continue;
    const summary={ budget_id:budget.public_id, pending:pendingAmount(budget,
      payments.filter(item => Number(item.budget_id) === Number(budget.id)), wallet.filter(item => Number(item.budget_id) === Number(budget.id))),
      method:parse(events.find(item => Number(item.budget_id) === Number(budget.id))?.metadata).collection_method || null };
    if (appointments[index].setDataValue) appointments[index].setDataValue('payment_summary',summary);
    else appointments[index].payment_summary=summary;
  }
}
async function notify(publicId, models = db) {
  const budget = await models.EconomicBudget.findOne({ where:{ public_id:publicId } });
  if (!budget) return;
  const links = await models.EconomicBudgetEvent.findAll({ where:{ budget_id:budget.id, event_type:'appointment_linked' }, raw:true });
  const vouchers = await models.PatientVoucher.findAll({ where:{ budget_id:budget.id }, attributes:['id'], raw:true });
  const linkIds = links.map(row => Number(parse(row.metadata).appointment_id)).filter(Boolean);
  const voucherIds = vouchers.map(row => row.id);
  if (!linkIds.length && !voucherIds.length) return;
  const rows = await models.CitaPaciente.findAll({ where:{ clinica_id:budget.clinic_id, paciente_id:budget.patient_id,
    [Op.or]:[...(linkIds.length ? [{ id_cita:{ [Op.in]:linkIds } }] : []), ...(voucherIds.length ? [{ voucher_id:{ [Op.in]:voucherIds } }] : [])] }, attributes:['id_cita'], raw:true });
  for (let offset=0; offset<rows.length; offset+=30) await require('./programBookingRealtime.service').publishProgramBookings({ db:models, clinicId:budget.clinic_id,
    result:{ sessions:rows.slice(offset,offset+30).map(row => ({ appointment_id:row.id_cita, action:'updated' })) } });
}
module.exports = { attach, notify, pendingAmount };
