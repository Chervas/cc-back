'use strict';
const service = require('../services/clinicSupplies.service');
const C = require('../lib/clinic-supplies-contract');
function createController({ getService = () => service.current() } = {}) {
  function input(req) {
    if (req.query.clinic_id !== undefined && req.body?.clinic_id !== undefined && String(req.query.clinic_id) !== String(req.body.clinic_id)) C.fail('scope_mismatch', 'Selecciona la misma clínica en esta acción.');
    return { actorId: req.userData?.userId, clinicId: req.query.clinic_id ?? req.body?.clinic_id, id: req.params.id, payload: req.body };
  }
  const handler = (action, status = 200) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.status(status).json(await action(getService(), input(req))); }
    catch (error) {
      const pending = ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error.original?.code || error.parent?.code);
      const status = pending ? 503 : [400, 401, 403, 404, 409, 428].includes(error.statusCode) ? error.statusCode : 500;
      res.status(status).json({ error: { code: pending ? 'clinic_supplies_schema_pending' : status === 500 ? 'clinic_supplies_unavailable' : error.code, message: pending ? 'Suministros está pendiente de preparación técnica.' : status === 500 ? 'No se pudo completar la acción de suministros.' : error.message } });
    }
  };
  return {
    overview: handler((s, i) => s.overview(i)),
    suppliers: handler((s, i) => s.list(i, 'suppliers')), products: handler((s, i) => s.list(i, 'products')), orders: handler((s, i) => s.list(i, 'orders')),
    createSupplier: handler((s, i) => s.createSupplier(i), 201), updateSupplier: handler((s, i) => s.updateSupplier(i)),
    createProduct: handler((s, i) => s.createProduct(i), 201), updateProduct: handler((s, i) => s.updateProduct(i)),
    movement: handler((s, i) => s.movement(i)), movements: handler((s, i) => s.movements(i)),
    createOrder: handler((s, i) => s.createOrder(i), 201), updateOrder: handler((s, i) => s.updateOrder(i)), receipt: handler((s, i) => s.receipt(i)),
  };
}
module.exports = { ...createController(), createController };
