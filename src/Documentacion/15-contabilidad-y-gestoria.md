# Backend de contabilidad y gestoria

> Implementado y repulido en `dev`; promovido a `staging`.
> Prefijo API: `/api/accounting`.
> Migraciones: `20260724203000-create-accounting-domain.js` y ampliacion
> `20260725090000-expand-clinical-accounting-workflows.js`. La relacion entre
> bonos y citas se añade en `20260725100000-link-voucher-appointments.js`.
> Apertura de caja y costes de personal:
> `20260725120000-add-cash-sessions-and-payroll-periods.js`.
> Nominas privadas individuales y separacion de colas:
> `20260725183000-add-accounting-payroll-documents.js`.

## Dominio

- `AccountingExpenseDocuments`: facturas recibidas y gastos.
- `AccountingCashMovements`: entradas, salidas y ajustes manuales.
- `AccountingCashClosures`: arqueo inmutable y snapshot de fuentes.
- `AccountingCashSessions`: apertura explicita, estado abierto/cerrado y
  relacion con el cierre.
- `AccountingPayrollPeriods`: resumen mensual agregado del coste de personal.
- `AccountingPayrollDocuments`: nominas individuales revisadas, vinculadas o
  pendientes de emparejar con Personal.
- `PatientFiscalDocuments`: fuente de facturas/recibos emitidos.
- `EconomicPayments`: fuente de cobros de pacientes.
- `ClinicalPrivateAssets`: adjuntos privados de proveedor
  (`accounting_expense_document`) y nomina (`accounting_payroll_document`).
- `AccountingFirms`, asignaciones y usuarios: scope externo por grupo o
  clinica independiente.
- `AccountingIngestionJobs`: cola durable de lectura y revision.
- `AccountingSepaMandates`, `AccountingRemittances` e items: domiciliaciones y
  lotes de cobro.

El servicio usa consultas separadas y mapas en memoria; no usa `LEFT JOIN`.

## API

- `GET /workspace?clinic_id=&from=&to=&business_date=`
- `GET /documents/:documentId?clinic_id=`
- `GET /export.csv?clinic_id=&from=&to=`
- `GET /export.zip?clinic_id=&from=&to=`
- `GET /firm` y `POST /firm/credentials`
- `GET /portal/scope`, `GET /portal/workspace`
- `GET /portal/export.csv` y `GET /portal/export.zip`
- `GET|POST /ingestion`
- `POST /ingestion/:jobId/process`
- `POST /ingestion/:jobId/accept`
- `GET /sepa`
- `POST|PATCH /sepa/mandates`
- `POST /sepa/remittances`
- `PATCH /sepa/remittances/:id`
- `GET /sepa/remittances/:id.xml`
- `POST /expenses`
- `PATCH /expenses/:expenseId`
- `GET /expenses/:expenseId/attachment?clinic_id=`
- `POST /cash/movements`
- `POST /cash/closures`
- `GET /cash/workspace`
- `POST /cash/open`
- `POST|PATCH /payroll`
- `GET /payroll/:payrollId/document`
- `GET /payroll-documents/:documentId/document`

Los adjuntos no tienen URL publica. La descarga exige JWT, permiso y clinica,
y responde `private, no-store`. Solo admite PDF/JPEG/PNG/WebP hasta 18 MB y
valida MIME, base64 y firma binaria antes de persistir la factura.

## Caja

Formula:

`apertura + cobros efectivo + entradas - facturas recibidas pagadas en efectivo
- salidas + ajustes`

El cierre guarda esperado, contado, diferencia, recuento por denominacion y
conciliacion por medio de pago. La auxiliar abre la caja confirmando el fondo
propuesto desde el ultimo cierre. Sin sesion abierta no se aceptan movimientos
manuales ni cierre; una sesion cerrada no se puede reabrir. Solo el efectivo
interviene en el cajon. Tarjeta,
transferencia, Bizum y otros medios quedan en el snapshot de conciliacion.
Existe una restriccion unica por clinica y dia.
El rango diario se convierte desde la zona de `Clinicas.configuracion`, con
fallback `Europe/Madrid`; no usa medianoche UTC como limite operativo.

