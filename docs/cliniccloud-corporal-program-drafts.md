# Borradores documentales de programas corporales

> **Tipo:** runbook de operación acotada.
> **Fuente de verdad:** ejecución del operador; contrato y estado en el manual central.
> **Última revisión:** 2026-09-27.
> **Relacionado con:** [37-importaciones](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/37-importaciones-cliniccloud-y-otros-sistemas.md).

El operador `src/scripts/cliniccloud-import-corporal-program-drafts.js` prepara
once definiciones adicionales en Medical. Conserva los dos ejemplos iniciales
Tono/Suelo Pélvico, los cinco capilares y todos los tratamientos individuales.
No crea compras, citas de pacientes ni movimientos de maquinaria.

## Alcance documental cerrado

Los dos PDF exactos de `Archivo explicado.zip` tienen huellas fijadas en
`corporal-program-drafts.js`: protocolo Corporal V1 y Tarifa 2026 Corporal.
La tarifa declara vigencia 01/10/2026; el protocolo contiene fechas contradictorias.
Los importes se conservan en notas, con `total_price=null`, nunca cero ni
aplicación anticipada. La importación no aprueba clínicamente el manual.

| Definición | Citas | Tratamiento individual |
| --- | ---: | --- |
| BS Contorno | 8 | Variante COR-43 pendiente; no sustituir por dos sesiones sueltas. |
| BS Firmeza | 8 | Combinado EXION/INDIBA de 45 min, pendiente de cierre de recursos. |
| BS Celulitis | 8 | Combinado ondas/RF; mesoterapia después en citas 3 y 6, 55 min en total. |
| BS Recuperación / versión corta | 10 / 6 | Postoperatorio combinado de 45 min, no INDIBA suelto. |
| BS Lipedema | 10 | Estándar 60 min, no ampliada de 75 min. |
| BS Linfedema control / continuidad | 10 / 6 | Tratamiento de linfedema de 60 min. |
| BS Contorno Arranque / 10 / Continuidad | 4 / 10 / 12 | Variantes y reparto temporal todavía pendientes. |

Son 92 entradas de composición, **no 92 reservas**. Las citas semanales tienen
propuesta días 0/7/14…; frecuencias variables siguen sin pauta automática.
Contorno añade mesoterapia después de sus 45 min en citas 2/5/8; se conserva
en notas/etiquetas, sin vincular solo el inyectable y perder la base pendiente.
En los tres ciclos de captación no se conoce el reparto de sus 45 min ni si
mesoterapia se añade: no copiar el reparto de otro protocolo.
Las condiciones 590 € dentro de cirugía y crédito de 100 € tras Arranque se
conservan en notas, no generan programas duplicados ni descuentos automáticos.

## Ejecución y controles

Desde `back-dev`, rama `dev`:

```text
node src/scripts/cliniccloud-import-corporal-program-drafts.js
  --mode prepare|preview|apply|verify --target crm
  --plan /ruta/privada/plan.json
  --workbook /ruta/BASE_DE_DATOS_TRATAMIENTOS_BS_MEDICAL_v2.xlsx
  --archive /ruta/Archivo explicado.zip
  --private-output /ruta/privada/salida-nueva.json
```

- `prepare`: SELECT consistente y paquete inmutable. Verifica fuentes,
  pertenencia, estado inactivo y correspondencias exactas de seis individuales.
- `preview`: añadir `--package`; usa la sesión normal CRM de Chromium 9227 y
  POST canónico de previsualización. Debe devolver borrador no comprable,
  precio nulo y reserva incompleta; no crea definiciones.
- `apply`: añadir paquete, `--approved-sha256`, `--backup-manifest` y
  `--private-journal`. Exige código limpio/commiteado, paquete y backup CRM
  verificado de menos de dos horas. Once POST canónicos independientes con
  claves estables; no es una transacción global. No copia tokens a disco ni
  elude MFA. SQL independiente verifica definición y revisión inicial.
- `verify`: añadir paquete; solo SELECT. El replay no duplica y rechaza una
  edición humana posterior, antes de crear otros registros. Ante timeout,
  conciliar diario y request key; no regenerar claves ni borrar filas.

Comparación antes/después de citas, catálogo individual, consentimientos
asociados y programas previos. El operador nunca cambia esos datos, nunca
activa recordatorios y no se carga en la API/worker/gateway normal.

Pruebas:

```sh
node --test src/scripts/tests/cliniccloud_corporal_program_drafts.test.js src/scripts/tests/treatment_programs.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/cliniccloud_corporal_program_drafts_mysql.integration.js
```

La integración usa MySQL temporal por socket y datos ficticios; verifica
revisiones, replay, clínica ajena, catálogo intacto y rechazo de activación.
Completar con Chromium de sesión normal, escritorio/móvil, sin guardar cambios.
No requiere build frontend, migración ni reinicio de runtime.

## Reversión

No restaurar una base completa ni borrar definiciones/revisiones. Conservar
borradores y diario; si procede retirarlos, archivar mediante API y versión
actual tras comprobar dependencias y que no haya ediciones humanas nuevas.
