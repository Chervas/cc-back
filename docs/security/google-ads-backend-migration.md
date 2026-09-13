# Google Ads: registro durable y sincronización por broker

Preparado el 13/09/2026 sobre backend `3801764d7cc2f22f9d71e44fe5e6477d347f9412`
y frontend `ff0306ff1b24d56e8e18aadc0a2a34244765700e`. OPS sigue aplazado. Este
contrato describe código y pruebas aisladas: cero cuentas migradas, ninguna
migración compartida, configuración instalada, proveedor real o despliegue.

## Registro y dependencia de esquema

`20260913080000-add-google-ads-broker-bindings.js` añade dos referencias opcionales
a ClinicGoogleAdsAccounts y una CHECK que exige ambas presentes o ambas NULL.
Crea GoogleAdsBrokerBindings con PK (customer_id, mapping_id), identidad SQL y
subject Google, connection_ref/asset_ref, scope_key, tenant_clinic_id,
login_customer_id y state active/blocked, inicialmente blocked. No contiene
credenciales ni FK/cascadas. Borrar y recrear mappings o conexiones no elimina
el registro ni habilita una vía legacy. Down rechaza registros o referencias
existentes; no borrar filas para conseguir un rollback.

El esquema es obligatorio **antes del código, incluso con el gate apagado**.
Los loaders y callbacks Google consultan la tabla independientemente del gate;
NOT EXISTS en el SELECT/UPDATE de credenciales también la incluye. Conserva las
dependencias Google anteriores. No ejecutar el conjunto de migraciones pendientes
en la BD compartida: el lote DDL concreto requiere aprobación y respaldo propios.

La migración solo crea esquema; no registra cuentas, vacía tokens, asigna grants,
mueve secretos ni activa flujos. Esos pasos deben coordinar todos los consumidores
de una identidad para evitar dejar usos antiguos sin adaptar.

## Identidad, grupos y usos compartidos

`googleAdsBrokerScope.service.js` crea contextos opacos en WeakMap y vuelve a
comprobarlos antes/después de las llamadas. Inspecciona hasta 1.000 registros,
mappings, clínicas, asignaciones y permisos por colección; el exceso falla.
Acepta customerId canónico de diez dígitos o la representación 3-3-4 con guiones.
El gestor queda fijado por el registro y metadata del mapping; no toma el gestor
global de la API antigua para una cuenta gestionada.

Una cuenta de grupo usa sus miembros actuales y un tenant_clinic_id que sea
miembro real. La clinicaId representativa del mapping no concede propiedad sobre
el grupo. Ads no tiene una columna de cuenta primaria en GrupoClinica: usa
assignmentScope/grupoClinicaId y GroupAssetClinicAssignments. Los primarios SC,
GA y GBP conservan sus comprobaciones propias.

Todos los mappings activos del mismo customer, incluidos alias con guiones,
deben estar registrados, coincidir en conexión/subject/gestor/referencia/tenant
y quedar dentro del propietario solicitado. Una lectura desde una sola clínica
no absorbe automáticamente un mapping de grupo. También se revisan las
asignaciones explícitas de mappings antiguos conservados solo en el registro.
Referencias fuera del grupo o de la clínica, registros inconsistentes o una
tupla bloqueada rechazan la lectura. No se remapean cuentas automáticamente.

La política es conservadora respecto a overrides: el grant de grupo debe estar
activo y ser único; cualquier grant explícito de sus clínicas debe estar activo
y apuntar a esa identidad. Una clínica puede heredar del grupo solo cuando no
tiene grant explícito. Revoked/disconnected/reauthorization_required y grants
ambiguos impiden la lectura. Antes de un canary hay que revisar los grupos con
overrides legítimos y su cohorte completa; no retirar overrides para pasar QA.

GoogleConnection se consulta solo por id/subject y el resultado SQL
`accessToken IS NULL AND refreshToken IS NULL`. Nunca se hidratan tokens para
comprobar su ausencia. IDs repetidos con el mismo subject, credenciales residuales,
cambio de miembros/propietario/grants y referencias inconsistentes fallan.
El conjunto y sus huellas se comparan durante todo el intento.

## Recorrido de sincronización

Sync y backfill preparan el contexto antes de `_getGoogleAccessToken`. Solo un
mapping sin referencias ni registro es candidato legacy, y ese candidato aún
debe pasar por el loader que consulta todos los registros Google por ID/subject.
Una cuenta gestionada con gate apagado, tabla ausente, fallo de broker o permiso
revocado nunca cae a tokens SQL.

La rama gestionada usa las ocho lecturas de
[este contrato](google-ads-read-broker.md): cuenta, campañas, métricas de campaña
y grupo, publicación, destinos, inventario de anuncios y métricas de anuncios.
El cliente firmado y su autorizador se ensamblan en googleAdsBroker.service.js;
la API general no recibe OAuth ni developer token. No se añade un proxy GAQL.