El panel principal consulta `AccountingCashSessions` por clínica y fecha
operativa para devolver `pending`, `open`, `closed` o `mixed`. El resumen
incluye únicamente las clínicas del scope y solo habilita el enlace de gestión
para las que superan `accounting.cash.manage`; la operativa completa sigue
viviendo en `/api/accounting/cash/*`.

## Acceso

- lectura: `billing.reports.view`;
- exportacion: `accounting.export`;
- gastos: `accounting.expenses.manage`;
- caja: `accounting.cash.manage`;
- nominas (lectura): `accounting.payroll.view`;
- nominas (edicion): `accounting.payroll.manage`;
- OCR: `accounting.ocr.manage`;
- domiciliaciones: `accounting.sepa.manage`;
- acceso externo: `accounting.firm.manage`;
- documentos emitidos: `billing.documents.manage`;
- plantillas: `clinic.settings.edit`.

El subrol `Gestoria` se normaliza como `accountant`: lectura/exportacion si,
mutaciones, caja y datos clinicos no. Cada grupo obtiene una gestoria y las
clinicas independientes la suya. Las credenciales iniciales solo se devuelven
al crearlas o restablecerlas y no caducan por tiempo; se revocan o restablecen
expresamente. El portal obtiene su scope desde
`AccountingFirmUser`, no desde filtros enviados por el navegador. Los defaults
desconocidos devuelven `false`.
La creación y edición de facturas/recibos en `/api/economics` exige
`billing.documents.manage`, no el permiso genérico de editar pacientes.

## Impresion y plantillas

Los documentos fiscales conservan un snapshot de plantilla. Builtins:

- `builtin-invoice-standard`: `Moderna`, renderer `modern`;
- `builtin-invoice-compact`: `Compacta`, renderer `compact`.

El renderer PDF v2 genera una hoja documental blanca con cabecera,
emisor/destinatario, tabla, totales y pie; no serializa tarjetas ni estados de
la web. Un PDF emitido permanece privado e inmutable.

Los logos personalizados usan el endpoint de medios publicos con
`purpose=invoice_logo`. El backend fuerza scope y owner de clinica, elimina el
nombre original y reencodea a WebP sin metadatos. Solo el logo es publico; el
documento fiscal, sus datos y sus adjuntos nunca usan `PUBLIC_MEDIA`.

## Nominas

Las nominas no se registran como factura de proveedor. Se guarda un resumen
agregado por clinica y mes:

- salario bruto;
- Seguridad Social del trabajador e IRPF como desglose de obligaciones;
- neto pagado;
- Seguridad Social a cargo de la empresa y otros costes;
- coste total de personal = bruto + SS empresa + otros costes.

El coste total reduce el resultado operativo. Los documentos agregados
(`RLC`, `RNT` o resumen de nominas) usan `ClinicalPrivateAssets` con proposito
`accounting_payroll_document`. Recepcion, gestor externo y roles clinicos no
reciben filas ni adjuntos de nominas por defecto.

La cola OCR tambien admite `document_kind=payroll`. El original crea un
`AccountingPayrollDocument` separado del resumen mensual: nombre, mes, bruto,
SS trabajador, IRPF, neto, otros importes, `employee_id` opcional y
`match_status`. Se intenta emparejar por las personas aceptadas de la clinica;
si no hay coincidencia puede conservarse como `unmatched`. Estos documentos no
se vuelven a sumar a `summary.payroll_total`, evitando contabilizar dos veces
la misma nomina.

El backend devuelve datos estructurados; el frontend genera la misma vista.
El PDF A4 se genera con Chromium. Un documento emitido conserva un unico PDF
privado inmutable; los ZIP de gestoria incluyen CSV, PDF emitidos y adjuntos
recibidos organizados por clinica.

Chromium solo puede cargar imagenes desde el frontend, `PUBLIC_MEDIA_BASE_URL`
y los origenes explicitos de `ECONOMIC_PDF_ASSET_ORIGINS`. Las redirecciones a
otros destinos se bloquean para evitar SSRF al usar logos personalizados.

