# Backend de economia del paciente

> Implementado y repulido en `dev`; promovido a `staging`.
> Prefijo API: `/api/economics`.
> Migracion: `20260724183000-create-patient-economics-domain.js`.

## Dominio

Tablas:

- `EconomicBudgets`: identidad, clinica, paciente, numero y estado actual.
- `EconomicBudgetVersions`: snapshot inmutable de lineas, totales, forma de
  pago, diseño, paciente y clinica.
- `EconomicBudgetEvents`: timeline de cambios de estado/version.
- `EconomicBudgetSignatureRequests`: solicitudes de aceptacion y firma de
  presupuestos por WhatsApp, enlace publico o tablet.
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
- `POST /budgets/:budgetId/signature-requests`

Firma publica de presupuestos:

- `GET /public/budget-signatures/:token`
- `POST /public/budget-signatures/:token/sign`

Estas rutas viven bajo `/api/economics` y no requieren sesion de usuario porque
validan un token opaco firmado. La solicitud conserva snapshot, hash, version
del presupuesto, canal, forma de pago ofrecida/elegida y estado de datos
bancarios.

La clinica decide las alternativas de pago en el presupuesto. Si hay varias,
el token puede dejar que el paciente elija entre esas alternativas; nunca puede
seleccionar una forma que no exista en la version firmada. Los datos bancarios
pueden quedar `pending` para que recepcion los complete despues: no bloquean la
aceptacion economica.

Cobros y saldo:

- `POST /budgets/:budgetId/payments`
- `POST /patients/:patientId/wallet-deposits`
- `POST /payments/:paymentId/void`
- `POST /budgets/:budgetId/wallet-allocations`

Bonos:

- `POST /patients/:patientId/vouchers`
- `POST /patients/:patientId/voucher-sales`
- `POST /vouchers/:voucherId/consume`

Los contratos separan dos operaciones que no deben confundirse:

- `voucher-sales` vende un bono nuevo desde el catalogo o desde un servicio,
  acepta el presupuesto, activa sus sesiones y puede registrar un cobro total
  o parcial en la misma operacion;
- `vouchers` incorpora un saldo ya vendido en ClinicCloud, Flowww u otro
  sistema. Es idempotente mediante `source_system` + `source_reference` y no
  inventa presupuesto ni cobro.

En ambos casos, cualquier `treatment_id` se revalida contra el catalogo real de
la clinica o su grupo.

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

Al aceptar o aceptar parcialmente, el backend valida
`selected_payment_mode`, `selected_financing_months` y `collection_method`
contra la version ofrecida y los guarda en `EconomicBudgetEvent.metadata`.
Las salidas posteriores muestran solo esa decision; las alternativas completas
siguen visibles unicamente mientras el paciente todavia debe elegir.
La salida documental de presupuesto presenta `collection_method` como
`Cobro previsto` y muestra `clinic_installments` al paciente como
`Aplazado en clinica`; esos textos no cambian los codigos internos.

La creacion fiscal general admite origen `manual`, `budget` o `payment`. El
backend calcula lo ya documentado y rechaza importes superiores al pendiente,
por lo que una factura o recibo puede cubrir solo una parte sin duplicar dinero.
El logo elegido queda congelado en el snapshot de plantilla. Los logos
personalizados se suben antes mediante `purpose=invoice_logo`: son branding
publico de clinica, reencodeado a WebP y sin nombre original ni asociacion a un
paciente. El PDF fiscal y sus datos siguen siendo privados.

Planificacion de bonos:

- `GET /vouchers/:voucherId/appointment-resources`
- `POST /vouchers/:voucherId/appointment-plan`
- `POST /vouchers/:voucherId/appointments`

La previsualizacion calcula una serie futura y conflictos por profesional o
instalacion. La confirmacion crea citas reales y encola las automatizaciones
de cita existentes.

Cuando una cita enlazada a un bono se marca como `completada`, Agenda descuenta
automaticamente una unidad del bono desde el backend. El consumo es idempotente
por `voucher_id + appointment_id`: repetir el cierre de asistencia no resta otra
sesion. Las citas `no_asistio`, `cancelada` o `reprogramada` no consumen bono.

Contabilidad transversal y portal:
[15-contabilidad-y-gestoria](./15-contabilidad-y-gestoria.md).

## Invariantes

- Las mutaciones de presupuesto/cobro requieren `patients.edit`; plantillas,
  `clinic.settings.edit`.
- Paciente y clinica se validan siempre antes de leer o mutar.
- Solo un borrador puede editarse directamente.
- Cada edicion genera una version nueva.
- Las transiciones de estado son explicitas.
- Una aceptacion con varias alternativas exige elegir una; una financiacion
  exige un plazo ofrecido y el medio de cobro debe pertenecer al catalogo.
- Cobros + saldo aplicado no pueden superar el importe aceptado/pendiente.
- Las fases deben sumar el total del presupuesto.
- Cada alternativa de pago puede aplicar su descuento propio mediante
  `option_discounts`; sus fases y financiacion se calculan sobre ese importe.
- Un bono conserva unidades y movimientos; no es metodo de pago.
- Vender e importar un bono son acciones distintas: solo la venta crea el
  presupuesto y, si se solicita, el cobro.
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

Para retirar solo la ampliacion de firma economica en un entorno sin
solicitudes que conservar:

```bash
npx sequelize-cli db:migrate:undo --name 20260730223000-create-economic-budget-signature-requests.js
```

El corte base de economia del paciente esta aplicado en `dev` y `staging`;
estado comprobado el 2026-07-29. La ampliacion de firma economica
`20260730223000-create-economic-budget-signature-requests.js` queda aplicada en
`dev`; para promocionarla a `staging` hay que mergear `dev`, ejecutar
migraciones y reiniciar el runtime de staging.

## Ampliacion 2026-07-25

La migracion `20260725090000-expand-clinical-accounting-workflows.js` agrega el
snapshot PDF fiscal y los contratos transversales de informes de cita,
gestorias, OCR y SEPA. Está aplicada en `dev` y `staging`. Su rollback es
destructivo para esas entidades nuevas y no debe ejecutarse si ya hay informes,
credenciales, mandatos, remesas o archivos procesados que deban conservarse.

La migracion `20260725100000-link-voucher-appointments.js` enlaza cada cita
planificada con su bono. Al calcular nuevas citas, se restan las sesiones ya
reservadas que todavia no tengan un movimiento de consumo; esto evita generar
dos veces la misma serie.
