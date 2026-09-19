# Estado local de Meta en Ajustes

Preparado el 19/09/2026, mismos worktrees DEV. Contrato primero en
[13-backend](../../src/Documentacion/13-backend.md#estado-y-asignaciones-meta-locales-sin-credenciales-preparado-19092026),
con espejo idéntico en front. Push conserva código; no publica una release.

## Motivo y comportamiento

El endpoint anterior consultaba `MetaConnections` completo e intentaba
`debug_token` con el transporte en contención. Un rechazo podía presentarse como
`token_validation_failed` y solicitar reautorización. La fecha local de caducidad
también producía esa recomendación sin comprobar el proveedor. Mappings leía
columnas secretas y `additionalData` para filtrarlas después. El selector compartido
reintentaba el estado sin ámbito después de fallar la consulta de clínica/grupo.
Ajustes podía aplicar respuestas antiguas y su resumen Marketing no se invalidaba.

El lector local devuelve conexión guardada y asignaciones mínimas, nunca salud de
Meta. Sesión gestionada SQL, ámbito explícito y ACL actual; el grupo necesita todas
sus clínicas. Listas cerradas de columnas, inventario limitado y tipos no WhatsApp.
Una baja, cambio de conexión, revocación de sesión o permiso durante la consulta
impide entregar los datos. Las respuestas no se cachean. No hay cliente HTTP de
proveedor, acceso al broker ni llamada Secrets Manager en este servicio.

`connected:false` mantiene cerrados los consumidores antiguos; `connectionStored`
permite mostrar lo guardado sin afirmar que funciona. La UI tiene pausa explícita,
no ofrece reconexión/selección mientras esté pausada y conserva el flujo separado
WhatsApp. Ajustes cancela consultas anteriores y comprueba generación, URL/ámbito y
sesión al recibir. El selector no cae a la autorización de usuario sin ámbito.
El workspace interpreta el mismo motivo antes de descubrir cuentas.

El resto de OAuth/Meta no está auditado íntegramente por este corte. El consumidor
CRM del runtime `meta-marketing-*` avanza en [el corte posterior](meta-crm-broker.md):
registro independiente, lector manual y auditoría humana preparados. Siguen
pendientes escritor de alta/grants, OAuth nuevo en vault, publicación de la baja coordinada,
operaciones restantes y aceptación con el titular. No usar estas pantallas como
prueba de que la migración de credenciales terminó. No cambia DDL, jobs, MFA,
pausas clínicas, infraestructura ni configuración de proveedor.

## QA reproducible

Node 24, desde back-dev:

```
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_METADATA_VISUAL=1 node src/scripts/tests/meta_connection_metadata_mysql.integration.js
```

El fixture crea su propio mysqld/socket, tablas/modelos, usuario y sesión. La red
exterior y otros sockets quedan cerrados. Reusa el servicio/handler/repository de
producto y los resolvers/ACL/sesión SQL; no monta el router OAuth monolítico entero.
Angular monta las clases y plantillas de Ajustes/selector y su suscripción de ámbito;
las APIs ajenas a Meta son datos de fixture. No hay login público/MFA ni Meta real.
La decisión del workspace se ejecuta desde su modelo real, sin renderizar la página
completa. Evidencia privada en
`qa-evidence/security-resume-20260917/meta-settings-metadata-20260919/`.

Resultado final: nueve grupos SQL correctos; 21/21 regresiones dirigidas y
compilación Angular `ngc --noEmit` correcta. Cinco capturas Chromium inspeccionadas:
Ajustes 1440/390 px, cambio de clínica, retirada por permisos y selector pausado.
23 peticiones Meta desde navegador, todas de estado/mappings; cero OAuth,
discovery, escrituras, conexiones exteriores o errores JavaScript. La prueba
A→B→A retiene la respuesta inicial de asignaciones, cambia el nombre en SQL y
comprueba que el nombre actualizado prevalezca al liberar la respuesta vieja.

Primera apertura estado+asignaciones: 29 sentencias/81 ms. Ocho repeticiones:
232 sentencias, 28–53 ms por apertura. Cero SELECT de OAuth Meta, tokens de página,
WhatsApp o `additionalData`; pool final 0 en uso/0 en espera. Sin benchmark de carga
sostenida/cardinalidad real. Los fallos de montaje/DI/traducción y el desborde móvil
hallados antes del cierre están corregidos; no se suman ejecuciones intermedias.
Se añadieron seis claves ES/CAT, sin modificar las anteriores. No se afirma que el
validador i18n global quede limpio: conserva sus pendientes previos fuera del corte.

## Publicación, compatibilidad y recuperación

Publicar API/UI juntas en un candidato selectivo revisado: los clientes antiguos
reciben `connected:false` durante la pausa y pueden mostrar la conexión ausente.
No promover todo DEV; dependencias de resolución/ACL/sesiones y bloques deben
existir en el esquema destino. Revisar mapeos cuyo consumidor utilizara
`additionalData`: este endpoint ya no lo devuelve. El inventario sigue agrupado
por clínica; no introduce discovery ni alta/migración de asignaciones de grupo.

Hasta publicar, conservar releases actuales. Ante una regresión de UI, mantener
el lector de metadatos y la contención, corregir el consumidor sin restaurar lectura
de tokens, fallback sin ámbito o salud inventada. No borrar bloques/assignments ni
credenciales para recuperar un indicador verde. La revisión AWS v19 sigue separada
y su canary congelado no se modifica. Copias/restauración continúan al final.
