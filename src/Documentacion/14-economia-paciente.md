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

### Presentacion, envio y actividad de firma de presupuestos

- Crear o editar desde el asistente guarda siempre un borrador. Ver, descargar
  o imprimir no cambia su estado. `Presentado` solo se registra al preparar un
  canal real (`whatsapp` o `tablet`) o cuando la clinica confirma expresamente
  que ya lo ha mostrado o entregado en persona.

- `POST /budgets/:budgetId/signature-requests` crea una solicitud por canal
  (`whatsapp`, `email`, `custom_email` o `tablet`) y conserva en
  `EconomicBudgetSignatureRequests` destino, estado, enlace publico,
  `sent_at`, `viewed_at`, `signed_at`, snapshot y hash.
- Las solicitudes por `tablet`, `email` y `custom_email` nacen como `sent`.
  Email sigue siendo mock y no cambia el presupuesto a `presented`; tablet
  queda disponible para copiar enlace o abrir en el kiosco de la clinica y si
  registra la presentacion.
- WhatsApp exige plantilla Meta aprobada. El catalogo base se llama
  `clinicaclick_envio_presupuesto_firma` y se siembra con la migracion
  `20260731103000-seed-budget-signature-whatsapp-template.js`. Cada WABA debe
  tener su variante aprobada antes de poder enviar una prueba real.
- Abrir el enlace cambia la solicitud a `viewed` si aun estaba pendiente o
  enviada. Firmar cambia a `signed` y acepta el presupuesto con la forma de
  pago elegida o la preseleccionada.
- Cada creacion, envio, fallo, apertura y firma genera un evento economico.
  La actividad se inyecta tambien en el timeline del paciente para que aparezca
  en la ficha, QuickChat y conversacion cronologica.
- WhatsApp registra la presentacion solo despues de que Meta acepte el mensaje.
  Un fallo conserva el presupuesto como borrador. Las presentaciones repetidas
  generan nuevos eventos, pero `presented_at` conserva la primera fecha.

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
- `POST /patients/:patientId/fiscal-documents/preview` (cálculo sin escritura)
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

### Precio final y desglose explícito de IVA

Contrato preparado y probado en DEV aislado; aún no promovido a CRM.
`clinical_config.price_profile` admite `schema_version: 1`,
`price_semantics: gross_tax_included`, `tax_percent` numérico y
`exemption_reason` obligatorio cuando el porcentaje es cero. No se infiere
exención ni porcentaje a partir del área clínica. Un catálogo antiguo sin
perfil mantiene su significado previo, explícitamente no clasificado.

Al guardar un presupuesto, el backend ignora perfiles/snapshots fiscales del
request y resuelve las nuevas referencias con una lectura acotada del catálogo
del ámbito autorizado. Congela `lines[].price_snapshot`. Cambiar posteriormente
el catálogo no altera el desglose de las versiones anteriores ni de una línea
conservada al editar el borrador. Una línea histórica sin perfil tampoco recibe
automáticamente el impuesto actual. La comparación de referencias no depende
del orden de claves de JSON/MySQL. Máximo: 500 conceptos por presupuesto.

El precio unitario explícito sigue siendo final: 145 € al 21 % son 119,83 € de
base y 25,17 € de impuesto, no 175,45 € a cobrar. El backend distribuye primero
el descuento global y los céntimos residuales entre líneas y después desglosa
el impuesto. `totals.tax_breakdown` conserva esa distribución;
`tax_breakdown_status` distingue `complete`, `partial` y `unclassified`.
Los conceptos sin perfil no se certifican como exentos. Los importes anteriores
sin clasificación conservan sus totales históricos.

Los snapshots de programa pueden conservar un perfil común únicamente cuando
todos los tratamientos incluidos tienen exactamente la misma configuración
explícita. Una composición mixta o incompleta no recibe un porcentaje supuesto.
La emisión automática exige que todos los conceptos aceptados tengan perfil
explícito. Programas sin perfil común siguen bloqueados; no se activa ningún
gate público. La revisión fiscal pendiente de tratamientos importados sigue
bloqueando su venta.

La previsualización fiscal exige `billing.documents.manage`, valida paciente y
clínica, devuelve `private, no-store` y no escribe ni bloquea filas. El servidor
devuelve conceptos, bases, impuestos, total y `lines_locked`. El editor cancela
peticiones obsoletas y espera 250 ms entre cambios; no recompone agregados.
Máximo 500 conceptos. Las dos rutas de alta fiscal usan la misma operación.

Para un presupuesto clasificado se usan exclusivamente la versión persistida y
su aceptación: claves de conceptos e importe realmente aceptado, incluidos sus
descuentos. Se ignoran importes/impuestos de `payload.lines`. El documento
congela `payment_data.fiscal_price_source`; actualizar un borrador no consulta el
catálogo actual ni acepta ese snapshot del cliente. Los documentos anteriores
sin este campo conservan sus reglas; los emitidos siguen ineditables y su PDF
privado no se regenera por este cambio.

