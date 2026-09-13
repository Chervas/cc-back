# Google: propiedades registradas con varios mappings y asignaciones compartidas

Preparación del 13/09/2026 sobre backend `d316506d` y frontend `3cbd894d`.
Consumidores migrados en runtime: **cero**. No despliegue, migración compartida,
AWS o proveedores reales. OPS continúa aplazado y el apagado EC2 anunciado no se
ha verificado. Amplía el [listado registrado](google-property-discovery-migration.md).

## Registro Search Console por mapping

La migración `20260913050000-scope-search-console-bindings-by-mapping` cambia la
clave primaria de SearchConsoleBrokerBindings de site_hash a
**(site_hash, mapping_id)** mediante un ALTER. El modelo Sequelize declara ambos
campos como clave. Conserva cada fila, estado, identidad, conexión y referencias;
no mueve tokens, crea mappings/grants o modifica assignments. No altera la
migración 20260913030000 original ni añade FK/cascadas.

La misma propiedad puede estar registrada para varias clínicas. Cada mapping
necesita su propio registro activo y grant exacto de tenant/activo/conexión.
El lector busca todas las filas de la propiedad, hasta 1.000, y selecciona solo
el mapping original. Estados independientes: bloquear el mapping de una clínica
no invalida el registro activo de otra. El bloqueo de conexión/activo del broker
conserva su ámbito y prevalece sobre esos registros SQL.

Un mapping sin registro propio no puede usar legacy si existe **cualquier**
registro de esa propiedad, incluso bloqueado. Borrar y recrear otro mapping ID
no hereda un grant ni elimina los marcadores de ID/subject de Google. Un
contexto capturado falla si cambia mapping, clínica, conexión, identidad,
referencias, estado o condición de tokens SQL NULL. Las lecturas/jobs/web SC
existentes usan este mismo adaptador; no hay nueva operación de proveedor.

Down solo acepta la tabla vacía. No elimina registros para hacer posible volver
a la clave anterior. El cambio de índice debe ensayarse con volumen, backup y
ventana del destino en el corte aprobado; esta QA no mide su bloqueo, espacio o
duración reales. No ejecutar DDL concurrente con escrituras de registros.

## Inventario efectivo de una clínica destinataria

El listado SC/GA conserva los registros propios de las clínicas solicitadas y
añade los mappings compartidos o primarios del grupo que selecciona actualmente
`listScopedGoogleProperties`. El nuevo adaptador
`googlePropertyInventoryScope.service.js` reutiliza esas reglas sin modificar
`effectiveMarketingAssets.service.js` ni el producto de publicidad.

Consulta exclusivamente metadata de la vertical SC o GA, assignments de ese tipo,
política de propiedades del grupo y pertenencia de las clínicas origen. Omite
los otros modelos de propiedades y no utiliza el resolver general de Marketing,
que también carga IntakeConfig/Meta. Las queries proyectan campos cerrados y
limitan cada conjunto de candidatos a 1.000; 1.001 implica conflicto, no una
lista truncada. No hay lectura de tokens ni datos de configuración de otros
proveedores en este adaptador.

El inventario se limita a la conexión Google resuelta para el ámbito, igual que
el contrato del listado previo. No agrega otras identidades/conexiones ni cambia
la selección de perfil. Un mapping compartido debe seguir en el inventario
efectivo y su clínica de origen debe pertenecer al mismo grupo actual. Un origen
inexistente, ambiguo o trasladado a otro grupo impide la lectura; una referencia
SQL obsoleta no permite cruzar grupos.

Para una petición de la clínica 72 que consume el mapping de la 71, se exige el
permiso de gestión sobre la **72** y la asignación vigente. El broker conserva
**tenant clinic:71** y su mapping/grant original. No se exige añadir permisos del
usuario sobre toda la clínica 71 ni se reescribe el propietario del dato.
En peticiones de grupo se conserva la autorización de todas sus clínicas.

Antes/después de cada lectura, durante la revalidación final de bindings y antes
de entregar se vuelve a comprobar sesión, ámbito/conexión y pertenencia del
mapping al inventario efectivo. Retirar el shared assignment o la política de
primario durante un await impide entregar la respuesta completa. La comprobación
final cubre todos los mappings compartidos, incluidos los leídos antes de otros
awaits. Como cualquier integración entre SQL, sesiones y proveedor, no constituye
una transacción distribuida; el corte sigue necesitando drenaje y control de
escrituras. El plazo cooperativo no cancela una consulta SQL pendiente.

