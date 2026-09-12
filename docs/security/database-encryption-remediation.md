# BD: diagnóstico de metadata y preparación del corte

12/09/2026. **Diagnóstico parcial real, remediación preparada y restauración
ficticia probada. Sin cambio del MySQL utilizado, de sus datos, claves o PM2.**
No es un acta de migración terminada ni de cumplimiento normativo.

## Evidencia disponible

`src/scripts/security-database-metadata.js` ejecutó diez consultas fijas por
el socket UNIX existente con la configuración de la aplicación. No carga
modelos, consulta filas clínicas, ejecuta DDL ni usa credenciales alternativas.
Seis consultas devolvieron metadata; cuatro quedaron denegadas. El informe
privado está en
`/home/ubuntu/qa-evidence/security-migration-20260912/database-local-metadata-20260912.json`.

| Capa | Evidencia propia | Límite / siguiente comprobación |
|---|---|---|
| Motor | MySQL `8.0.42-0ubuntu0.20.04.1`; datadir `/var/lib/mysql/` y socket local | Autogestionado en el host, no aplicar una receta RDS |
| Configuraciones | DEV/staging/gateway apuntan al mismo destino tras normalizar localhost/127.0.0.1 | Ficheros actuales; no prueba por sí sola opciones de procesos ya iniciados |
| Host | Cloud-init cacheado identifica `i-0b2967e8de0866910` en eu-west-3a | Metadata local cacheada, no verificación AWS. Es distinto del broker entregado `i-0cf40cfe823f160fa` |
| Disco | Datadir en ext4, raíz `/dev/nvme0n1p1`, 320 GiB nominales; sin capa LUKS visible | No permite inferir el cifrado del volumen por el proveedor. Verificar volumen y snapshots en su cuenta real |
| Esquema | Metadata visible: 235 tablas InnoDB, suma DATA_LENGTH+INDEX_LENGTH `12678627328` bytes (aproximada) | No tamaño de backup ni inventario de todos los esquemas del servidor |
| Cifrado nativo | `default_table_encryption=OFF` y default del esquema NO; redo y undo OFF; binlog activo y `binlog_encryption=OFF` | Defaults no prueban el estado de todas las tablas ni sustituyen la verificación del volumen |
| Tablespaces | Consulta denegada por permisos | Obtener agregado mediante operador DBA; no conceder PROCESS al usuario de aplicación |
| Claves | Lista de plugins keyring vacía; componente keyring no accesible | No afirmar ausencia de toda gestión de claves; falta componente/configuración efectiva |
| TLS | Servidor anuncia TLS 1.2/1.3; `require_secure_transport=OFF` | La sesión de diagnóstico usa UNIX y no tiene cipher; no atribuir ese dato a sesiones de la API |
| Sesiones/réplicas | Performance Schema activo, consultas agregadas denegadas | Falta TLS efectivo y validación de identidad de clientes, canales y su cifrado |
| Backups | Un fichero `.sql.gz` de 70.740 bytes, modo 0600, en directorio revisado; no leído ni descomprimido | Nombre/extensión no acreditan cifrado, actualidad, cobertura ni restaurabilidad. No encontrado job candidato en crontab del usuario actual; no cubre root/systemd/proveedor |

La evidencia prueba carencias del cifrado **nativo** y de exigencia de TLS.
El estado global de cifrado en reposo sigue sin acreditarse: el volumen puede
estar cifrado por el proveedor aunque estas variables estén apagadas.

## Preparación de clientes implementada, sin activar

`src/lib/databaseTlsConfig.js` incorpora TLS obligatorio con CA PEM de
confianza, `rejectUnauthorized=true`, `verifyIdentity=true` y mínimo TLS 1.2.
Con `DB_TLS_REQUIRED=true`, CA ausente/inválida o error TLS fallan cerrados;
no hay conexión alternativa sin TLS. `DB_TLS_CA_FILE` es ruta absoluta de CA
pública, no una clave privada. El hostname a verificar es `DB_HOST`.
El modo ausente mantiene el transporte previo únicamente para preparar un
corte coordinado; no se ha configurado el flag en ningún runtime utilizado.

