# Backend de contabilidad y gestoria

> Implementado en `dev` el 2026-07-24.
> Prefijo API: `/api/accounting`.
> Migracion: `20260724203000-create-accounting-domain.js`.

## Dominio

- `AccountingExpenseDocuments`: facturas recibidas y gastos.
- `AccountingCashMovements`: entradas, salidas y ajustes manuales.
- `AccountingCashClosures`: arqueo inmutable y snapshot de fuentes.
- `PatientFiscalDocuments`: fuente de facturas/recibos emitidos.
- `EconomicPayments`: fuente de cobros de pacientes.
- `ClinicalPrivateAssets`: adjuntos privados de proveedor con proposito
  `accounting_expense_document`.

El servicio usa consultas separadas y mapas en memoria; no usa `LEFT JOIN`.

## API

- `GET /workspace?clinic_id=&from=&to=&business_date=`
- `GET /documents/:documentId?clinic_id=`
- `GET /export.csv?clinic_id=&from=&to=`
- `POST /expenses`
- `PATCH /expenses/:expenseId`
- `GET /expenses/:expenseId/attachment?clinic_id=`
- `POST /cash/movements`
- `POST /cash/closures`

Los adjuntos no tienen URL publica. La descarga exige JWT, permiso y clinica,
y responde `private, no-store`. Solo admite PDF/JPEG/PNG/WebP hasta 18 MB y
valida MIME, base64 y firma binaria antes de persistir la factura.

## Caja

Formula:

`apertura + cobros efectivo + entradas - facturas recibidas pagadas en efectivo
- salidas + ajustes`

El cierre guarda esperado, contado, diferencia y los ids de documentos y
movimientos usados. Existe una restriccion unica por clinica y dia.
El rango diario se convierte desde la zona de `Clinicas.configuracion`, con
fallback `Europe/Madrid`; no usa medianoche UTC como limite operativo.

## Acceso

- lectura: `billing.reports.view`;
- exportacion: `accounting.export`;
- gastos: `accounting.expenses.manage`;
- caja: `accounting.cash.manage`;
- documentos emitidos: `billing.documents.manage`;
- plantillas: `clinic.settings.edit`.

El subrol `Gestoria` se normaliza como `accountant`: lectura/exportacion si,
mutaciones y datos clinicos no. Los defaults desconocidos devuelven `false`.
La creación y edición de facturas/recibos en `/api/economics` exige
`billing.documents.manage`, no el permiso genérico de editar pacientes.

## Impresion y plantillas

Los documentos fiscales conservan un snapshot de plantilla. Builtins:

- `builtin-invoice-standard`: `Fuse moderna`, renderer `modern`;
- `builtin-invoice-compact`: `Fuse compacta`, renderer `compact`.

El backend devuelve datos estructurados; el frontend genera vista e impresion
A4 con el mismo renderer. No se persiste un PDF duplicado.

## VeriFactu

Solo se conserva estado preparatorio. No hay transporte a AEAT:

- recibos: `not_applicable`;
- borradores de factura: `mock_pending`;
- facturas emitidas: `ready`.

## Demo y operacion

```bash
node src/scripts/qa/prepare-accounting-demo.js
```

El seed de clinica 66 es idempotente y crea factura recibida con PDF privado,
movimiento de caja y cierre anterior.

Verificacion API reproducible:

```bash
QA_AUTH_TOKEN=... node src/scripts/qa/verify-accounting-demo.js
```

Comprueba workspace, documento fiscal, CSV, PDF privado, zona horaria/caja y
que un adjunto invalido se rechaza sin crear una fila residual.

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
npx sequelize-cli db:migrate:undo --name 20260724203000-create-accounting-domain.js
```

No se aplico esta migracion en staging durante el corte.
