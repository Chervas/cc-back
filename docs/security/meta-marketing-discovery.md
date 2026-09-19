# Inventario Meta de una autorización candidata

Preparación sobre backend `6ff184e1` / front `90b32a7e`, 19/09/2026; no desplegada.
Contrato canónico primero en [13-backend](../../src/Documentacion/13-backend.md#inventario-candidato-meta-desde-ajustes-preparado-19092026).

## Autoridad y resultado

Comando tipado meta.marketing.oauth.assets.v1, solo en runtime OAuth y con
assetDiscovery=true y grant gateway exacto. Clave de control no lista activos.
POST humano /oauth/meta/marketing/authorization/:id/assets exige MFA, iniciador,
permisos de todo el ámbito y slot/historial/candidato/sesión original vigentes.
El gate META_MARKETING_OAUTH_DISCOVERY_ENABLED está apagado por defecto. No se
muestran controles de selección ni se crean bindings/grants. La lista no acredita
propiedad clínica, correspondencia de aliases/primarias/shares o permiso de escritura.

La credencial candidata permanece dentro del broker. Lista metadata de Ads y de
páginas/Instagram según los scopes concedidos. Inspección USER fresca antes/después,
principales/grants/bloqueos entre páginas y pins de slot/app/KMS alrededor del uso.
No pide token de página, datos personales de perfil, conversaciones o archivos.
No usa List/PutSecretValue al descubrir; tampoco promueve ni borra un candidato.

Límites: 100 filas/página, 10 páginas totales, 500 activos, 128 KiB/respuesta, 1 MiB
agregado, 256 KiB de salida y 25 s por operación (HTTP 8 s). 20 solicitudes/minuto,
2 ordinarias/1 control. Nunca sigue next URLs de Meta; reutiliza únicamente cursor
opaco en un endpoint fijo y no lo conserva. Cualquier exceso, duplicado, bucle o
respuesta inválida falla completa. No confundir esto con aceptación de carga real.

La respuesta es una fotografía de hasta 5 minutos ligada a flow/versión/digest/ámbito.
CRM exige observación dentro de 5 s del reloj esperado. La pantalla la retira al
consultar/cambiar ámbito, ante cambio de token y por temporizador de vencimiento;
los timers dependen de la planificación del navegador. No hay polling externo.
Auditoría humana v23 y técnica v2 con referencia de consulta; ningún token/cursor ni
payload completo del proveedor en SQL, SQLite, registros o errores. Captura/resultados
humanos se confirman antes de devolver metadata; un fallo deja error o intento
pendiente, nunca éxito parcial.

## Pruebas y fuentes

Desde broker con Node 24 y red exterior cerrada:

```sh
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/meta-marketing-discovery.test.js test/meta-marketing-oauth-runtime.test.js
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/*.test.js
```

Desde backend:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_CRM_VISUAL=1 META_OAUTH_DISCOVERY_TEST=1 node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
node --test services/platform-audit/test/*.test.js src/scripts/tests/platform_audit*.test.js
```

Usa MySQL propio temporal, TLS/SQLite y componentes Angular de producto reales;
Meta, Secrets y S3 son ficticios. Ninguna prueba abre un popup Meta, usa token
histórico o acredita MFA pública/proveedor real. Resultados/capturas/hashes exactos
en 99 y qa-evidence/security-resume-20260917/meta-discovery-20260919/.

Se consultó el [SDK oficial User de Meta](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/user.js)
para edges accounts/adaccounts y el [modelo Page](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/page.js)
para la relación Instagram. Esas fuentes no sustituyen la aceptación de Graph v24.
Las referencias de [cuentas](https://developers.facebook.com/docs/graph-api/reference/user/adaccounts/),
[páginas](https://developers.facebook.com/docs/graph-api/reference/user/accounts/) e
[Instagram](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started/)
no estaban accesibles (429/error) en esta revisión. Revalidar permisos, campos y
paginación reales antes de abrir cohorte; no inferir disponibilidad del ensayo falso.

## Publicación y recuperación

No se crea infraestructura, DDL ni job nuevo. Mantener las dependencias y los gates
cerrados del OAuth candidato. Publicar primero lector AWS compatible v23, después
escritor y por último productor humano; conservar intactos archivo/seis eventos v19.
Candidato selectivo e identidad/slots/grants/TLS propios por entorno, clocks sanos,
aceptación de titular/proveedor y carga/cuotas antes de activar. No promover DEV
completo a staging/gateway ni activar jobs clínicos, campañas, leads o envíos.

Cerrar solo discovery retira las consultas nuevas; mantener status/abort y su
recuperación. Una lectura fallida puede repetirse expresamente con UUID nueva,
porque no escribe en el proveedor; no recanjear code, borrar diario/bajas, promover
candidato ni reutilizar como permiso una lista previa. La selección/activación
tiene ya [núcleo broker preparado](meta-marketing-enrollment.md); faltan su
consumidor CRM, transacción de asignaciones, auditoría humana y UI. Copias/restauración al final.


## Resultado del ensayo aislado (19/09/2026, UTC)

- Broker completo: 715/715; subconjunto inventario/TLS: 19/19. No sumar ambos.
- Auditoría y regresiones: 124/124; routers OAuth/Google montados: 6/6.
- Ocho grupos con MySQL temporal, TLS y componentes reales; 11 capturas propias
  de escritorio/móvil/Actividad. Sin errores JS, salida exterior ni escritura de negocio.
- Primera consulta de tres activos: 57 consultas SQL / 95 ms; ensayo completo
  1296 consultas, pool final 0/0 y MySQL apagado correctamente. Muestra separada
  de broker: 15 llamadas Secrets y 4 Graph, cero List/Put durante el inventario.
- Build Angular completo `dabc973ae64efea6`, 101507 ms. Aviso CommonJS previo
  de debug/socket.io-parser; sintaxis válida de los 28 JS/CJS cambiados.

La primera prueba visual detectó un reloj fijo en el fixture mientras transcurría
la compilación del navegador. Se hizo avanzar solo ese reloj de prueba, conservando
el control de desfase de 5 s del producto. La segunda ejecución pasó completa.
Un primer build terminó con señal 15 (143), sin causa acreditada; el segundo pasó.
Logs fallidos conservados. Estos resultados no aceptan Meta/AWS ni carga reales.
Coste incremental AWS real `null`; no se consultó Cost Explorer ni creó recurso.

Huellas de las fuentes cambiadas en `meta-marketing-discovery-consumers.json`;
no es un paquete autónomo de despliegue. El inventario OAuth/CRM anterior conserva
su alcance histórico. `accepted-result.json`, PNG en `visual/`, logs finales,
`syntax.json` y `source-final.json` quedan en la evidencia privada indicada arriba.