`source_amount` permite documentar una parte. Se prorratean conceptos y céntimos
pendientes en backend sin añadir otra vez IVA; los parciales del mismo origen
consumen exactamente su total/base/impuesto. Las escrituras serializan la
comprobación con el presupuesto y los documentos existentes. Cantidad fiscal
1 representa el importe documentado de cada concepto, no sesiones clínicas.
Vista previa/PDF indican «Precio final», «IVA incluido» o el motivo de exención.

Un cobro guarda su versión de presupuesto. Se admite aplicación a conceptos
identificados o al presupuesto completo cuando todos comparten perfil fiscal.
Si mezcla impuestos sin aplicación por concepto, o incluye saldo sin asignación,
se solicita revisión: no se infiere el desglose. No se duplica un documento
global facturando otra vez sus cobros. Documentos anteriores incompatibles o
rectificativas automáticas de precios finales requieren revisión explícita.
No hay DDL, cambios en gates, recordatorios ni clasificación fiscal masiva.

### Programas y bonos versionados

El catálogo de presupuestos admite `include_programs=1`, pero la integración
económica está **cerrada por defecto** mediante
`TREATMENT_PROGRAM_ECONOMICS_ENABLED` (solo el valor literal `true` la habilita).
No se activa en este corte. Con el gate cerrado no devuelve ofertas de programas
seleccionables y comunica `program_catalog=false`,
`program_definitions_preparation_only=true` y
`shared_runtime_compatibility_pending`. Crear, resolver, editar o revisar líneas
de programas y generar sus bonos se rechaza antes de escribir en las tablas
económicas compartidas.

La BD es compartida y los runtimes antiguos de staging/gateway no conocen estos
guards. Por eso **ni siquiera se permite guardar un presupuesto borrador con
programas desde dev** hasta promocionar código compatible a todos los lectores
y escritores de economía. No basta con aplicar el esquema. Las definiciones y
su preview sí pueden prepararse en las nuevas tablas de `TreatmentPrograms`.
Habilitar el gate exige revisar esa promoción y los contratos de todos los
consumidores; no modifica automáticamente permisos de venta o reserva.

El código preparado para una futura habilitación solo incorpora definiciones
activas y completas de `TreatmentPrograms`; el selector histórico
de venta/importación directa de bonos continúa usando tratamientos numéricos.
Las definiciones requieren la migración aditiva
`20260907003000-create-treatment-programs.js`. Si aún falta, el catálogo
económico habitual sigue disponible y comunica `program_catalog=false`.

Una selección nueva envía `program_id`, `program_version`, `key` estable y
`quantity=1`. El precio corresponde al programa/bono completo, no se multiplica
por sus citas. El backend resuelve y congela composición, nombres, duración y
perfil en `EconomicBudgetVersion.lines[].program_snapshot` (schema 2 + SHA256
canónico, independiente del orden de claves JSON de MySQL),
sin aceptar snapshots enviados por el cliente. Una edición posterior del
catálogo no modifica presupuestos ni firmas existentes. Un borrador conserva
su snapshot salvo sustitución explícita de referencia/versión.

La operación completa exige cuatro gates literales `true`: el económico y
`TREATMENT_PROGRAM_BOOKING_ENABLED`, `BOOKING_PROFILES_ENABLED`,
`BOOKING_MULTI_RESOURCE_ENABLED`. Si falta alguno, presentación/firma/aceptación
de programas permanecen bloqueadas. Los snapshots preparatorios schema 1 no se
convierten implícitamente en compras operativas: hay que actualizar la referencia
del borrador antes de presentarlo. Los borradores no admiten cobros ni saldo.
En CRM/gateway siguen cerrados. La QA de septiembre usa la BD
`clinicaclick_dev_isolated`, clínica 1 verificada como ficticia, no la antigua
clínica DEMO82 de la BD compartida. El override opcional
`ops/clinical/isolated-booking-qa.conf` carga exclusivamente cuatro flags desde
`clinical-qa.env`; no cambia MFA, secretos ni jobs. Se retira su drop-in y se
reinicia solo el servicio DEV para volver a la configuración de base.

El presupuesto usa su idempotencia existente `source_reference` y una huella
de solicitud: reintentos idénticos producen un solo presupuesto; otra persona,
otro paciente o una solicitud distinta no pueden reaprovechar silenciosamente
la referencia. `expected_version` protege las ediciones concurrentes.

`PatientVouchers` sigue siendo el único libro de unidades: una línea genera N
citas/unidades y conserva el importe global, con `source_system=treatment_program`.
La aceptación activa solo las líneas aceptadas y **no registra ningún cobro**;
la reserva vuelve a comprobar el evento canónico de aceptación parcial.
Retirar una línea del borrador cancela su derecho pendiente conservando la fila.

