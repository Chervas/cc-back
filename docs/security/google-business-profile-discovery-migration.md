# Listado de fichas Google con grants del broker

Estado 13/09/2026: **implementado y probado offline; sin despliegue ni cohorte
real activada**. Amplía las seis lecturas de jobs del [contrato anterior](google-business-profile-read-migration.md).
El usuario ha dejado OPS fuera del foco y ha anunciado que apagará la instancia
AWS. No se ha consultado su estado ni ejecutado ese apagado desde esta tarea;
la validación/despliegue AWS requieren retomarse con acceso y lote aprobados.
OPS queda pendiente, sin modificar su script, jobs, flags ni estado operativo.

## Comportamiento de la API

`GET /oauth/google/local/locations` conserva el requisito de sesión y permiso
de gestión sobre todas las clínicas del scope solicitado. El resolver recibe
`metadataOnly: true`: sus caminos de assignment, mapping y propietario legacy
seleccionan únicamente `GoogleConnection.id`, incluidos los joins. El parámetro
es interno; no procede de query/body. Los demás consumidores del resolver
conservan su comportamiento y siguen pendientes de migración.

`BusinessProfileBrokerBindings` actúa como registro persistente. Mientras está
vacío, el endpoint conserva descubrimiento legacy; solo esa rama carga tokens.
En cuanto existe cualquier registro, el listado usa exclusivamente fichas
registradas para las clínicas autorizadas y la conexión resuelta. Cada una
debe tener exactamente un mapping activo con referencias coincidentes. El
grant del broker vuelve a comprobar principal/tenant/conexión/activo/operación.
No se descubre todo lo accesible al token ni se añaden grants por visitar la UI.

**Consecuencia global del primer corte:** se cierra el descubrimiento legacy
de este endpoint para toda la instalación y el POST normal de
`/oauth/google/local/map-locations` devuelve 409. Una credencial compartida
podría ver fichas ya migradas desde otro scope/conexión; conservar aquella
enumeración no acreditaría una fuente única. Los ámbitos sin grants reciben
409, no una lista vacía que simule éxito. Este límite debe aceptarse expresamente
en el lote de canary. El POST con `mapping_purpose=reviews` conserva el alias de
reseñas sobre una ficha ya existente; no crea ni cambia el grant del proveedor.
Alta/reasignación/desconexión OAuth aún necesitan su ciclo de vida seguro y
deben mantenerse pausadas en el ámbito del canary por su lote operativo.

La respuesta gestionada conserva `accounts[]` y sus campos `accountName`,
`accountDisplayName`, `accountNumber`, `locations[]` y el DTO normalizado de
ficha, con proyección cerrada de `rawLocation`. Añade
`inventory_mode: "broker_grants"` y `Cache-Control: private, no-store`.
El consumidor frontend actual admite esos campos y muestra su error genérico
ante 409/503; no se cambia la UI ni se declara validación Chromium de esta fase.
No existe una nueva ruta para obtener credenciales o editar la política.

Se revalidan sesión, permisos y conexión antes del listado, de cada comando y
de devolver el resultado. El adaptador verifica registro y mapping alrededor
de cada llamada; el listado repite el inventario y los mappings al terminar.
Un cambio observado descarta toda la respuesta. La rama legacy también corta
si observa un registro entre páginas, sin convertir ese error en una cuenta
omitida. No es una transacción distribuida con Google: pausar y drenar las
peticiones previas sigue siendo obligatorio durante el corte.

Límites: 20 fichas por solicitud, consulta SQL limitada a 21 para detectar
exceso, cuatro listados activos por proceso, sin cola, un comando por listado
en vuelo y máximo 1 MiB acumulado. Presupuesto de 30 s medido antes de cada
despacho, pasado al cliente HTTP como remanente; el cliente nunca amplía su
timeout configurado. Consultas SQL y verificaciones de permisos no tienen
cancelación propia: retienen su plaza hasta finalizar. Si no cabe todo el
listado en tiempo/tamaño, se falla sin emitir una respuesta parcial. No hay
paginación API nueva; ámbitos mayores requieren otro diseño antes de migrar.

| Estado | HTTP / código |
|---|---|
| Sesión expirada/revocada durante la espera | 401 `unauthenticated` |
| Permiso del scope retirado | 403, error canónico de scope |
| Registro/mapping incompatible o conexión cambiada | 409 `broker_binding_invalid` |
| Ámbito sin fichas registradas | 409 `broker_discovery_scope_unconfigured` |
| Exceso de fichas/tamaño | 409 `broker_discovery_limit` |
| Remapeo o descubrimiento legacy tras primer registro | 409 `broker_legacy_discovery_blocked` |
| Gate apagado, registro no disponible, saturación o timeout | 503, código cerrado del adaptador |
| Broker/proveedor bloqueado, revocado o no disponible | 503, código cerrado; sin cuerpo/error/token del proveedor |

