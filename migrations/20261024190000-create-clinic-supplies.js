'use strict';

// Explicit, additive migration. Running the application never creates these tables.
module.exports = {
  async up(q, S) {
    const id = () => ({ type: S.STRING(36), allowNull: false, primaryKey: true });
    const clinic = () => ({ type: S.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' });
    const timestamps = () => ({ created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } });
    const quantity = () => ({ type: S.DECIMAL(14, 3), allowNull: false, defaultValue: 0 });
    await q.createTable('ClinicSuppliers', {
      id: id(), clinic_id: clinic(), name: { type: S.STRING(160), allowNull: false },
      type: { type: S.STRING(24), allowNull: false }, contact_name: { type: S.STRING(160), allowNull: false, defaultValue: '' },
      email: { type: S.STRING(254), allowNull: false, defaultValue: '' }, phone: { type: S.STRING(60), allowNull: false, defaultValue: '' },
      notes: { type: S.TEXT, allowNull: false }, active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      version: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 }, created_by: { type: S.INTEGER, allowNull: false }, updated_by: { type: S.INTEGER, allowNull: false }, ...timestamps(),
    });
    await q.addIndex('ClinicSuppliers', ['clinic_id', 'active', 'name'], { name: 'clinic_suppliers_scope' });
    await q.createTable('ClinicStockProducts', {
      id: id(), clinic_id: clinic(), name: { type: S.STRING(160), allowNull: false }, unit: { type: S.STRING(40), allowNull: false },
      location: { type: S.STRING(160), allowNull: false, defaultValue: '' }, supplier_id: { type: S.STRING(36), allowNull: true, references: { model: 'ClinicSuppliers', key: 'id' }, onDelete: 'RESTRICT' },
      minimum_quantity: quantity(), quantity: quantity(), active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      version: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 }, created_by: { type: S.INTEGER, allowNull: false }, updated_by: { type: S.INTEGER, allowNull: false }, ...timestamps(),
    });
    await q.addIndex('ClinicStockProducts', ['clinic_id', 'active', 'name'], { name: 'clinic_stock_scope' });
    await q.createTable('ClinicMaterialOrders', {
      id: id(), clinic_id: clinic(), supplier_id: { type: S.STRING(36), allowNull: false, references: { model: 'ClinicSuppliers', key: 'id' }, onDelete: 'RESTRICT' },
      reference: { type: S.STRING(100), allowNull: false, defaultValue: '' }, status: { type: S.STRING(24), allowNull: false },
      expected_on: { type: S.DATEONLY, allowNull: true }, notes: { type: S.TEXT, allowNull: false },
      version: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 }, created_by: { type: S.INTEGER, allowNull: false }, updated_by: { type: S.INTEGER, allowNull: false }, ...timestamps(),
    });
    await q.addIndex('ClinicMaterialOrders', ['clinic_id', 'status', 'expected_on'], { name: 'clinic_material_orders_scope' });
    await q.createTable('ClinicMaterialOrderLines', {
      id: id(), clinic_id: clinic(), order_id: { type: S.STRING(36), allowNull: false, references: { model: 'ClinicMaterialOrders', key: 'id' }, onDelete: 'RESTRICT' },
      product_id: { type: S.STRING(36), allowNull: false, references: { model: 'ClinicStockProducts', key: 'id' }, onDelete: 'RESTRICT' },
      product_name: { type: S.STRING(160), allowNull: false }, unit: { type: S.STRING(40), allowNull: false }, quantity: quantity(), received_quantity: quantity(), ...timestamps(),
    });
    await q.addIndex('ClinicMaterialOrderLines', ['order_id', 'product_id'], { unique: true, name: 'clinic_material_line_product' });
    await q.createTable('ClinicStockMovements', {
      id: id(), clinic_id: clinic(), product_id: { type: S.STRING(36), allowNull: false, references: { model: 'ClinicStockProducts', key: 'id' }, onDelete: 'RESTRICT' },
      order_id: { type: S.STRING(36), allowNull: true, references: { model: 'ClinicMaterialOrders', key: 'id' }, onDelete: 'RESTRICT' },
      kind: { type: S.STRING(24), allowNull: false }, quantity: quantity(), quantity_after: quantity(), reason: { type: S.STRING(500), allowNull: false },
      actor_id: { type: S.INTEGER, allowNull: false }, ...timestamps(),
    });
    await q.addIndex('ClinicStockMovements', ['clinic_id', 'product_id', 'created_at'], { name: 'clinic_stock_movement_scope' });
    await q.createTable('ClinicSupplyCommands', {
      id: id(), clinic_id: clinic(), command_key: { type: S.STRING(120), allowNull: false }, command_hash: { type: S.STRING(64), allowNull: false },
      command_type: { type: S.STRING(60), allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false }, result: { type: S.JSON, allowNull: false }, ...timestamps(),
    });
    await q.addIndex('ClinicSupplyCommands', ['clinic_id', 'command_key'], { unique: true, name: 'clinic_supply_command_key' });
  },
  async down() { throw Error('clinic_supplies_history_preserved: roll back compatible code, never drop inventory movements'); },
};
