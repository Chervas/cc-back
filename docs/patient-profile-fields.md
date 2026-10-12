# Datos básicos y datos clínicos relevantes del paciente

> **Tipo:** contrato y runbook de esquema aditivo.
> **Última revisión:** 12/10/2026.
> **Estado de este corte:** implementación y pruebas preparadas; el usuario ha autorizado explícitamente la migración y publicación en DEV y CRM el 12/10/2026. Todavía no se ha aplicado SQL ni publicado este cambio. La aprobación no sustituye la verificación del plan, respaldo y esquema de cada destino.

## Contrato canónico

La ficha conserva una única fuente canónica en `Pacientes`. Alergias,
medicación actual y antecedentes siguen usando `alergias`, `medicacion` y
`antecedentes`, respectivamente. `notas_medicas` añade un cuarto campo clínico
independiente: no duplica ni reclasifica antecedentes, notas internas o archivos
de origen.

La antigua UI editaba antecedentes mediante un control llamado `notas`, que el
PATCH no admitía. La nueva UI debe enviar `antecedentes` para este contenido y
`notas_medicas` únicamente para las notas médicas diferenciadas. No convertir
el alias antiguo en una escritura automática sobre ambos campos.

Los nueve campos nuevos son nullable, sin valores predeterminados ni backfill:

| Campo API/BD | Tipo | Límite de entrada | Uso |
| --- | --- | --- | --- |
| `notas_medicas` | TEXT NULL | 16.000 caracteres | Notas médicas de la ficha, separadas de antecedentes |
| `direccion` | TEXT NULL | 2.000 caracteres | Dirección postal, conservando texto y líneas |
| `codigo_postal` | VARCHAR(32) NULL | 32 caracteres | Código postal textual; conserva ceros iniciales |
| `poblacion` | VARCHAR(255) NULL | 255 caracteres | Población |
| `provincia` | VARCHAR(255) NULL | 255 caracteres | Provincia |
| `pais` | VARCHAR(255) NULL | 255 caracteres | País de la dirección |
| `pais_origen` | VARCHAR(255) NULL | 255 caracteres | País de origen, independiente del país de la dirección |
| `estudios` | VARCHAR(255) NULL | 255 caracteres | Estudios registrados |
| `tiene_hijos` | BOOLEAN NULL | boolean o null | Sí, no o desconocido; nunca falso por omisión |

`notas_paciente` conserva su contenido existente y su almacenamiento. Su nuevo
rótulo de interfaz es «Notas varias», con indicación de no introducir notas
sanitarias. Ese cambio de rótulo no permite borrar, separar o reclasificar
automáticamente contenido antiguo que pudiera estar mezclado.

Profesión, cómo conoció la clínica, nacimiento, sexo, altura y peso mantienen
sus campos existentes. La reorganización visual de «Información adicional»
dentro de «Datos básicos» no cambia su significado ni introduce valores por
defecto. No se añade un flag de menor ni se modifican relaciones de tutoría:
la UI debe distinguir una fecha de nacimiento desconocida de una edad conocida,
y mostrar las relaciones existentes sin deducir nuevas autorizaciones legales.

## Lectura, escritura y protección

El contrato común de campos y tipos está en
`src/lib/patient-profile-fields.js`; el modelo reutiliza sus atributos nullable.
`POST /pacientes` y `PATCH /pacientes/:id` admiten los nueve campos canónicos.

La validación de los nuevos campos ocurre después de comprobar `patients.edit`
y antes de mutar el paciente o guardar cualquier parte de un PATCH mixto. Un
campo nuevo inválido rechaza la solicitud completa sin guardar otros campos:

- Campos omitidos o con `undefined` no generan valores ni reemplazan el dato vigente.
- `null` explícito conserva la condición de desconocido o limpia sólo el campo solicitado.
- Las cadenas vacías son explícitas y se conservan. No se recorta ni transforma el texto clínico.
- Los campos de texto sólo aceptan string o null; `tiene_hijos` sólo acepta boolean o null. No se convierten `"false"`, `0`, arrays u objetos.
- Los límites cuentan puntos de código Unicode. Se rechazan NUL y texto que exceda 65.535 bytes UTF-8; no se trunca silenciosamente.
- Los errores de validación exponen únicamente el nombre del campo y un motivo canónico, nunca el valor enviado.