Ambas verticales verifican cada registro seleccionado, conservan sus grants de
clínica y deduplican solo resultados de propiedad idénticos. Una fila bloqueada
seleccionada en el ámbito impide la lista completa; otra fila bloqueada fuera del
ámbito y del inventario efectivo no deniega un grant propio válido.

## API, límites y coste

Se mantienen DTO, rutas, scopes y códigos del bloque de discovery:
GET /oauth/google/assets, /google/analytics/properties y
/google/analytics/connection-status. Añade propiedades compartidas válidas;
no modifica componentes frontend ni presenta un mapping compartido como propio.
Retirada de permiso/inventario o cruce de grupo: google_discovery_scope_forbidden
(403); cambio del plan/bindings: broker_binding_invalid (409); exceso:
broker_discovery_limit (409), también al atravesar el lector GA.

Siguen los límites de 20 mappings por petición, cuatro peticiones concurrentes
por proceso, 60 s cooperativos, timeout de broker hasta 30 s/restante y salida
hasta 1 MiB. No persiste resultados parciales ni reutiliza SQL como fallback.
Las consultas adicionales de inventario son locales; no añaden llamadas de
proveedor por mapping. Incluir nuevos mappings legítimos sí aumenta las lecturas
Google/metadata de secretos dentro de los mismos techos. Estado GA y listado
siguen siendo peticiones independientes. Sin precio/cuota/latencia real medida;
Cost Explorer, filtros, tags, Budget/CloudFormation y canary siguen pendientes.

## Migración y activación pendientes

Esquema 20260913050000 y registros previos GBP/revocación, OAuth 20260913020000,
SC 20260913030000, GA 20260913040000 y sus dependencias deben formar parte del
lote revisado **antes del código**, incluso con gates apagados. No hay variables,
roles, servicios, jobs, claves o permisos AWS nuevos. No se ha ejecutado ninguna
migración en la BD compartida ni cambiado pausas, PM2 o OPS.

Antes de activar: inventariar mappings/assignments/primarios vigentes, registros
durables y grants por mapping; aprobar migraciones exactas, backup, drenaje de
legacy, sesiones, traslado de secretos y aislamiento de origen/IAM. Validar
restauración y rollback que conserve marcadores/bloqueos. Activar el flujo
completo sigue requiriendo onboarding/remapeo, OAuth/desconexión y estado/UI
general SC/GA; el endpoint Google genérico legacy permanece cerrado tras el
primer registro fuera de su cohorte OAuth existente.

Auditoría v2 de las lecturas del principal de servicio permanece; trazabilidad
completa de usuario/denegaciones/cache, las otras cohortes, retención DPD,
permisos/Budget/Cost Explorer y cifrado/restauración/corte real de BD siguen
abiertos. No se ha declarado terminada la migración general.

## QA y publicación

188 tests Node: 109 backend en Node 22.17.0 y 79 broker en Node 24.21.0.
Incluyen lector SC compuesto, grants separados, cierre de recreaciones, límite
de registros, selector real con proyecciones acotadas, clínica destinataria,
shared/primario retirados durante lectura y revalidación final, límites después
de awaits y dueño movido a otro grupo. TLS local real de ambos brokers con SDK/
Google ficticios, bloqueos tras reinicio y regresiones de OAuth/SC/GA/GBP incluidas.

59 comprobaciones MySQL 8.0.42 en cuatro bases temporales propias sin networking:
20 GA, 20 SC, ocho legacy y once OAuth. Se prueba la DDL nueva vacía y poblada,
conservación de filas, down cerrado, varios mappings SC, selector y repositorios
reales, asignaciones/primarios retirados durante la respuesta y cambio de grupo.
Usa modelos de dominio reales y, para el grupo, solo las columnas SQL de metadata
consultadas; no reproduce tablas/FK de proveedores ajenos. Cierre 0 y PIDs propios
terminados en las cuatro bases. Tres contratos adicionales: scheduler 46 jobs,
caducidad GBP y multigrant. Hotfix getAssetStats conserva su hash.

No QA visual nueva porque no cambia componentes UI; HTTP aislado no certifica
Ajustes completo ni una conexión real. Evidencias privadas shared-property-*.json
/.log en /home/ubuntu/qa-evidence/security-migration-20260912/ (0700/0600).
Publicación únicamente de archivos/commits propios a DEV, con rango completo y
SHA remoto revisados. El acta privada de publicación registra los SHAs finales;
push no equivale a despliegue ni aprobación de migración compartida.
