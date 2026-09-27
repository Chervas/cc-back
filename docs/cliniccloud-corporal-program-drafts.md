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
| BS Contorno | 8 | Variante COR-43 específica; operador complementario al final de este runbook. |
| BS Firmeza | 8 | Combinado EXION/INDIBA de 45 min, pendiente de cierre de recursos. |
| BS Celulitis | 8 | Combinado ondas/RF; mesoterapia después en citas 3 y 6, 55 min en total. |
| BS Recuperación / versión corta | 10 / 6 | Postoperatorio combinado de 45 min, no INDIBA suelto. |
| BS Lipedema | 10 | Estándar 60 min, no ampliada de 75 min. |
| BS Linfedema control / continuidad | 10 / 6 | Tratamiento de linfedema de 60 min. |
| BS Contorno Arranque / 10 / Continuidad | 4 / 10 / 12 | Variantes y reparto temporal todavía pendientes. |

Son 92 entradas de composición, **no 92 reservas**. Las citas semanales tienen
propuesta días 0/7/14…; frecuencias variables siguen sin pauta automática.
Contorno añade mesoterapia después de sus 45 min en citas 2/5/8. El operador
inicial conserva huecos sin enlazar únicamente el inyectable; el complemento
COR-43 vincula después la base y la mesoterapia, juntas y en ese orden.
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

## Perfiles físicos de las sesiones combinadas

`cliniccloud-import-corporal-program-profiles.js` concilia cinco individuales
inactivos con el mismo PDF y las unidades confirmadas. No crea tratamientos,
programas, citas ni equipos. Siete definiciones reciben una revisión solo de
notas, sin cambiar composición, precio o pauta.

| Sesión | Primer paso | Segundo paso | Total |
| --- | --- | --- | ---: |
| Firmeza | C12, EXION, 20 min | C12, INDIBA, 25 min | 45 min |
| Celulitis | C11, ondas BTL, 27 min | C11, Cyclone, 18 min | 45 min |
| Recuperación | C12, INDIBA, 28 min | C9, Lymphastim, 17 min | 45 min |
| Lipedema estándar | C12, INDIBA, 35 min | C9, Lymphastim, 25 min | 60 min |
| Linfedema | C12, INDIBA, 40 min | C9, Lymphastim, 20 min | 60 min |

Son agrupaciones de pasos consecutivos del documento por uso de máquina,
incluyendo preparación/registro. No se añaden tiempos ni se cambia el contenido
clínico. Dos fases en la misma cabina mantienen su ocupación continua, pero
liberan EXION/BTL al terminar su parte. Piedad conserva la asignación del Excel;
la cualificación específica de linfedema **no se da por acreditada**. El estado
permanece borrador y conserva revisión clínica/fiscal y consentimientos pendientes.
La mesoterapia adicional de Celulitis sigue siendo su tratamiento de diez minutos;
las citas 3/6 continúan sumando 55 minutos, ahora con tres fases físicas.

Mismos argumentos de fuentes/paquete del operador anterior; modos
`prepare|rehearse|apply|verify`. Preparación solo SELECT. Ensayo y aplicación
requieren SHA del paquete, copia íntegra de CRM de menos de dos horas, código
commiteado limpio, diario privado y sesión normal de CRM. Los cinco perfiles se
actualizan en una transacción bloqueada, solo `clinical_config` y `updatedAt`;
el ensayo revierte y comprueba el estado original. El resto del catálogo,
recursos, citas y vínculos de consentimiento no cambian. Las siete revisiones
posteriores usan la API normal con versión esperada: no es una transacción
global con los perfiles. Un fallo parcial exige el mismo paquete/diario; replay
concilia el estado y no pisa ediciones humanas. La verificación independiente
comprueba también las revisiones canónicas. No ejecutar nuevamente `prepare`
para sobrescribir una configuración ya aplicada.

Pruebas focales:

```sh
node --test src/scripts/tests/cliniccloud_corporal_program_profiles.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/cliniccloud_corporal_program_profiles_mysql.integration.js
```

Reversión de perfiles: revisar primero los IDs, cambios posteriores y el
`previous_profile` del diario; preparar una corrección individual versionada,
sin retirar maquinaria ni restaurar toda la base. No aprobar ni activar un
perfil antiguo por volver a él. Las notas se corrigen con una revisión nueva.

## Variante COR-43 y composición de BS Contorno

`cliniccloud-import-contorno-program-variant.js` crea un único individual
inactivo `BS26-COR43-PROGRAM` y revisa la definición de Contorno, sin cambiar
los tratamientos sueltos, los otros programas ni citas existentes.
Fuente exacta: mismo protocolo, páginas PDF 10/11/32. Sesión total 45 min:
C11/Piedad/Cyclone 35 min (5+3+10+9+8) y C11/Piedad/EXION 10 min (8+2).
La sala sigue ocupada entre pasos; EXION no se reserva durante el Cyclone.
No es la variante COR-42 de 75 min ni la suma de dos sesiones de 45 min.

Las ocho entradas reciben COR-43; en 2/5/8 se añade después la mesoterapia
existente de C9, diez minutos. Totales 45/55/45/45/55/45/45/55, conservando
la propuesta semanal y sin crear reservas. Piedad en inyectables sigue siendo
la asignación provisional autorizada, no una acreditación clínica.
Precio base nulo; 145 € documental desde 01/10/2026 queda en procedencia/notas,
no se presenta como precio vigente ni se transforma en cero. No se añade bono
ni consentimiento por suposición. Borrador y revisión clínica/fiscal persisten.

Mismos argumentos, modos `prepare|apply|verify`. `prepare` solo lee; `apply`
exige backup CRM íntegro verificado y paquete menores de dos horas, SHA
revisado, código limpio commiteado, diario privado y sesión normal de CRM.
Usa POST canónico de tratamiento y PATCH de programa con versión esperada 1;
son dos operaciones, no una transacción global. SQL es solo lectura y verifica
también la revisión 2. Si falla entre operaciones, conciliar el código estable
y el diario con el paquete original; el replay no duplica ni pisa cambios.
Comprueba todas las citas y vínculos de consentimiento antes/después.

```sh
node --test src/scripts/tests/cliniccloud_contorno_program_variant.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/cliniccloud_contorno_program_variant_mysql.integration.js
```

Reversión no destructiva: mantener el individual como borrador y, solo tras
comprobar dependencias y cambios humanos, emitir una revisión de programa
basada en el snapshot anterior. No borrar historial ni restaurar la BD completa.
