# Auditoría de lecturas de pacientes: contrato y corte

Estado 13/09/2026: código preparado, captura apagada, migración ensayada solo
en MySQL propio con datos ficticios. Sin despliegue ni operación AWS. OPS
queda aplazado por el usuario; el apagado de EC2 está anunciado, sin comprobar.
Este bloque no acredita contención del incidente WABA ni prueba sus tokens.

## Cobertura concreta

Siete controladores GET existentes, montados en `/api/pacientes`. Conservan
sus DTO y permisos de negocio; el wrapper retiene la respuesta JSON mientras
guarda la auditoría. Ninguna llamada a WhatsApp, proveedor o mensaje real.

| Sufijo de ruta | Acción v6 | Revalidación al preparar y tras persistir |
|---|---|---|
| `/` | `patient.list` | `patients.view`; sensible si la respuesta no está redactada |
| `/search` | `patient.search` | `patients.view` y `patients.sensitive.view` |
| `/contact-targets` | `patient.contact_targets` | Sensible en clínica elegida y clínicas legibles |
| `/check-duplicates` | `patient.duplicate_check` | `patients.edit` en elegida; sensible en la parte visible del duplicado |
| `/:id/consents` | `patient.legacy_consents.read` | `consents.view` en todas las clínicas del paciente |
| `/:id` | `patient.detail.read` | `patients.view` y sensible |
| `/:id/activity` | `patient.activity.read` | View/sensible y `nutrition.workspace.view` donde se consultó Nutrición |

Después de cada verificación de permisos se consulta la pertenencia actual
de las fichas devueltas y relaciones no redactadas. Debe mantenerse una
clínica visible; consentimientos legacy exige que no aparezcan pertenencias
fuera del ámbito validado. Son comprobaciones puntuales, sin bloqueo del
dominio que pueda garantizar autorización durante toda la entrega HTTP.

Los retornos vacíos sin objetivo también dejan resultado. La detección
redactada de duplicados conserva `exists: true`, sin ID de paciente en el
evento cuando no se devuelve su ficha. Intentos rechazados por el middleware
de autenticación antes del controlador no pertenecen a esta captura.

Correcciones de privacidad vigentes incluso con captura apagada:

- El identificador público ausente de una ficha solo se crea después de
  autorizar su detalle. Antes podía escribirse para una petición denegada.
- Los contactos filtran los vínculos de clínicas mediante la proyección
  compartida. El mensaje de duplicado usa también la clínica de esa proyección;
  evita conservar en el texto el nombre de una sede fuera del ámbito. Este
  helper se comparte con las validaciones de alta/edición, sin cambiar su flujo.
- Los siete errores internos de lectura devuelven `patient_read_failed` y
  el log de contactos usa un código fijo; no serializan el error SQL.

## Evento y significado

Codec cerrado `v6`, prefijo `app/platform/v6/fechaUTC/…`, sin cambiar los
bytes v1–v5. Actor/sesión, UUID de correlación generado en servidor, fecha,
acción, scope, IDs internos ordenados de clínicas/pacientes, número de
pacientes únicos/resultados, indicador de respuesta sensible y número de
parte. `authorizationPolicyVersion=patient-read-scope-v1`,
`capturePolicy=patient-reads-durable-v1`.

No guarda nombres, identificadores públicos, búsquedas, teléfonos, correos,
direcciones, notas, cuerpos clínicos, consentimientos, respuestas completas,
headers ni secretos. El SHA-256 del conjunto usa exclusivamente los metadatos
enumerados; no es un hash del contenido clínico. Los IDs siguen siendo datos
vinculables: requieren los mismos controles de acceso y retención aprobada.

`attempted/unknown/request_received` se persiste antes del trabajo. Contiene
actor/sesión, sin objetivo ni contadores no verificados. Un resultado negativo
usa motivos cerrados: petición inválida, denegación, recurso ausente u operación
no confirmada, también sin objetivos. Caída del proceso puede dejar solo intento.

