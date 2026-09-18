# Google Ads: ámbito y solicitudes de alta en la aplicación

Estado 18/09/2026: preparados el esquema, validadores, comprobación de ámbito,
cliente tipado, escritor y worker de conciliación. El guardado humano de mappings
comprueba la confirmación del broker y actualiza la solicitud en la misma
transacción que el mapping, binding y auditoría. Faltan las rutas de alta/estado,
su enlace con bajas y Ajustes, y registrar/configurar el worker con autorización
de sesión persistente. No hay alta real completa ni worker de alta instalado.
Las pruebas nuevas son aisladas y no sustituyen una prueba visual autenticada.

## Registro independiente

La migración `20260913120000-create-google-ads-enrollment.js` crea:

| Tabla | Finalidad |
| --- | --- |
| `GoogleAdsEnrollmentScopes` | Un ámbito aprobado por clínica/grupo: identidad Google, conexión, tenant, MCC, gestor y referencia sintética. Estado inicial `blocked`. |
| `GoogleAdsEnrollmentRequests` | Intención por UUID, cliente único, referencias originales, conjunto de clínicas, actor/sesión, tres UUID de comandos, estado y campos de entrega. |

No hay FK ni borrado en cascada. Una solicitud conserva su conexión y sujeto
aunque desaparezcan los registros originales. El down rechaza cualquiera de las
dos tablas con datos. Una cuenta nueva no puede reservarse para dos propietarios.
Trasladar propietarios y recuperar capacidad borrando historia no forman parte
de este flujo.

La DDL es **obligatoria antes del futuro corte de código aunque los gates estén
apagados**: la barrera de credenciales consulta ambas tablas. Un esquema ausente
falla cerrado. El 18/09 se aplicó por plan exacto a DEV aislado junto con las
otras doce migraciones Google necesarias: registros vacíos, flags apagados,
sin mover credenciales. Staging sigue pendiente. El up/down/up se probó solo
en MySQL privado con datos ficticios. No usar un `db:migrate` general.

Los estados definidos son `prepare_pending`, `prepared`, `activate_pending`,
`activation_confirmed`, `active`, `revoke_pending` y `revoked`. El contrato exige
mapping para estados preparados/activados, fechas válidas, UUID distintos y
clínicas canónicas sin duplicados. El repositorio y worker escriben estas
transiciones, pero **aún no hay un worker de alta registrado ni funcionando**.

## Autorización y cliente

`googleAdsEnrollmentScope.service.js` captura un contexto opaco del ámbito
original. Comprueba su estado, identidad única de conexión y ausencia de tokens
SQL mediante un predicado booleano; no selecciona valores de tokens. Verifica la
clínica titular, todos los miembros del grupo, la asignación principal de conexión
y sus overrides, y el permiso proporcionado por el autorizador de sesión.

La huella fija ámbitos, miembros, asignaciones e identidad. Los asserts dentro de
una transacción usan `FOR UPDATE`, también si el snapshot previo era REPEATABLE
READ. Restaurar una solicitud mantiene el conjunto original, la sesión y la
caducidad; no amplía el ámbito con una captura nueva. La autorización de sesión
persistente deberá inyectarse al conectar el servicio con las rutas y el worker.

La elegibilidad de un cliente nuevo consulta todos sus mappings, bindings,
revocaciones y solicitudes, incluyendo el ID con guiones. Cualquier mapping
existente, incluso inactivo o titular de otro grupo, impide tratarlo como un alta.
El flujo no puede convertir un uso compartido en un propietario nuevo. Los cambios
de propiedad requieren otro recorrido todavía pendiente.

`googleAdsEnrollmentClient.service.js` admite exclusivamente las operaciones
internas de alta y revocación. Discovery valida hasta cuatro páginas y 1000
resúmenes, sin devolver resultados parciales, referencias de secretos ni datos
ajenos al DTO. Cada petición tiene un máximo de diez segundos, dentro de un plazo
global de sesenta segundos para el listado. Se revalida el contexto antes y
después de las esperas; los recibos deben coincidir con la intención original.

Preparar usa el UUID durable de preparación; activar exige que la intención esté
en un estado de activación. La revocación utiliza otro cliente/principal y exige
un callback que confirme la intención durable. Puede ejecutarse cuando la sesión
original haya caducado: no activa cuentas ni amplía permisos. La comprobación
concreta de la fila y del lease la realiza ahora el repositorio de entrega.

Configuración preparada, sin valores instalados:

- `GOOGLE_ADS_ENROLLMENT_ENABLED`, apagado salvo valor exacto `true`.
- `GOOGLE_ADS_ENROLLMENT_WORKER_ENABLED`, también apagado salvo `true`.
- `GOOGLE_ADS_BROKER_ENROLLMENT_KEY_ID` y `GOOGLE_ADS_BROKER_ENROLLMENT_KEY_FILE`,
  principal de alta distinto de lectura/control/OAuth.
- Reutiliza ORIGIN, AUDIENCE, CA_FILE y las claves CONTROL de la cohorte Ads.

Las claves se leen de ficheros privados. Este bloque no crea claves, modifica
variables del runtime ni instala un nuevo job.

## Escritura y conciliación

El enqueue fija cliente, actor/sesión, vencimiento, miembros originales y tres
UUID de comandos. Repetir el mismo UUID de alta exige la misma identidad; no
reserva cuentas ya mapeadas ni borra historia. El recibo de preparación crea un
mapping inactivo y binding `staged` en una transacción. Un ACK perdido se consulta
con status; si aún no hay recibo, solo se reintenta el UUID original. Confirmar
la activación remota deja el mapping inactivo en `activation_confirmed`.