La redacción de pacientes sin permiso sensible incluye los nueve campos nuevos,
también para pacientes embebidos en relaciones de otra clínica no visible. Los
controles y filtros existentes de clínica y lectura sensible no se amplían.

No se utiliza `PatientCustomFields` como escritor de estos campos: esa tabla
también alimenta variables de marketing. Las notas médicas no se añaden a esas
variables. Los snapshots y el histórico de ClinicCloud mantienen su contrato
de evidencia original de sólo lectura; no rellenan por inferencia los nuevos
campos canónicos ni son sobrescritos al editar la ficha.

## Migración aditiva

La única migración de este corte es
`20261012100000-add-patient-profile-and-medical-notes.js`, SHA256
`b642794506d9cbcb11d8ca5b22817bfe3a8f4e7f581fa42d9fb1c7ab6f64870b`.
El contrato puro de campos tiene SHA256
`6872ca9f3d416fecbf6ac47cbe62206df94401d901653aec8194be4eedbc6ef9`.

`up` añade sólo columnas ausentes. Antes de la primera DDL compara cualquier
columna ya existente: debe tener el tipo esperado, permitir NULL y no tener un
default distinto de NULL. No altera columnas ajenas ni realiza DML, backfill,
copias desde importaciones o escrituras en campos personalizados. Una carrera
de columna duplicada sólo se acepta después de verificar su definición exacta.

MySQL DDL confirma implícitamente. Una aplicación parcial no es una transacción
reversible: conservar evidencias y revisar el estado antes de preparar una
recuperación. Aunque `up` puede reanudar un estado parcial estrictamente
compatible, el operador de publicación rechaza estados existentes o parciales
para impedir un reintento ciego.

`down` rechaza eliminar estas columnas, porque podría destruir notas y
direcciones introducidas posteriormente. El rollback de código conserva el
esquema aditivo; no restaura globalmente una BD sobre escrituras nuevas.

## Secuencia de publicación autorizada

El operador específico es `src/scripts/patient-profile-schema-release.js`
(`prepare`, `check`, `apply`, `verify`). Debe ejecutarse desde
`/home/ubuntu/wt/back-dev`, rama canónica DEV, fuente limpia y comprometida.
Sólo aplica la migración anterior y el registro correspondiente en
`SequelizeMeta`: no ejecuta el historial completo de migraciones pendientes.

Sus planes y verificaciones leen metadata e identidad de BD, no filas o
contadores de pacientes. El plan vincula destino, nombre exacto de BD,
configuración, commit, hashes revisados y metadata previa. La comparación de
conservación acredita metadata, no una lectura o hash del contenido clínico.

1. Obtener la aprobación explícita del corte y revisar íntegramente el operador,
   el respaldo y sus helpers reutilizados. Confirmar identidad de cada destino
   sin volcar secretos, sesiones o variables de entorno. No mezclar credenciales
   DEV/CRM ni cambiar MFA, gates o flags para ejecutar el corte.
2. Preparar un plan privado para un destino y conservar el `plan_sha256` emitido:

   ```bash
   cd /home/ubuntu/wt/back-dev
   cc_profile_target=dev
   cc_profile_cut=$(mktemp -d /home/ubuntu/secure-imports/patient-profile-dev-XXXXXX)
   node src/scripts/patient-profile-schema-release.js --mode prepare --target "$cc_profile_target" --private-output "$cc_profile_cut/plan.json"
   ```

3. Crear un respaldo completo nuevo del mismo servidor y BD:

   ```bash
   mkdir -m 700 "$cc_profile_cut/backup"
   node src/scripts/cliniccloud-operator-backup.js --target "$cc_profile_target" --private-directory "$cc_profile_cut/backup"
   ```

   El respaldo verifica identidad, tablas InnoDB, integridad gzip, finalización
   del dump y SHA256. Esto no acredita un ensayo real de restauración. Plan y
   respaldo deben tener menos de dos horas al aplicar el corte.
