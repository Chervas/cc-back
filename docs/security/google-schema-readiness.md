# Google: requisitos de esquema antes del despliegue

Estado comprobado el 18/09/2026. La preparación del esquema no migra tokens,
no añade permisos y no activa consumidores. La conexión compartida observada en
staging sirve 14 mappings de Business Profile, 6 de Search Console, 5 de
Analytics y 6 de Ads, con 14 asignaciones de clínica y 3 de grupo activas.
Se consultaron presencia de credenciales y metadata; no se extrajeron tokens.
Meta no WhatsApp mantiene la cuarentena; no se comprobó su token con Meta.

El código nuevo de `googleLegacyCredentials.service` consulta ocho registros
duraderos antes de seleccionar credenciales, aunque los flags del broker estén
apagados. Las tablas ausentes producen `google_credentials_unavailable`.
Un marcador por ID o identidad Google cierra el acceso legacy de la identidad
compartida: mover solo un servicio podría cortar los otros. Preparar las tablas
vacías no crea ese marcador ni permite retirar las credenciales existentes.

El contrato de despliegue incorpora ahora 16 tablas de Google: once registros
nuevos, las referencias de cuatro mappings y la nulabilidad de
`GoogleConnections.accessToken`. Fija las trece migraciones de Google del
13/09, sus hashes, columnas, índices, estados y restricciones. El comprobador
también verifica la expresión y activación de los cuatro CHECK que exigen
referencias completas. El publicador DEV existente usa este contrato antes de
detener servicios o cambiar la versión. No debe omitirse ese control.

Prueba reproducible, exclusivamente en un MySQL temporal propio con red externa
bloqueada:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/google_broker_schema_mysql.integration.js
node --test src/scripts/tests/security_schema_release.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node --test src/scripts/tests/security_schema_release_mysql.test.js
```

La secuencia completa ejecuta las trece migraciones reales mediante el mismo
aplicador de despliegue. Conserva tokens ficticios, mappings activos/inactivos y
asignaciones de clínica/grupo/desconectadas. Comprueba rechazo de referencias
incompletas, detección de un CHECK desactivado, reaplicación de plan antiguo,
cierre de la identidad compartida sin hidratar tokens y conservación del
historial al intentar `down`. La regresión existente verifica exclusión mutua,
DDL parcial sin reintento automático y preservación de datos. No acredita
operaciones reales de Google ni interfaz autenticada.

La primera ejecución detectó la ausencia de estas tablas en el contrato de
despliegue; la ejecución final pasa con el contrato ampliado. Aún no se han
aplicado estas migraciones a DEV ni staging ni publicado este cambio de
contrato. Ambos esquemas observados carecen de las tablas de broker Google.
El campo `accessToken` sigue siendo NOT NULL en ambos y requiere la modificación
incluida en la secuencia; la prueba parte también de esa definición anterior.
No ejecutar `db:migrate` global ni reintentar automáticamente DDL parcial.

Siguiente paso: preparar el plan DEV con revisión y hashes exactos, detener el
runtime aislado al aplicar y comprobar paridad antes de publicar. El corte de
staging exige además completar consumidores de la identidad compartida,
operaciones tipadas, inventario de pausas, drenaje y recuperación. La creación
de solicitudes/reconciliación de altas Ads y las operaciones de escritura aún
no están completas; este documento no autoriza dar esos recorridos por probados.