El workspace devuelve `program_plans`, composición congelada, aceptación y
`voucher_id`. Con el runtime compatible, dos lecturas en bloque para todo el
workspace consultan sesiones y citas del paciente/clínica. Backend proyecta
`scheduling_counts` (pendientes, reservadas, completadas, por revisar), el estado
y la fecha de cada cita; frontend no reconstruye agregados ni relaciones. Una
cancelación vuelve a pendiente sin inventar una nueva reserva; consumo y
reservas no se deducen del pago. Si no se consultó el ledger, los contadores son
`null` y el estado `not_loaded`, nunca «pendiente» ficticio. Una relación rota
se muestra `review_required`, sin habilitar reservas.
La UI ofrece `Ver citas incluidas` y, según el estado real, `Planificar citas
pendientes` o `Consultar citas`. Desde Bonos del paciente, `Planificar citas` abre
el mismo diálogo operativo. El planificador antiguo y el descuento manual de
bonos rechazan programas: no son una vía alternativa de reserva/consumo.

`PatientProgramSessions` identifica cada unidad por `(voucher_id, session_key)`;
conserva snapshot, cita actual y movimiento de consumo. Una sesión con varias
fases tiene **una sola CitaPaciente** y se descuenta una sola vez al completarla,
en la misma transacción que la asistencia y mediante `PatientVoucherMovement`.
Cancelar libera la reserva sin consumir. Volver a reservar crea otra cita y
conserva la cancelada como historia; no se puede restaurar la sustituida ni
mover/deshacer una sesión consumida mediante una edición ordinaria.
`PatientProgramBookingRequests` guarda recibos idempotentes por compra/solicitud.
DDL aditiva: `20260914070000-create-patient-program-sessions.js`, también añade
`TreatmentPrograms.cadence`. No eliminar estas tablas si contienen historia.

Rutas autenticadas bajo `/api/economics/vouchers/:voucherId`:

- `GET /program-plan`: unidades pendientes/reservadas/completadas y capacidades.
- `POST /program-proposals`: consulta acotada, sin reservar; `from_date`,
  `days` (1–180), hasta 30 `session_keys`; `fixed_sessions` conserva propuestas
  al pedir día anterior/siguiente, sin convertirlas en reservas.
- `POST /program-appointments`: `request_key`, `snapshot_sha256` y hasta 30
  sesiones con inicio UTC, selecciones por fase y aceptación explícita del
  profesional alternativo. Bloquea compra/recursos/paciente y revalida en una
  transacción READ COMMITTED: todas las citas elegidas o ninguna. Repetir la
  misma solicitud devuelve el recibo; cambiarla con la misma clave da 409.

Los endpoints exigen scope de clínica, `patients.sensitive.view`, lectura o
edición del paciente y lectura o gestión de agenda según la operación. No
aceptan composición, clínica ni precio proporcionados por el navegador como
autoridad. La consulta usa un contexto agregado de disponibilidad, máximo 100
recursos distintos por lote, sin SQL por cada hora candidata.

Las fases suman exactamente las duraciones de los tratamientos en su orden,
con cabinas alternativas dentro de cada fase. La pauta semanal fija un máximo
por semana civil y separación mínima en días locales; no garantiza llenar esa
frecuencia. Los `offset_days` son objetivos para proponer fechas, no intervalos
clínicos rígidos al confirmar. Cambios de catálogo no alteran una compra.

Las citas nuevas conservan HOLD y las tres supresiones de notificación. Tras
confirmar se prepara el paquete canónico de consentimientos, sin enviarlo ni
firmarlo. Un fallo documental posterior al commit devuelve las citas y
`documentation_pending`, nunca un falso fallo total que induzca otra reserva.

El precio del catálogo nuevo es IVA incluido. Un programa con desglose explícito
congelado sigue el contrato de precios finales anterior; uno incompleto o mixto
sin perfil común mantiene el bloqueo de emisión. No se añade un 21 % supuesto
ni se cambia el normalizador fiscal histórico de conceptos sin perfil.

Pruebas sin DB: `economic_program_snapshot.test.js` y `program_booking.test.js`.
QA SQL/HTTP sintética: `src/scripts/program-booking-dev-qa.js`; exige directorio
DEV y opt-in `QA_PROGRAM_DEMO_WRITES=82`, valida la clínica antes de escribir,
no carga `app.js` ni jobs. Evidencias y rollback en la bitácora central frontend.

- Las mutaciones de presupuesto/cobro requieren `patients.edit`; plantillas,
  `clinic.settings.edit`.
- Paciente y clinica se validan siempre antes de leer o mutar.
- Solo un borrador puede editarse directamente.
- Guardar, ver, descargar o imprimir no equivale a presentar.
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

Para retirar solo el seed de catalogo WhatsApp de firma de presupuesto:

```bash
npx sequelize-cli db:migrate:undo --name 20260731103000-seed-budget-signature-whatsapp-template.js
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