Una tabla inexistente también falla cerrada. La migración aditiva
`20260913000000-add-business-profile-broker-read-binding.js` debe estar aplicada
**antes de cargar esta API** aunque el gate esté apagado. Este bloque no añade
otra migración ni aplica ninguna a la BD compartida.

## Operación de integración

`google.business_profile.discovery.read.v1`, payload `{}`, conserva
`assetRef=gbp:<accountId>:<locationId>` y tenant `clinic:<id>`. Requiere su
propio permiso explícito en los grants: las seis operaciones anteriores no
autorizan esta séptima. Hace dos GET secuenciales, con destinos construidos
solo desde el grant: cuenta en Account Management v1 y ficha en Business
Information v1 con el readMask fijo de detalles. No lista cuentas ni ubicaciones
vecinas. Ambos nombres devueltos deben coincidir; una cuenta ajena detiene la
segunda llamada. Esta comprobación de nombres no descubre ni acredita por sí
sola la relación cuenta/ficha: el operador debe validarla antes de emitir el grant.

La proyección de cuenta limita la salida a `name/accountName/accountNumber`;
se omiten organización, propietario y roles. La ficha usa la proyección de
detalles existente. Transporte HTTPS privado, quinta hostname permitida
`mybusinessaccountmanagement.googleapis.com`, TLS validado, GET fijo,
sin redirecciones ni URL/headers del consumidor. Referencias contrastadas:
[accounts.get](https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts/get),
[Account](https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts) y
[locations.get](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/get).

Se reutilizan la lectura/versionado/caducidad de Secrets Manager y la
revocación durable. `persistResult: false` evita guardar contenido en SQLite;
repetir el mismo requestId completado devuelve `outcome_unknown` sin repetir
Google. Intento/resultado usan la auditoría de integraciones v2 existente,
con principal de servicio, tenant y operación. **No añade auditoría semántica
del actor humano de esta ruta** ni su consulta en el visor de plataforma.
Ambos siguen siendo cobertura pendiente; no se atribuye un servicio a una persona.

Coste pendiente de medir: dos GET Google, hasta cuatro llamadas SM por comando
y normalmente dos escrituras de eventos S3, sin multiplicar infraestructura.
El colector/cache/Ajustes/Budget existentes no cambian. No hay factura AWS
verificada ni ahorro acreditado por el apagado anunciado de la instancia.

## QA y publicación

36 tests del paquete broker, 9 de listado/HTTP, 5 del adaptador anterior y
11 del hotfix: **61 tests**. Diez comprobaciones MySQL 8.0.42 propias ensayan
migración/modelos/SQL reales, jobs, cachés, selección de columnas sin tokens,
cambios de mapping, registro independiente y rollback ficticio. La BD solo
acepta su socket/datadir temporal y finaliza con código 0. TLS/HTTP usan
servidores propios y Google/SDK ficticios; no hay OAuth, OPS ni AWS reales.

El primer intento MySQL combinó por error el preload general de red con la
guarda del fixture; se detuvo antes de los checks y cerró 0. La ejecución válida
usa el fixture como única autoridad de su socket, conservando la prohibición
de otras conexiones. No se deshabilitó la guarda para hacer pasar las pruebas.
Resultados/comandos/hashes privados: `gbp-discovery-offline-qa.json`, logs
`gbp-discovery-{broker,backend,mysql}.log` y acta de publicación
`gbp-discovery-publication.json`, en
`/home/ubuntu/qa-evidence/security-migration-20260912/`.

El nuevo apartado de API se escribe primero en backend y se refleja exactamente
en frontend; se conserva el desfase anterior de ambos `13-backend.md`, sin
copiar documentación ajena de publicidad. Antes de push: fetch, rango completo
propio, diff revisado, hotfix conservado y SHA remoto comprobado.

## Lote real y rollback pendientes

El lote anterior sigue abierto: identidad temporal asignada, estado EC2 después
del apagado anunciado, runtime/canal TLS/IAM/trusts/instalación, secretos,
backup, coste y restauración. Aprobar expresamente los scopes/grants y el cierre
global de descubrimiento/remapeo legacy; instalar los commits compatibles en
todos los lectores, aplicar solo la migración indicada y drenar peticiones.
OPS se mantiene fuera del desarrollo actual por indicación del usuario, pero
su pausa efectiva o migración aún debe acreditarse antes de proclamar una sola
fuente operativa. No se ha cambiado PM2 ni se da por detenido ese proceso.

Rollback: detener la cohorte y conservar registro/marcadores, bloqueos y
auditoría. Apagar el gate detiene el listado gestionado; no reactiva legacy.
No desplegar la versión previa del listado en una instalación ya migrada,
porque aquella no consulta el registro. Eliminarlo para recuperar OAuth/OPS
queda prohibido como fallback automático. La cuenta/ficha y el ciclo de vida
Google completos, demás consumidores, auditoría clínica, retención/SSO/Budget
y cifrado/corte de la BD compartida siguen pendientes. Push no despliega.
