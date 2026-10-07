# Duración individual por reserva: prueba MySQL aislada

Resultado del 7 de octubre de 2026: **1 prueba integrada, 9 bloques de comprobación, todos correctos**. MySQL `8.0.42`; 11 conexiones HTTP a un servidor loopback creado y registrado por la prueba. Ninguna conexión a otro socket, base de datos, cola o proveedor. Cierre limpio de mysqld.

Evidencia de esta ejecución: `/tmp/cc-campaign-opt-mysql-zf1eI1/result.json`, privado (0600). El launcher crea un datadir nuevo (0700), usa su socket Unix con `--no-defaults --skip-networking` y bloquea TCP ajeno, fetch, colas y el índice real de modelos. Sólo hay datos ficticios. No se han activado flags, cambiado datos de la aplicación ni modificado código runtime en este subpaso.

Se ha comprobado:

- Los cinco handlers de disponibilidad rechazan la falta de duración; entradas inválidas, perfil ausente y duración fija incompatible no crean citas, snapshots, ocupaciones ni anchors.
- HTTP real → handler real → lecturas Sequelize/MySQL → solver → command y transacción `READ COMMITTED`. La elección de 45 minutos se almacena como DATETIME y JSON reales; la plantilla del catálogo sigue con `duration_minutes: null`.
- Preview, movimiento, cancelación y reapertura conservan el perfil y `booking.duration_selection` originales aunque cambie después el catálogo. La ocupación reemplazada no permanece en el hueco anterior.
- Dos pasos v4 congelan offsets 0/15 y span 40, no la suma 60. El segundo paso conserva su intervalo 09:15–09:35.
- Una sala y su alias en otra clínica comparten ocupación física real. Ni `force` evita el conflicto ni la respuesta expone datos del paciente o de la clínica ajena.
- Otra sala y profesional tampoco liberan una máquina ocupada ni sus diez minutos de turnaround.
- Un fallo después de insertar la cita y antes de terminar la ocupación revierte cita, receipt y ocupaciones dentro de la misma transacción.
- Dos escritores concurrentes sobre un hueco vacío se serializan con anchors InnoDB: confirma uno; el otro lee la ocupación posterior al lock y revierte.
- El control existente `supportOnly.expectedRange` espera el lock `UPDATE`, observa el movimiento confirmado y rechaza el rango obsoleto sin sobrescribirlo. Esta prueba **no acredita un CAS general nuevo** para toda edición.

Límites: se prueban wiring y transporte HTTP reales de disponibilidad, con una ACL sintética explícita. No es una prueba de autenticación, sesiones ni rutas completas de la aplicación; tampoco acredita recursos o tiempos clínicos reales de BS, ni despliegue o habilitación en CRM. Las reservas se ejecutan mediante el command real, no mediante el endpoint completo de creación.

Reproducción (sólo launcher OWNED):

```bash
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 BOOKING_INDIVIDUAL_DURATION_MYSQL_TEST=1 node --test src/scripts/tests/booking_individual_duration_mysql.integration.test.js
```

Sin los opt-ins, el test integrado queda omitido. El test no permite conectarse a una base existente.
