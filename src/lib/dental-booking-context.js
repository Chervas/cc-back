'use strict';
// An HTTP body cannot manufacture this transaction-bound planning capability.
const issued=new WeakMap();
function createDentalBookingContext(values){const token=Object.freeze({});issued.set(token,values);return token;}
function requireDentalBookingContext(token,{transaction,values,existing}){
 const context=issued.get(token);
 if(!context||context.transaction!==transaction||Number(existing?.id_cita||0)!==Number(context.existingAppointmentId||0)||Number(values.clinica_id)!==context.clinicId||Number(values.paciente_id)!==context.patientId||values.voucher_id||!['pendiente','reprogramada'].includes(values.estado))throw Error('dental_booking_context_invalid');
 return context;
}
module.exports={createDentalBookingContext,requireDentalBookingContext};