## Lectura automatica de gastos

La cola acepta PDF/JPEG/PNG/WebP hasta 18 MB. El archivo se guarda primero en
almacenamiento privado y el job pasa por `queued`, `processing`, `review`,
`accepted` o `failed`.

El extractor usa Responses API con salida JSON Schema estricta, `store:false`
y el modelo configurable `ACCOUNTING_OCR_MODEL` (default
`gpt-5.4-nano`). Ningun dato se contabiliza automaticamente: `accept` reutiliza
el mismo adjunto privado y crea la factura recibida solo tras revision humana.

Tras leer una factura, el servicio consulta documentos anteriores del mismo
proveedor por NIF o nombre y propone la categoria y medio mas frecuentes. No
necesita un `LEFT JOIN` ni una tabla duplicada de proveedores. La respuesta
incluye `learning` para explicar si se reconocio.

`GET /ingestion` devuelve `expense` por defecto. Para ver `payroll` hay que
pedir `document_kind=payroll` y superar ademas
`accounting.payroll.view`; omitir el filtro nunca expone metadatos de nominas a
un rol con solo permiso OCR.

## Domiciliaciones

El IBAN del paciente se valida con modulo 97 y se cifra con AES-256-GCM. La API
solo devuelve los ultimos cuatro digitos. La exportacion genera `pain.008` y
exige identificador de acreedor e IBAN fiscal de la clinica. La clave dedicada
es `ACCOUNTING_DATA_ENCRYPTION_KEY`, debe tener al menos 16 caracteres,
permanecer estable y ser distinta por entorno. El fallback a `JWT_SECRET`
existe por compatibilidad, pero no debe usarse en produccion.

La lista de cobros elegibles exige presupuesto aceptado/parcial, evento de
aceptacion con `collection_method=direct_debit`, mandato activo e importe
pendiente. Cobros confirmados y remesas operativas se descuentan; la
transaccion de alta vuelve a comprobar el maximo para evitar duplicados. Una
transferencia no entra en SEPA. Estados:
`draft -> exported -> submitted -> settled|rejected`; `rejected` y
`cancelled` liberan el importe para volver a remesarlo.

## VeriFactu

Solo se conserva estado preparatorio. No hay transporte a AEAT:

- recibos: `not_applicable`;
- borradores de factura: `mock_pending`;
- facturas emitidas: `ready`.

## Demo y operacion

La demo visual aislada no reutiliza una clinica real:

```bash
# Configurar antes una clave estable fuera de Git.
# ACCOUNTING_DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)
node src/scripts/qa/prepare-bs-medical-demo-clinic.js
```

El script crea o actualiza `BS Medical · DEMO`, sin grupo, con marcador
`configuracion.qa_demo.key=bs-medical-accounting-demo-v1`. Todo su contenido es
sintetico y eliminable:

- `demo_bsmedical_accounting_v1`: caso de Estetica, historia con antes/despues,
  presupuesto, cobro, bono y factura;
- `demo_bsmedical_nutrition_v1`: caso de Nutricion con dos mediciones completas,
  42 metricas por visita e informe comparativo;
- `demo_bsmedical_capillary_v1`: caso Capilar con antes/despues, informes,
  consentimientos firmados y dos pendientes para tablet;
- ocho tratamientos, instalaciones, horarios, profesional y citas del dia;
- factura recibida privada, miniatura OCR, caja abierta, cierre anterior,
  resumen mensual de personal, nomina individual pendiente, mandato SEPA
  cifrado, pendiente domiciliable, gestoria y plantillas fiscales.

La doctora sintetica usa
`doctora+bs-medical-demo@invalid.clinicaclick.local` /
`DemoDoctor2026!`. La tablet usa `bs-medical-demo-tablet` /
`DemoTablet2026!`. La primera ejecucion genera las credenciales de Recepcion y
gestoria y las imprime una sola vez; las siguientes no restablecen sus
contrasenas.

