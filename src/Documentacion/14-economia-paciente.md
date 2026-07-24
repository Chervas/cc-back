# Backend de economia del paciente

> Implementado en `dev` el 2026-07-24.
> Prefijo API: `/api/economics`.
> Migracion: `20260724183000-create-patient-economics-domain.js`.

## Dominio

Tablas:

- `EconomicBudgets`: identidad, clinica, paciente, numero y estado actual.
- `EconomicBudgetVersions`: snapshot inmutable de lineas, totales, forma de
  pago, diseño, paciente y clinica.
- `EconomicBudgetEvents`: timeline de cambios de estado/version.
- `ClinicEconomicTemplates`: plantillas reutilizables de presupuesto/factura.
- `EconomicPayments`: dinero recibido y su aplicacion explicita.
- `PatientWalletEntries`: libro de saldo/anticipos.
- `PatientVouchers` y `PatientVoucherMovements`: unidades vendidas y consumos.
- `PatientFiscalDocuments`: recibos, facturas y rectificativas con snapshot.

No hay asociaciones Sequelize necesarias para montar el workspace. El servicio
ejecuta consultas separadas y relaciona resultados con `Map`; no usa
`LEFT JOIN`.

## Rutas

Lectura:

- `GET /patients/:patientId/workspace?clinic_id=:id`
- `GET /catalog?clinic_id=:id&patient_id=:id&page=:n&page_size=:n`
- `GET /templates?clinic_id=:id&template_type=budget|invoice`

Presupuestos:

- `POST /patients/:patientId/budgets`
- `PATCH /budgets/:budgetId`
- `POST /budgets/:budgetId/revise`
- `POST /budgets/:budgetId/transition`

Cobros y saldo:

- `POST /budgets/:budgetId/payments`
- `POST /patients/:patientId/wallet-deposits`
- `POST /payments/:paymentId/void`
- `POST /budgets/:budgetId/wallet-allocations`

Bonos:

- `POST /patients/:patientId/vouchers`
- `POST /vouchers/:voucherId/consume`

Fiscal y plantillas:

- `POST /budgets/:budgetId/fiscal-documents`
- `PATCH /fiscal-documents/:documentId`
- `POST /templates`
- `PATCH /templates/:templateId`

## Invariantes

- Las mutaciones de presupuesto/cobro requieren `patients.edit`; plantillas,
  `clinic.settings.edit`.
- Paciente y clinica se validan siempre antes de leer o mutar.
- Solo un borrador puede editarse directamente.
- Cada edicion genera una version nueva.
- Las transiciones de estado son explicitas.
- Cobros + saldo aplicado no pueden superar el importe aceptado/pendiente.
- Las fases deben sumar el total del presupuesto.
- Un bono conserva unidades y movimientos; no es metodo de pago.
- Una factura requiere emisor y destinatario fiscal completos.
- Solo se edita un documento fiscal en borrador.
- Numeros automaticos se serializan bloqueando la fila de clinica y calculando
  la secuencia maxima del año/serie; los indices unicos son la segunda barrera.
- `source_system` + `source_reference` permite importacion idempotente de
  ClinicCloud/Flowww.

## VeriFactu

Es un contrato preparatorio, no una integracion:

- borrador de factura: `mock_pending`;
- factura emitida: `ready`;
- recibo: `not_applicable`.

No se llama a la AEAT. `submitted`, `accepted` y `rejected` quedan reservados
para una futura integracion real.

## Despliegue y rollback

En un runtime que vaya a usar el dominio:

```bash
npx sequelize-cli db:migrate
pm2 restart <proceso-backend>
```

La migracion no añade dependencias NPM. Si un corte futuro modifica
`package.json`/`package-lock.json`, ejecutar `npm install` en cada checkout que
cargue ese runtime (`back-dev`, `back-staging` y `gateway` si corresponde)
antes de reiniciar.

Rollback destructivo, solo si no hay datos que conservar:

```bash
npx sequelize-cli db:migrate:undo --name 20260724183000-create-patient-economics-domain.js
```

No se ha aplicado nada en `staging` en este corte.