Se aplica a config Sequelize canónica, Sequelize secundaria, pool legacy,
runtime de importación y ocho scripts de mantenimiento que abrían su propia
conexión. Solo se añaden opciones de transporte; no se ejecutan importaciones,
reparaciones de publicidad ni consultas de esos scripts.
`docs/security/database-client-inventory.json` registra rutas/símbolos/hashes,
sin valores. Es un inventario estático, no certificado de actividad:
`models/index.js` hereda la config común; el diagnóstico autorizado usa UNIX;
SocketService solo utiliza DB_NAME como namespace, sin conexión SQL propia.
Los scripts externos al repositorio y cron de otros usuarios quedan por revisar.

Se retiró una credencial incrustada en `src/config/db.js`. El pool ahora usa
la identidad de la configuración canónica y falla si faltan sus campos;
no usa un usuario alternativo. No hay imports estáticos localizados de ese
módulo en el árbol revisado, lo que no prueba ausencia de cargas dinámicas.
No se ha probado esa credencial ni modificado/revocado el usuario real.
El valor sigue potencialmente en historia Git, artefactos o copias: su retirada
del código no sustituye la rotación coordinada. No reescribir historia ni
borrar evidencia del incidente sin lote específico.

## Restauración ensayada

`src/scripts/tests/database_encrypted_restore.integration.js` crea tres
mysqld propios, datadirs/socket privados y un único puerto loopback efímero.
Guarda y restaura solo dos tablas sintéticas con relación y clave única.
Usa el plugin `keyring_file` disponible en este MySQL 8.0.42 únicamente
para el ensayo; está deprecado y no se prescribe como arquitectura de
gestión de claves para producción. No se activa ningún plugin del MySQL real.

El ensayo cifra tablas/diccionario, activa redo/undo/binlog y rota la clave
del servidor ficticio. Prueba la configuración TLS del backend contra MySQL:
CA/nombre correctos aceptados; TCP sin TLS, CA ajena y nombre distinto rechazados.
Apaga limpiamente la fuente antes de crear la copia física.

GPG cifra por separado el archivo de datos y el keyring, con identidad de
recuperación ficticia en directorio privado separado. Identidad ajena y
archivo cifrado dañado son rechazados. Restaurar sin el keyring correcto
impide arrancar el MySQL ficticio. Con datos/claves correctos se conservan
filas, relación, unicidad y cifrado tras reinicio; hashes de los archivos de
backup no cambian durante los ensayos. Fuente/restaurado salen con 0; la
instancia sin claves sale con error esperado, sin terminación forzada.

Esto no prueba restauración de 12,7 GB reales, RPO/RTO clínicos, volumen EBS,
custodia KMS, acceso IAM, copias externas ni sus permisos/retención. El fichero
keyring y el escrow GPG del ensayo son sintéticos; no se reutilizan como
claves de la BD, integraciones o auditoría. Antes del corte real se requiere
backup externo cifrado y manifiesto de integridad con origen autenticado.

## Lotes de ejecución pendientes

1. **Completar metadata, sin cambios.** Operador DBA ejecuta solo los cuatro
   agregados `tablespaces`, `keyringComponent`, `replicas` y `observedTls`
   definidos en `databaseEncryptionMetadata.js` y entrega resultados saneados.
   No necesita entregar su contraseña ni otorgar PROCESS al backend.
   Con SSO temporal asignado, verificar identidad/cuenta del host de BD,
   volumen y snapshots, custodia de claves y procedimiento efectivo de backup.
   El rol de integraciones no acredita acceso a esta otra instancia.
