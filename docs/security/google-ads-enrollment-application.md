# Google Ads: ámbito y solicitudes de alta en la aplicación

Estado 13/09/2026: preparados el esquema, validadores, comprobación de ámbito y
cliente tipado. La exclusión de credenciales antiguas ya consulta estos registros
en el código. Todavía faltan el escritor de solicitudes, la conciliación y su
conexión con rutas/Ajustes. No hay alta completa de extremo a extremo, nuevas
cuentas reales, configuración instalada ni despliegue.

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
falla cerrado. La migración no se ha aplicado a la BD compartida; su up/down/up
se ha ejecutado exclusivamente en un MySQL privado con datos ficticios. No usar
un `db:migrate` general para instalarla.

Los estados definidos son `prepare_pending`, `prepared`, `activate_pending`,
`activation_confirmed`, `active`, `revoke_pending` y `revoked`. El contrato exige
mapping para estados preparados/activados, fechas válidas, UUID distintos y
clínicas canónicas sin duplicados. **La máquina que escribe y entrega esas
transiciones sigue pendiente**; la presencia de columnas de lease no implica que
haya un worker funcionando.

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
concreta de la fila y del lease corresponde al repositorio de entrega pendiente.

Configuración preparada, sin valores instalados:

- `GOOGLE_ADS_ENROLLMENT_ENABLED`, apagado salvo valor exacto `true`.
- `GOOGLE_ADS_BROKER_ENROLLMENT_KEY_ID` y `GOOGLE_ADS_BROKER_ENROLLMENT_KEY_FILE`,
  principal de alta distinto de lectura/control/OAuth.
- Reutiliza ORIGIN, AUDIENCE, CA_FILE y las claves CONTROL de la cohorte Ads.

Las claves se leen de ficheros privados. Este bloque no crea claves, modifica
variables del runtime ni instala un nuevo job.

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

Falta enlazar estas piezas: crear intenciones bajo autorización y locks, escribir
mappings/bindings inactivos después del recibo válido, cancelar desde las bajas
de ámbito, conciliar comandos y ACK perdidos, y confirmar la asignación local con
auditoría humana. La selección original y las cuentas que se sustituyen deberán
conservarse hasta la confirmación de la transacción final. No activar el gate por
tener los modelos o el cliente listos.

También siguen pendientes la primera identidad Google sin conexión gestionada,
el uso del ámbito independiente en el adaptador OAuth de la aplicación, otros
consumidores, auditoría completa, costes en Ajustes, retención/IAM/Cost Explorer/
Budget y cifrado/restauración/corte de BD. OPS continúa aplazado.

La QA usa proveedores/SDK ficticios, HTTPS local y MySQL/SQLite propios. El acta
privada `qa-evidence/security-migration-20260912/ads-enrollment-app-*` conserva
comandos, fallos corregidos, recuentos y cierre de cada instancia. No acredita
ninguna llamada o permiso real de AWS/Google. Las consultas de guardas añadirán
lecturas SQL; los costes efectivos del broker aún no se han medido.

QA definitiva del bloque: 574 tests Node (391 backend, 183 broker), 141 checks
en nueve MySQL propios con cierre 0. No se repite build/UI porque no cambia
la interfaz; acta privada `ads-enrollment-app-qa.json`.