El éxito es `completed/success/response_prepared`: acredita preparación
autorizada, no recepción del navegador. Tras persistir, se repiten sesión,
permisos y pertenencia. Si cambian, se bloquea la respuesta y se intenta guardar
`discarded/denied/access_changed`; otros fallos posteriores usan
`discarded/error/response_unconfirmed`. El descarte no reemplaza el éxito
preparado ni contiene IDs de pacientes. Si también falla su persistencia,
el cliente recibe 503 y puede quedar solo la evidencia de preparación.

Hasta 100 clínicas y 10.000 pacientes únicos por respuesta; los IDs incluyen
relaciones presentes en el DTO, también referencias redactadas. Cada evento
contiene hasta 100 IDs de paciente y ocupa como máximo 4096 bytes. Un resultado
vacío genera una parte. `patientCount` cuenta IDs únicos de toda la respuesta;
`resultCount` cuenta elementos devueltos (ficha = 1, actividad/documentos = N).
La paginación del listado conserva `total`; la auditoría cuenta la página.
Los límites de captura no añaden paginación al listado legacy ilimitado: si
supera el límite, no se entrega y debe usarse su paginación existente.

Todas las partes del resultado comparten correlación, `resultSetDigest`,
contadores y número de partes. Se insertan **en una transacción SQL**: el fallo
de una parte revierte todas. El intento queda fuera y permite registrar error.
La entrega S3 posterior sigue siendo individual: una página del visor puede
contener solo parte del conjunto. No certifica integridad entre partes ni
historial completo; verifica bytes/digest/versión de cada objeto mostrado.

## Activación, límites y compatibilidad

`PLATFORM_AUDIT_PATIENT_READS_ENABLED` ausente/vacío/`false`: sin outbox ni
revalidaciones adicionales de esta cohorte. `true` activa captura; cualquier
otro valor cierra la lectura con 503. El gate no se configura en PM2 desde
esta tarea. Sesión caducada/revocada devuelve 401; permiso perdido, 403;
auditoría/metadatos/límite no disponible, 503 `patient_read_audit_unavailable`.
Todas estas lecturas envían `Cache-Control: private, no-store`.

Backlog de 10.000 eventos o antigüedad de una hora cierra la admisión. Se
comprueba otra vez con el número de partes antes de la transacción. No es
reserva distribuida de capacidad, cola global ni límite temporal de SQL.
Varias solicitudes simultáneas pueden superar el umbral entre comprobaciones;
medir concurrencia/pool/latencia antes del corte y mantener entrega monitorizada.

La creación lazy del `public_id` en listados/búsquedas/detalle sigue siendo una
mutación legacy separada del resultado. El intento la precede con captura
activa, pero no se reclama atomicidad del dominio ni auditoría de escrituras.
Resto de escritores, exportaciones, adjuntos, consentimientos modernos,
Nutrición/PDF, Director, otras APIs, SQL/scripts y OPS siguen pendientes.

El visor técnico existente añade filtros para las siete acciones, metadatos
`patientRead`, correlación, partes e IDs desplegables. Solo admins 1/44 con
sesión gestionada y objetos externos confirmados; ninguna PII clínica nueva.
La etiqueta Preparado y el descarte conservan la distinción de entrega.

## Migración y lote pendiente de aprobación

`20260913003000-add-platform-audit-result-part` requiere
`20260912210000-create-platform-audit-events`. Un ALTER MySQL 8 añade
`result_part INT UNSIGNED DEFAULT 0 NOT NULL` y cambia la unicidad a
`(correlation_id, stage, result_part)`. Los codecs previos escriben parte 0,
con la misma unicidad anterior. **Aplicarla antes del nuevo modelo ORM**, aunque
la captura esté apagada; APIs/jobs de auditoría previos también usan el modelo.
Writer/reader v6 antes de generar eventos v6. El índice del visor sigue siendo
`20260912230000`; no requiere otra modificación.