2. **TLS de aplicación.** Candidato incluye este helper y todos los clientes
   revisados, conservando hotfix y pausas. Confirmar CA, vigencia/SAN y nombre
   utilizado por cada cliente. Ventana propuesta: 20 minutos coordinados
   para preflight y reinicios acotados de DEV/staging/gateway, preservando
   flags; no iniciar hasta aprobar instante y versiones exactas. No necesita
   migración de tablas ni nuevo recurso AWS; el impacto de reinicios requiere
   aprobación porque WhatsApp/staging siguen en uso. Tras validar todos los
   clientes, proponer por separado exigir transporte seguro en MySQL;
   no activar el requisito global mientras haya clientes pendientes.
3. **Volumen y backups.** Si el volumen ya está cifrado, documentar su clave
   y recuperación y remediar huecos de backups/logs. Si no lo está, preparar
   un destino cifrado adecuado al proveedor real, copiar/restaurar y cortar
   dentro de una ventana medida y aprobada. No contratar RDS ni usar los
   20 GiB del broker para alojar la BD. Coste temporal de volumen/backup y
   validación de capacidad pendientes del inventario del proveedor.
4. **Cifrado nativo adicional, si se acuerda.** Seleccionar componente/gestor
   de claves mantenido y compatible con edición/versión del motor; costes
   de licencias/KMS y credenciales del gestor requieren aprobación. Inventariar
   todos los tablespaces, logs, temporales y copias; el cifrado nativo no cubre
   automáticamente todos los ficheros. Las tablas file-per-table existentes
   pueden reconstruirse al cifrarlas: medir espacio/bloqueo antes de proponer
   la ventana. No ejecutar ALTER global, cambiar keyring ni rotar la clave
   existente para cerrar el checklist.
5. **Rotación de credencial retirada.** DBA identifica el principal asociado
   y consumidores efectivos sin usar el valor encontrado. Crear/entregar la
   identidad de sustitución por canal aprobado, coordinar todos los runtimes,
   validar permisos mínimos y retirar la anterior cuando no queden consumidores.
   No hacer esta operación junto a cambios de publicidad ni probar usuarios
   alternativos si el acceso actual resulta denegado.

Respaldo y rollback de cualquier lote: conservar versión segura y configuración
anterior protegida, snapshot/backup verificable, keyring/custodia independiente,
grants y referencias consistentes. Antes de nuevas escrituras, rollback puede
volver a la fuente segura conservada; después requiere conciliar cambios,
nunca restaurar una copia antigua y perder actividad. Tras exigir TLS, volver
a una versión compatible con TLS, no deshabilitar la validación del certificado.
No cambiar relojes, tokens de proveedores, PM2 de otros trabajos ni el hotfix.

## Repetición de QA

```bash
node --test src/scripts/tests/database_connection_config.test.js src/scripts/tests/database_tls_config.test.js src/scripts/tests/database_encryption_metadata.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/database_encryption_metadata_mysql.integration.js
SECURITY_ENCRYPTED_MYSQL_TEST=1 node src/scripts/tests/database_encrypted_restore.integration.js
node src/scripts/security-inventory-database-clients.js
```

No sustituir datadirs ni sockets de los fixtures por los reales. El diagnóstico
real es un comando explícito diferente, requiere la autorización de metadata
del prompt y un archivo de evidencia nuevo bajo el directorio privado de QA:
`node src/scripts/security-database-metadata.js --local-metadata-only --env-file /home/ubuntu/wt/back-dev/.env --out <archivo-privado-nuevo>`.
No ejecutar diagnósticos o scripts clínicos con credenciales extra para sortear
las cuatro denegaciones observadas.

Referencias:
[metadata de tablespaces](https://dev.mysql.com/doc/refman/8.0/en/information-schema-innodb-tablespaces-table.html),
[alcance y limitaciones InnoDB](https://dev.mysql.com/doc/refman/8.0/en/innodb-data-encryption.html),
[plugin utilizado solo en QA](https://dev.mysql.com/doc/refman/8.0/en/keyring-file-plugin.html).
La necesidad de `verifyIdentity` se comprobó también en el driver instalado
`mysql2@3.14.1`, `lib/base/connection.js:startTLS`; rechazar una CA desconocida
por sí solo no activa en ese driver la comprobación del nombre.
