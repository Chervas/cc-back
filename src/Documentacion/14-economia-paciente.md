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

La alta manual admite dos usos con el mismo contrato: bono nuevo
(`source_system=clinicaclick`) e importacion idempotente
(`source_system` + `source_reference`). El cobro sigue siendo una operacion
separada.

Fiscal y plantillas:

- `POST /patients/:patientId/fiscal-documents`
- `POST /budgets/:budgetId/fiscal-documents`
- `GET /budgets/:budgetId/pdf`
- `GET /fiscal-documents/:documentId/pdf`
- `PATCH /fiscal-documents/:documentId`
- `POST /templates`
- `PATCH /templates/:templateId`

La impresion conserva el snapshot estructurado y tambien dispone de PDF
generado en backend. Los PDF fiscales emitidos se materializan una sola vez en
almacenamiento privado; los borradores se generan bajo demanda. El presupuesto
puede incluir simultaneamente pago
unico, fases, financiacion y saldo mediante `included_modes`; `mode` solo se
conserva para leer versiones antiguas.

La creacion fiscal general admite origen `manual`, `budget` o `payment`. El
backend calcula lo ya documentado y rechaza importes superiores al pendiente,
por lo que una factura o recibo puede cubrir solo una parte sin duplicar dinero.
El logo elegido queda congelado en el snapshot de plantilla.

Planificacion de bonos:

- `GET /vouchers/:voucherId/appointment-resources`
- `POST /vouchers/:voucherId/appointment-plan`
- `POST /vouchers/:voucherId/appointments`

La previsualizacion calcula una serie futura y conflictos por profesional o
instalacion. La confirmacion crea citas reales y encola las automatizaciones
de cita existentes.

Contabilidad transversal y portal:
[15-contabilidad-y-gestoria](./15-contabilidad-y-gestoria.md).

## Invariantes

- Las mutaciones de presupuesto/cobro requieren `patients.edit`; plantillas,
  `clinic.settings.edit`.
- Paciente y clinica se validan siempre antes de leer o mutar.
- Solo un borrador puede editarse directamente.
- Cada edicion genera una version nueva.
- Las transiciones de estado son explicitas.
- Cobros + saldo aplicado no pueden superar el importe aceptado/pendiente.
- Las fases deben sumar el total del presupuesto.
- Cada alternativa de pago puede aplicar su descuento propio mediante
  `option_discounts`; sus fases y financiacion se calculan sobre ese importe.
- Un bono conserva unidades y movimientos; no es metodo de pago.
- Una factura requiere emisor y destinatario fiscal completos.
- Crear o editar facturas y recibos requiere `billing.documents.manage`.
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

## Ampliacion 2026-07-25

La migracion `20260725090000-expand-clinical-accounting-workflows.js` agrega el
snapshot PDF fiscal y los contratos transversales de informes de cita,
gestorias, OCR y SEPA. Se aplico solo en `dev`. Su rollback es destructivo para
esas entidades nuevas y no debe ejecutarse si ya hay informes, credenciales,
mandatos, remesas o archivos procesados que deban conservarse.

La migracion `20260725100000-link-voucher-appointments.js` enlaza cada cita
planificada con su bono. Al calcular nuevas citas, se restan las sesiones ya
reservadas que todavia no tengan un movimiento de consumo; esto evita generar
dos veces la misma serie.