4. Conservar los estados anteriores de los servicios. DEV exige detener
   previamente `clinicaclick-back-dev.service` y
   `clinicaclick-dev-security.service`; el operador sólo comprueba sus estados,
   no los cambia. Coordinar el corte CRM conforme a su runbook habitual sin
   cambiar flags de proveedores, pausas, workers o MFA.
5. Aplicar el plan aprobado con un diario privado nuevo y verificarlo:

   ```bash
   node src/scripts/patient-profile-schema-release.js --mode apply --target "$cc_profile_target" --plan "$cc_profile_cut/plan.json" --approved-plan-sha256 HASH_EMITIDO_POR_PREPARE --backup-manifest "$cc_profile_cut/backup/backup-manifest.json" --private-journal "$cc_profile_cut/journal.jsonl"
   node src/scripts/patient-profile-schema-release.js --mode verify --target "$cc_profile_target" --plan "$cc_profile_cut/plan.json" --private-output "$cc_profile_cut/verified.json"
   node src/scripts/patient-profile-schema-release.js --mode check --target "$cc_profile_target" --private-output "$cc_profile_cut/preflight.json"
   ```

   Los nueve ADD exigen `ALGORITHM=INSTANT`; si no se soporta, se falla sin
   reconstruir/copiar la tabla. El diario registra intención antes de DDL y se
   verifica la metadata previa antes de registrar esta migración. Sólo el
   registro de `SequelizeMeta` es transaccional, no la DDL.
6. Verificar estos nueve tipos, nullable/default NULL y charset/collation
   heredados de `Pacientes`, además del preflight normal de seguridad. Publicar
   y recargar el backend **después del schema**: el modelo nuevo selecciona
   estas columnas y fallaría si todavía no existen. El preflight general de
   seguridad no sustituye el específico de este corte.
7. Publicar DEV mediante `ops/security/publish-isolated-dev.py` y restaurar el
   estado previo de los servicios según el procedimiento aprobado. Repetir
   preparación, respaldo y verificación para CRM con otro directorio y destino
   explícito `crm`; no reutilizar plan o respaldo DEV. Cerrar evidencia del
   build servido y aceptación autenticada sin atribuir a estas pruebas una
   publicación aún no realizada.

Ante error, conservar plan, respaldo y diario; detener la continuación del
corte y revisar su último paso. No ejecutar `down`, reintentar automáticamente,
alterar permisos o restaurar globalmente el respaldo sobre cambios posteriores.

## Validación realizada, todavía sin SQL ni publicación

Los casos directos pasan 23/23 pruebas del contrato de campos y 13/13 del
operador. Las pruebas HTTP utilizan un servidor ficticio propio en
`127.0.0.1`, con conexiones a BD/proveedores y servidores ajenos bloqueadas:
10/10 casos directos pasan. La cohorte final comprende estos 11 archivos y
pasa 107/107 comprobaciones del runner, cero fallos, cancelaciones o skips:

- `patient_profile_fields.test.js`
- `patient_profile_schema_release.test.js`
- `patient_history_duplicates.test.js`
- `platform_audit_patient_reads.test.js`
- `patient_shared_scope_contract.test.js`
- `cliniccloud_patient_history.test.js`
- `cliniccloud_source_patient_notes.test.js`
- `patient_questionnaire_lifecycle.test.js`
- `patient_intake_access.test.js`
- `patient_contact_search.test.js`
- `platform_audit_patient_http.test.js`

La cohorte final terminó correctamente en la sesión 21711, en 3.482,444 ms.
Son pruebas offline y HTTP ficticias: no sustituyen MySQL real, aplicación de
DDL, respaldo operativo ni validación autenticada de un build publicado.

Las ejecuciones anteriores fallidas no cuentan como aceptación: el sandbox
impedía el bind HTTP (`EPERM`), y después se identificó una dependencia pura
ausente del fixture que HEAD ya utilizaba. Se corrigió únicamente el fixture;
la frontera de dependencias permanece estricta. Un test antiguo de idioma
tiene además una aserción estática previa incompatible con el wrapper actual
de reservas; no se modificó ni se incluyó como prueba pasada de este corte.

Hasta registrar resultados reales de una operación autorizada, este documento
describe implementación preparada, no una migración aplicada o publicación.