El guardado humano exige esa confirmación y la sesión original todavía válida.
Su autorización y ámbito se vuelven a comprobar bajo los locks de la transacción
existente. Una excepción revierte también cualquier sustitución de cuentas,
revocación y auditoría; `active` solo se confirma con el mapping. Las cuentas
estáticas anteriores, sin historial de alta, conservan sus controles previos.

Cada claim tiene lease de 120 segundos; hay un máximo de veinte pasos o treinta
segundos por ejecución. La petición individual mantiene el límite de diez
segundos. El claim usa SQL explícito `FOR UPDATE SKIP LOCKED`: Sequelize 6.37.7
omite silenciosamente `skipLocked` en su dialecto MySQL. La prueba mantiene una
fila bloqueada mientras otra transacción reclama otra fila, y verifica que un
lease caducado no puede confirmar, reintentar ni cancelar trabajo posterior.

Antes de aceptar un mapping, una sesión caducada, permiso retirado, ámbito
eliminado o cambiado provoca `revoke_pending`. La cancelación no requiere la
sesión ni el switch de alta: usa la autoridad de control y la intención durable.
Una desconexión concurrente invalida el lease anterior. Se bloquea solamente el
propietario original; una fila reutilizada por otro ámbito no se modifica.
El método de cancelación de ámbito existe, pero **todavía falta invocarlo desde
las rutas de baja**. Una cuenta ya aceptada no se revoca por el vencimiento
posterior de la sesión que la dio de alta.

## Exclusión de credenciales antiguas

`googleLegacyCredentials.service.js` incluye las dos tablas nuevas en las
comprobaciones de metadata y en los `NOT EXISTS` del propio SELECT/UPDATE de
credenciales. Se excluye tanto el ID de conexión como el sujeto Google. Esto
cierra recreaciones de ID, duplicados de sujeto y altas que se confirmen entre
el preflight y la consulta. No hay fallback ante una tabla ausente.

Las puertas de entrada/callback OAuth también consultan ambos registros, sin
depender del gate de alta. Se conserva el comportamiento de las seis tablas
anteriores. Los consumidores de negocio usan la misma barrera; sus cambios de
este bloque son únicamente fixtures para representar las dos tablas nuevas.

## Cancelación antes de preparar

El broker añade `google.ads.enrollment.revoke.v1` con el payload original de alta
y un grant explícito del principal de control sobre el ámbito sintético. Cada
ámbito tiene una sola identidad de servicio de alta. El servicio de alta y el de
lectura no reciben permisos para esta revocación.

Si aún no existe una preparación validada, escribe una cancelación en
`google_ads_enrollment_cancellations`, limitada a tenant/conexión/cliente. No
reserva el cliente ni bloquea su incorporación legítima en otra clínica. Si ya
existe una preparación/activación propia, conserva además el tombstone de activo
habitual. La cancelación no requiere secretos ni Google y funciona con conexión
o ámbito bloqueados. Impide una preparación tardía, admite reintento idempotente
y se puede consultar tras reiniciar.

No se permite cancelar cuentas estáticas ni preparaciones de otro propietario
con este control. Tampoco cambiar el UUID, conjunto de clínicas o cliente de una
intención existente. Cancelación, recibo y auditoría técnica comparten la
transacción SQLite; un fallo de auditoría revierte los tres.

## Trabajo siguiente y límites de validación

Por indicación del usuario, la siguiente primera etapa prioriza protecciones Meta
y doble factor. Este fundamento Ads se entrega probado y el alta general se aplaza
según el [plan por etapas](incremental-delivery-plan.md); el objetivo completo de
seguridad conserva todos sus pendientes.

Faltan las rutas de discovery/enqueue/estado con sesión persistente, el registro
del job, la conexión de bajas con cancelaciones pendientes, la auditoría humana
específica del inicio/cancelación de alta, y el recorrido de Ajustes. La
confirmación final del mapping sí utiliza la auditoría humana v12 existente;
esto no acredita cobertura completa del alta. No activar los gates por tener
el repositorio, worker o cliente probados.

También siguen pendientes la primera identidad Google sin conexión gestionada,
el uso del ámbito independiente en el adaptador OAuth de la aplicación, otros
consumidores, auditoría completa, costes en Ajustes, retención/IAM/Cost Explorer/
Budget y cifrado/restauración/corte de BD. OPS continúa aplazado.

La QA usa proveedores/SDK ficticios, HTTPS local y MySQL/SQLite propios. El acta
privada `qa-evidence/security-migration-20260912/ads-enrollment-app-*` conserva
comandos, fallos corregidos, recuentos y cierre de cada instancia. No acredita
ninguna llamada o permiso real de AWS/Google. Las consultas de guardas añadirán
lecturas SQL; los costes efectivos del broker aún no se han medido.

QA histórica del fundamento del 13/09: 574 tests Node (391 backend, 183 broker), 141 checks
en nueve MySQL propios con cierre 0. No se repite build/UI porque no cambia
la interfaz; acta privada `ads-enrollment-app-qa.json`.

QA adicional del 18/09: `google_ads_enrollment_worker_mysql.integration.js`
ejecuta ámbito, cliente, repositorio, worker, discovery, guardado y auditoría
reales contra MySQL propio; simula exclusivamente el transporte del broker.
Cubre ACK perdidos, rollback SQL, permisos/sesiones, cancelación concurrente,
leases, activación final y preservación de cuentas existentes. Se verifican
también los tests HTTP/boundary y las regresiones SQL Ads/enrollment. Evidencia
privada en `security-resume-20260917/google-ads-enrollment-worker/`.
No se llamó a Google/AWS ni se cambiaron servicios, flags o claves reales.