El lote operativo aún no está autorizado: responsable de aplicación/DBA debe
aportar respaldo restaurable de outbox y esquema, cantidad/tamaño de tabla,
ventana y prueba del ALTER/metadata lock; las siete suites locales no miden
el bloqueo ni volumen real. Preparar los commits exactos, desplegar lector/
writer compatibles y migrar solo esta dependencia en la BD compartida bajo
el runbook. No usar `db:migrate` general ni arrancar jobs para probarlo.

Antes de activar captura: aprobar el corte de sesiones `AUTH_SESSION_MODE=enforce`
y sus dependencias, delivery/monitor operativos, canary de permisos/roles/
clínicas/relaciones y carga, retención DPD e IAM/KMS efectivos. Modo legacy
no acredita revocación persistente de esos JWT. Con EC2 fuera del foco, ninguna
de estas verificaciones se sustituye por acceso alternativo o llamadas reales.

Coste pendiente de medir: por lectura correcta, `1 + max(1, ceil(P/100))`
eventos, más un eventual descarte; consulta negativa dentro del wrapper,
normalmente dos. Multiplica carga SQL, PUT S3/KMS, almacenamiento/versiones
y GET del visor. Por ejemplo 205 IDs producen cuatro eventos y hasta cuatro
PUT iniciales; reintentos/lecturas pueden añadir operaciones. No es un precio
ni una garantía de gasto. Ajustes mantiene gasto/presupuesto/estimación
separados; Budget 60/45 y CloudFormation, etiquetas/CE y retención continúan
pendientes. No se cambia presupuesto, infraestructura ni IAM.

Rollback: detener la cohorte según el lote aprobado, preservar las correcciones
de privacidad y los eventos. El `down` rechaza cualquier evento v6, incluso
parte 0, para no destruir evidencias; solo revierte un esquema sin v6 ni
partes adicionales. No bajar writer/reader a codecs incompatibles mientras
existan estos eventos. Desactivar captura pierde cobertura futura y no borra
registros; requiere decisión operativa, no se hace como fallback silencioso.

## QA y publicación

75 tests: paquete Node 24, captura/HTTP y regresiones Node 18, hotfix y visor
frontend. Además, contrato existente de scope ejecutado con modelos sustituidos,
58 comprobaciones MySQL 8.0.42 en siete procesos con socket/datadir propios,
cierre 0, Angular y ocho capturas Chromium desktop/móvil del componente real.
Todo ficticio; red externa bloqueada, sin bootstrap real ni sesión de aplicación.
Los primeros ensayos corrigieron un doble incompleto de permisos y un nombre
de método del reconciliador en QA; no se quitó ninguna guarda de aislamiento.

Reproducir los nuevos tests desde backend:

```sh
node --require ./src/scripts/tests/fixtures/security_offline_runtime.cjs --test src/scripts/tests/platform_audit_patient_reads.test.js src/scripts/tests/platform_audit_patient_http.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/platform_audit_patient_mysql.integration.js
```

El fixture MySQL instala su propia guarda y reemplaza el índice de modelos;
no añadirle el preload de red anterior. Paquete de auditoría: Node 24 con
`--require ./test/offline-guard.cjs --test test/*.test.js`. Front:
`scripts/tests/platform_audit_view_contract.test.js` y
`platform_audit_view_chromium_qa.js` con salidas privadas.

Inventario estático renovado: 60 archivos/874 declaraciones, siete lecturas
adicionales preparadas, cero cobertura runtime acreditada. Actualiza también
hash/líneas del OAuth ya publicado en el bloque anterior, sin modificarlo.
El inventario manual de este bloque está en `patient-read-cohort-inventory.json`.

Evidencias fuera de rutas públicas:
`/home/ubuntu/qa-evidence/security-migration-20260912/patient-read-offline-qa.json`,
`patient-read-api-mirror.json` y `patient-read-publication.json`. Las actas
registran hashes, suites y SHAs remotos efectivos al cerrar. API primero en
backend; espejo solo del apartado nuevo, conservando divergencia histórica
y publicidad. Publicar DEV no despliega ni migra la BD compartida.
