=== ClinicaClick Web Publisher ===
Contributors: clinicaclick
Requires at least: 5.8
Requires PHP: 7.4
Stable tag: 2.0.0-alpha.4
License: Proprietary

Medición de ClinicaClick y publicación segura de landings firmadas con caché local.

== Description ==

Clinicaclick descarga artefactos inmutables, verifica su firma Ed25519 y sus
hashes, conmuta la caché local de forma atómica y sirve las landings bajo
`/cita/` sin consultar el CRM en cada visita. Los formularios usan un puente
same-origin con allowlist, honeypot y rate-limit que firma el JSON hacia intake
con scope/HMAC tomados solo del runtime firmado.

Esta versión es una pre-release técnica: necesita los endpoints descritos en
README.md y no debe instalarse en producción hasta superar el gate W5.

== Security ==

* No contiene ni acepta claves privadas.
* No ejecuta PHP remoto ni JavaScript arbitrario; solo admite el loader exacto.
* Rechaza traversal, tipos no permitidos, HTML ejecutable y formularios
  manipulados.
* No modifica el CMP ni desactiva otros plugins.
* No registra ni devuelve el token de instalación.
* No refleja PII ni errores del backend en redirects o respuestas.

== Uninstall ==

Desinstalar conserva por defecto configuración y última publicación válida.
El borrado destructivo requiere `CLINICACLICK_WEB_PURGE_ON_UNINSTALL=true`.