Recepcion puede abrir, operar y cerrar Caja, pero no recibe resumen contable,
gastos, nominas ni gestion de gestoria. La doctora ve agenda, consentimientos e
historia clinica, sin economia. La cuenta de gestoria solo ve los documentos de
las clinicas asignadas y no recibe navegacion general ni datos clinicos.

El seed es idempotente y se elimina, incluidos archivos privados, sesiones de
tablet y usuarios sinteticos, con:

```bash
node src/scripts/qa/prepare-bs-medical-demo-clinic.js --cleanup
```

La limpieza rechaza cualquier clinica sin el marcador exacto. En `dev`, la
preparacion validada el 2026-07-25 creo `clinica_id=82`; el consumidor debe
resolverla por nombre o marcador y no fijar ese id en codigo. La fecha
operativa se puede fijar sin tocar datos reales:

```bash
BS_MEDICAL_DEMO_BUSINESS_DATE=2026-07-25 \
  node src/scripts/qa/prepare-bs-medical-demo-clinic.js
```

La migracion
`20260725170000-seed-nutrition-system-specialties.js` completa el catalogo
global de Nutricion con Nutricion clinica, deportiva, digestiva y Antropometria
avanzada. No activa areas en clinicas reales.

El seed historico siguiente modifica la clinica 66 y solo se conserva para sus
pruebas API existentes; no debe usarse para preparar demos de producto:

```bash
node src/scripts/qa/prepare-accounting-demo.js
```

Ese seed es idempotente y crea factura recibida con PDF privado, movimiento de
caja y cierre anterior.

Verificacion API reproducible:

```bash
QA_AUTH_TOKEN=... node src/scripts/qa/verify-accounting-demo.js
```

Comprueba workspace, documento fiscal, CSV, PDF privado, zona horaria/caja y
que un adjunto invalido se rechaza sin crear una fila residual.

Validacion visual focal:

```bash
cd /home/ubuntu/wt/front-dev
QA_AUTH_TOKEN=... node scripts/tests/accounting_visual_qa.js
```

La evidencia queda en
`/home/ubuntu/qa-evidence/accounting-visual-20260725/report.json` y cubre
dashboard, OCR de gastos/nominas, caja, SEPA, plantillas, importaciones,
presupuesto aceptado, editor fiscal y print en desktop/movil.

Validacion ampliada del corte `20260725090000`:

- los contratos de acceso backend y de paciente compartido pasan;
- el portal resuelve dos clinicas del grupo de prueba sin aceptar ids ajenos;
- una cuenta de gestoria recibe `cash: null` incluso si llama al workspace
  general, y el alcance se recalcula cuando cambia la composicion del grupo;
- la descarga ZIP contiene CSV, PDF emitidos y adjunto de proveedor;
- presupuesto y documento fiscal se descargan como PDF 1.4;
- la cola OCR conserva el documento en `review` hasta confirmacion humana;
- Chromium desktop/movil, roles y tablet quedan registrados en
  `/home/ubuntu/qa-evidence/bs-medical-operational-20260725/final/report.json`.

En cada runtime:

```bash
npx sequelize-cli db:migrate
pm2 restart <backend>
```

No hay dependencia NPM nueva. Si un corte cambia `package.json` o lockfile,
ejecutar `npm install` en `back-dev`, `back-staging` y `gateway` cuando esos
runtimes carguen el cambio, antes de reiniciar.

Rollback destructivo solo sin datos que conservar:

```bash
npx sequelize-cli db:migrate:undo --name 20260725183000-add-accounting-payroll-documents.js
npx sequelize-cli db:migrate:undo --name 20260725100000-link-voucher-appointments.js
npx sequelize-cli db:migrate:undo --name 20260725090000-expand-clinical-accounting-workflows.js
npx sequelize-cli db:migrate:undo --name 20260724203000-create-accounting-domain.js
```

Estas migraciones están aplicadas en `dev` y `staging`; estado comprobado el
2026-07-29. Los seeds sintéticos de demostración permanecen exclusivos de
`dev`.
