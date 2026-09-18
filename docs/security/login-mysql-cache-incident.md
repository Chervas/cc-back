# Login CRM: agotamiento de consultas preparadas, 18/09/2026

El titular confirmó que volvió a entrar tras recuperar la auditoría. La causa
estaba en el worker de seguridad DEV y afectó al MySQL compartido por ambos
entornos; no en la contraseña, el frontend ni la nueva gestión Google sin desplegar.

## Causa comprobada

MySQL registró `max_prepared_stmt_count` agotado (16.382). Las conexiones del
worker DEV, PID1766061 y usuario SQL DEV, conservaban unas 14.000 consultas
preparadas cuando se inspeccionó el servidor. Se identificaron mediante threads,
puertos y PID, sin extraer consultas clínicas. Las consultas acumuladas eran
UPDATE de `PlatformAuditDeliveryStates`: el polling cada segundo genera distintos
predicados de lease. La caché mysql2 predeterminada permite 16.000 por conexión,
mayor que el presupuesto disponible al sumar las conexiones del pool.

Los fallos SQL impidieron finalizar el job de auditoría CRM 99516 iniciado a las 10:44 UTC.
La cola conservaba cinco eventos sin entrega; el más antiguo era de las 11:32 UTC. Cuando
superó una hora, la comprobación de capacidad de MFA rechazó contraseñas válidas
con 503. Una contraseña vacía/incorrecta todavía devolvía 401 porque ese camino no
pasa por la misma comprobación de capacidad. La página pública respondía 200.
La separación por esquema/usuario no separa los recursos globales de MySQL.

## Recuperación y corrección permanente

Se reinició inicialmente la API DEV al identificar el usuario SQL; el análisis
de sockets precisó que las conexiones pertenecían al worker. Reiniciar ese
worker redujo el contador de unas 14.000 a 91. Se entregaron explícitamente los
cinco eventos de auditoría pendientes al escritor configurado:5 entregados,
cero fallos, pendientes o conciliaciones. No se vació ni se falseó la auditoría.

`src/config/config.js` fija `dialectOptions.maxPreparedStatements=128` en DEV y
CRM. La expulsión LRU cierra las consultas antiguas en MySQL. DEV conserva las
opciones TLS mediante composición; no debe añadirse un segundo `dialectOptions`
que sobrescriba el límite. El primer ensayo detectó justamente esa composición
incorrecta antes de publicar y se corrigió. No se elevó el límite global.

DEV usa el runtime anterior 68808b82 más ese único archivo, commit de hotfix
`30fb9050063e6cc7a847706b9e66c8d35ce784ee`, instalado en
`/opt/clinicaclick-dev/release-30fb9050063e6cc7a847706b9e66c8d35ce784ee-cache1`.
2222 archivos del runtime conservados, mismo lockfile/dependencias y hashes de
entorno privado. API y worker recargados. Rama dev incorpora también el arreglo
en `d756bcf2`; la aplicación completa pendiente de migración no se publicó.

CRM/back-staging incorpora `52274707`, publicado y reiniciado con su configuración
previa. Antes del reinicio se verificó que el único job running era de auditoría;
los históricos pendientes pertenecían a otros namespaces, y los clínicos staging
en espera estaban programados para el futuro. No se cambiaron pausas, namespaces,
flags o estados clínicos para recuperar el login. El job agotado quedó failed
por la recuperación existente; nuevas entregas automáticas completan correctamente.

La primera preparación DEV con archivo Git completo fue rechazada por diferir
del conjunto instalado. La copia exacta posterior omitió enlaces de dependencias
anidadas y produjo un fallo temporal de arranque sólo en la API DEV. Se repusieron
los tres enlaces existentes, se comprobó HTTP real y quedó sin nuevos reinicios.
El instalador de evidencia se corrigió para conservarlos y exigir HTTP 401 en
`/api/auth/me`, además de estado systemd. No repetirlo sobre el destino instalado.

## Validación y límites

Dos pruebas de 1024 consultas SELECT distintas, con Sequelize/mysql2 reales y las
configuraciones DEV/CRM, completaron todas las respuestas. Cada conexión retuvo
128 consultas y cerró 896 antiguas. Sólo se usó la BD aislada DEV, sin tablas
clínicas, DDL ni modelos de aplicación. La observación del worker instalado
alcanza 128 por conexión/512 en sus cuatro conexiones, en lugar de crecer hasta
agotar el servidor. Trece muestras durante tres minutos dan un máximo global de 598 consultas,
con el límite del servidor intacto en 16.382. El monitor de auditoría vuelve a
healthy, sin pendientes, y API/worker DEV quedan sin reinicios tras la corrección.
Evidencia y observación temporal en `login-incident/`.

Chromium real verifica el login público CRM a 1440 y 390 px, validación del formulario,
sin errores JS ni respuestas 5xx ni desbordamiento; capturas inspeccionadas. La prueba automatizada
es anónima, sin simular respuestas ni extraer sesión/OTP. El titular confirmó su
acceso real; esto no completa la aceptación visual autenticada de toda la migración.
MFA, sesiones, auditoría y permisos permanecen activos.

Conservar el límite de caché al actualizar cualquier runtime. La preparación
completa 7db098a9 previa al incidente carece del arreglo: no activarla sin incorporarlo.
La reversión a 68808b82 sin el límite volvería a introducir la causa; conservar el
hotfix al preparar una recuperación. El problema de aceptación IA 21/22 y el resto
de la migración siguen abiertos.

[Documentación oficial mysql2 sobre caché y cierre LRU](https://sidorares.github.io/node-mysql2/docs/documentation/prepared-statements).
