'use strict';

const crypto = require('node:crypto');
const { Op, col } = require('sequelize');
const C = require('../lib/clinic-supplies-contract');
const plain = value => value?.toJSON ? value.toJSON() : value;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const LIMIT = 500;

function createClinicSuppliesService({ db, canAccess, isGlobalAdmin, now = () => new Date(), newId = () => crypto.randomUUID() } = {}) {
  const can = canAccess || (input => require('../lib/access-policy').canUserAccessFeature(input));
  const admin = isGlobalAdmin || require('../lib/role-helpers').isGlobalAdmin;
  const scope = (Model, ctx, id, transaction, lock = false) => Model.findOne({ where: { id: C.id(id), clinic_id: ctx.clinicId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  async function context(input, transaction, writing = false) {
    if (!input.actorId) C.fail('unauthenticated', 'Inicia sesión para continuar.', 401);
    const actorId = C.integer(input.actorId), clinicId = C.integer(input.clinicId);
    const membership = admin(actorId) ? true : await db.UsuarioClinica.findOne({ where: { id_usuario: actorId, id_clinica: clinicId, [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }] }, transaction });
    if (!membership) C.fail('forbidden', 'No tienes acceso a los suministros de esta clínica.', 403);
    const [view, manage] = await Promise.all(['appointments.view', 'appointments.manage'].map(featureKey => can({ actorId, clinicId, featureKey })));
    if ((!view && !manage) || writing && !manage) C.fail('forbidden', 'No tienes permiso para esta acción de suministros.', 403);
    // Serialize logistics writes per clinic before journal lookup, including first creates.
    // Locking an existing parent avoids create-first-row races and duplicate receptions.
    const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'configuracion'], transaction, ...(writing ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!clinic) C.fail('clinic_not_found', 'Clínica no disponible.', 404);
    const timezone = require('./clinicOpeningHours.service').resolveClinicTimeZone(clinic);
    return { actorId, clinicId, capabilities: { view: !!(view || manage), manage: !!manage }, today: C.today(now(), timezone), timezone };
  }
  const supplierDto = row => { const r = plain(row); return Object.fromEntries(['id', 'name', 'type', 'contact_name', 'email', 'phone', 'notes', 'active', 'version'].map(key => [key, key === 'version' ? Number(r[key]) : r[key]])); };
  const productDto = row => { const r = plain(row); return { id: r.id, name: r.name, unit: r.unit, location: r.location, supplier_id: r.supplier_id, active: !!r.active, quantity: Number(r.quantity), minimum_quantity: Number(r.minimum_quantity), version: Number(r.version), on_order_quantity: 0 }; };
  const movementDto = row => { const r = plain(row); return { id: r.id, kind: r.kind, quantity: Number(r.quantity), quantity_after: Number(r.quantity_after), reason: r.reason, created_at: r.created_at, actor_id: r.actor_id, order_id: r.order_id }; };
  async function orderDtos(rows, ctx, transaction) {
    if (!rows.length) return [];
    const values = rows.map(plain);
    const [lines, supplier] = await Promise.all([
      db.ClinicMaterialOrderLine.findAll({ where: { order_id: { [Op.in]: values.map(row => row.id) }, clinic_id: ctx.clinicId }, order: [['id', 'ASC']], transaction }),
      db.ClinicSupplier.findAll({ where: { id: { [Op.in]: [...new Set(values.map(row => row.supplier_id))] }, clinic_id: ctx.clinicId }, transaction }),
    ]);
    const suppliers = new Map(supplier.map(item => [item.id, item.name]));
    const grouped = new Map();
    for (const line of lines) { const l = plain(line); if (!grouped.has(l.order_id)) grouped.set(l.order_id, []); grouped.get(l.order_id).push({ id: l.id, product_id: l.product_id, product_name: l.product_name, unit: l.unit, quantity: Number(l.quantity), received_quantity: Number(l.received_quantity) }); }
    return values.map(r => ({ id: r.id, supplier_id: r.supplier_id, supplier_name: suppliers.get(r.supplier_id) || '', reference: r.reference, status: r.status, expected_on: r.expected_on, notes: r.notes, version: Number(r.version), lines: grouped.get(r.id) || [] }));
  }
  const orderDto = async (row, ctx, transaction) => (await orderDtos([row], ctx, transaction))[0];
  async function suppliers(ctx, transaction) {
    const rows = await db.ClinicSupplier.findAll({ where: { clinic_id: ctx.clinicId }, order: [['active', 'DESC'], ['name', 'ASC'], ['id', 'ASC']], limit: LIMIT + 1, transaction });
    return { items: rows.slice(0, LIMIT).map(supplierDto), truncated: rows.length > LIMIT };
  }
  async function products(ctx, transaction) {
    const rows = await db.ClinicStockProduct.findAll({ where: { clinic_id: ctx.clinicId }, order: [['active', 'DESC'], ['name', 'ASC'], ['id', 'ASC']], limit: LIMIT + 1, transaction });
    const items = rows.slice(0, LIMIT).map(productDto);
    if (items.length) {
      const lines = await db.ClinicMaterialOrderLine.findAll({ where: { clinic_id: ctx.clinicId, product_id: { [Op.in]: items.map(item => item.id) } }, include: [{ model: db.ClinicMaterialOrder, as: 'order', attributes: [], required: true, where: { clinic_id: ctx.clinicId, status: { [Op.in]: ['ordered', 'partial'] } } }], transaction });
      const amounts = new Map();
      for (const line of lines) amounts.set(line.product_id, (amounts.get(line.product_id) || 0) + Math.round(Number(line.quantity) * 1000) - Math.round(Number(line.received_quantity) * 1000));
      for (const item of items) item.on_order_quantity = C.amount(amounts.get(item.id) || 0);
    }
    return { items, truncated: rows.length > LIMIT };
  }
  async function orders(ctx, transaction) {
    // Open orders are always displayed before completed history; global counters are separate queries.
    const rows = await db.ClinicMaterialOrder.findAll({ where: { clinic_id: ctx.clinicId }, order: [[db.sequelize.literal("CASE WHEN status IN ('draft','ordered','partial') THEN 0 ELSE 1 END"), 'ASC'], ['expected_on', 'ASC'], ['created_at', 'DESC'], ['id', 'ASC']], limit: LIMIT + 1, transaction });
    return { items: await orderDtos(rows.slice(0, LIMIT), ctx, transaction), truncated: rows.length > LIMIT };
  }
  async function summary(ctx, transaction) {
    const base = { clinic_id: ctx.clinicId }, open = { ...base, status: { [Op.in]: ['ordered', 'partial'] } };
    const [to_order, expected, overdue, low_stock] = await Promise.all([
      db.ClinicMaterialOrder.count({ where: { ...base, status: 'draft' }, transaction }),
      db.ClinicMaterialOrder.count({ where: open, transaction }),
      db.ClinicMaterialOrder.count({ where: { ...open, expected_on: { [Op.lt]: ctx.today } }, transaction }),
      db.ClinicStockProduct.count({ where: { ...base, active: true, quantity: { [Op.lt]: col('minimum_quantity') } }, transaction }),
    ]);
    return { to_order, expected, overdue, low_stock };
  }
  async function overview(input) {
    return db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
      const ctx = await context(input, transaction), [s, p, o, totals] = await Promise.all([suppliers(ctx, transaction), products(ctx, transaction), orders(ctx, transaction), summary(ctx, transaction)]);
      return { summary: totals, suppliers: s.items, products: p.items, orders: o.items, capabilities: ctx.capabilities, today: ctx.today, timezone: ctx.timezone, truncated: { suppliers: s.truncated, products: p.truncated, orders: o.truncated } };
    });
  }
  async function list(input, kind) { const ctx = await context(input); return ({ suppliers, products, orders })[kind](ctx); }
  async function requireSupplier(id, ctx, transaction, active = true) {
    const supplier = await scope(db.ClinicSupplier, ctx, id, transaction);
    if (!supplier || active && !supplier.active) C.fail('supplier_not_found', 'Selecciona un proveedor activo de esta clínica.', 404);
    return supplier;
  }
  function expected(row, payload) { if (Number(row.version) !== C.version(payload.expected_version)) C.fail('version_conflict', 'El registro ha cambiado. Actualízalo antes de guardar.', 409); }
  async function mutate(input, type, action) {
    const payload = input.payload;
    if (!C.object(payload)) C.fail('payload_invalid', 'Revisa los datos de esta acción.');
    const key = C.commandKey(payload.idempotency_key);
    const hash = C.hash({ type, id: input.id || null, payload: Object.fromEntries(Object.entries(payload).filter(([field]) => !['clinic_id', 'idempotency_key'].includes(field))) });
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const ctx = await context(input, transaction, true);
      const previous = await db.ClinicSupplyCommand.findOne({ where: { clinic_id: ctx.clinicId, command_key: key }, transaction });
      if (previous) {
        if (previous.command_hash !== hash || Number(previous.actor_id) !== ctx.actorId) C.fail('idempotency_conflict', 'Esta solicitud ya corresponde a otra acción.', 409);
        return { item: parse(previous.result), replayed: true };
      }
      const item = await action(ctx, transaction, payload);
      await db.ClinicSupplyCommand.create({ id: newId(), clinic_id: ctx.clinicId, command_key: key, command_hash: hash, command_type: type, actor_id: ctx.actorId, result: item }, { transaction });
      return { item, replayed: false };
    });
  }
  async function createSupplier(input) { return mutate(input, 'supplier.create', async (ctx, transaction, payload) => supplierDto(await db.ClinicSupplier.create({ id: newId(), clinic_id: ctx.clinicId, ...C.supplier(payload.supplier, true), version: 1, created_by: ctx.actorId, updated_by: ctx.actorId }, { transaction }))); }
  async function updateSupplier(input) { return mutate(input, 'supplier.update', async (ctx, transaction, payload) => {
    const row = await requireSupplier(input.id, ctx, transaction, false); expected(row, payload);
    await row.update({ ...C.supplier(payload.supplier), version: Number(row.version) + 1, updated_by: ctx.actorId }, { transaction }); return supplierDto(row);
  }); }
  async function createProduct(input) { return mutate(input, 'product.create', async (ctx, transaction, payload) => {
    const values = C.product(payload.product, true);
    if (values.supplier_id) await requireSupplier(values.supplier_id, ctx, transaction);
    return productDto(await db.ClinicStockProduct.create({ id: newId(), clinic_id: ctx.clinicId, ...values, quantity: 0, version: 1, created_by: ctx.actorId, updated_by: ctx.actorId }, { transaction }));
  }); }
  async function updateProduct(input) { return mutate(input, 'product.update', async (ctx, transaction, payload) => {
    const row = await scope(db.ClinicStockProduct, ctx, input.id, transaction, true);
    if (!row) C.fail('product_not_found', 'Producto no disponible en esta clínica.', 404); expected(row, payload);
    const values = C.product(payload.product);
    if (values.supplier_id) await requireSupplier(values.supplier_id, ctx, transaction);
    if (values.unit !== undefined && values.unit !== row.unit && (await db.ClinicStockMovement.count({ where: { product_id: row.id, clinic_id: ctx.clinicId }, transaction }) || await db.ClinicMaterialOrderLine.count({ where: { product_id: row.id, clinic_id: ctx.clinicId }, transaction }))) C.fail('unit_locked', 'La unidad no puede cambiar cuando el producto ya tiene pedidos o movimientos.', 409);
    await row.update({ ...values, version: Number(row.version) + 1, updated_by: ctx.actorId }, { transaction }); return productDto(row);
  }); }
  async function recordStock(ctx, transaction, product, delta, kind, reason, orderId = null) {
    const after = Math.round(Number(product.quantity) * 1000) + delta;
    if (after < 0 || after > C.MAX_QUANTITY * 1000) C.fail('stock_out_of_range', 'La operación dejaría unas existencias fuera del rango permitido.', 409);
    await product.update({ quantity: C.amount(after), version: Number(product.version) + 1, updated_by: ctx.actorId }, { transaction });
    return db.ClinicStockMovement.create({ id: newId(), clinic_id: ctx.clinicId, product_id: product.id, order_id: orderId, kind, quantity: C.amount(delta), quantity_after: C.amount(after), reason, actor_id: ctx.actorId }, { transaction });
  }
  async function movement(input) { return mutate(input, 'stock.movement', async (ctx, transaction, payload) => {
    const product = await scope(db.ClinicStockProduct, ctx, input.id, transaction, true);
    if (!product || !product.active) C.fail('product_not_found', 'Selecciona un producto activo de esta clínica.', 404); expected(product, payload);
    if (!['entry', 'exit', 'count'].includes(payload.kind)) C.fail('movement_kind', 'Selecciona entrada, salida o recuento.');
    const quantity = C.units(payload.quantity, payload.kind === 'count'), reason = C.text(payload.reason, 500, true);
    const delta = payload.kind === 'count' ? quantity - Math.round(Number(product.quantity) * 1000) : payload.kind === 'exit' ? -quantity : quantity;
    if (!delta) C.fail('stock_unchanged', 'El recuento coincide con las existencias actuales.');
    await recordStock(ctx, transaction, product, delta, payload.kind, reason); return productDto(product);
  }); }
  async function movements(input) {
    const ctx = await context(input), product = await scope(db.ClinicStockProduct, ctx, input.id);
    if (!product) C.fail('product_not_found', 'Producto no disponible en esta clínica.', 404);
    const rows = await db.ClinicStockMovement.findAll({ where: { product_id: product.id, clinic_id: ctx.clinicId }, order: [['created_at', 'DESC'], ['id', 'DESC']], limit: LIMIT + 1 });
    return { items: rows.slice(0, LIMIT).map(movementDto), truncated: rows.length > LIMIT };
  }
  async function createOrder(input) { return mutate(input, 'order.create', async (ctx, transaction, payload) => {
    const o = C.fields(payload.order, ['supplier_id', 'status', 'expected_on', 'reference', 'notes', 'lines']);
    await requireSupplier(o.supplier_id, ctx, transaction);
    if (!['draft', 'ordered'].includes(o.status)) C.fail('order_status', 'Selecciona borrador o pedido cursado.');
    if (!Array.isArray(o.lines) || !o.lines.length || o.lines.length > 100) C.fail('order_lines', 'Añade entre uno y cien productos al pedido.');
    const seen = new Set(), lines = [];
    for (const line of o.lines) {
      C.fields(line, ['product_id', 'quantity']); const id = C.id(line.product_id);
      if (seen.has(id)) C.fail('duplicate_product', 'Cada producto debe aparecer una sola vez en el pedido.'); seen.add(id);
      const product = await scope(db.ClinicStockProduct, ctx, id, transaction);
      if (!product || !product.active) C.fail('product_not_found', 'Selecciona productos activos de esta clínica.', 404);
      lines.push({ id: newId(), clinic_id: ctx.clinicId, product_id: product.id, product_name: product.name, unit: product.unit, quantity: C.amount(C.units(line.quantity, false)), received_quantity: 0 });
    }
    const row = await db.ClinicMaterialOrder.create({ id: newId(), clinic_id: ctx.clinicId, supplier_id: o.supplier_id, status: o.status, expected_on: C.date(o.expected_on ?? null), reference: C.text(o.reference ?? '', 100), notes: C.text(o.notes ?? '', 5000), version: 1, created_by: ctx.actorId, updated_by: ctx.actorId }, { transaction });
    for (const line of lines) await db.ClinicMaterialOrderLine.create({ ...line, order_id: row.id }, { transaction });
    return orderDto(row, ctx, transaction);
  }); }
  async function updateOrder(input) { return mutate(input, 'order.update', async (ctx, transaction, payload) => {
    const row = await scope(db.ClinicMaterialOrder, ctx, input.id, transaction, true);
    if (!row) C.fail('order_not_found', 'Pedido no disponible en esta clínica.', 404); expected(row, payload);
    if (['received', 'cancelled'].includes(row.status)) C.fail('order_readonly', 'El pedido está cerrado.', 409);
    const o = C.fields(payload.order, ['status', 'expected_on', 'reference', 'notes']), values = {};
    if (o.status !== undefined) {
      if (!['ordered', 'cancelled'].includes(o.status) || o.status === 'ordered' && row.status !== 'draft') C.fail('order_transition', 'El estado no permite esa transición.', 409);
      if (o.status === 'ordered') await requireSupplier(row.supplier_id, ctx, transaction);
      if (o.status === 'cancelled' && row.status === 'partial') C.fail('received_order_cancel', 'Un pedido recibido parcialmente requiere conciliar su entrega; no puede anularse como si no hubiera llegado.', 409);
      values.status = o.status;
    }
    if (o.expected_on !== undefined) values.expected_on = C.date(o.expected_on);
    if (o.reference !== undefined) values.reference = C.text(o.reference, 100);
    if (o.notes !== undefined) values.notes = C.text(o.notes, 5000);
    if (!Object.keys(values).length) C.fail('empty_update', 'Indica qué quieres modificar.');
    await row.update({ ...values, version: Number(row.version) + 1, updated_by: ctx.actorId }, { transaction }); return orderDto(row, ctx, transaction);
  }); }
  async function receipt(input) { return mutate(input, 'order.receive', async (ctx, transaction, payload) => {
    const row = await scope(db.ClinicMaterialOrder, ctx, input.id, transaction, true);
    if (!row) C.fail('order_not_found', 'Pedido no disponible en esta clínica.', 404); expected(row, payload);
    if (!['ordered', 'partial'].includes(row.status)) C.fail('order_not_receivable', 'Solo se pueden recibir pedidos cursados con cantidades pendientes.', 409);
    if (!Array.isArray(payload.lines) || !payload.lines.length || payload.lines.length > 100) C.fail('receipt_lines', 'Selecciona las líneas recibidas.');
    const lines = await db.ClinicMaterialOrderLine.findAll({ where: { order_id: row.id, clinic_id: ctx.clinicId }, transaction, lock: transaction.LOCK.UPDATE });
    const selected = new Set(), pending = [];
    for (const entry of payload.lines) {
      C.fields(entry, ['id', 'quantity']); const id = C.id(entry.id), quantity = C.units(entry.quantity, false);
      if (selected.has(id)) C.fail('duplicate_line', 'Cada línea debe aparecer una sola vez.'); selected.add(id);
      const line = lines.find(value => value.id === id);
      if (!line) C.fail('receipt_scope', 'La línea no pertenece a este pedido.', 404);
      const received = Math.round(Number(line.received_quantity) * 1000) + quantity;
      if (received > Math.round(Number(line.quantity) * 1000)) C.fail('receipt_exceeds', 'La recepción supera la cantidad pendiente del pedido.');
      pending.push({ line, quantity, received });
    }
    const reason = C.text(payload.reason ?? 'Recepción de pedido de material', 500, true);
    for (const entry of pending.sort((a, b) => a.line.product_id.localeCompare(b.line.product_id))) {
      const product = await scope(db.ClinicStockProduct, ctx, entry.line.product_id, transaction, true);
      if (!product) C.fail('product_not_found', 'No se puede conciliar un producto de este pedido.', 409);
      await recordStock(ctx, transaction, product, entry.quantity, 'receipt', reason, row.id);
      await entry.line.update({ received_quantity: C.amount(entry.received) }, { transaction });
    }
    const complete = lines.every(line => Math.round(Number(line.received_quantity) * 1000) === Math.round(Number(line.quantity) * 1000));
    await row.update({ status: complete ? 'received' : 'partial', version: Number(row.version) + 1, updated_by: ctx.actorId }, { transaction });
    return orderDto(row, ctx, transaction);
  }); }
  return { overview, list, createSupplier, updateSupplier, createProduct, updateProduct, movement, movements, createOrder, updateOrder, receipt };
}

let singleton;
module.exports = { createClinicSuppliesService, current: () => singleton ||= createClinicSuppliesService({ db: require('../../models') }) };