Se conserva la conciliación, cobertura, atribución y separación de snapshots
de métricas/anuncios. Publicación e inventario mantienen sus resultados, y los
destinos preservan pruebas interactivas más recientes. Cada escritura gestionada
vuelve a comprobar el contexto con SELECT FOR UPDATE dentro de su transacción:
mapping, registros, miembros, asignaciones, grants e identidad quedan protegidos
hasta terminarla. Las lecturas HTTP usan metadata actual sin una transacción
antigua; la persistencia usa lecturas bloqueantes actuales aunque exista un
snapshot REPEATABLE READ previo. Puede haber contención/deadlocks: un error
revierte la transacción y no confirma la sincronización.

Solo el éxito de métricas, publicación, destinos y caché de anuncios permite
actualizar lastSyncedAt; esa actualización también comprueba el contexto en SQL.
Los snapshots de fases anteriores pueden permanecer si una fase posterior falla,
como en el contrato previo; el reporte conserva el progreso y no declara la
cuenta completamente actualizada. Esto es distinto de la atomicidad de una baja.

## Desconexión preparada y OAuth pendiente

El bloque [de revocación Ads](google-ads-revocation-migration.md) sustituye el
rechazo provisional por historial independiente, outbox y auditoría v11 en la
transacción de baja. Comprueba grupos, aliases y asignaciones históricas; un
conflicto fuera del ámbito revierte todo. El worker confirma el mismo UUID con
su clave de control. DDL 090000 obligatoria antes del código aun apagado.

El historial sobrevive a bindings/mappings/conexiones y cierra también la vía
legacy por ID/subject. Status agrega solo tuples cuyas clínicas están autorizadas.
OAuth Ads tipado y corte real aún pendientes; no activar cuentas hasta completarlos.

## Configuración preparada y costes

Variables sin instalar: GOOGLE_ADS_BROKER_ENABLED (solo true habilita lecturas),
GOOGLE_ADS_BROKER_ORIGIN, GOOGLE_ADS_BROKER_AUDIENCE, GOOGLE_ADS_BROKER_KEY_ID,
GOOGLE_ADS_BROKER_KEY_FILE y GOOGLE_ADS_BROKER_CA_FILE. Archivos privados canónicos,
sin symlinks, hasta 64 KiB, sin permisos de grupo/otros; cliente con timeout de
30 segundos y política de transporte existente. El gate no elimina la obligación
de esquema ni permite fallback. No se cambia un job, flag o clave reales.

Los topes de filas/bytes/tiempo siguen en el contrato del lector. El autorizador
añade lecturas SQL y locks de persistencia; no se ha medido su latencia ni carga
con cuentas reales. Las seis llamadas nominales SM por petición de broker y
su auditoría permanecen; esta fase no añade infraestructura ni valida facturación.
Cost Explorer/tags/Budget, gasto real en Ajustes y permisos siguen pendientes.

## Evidencia de la fase de lecturas y límites de la validación

344 tests Node correctos: 332 de regresión/lectores/jobs y 12 en procesos con
los contratos de desconexión/revocación. Incluyen el hotfix, catálogo de 47 jobs,
colectores previos, gates, grupos, aliases, registro perdido, cambios concurrentes,
callbacks y ausencia de fallback. La prueba de pipeline ejecuta los jobs reales
con repositorios y broker ficticios; no demuestra un canary desplegado.

106 comprobaciones en ocho instancias MySQL propias, socket local y networking
deshabilitado; cero conexiones rechazadas y ocho cierres con código 0. Once
comprobaciones Ads incluyen DDL/down vacío, ausencia de FK, metadata sin tokens,
scope/overrides, borrado/recreación, cierre OAuth, carrera SELECT, tabla ausente,
lectura actual en transacción antigua y timeout de una actualización competidora
mientras el registro está bloqueado. Las otras siete bases ejercitan legacy,
SC, GA, OAuth por servicios y bajas SC/GA/GBP con la nueva tabla requerida.

Evidencia privada: `ads-bindings-full-node.log/json`,
`ads-bindings-full-mysql.log/json` bajo
`/home/ubuntu/qa-evidence/security-migration-20260912/`. Las ejecuciones iniciales
se conservan aparte. No se repitieron tests del motor del broker o UI, cuyos
fuentes no cambian en esta fase. Sin build de UI ni llamadas AWS/proveedor real.

La evidencia de revocación posterior está en su contrato. [OAuth Ads](google-ads-oauth-migration.md)
queda preparado en broker/API/Ajustes; corte real pendiente. Faltan otros consumidores, escrituras, recepción,
conversiones y optimización; auditoría completa, retención/IAM, costes verificados,
Budget/CloudFormation y cifrado/restauración/corte real de BD. El objetivo completo
permanece abierto y OPS aplazado. Push es publicación de fuentes, no despliegue.
