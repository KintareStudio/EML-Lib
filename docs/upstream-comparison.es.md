# Comparación con EML-Lib oficial

## Base y alcance

Este soft fork parte directamente de [EML-Lib 2.7.3](https://github.com/Electron-Minecraft-Launcher/EML-Lib/tree/1350114806500481003dbd7c1ff323b0cb79ae4f), commit `1350114806500481003dbd7c1ff323b0cb79ae4f` de la rama `main`, consultada el 15 de octubre de 2026. Se conservaron su historial, licencia MIT, atribución y todos sus archivos de código.

Se comparó esa copia oficial con la edición local de Kintare. Antes de preparar la publicación, la comparación normalizada por finales de línea encontró 29 archivos diferentes, 29 adicionales y 75 iguales. Entre las diferencias había código anterior del fork, mejoras generales y las incorporaciones de Kintare. Estos números describen la comparación inicial, no el tamaño final del commit.

Siete archivos antiguos presentes únicamente en la edición local no se reintroducen: `argumentsmanager.ts`, `filesmanager.ts`, `loaders/fabriclike.ts`, `loaders/forgelike.ts`, `loaders/patcher.ts`, `utils/cleaner.ts` y `utils/loaders.ts`. Upstream ya los sustituyó y las implementaciones activas del fork no los importan. Sus mejoras relevantes están en las implementaciones actuales, no en una segunda copia del mismo subsistema.

## Diferencias funcionales

| Área                | Cambio del fork                                                                                        | Relación con EML oficial                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Autenticación       | KintareAuth y clientes de perfiles, guardarropas y sesiones con descubrimiento por despliegue          | Proveedor opcional. No reemplaza Microsoft, Yggdrasil, Azuriom ni CrackAuth.                                                                  |
| Agente              | Descarga de Loki desde GitHub Releases, verificación y caché                                           | Solo se usa al pedir AuthAgent o la integración Kintare.                                                                                      |
| Transporte          | Transporte HTTP inyectable y errores con estado y causa                                                | No exige configuración; usa fetch de forma predeterminada. Las peticiones con credenciales rechazan redirecciones.                            |
| Perfiles protegidos | Adaptador de contraseñas, tokens temporales y coordinación de solicitudes                              | Conserva las rutas `/api/profiles` y `/api/profiles/{slug}/auth`, las cabeceras `pseudo`, Basic y Bearer y los métodos anteriores de Profile. |
| Configuración       | Utilidades de memoria, Java, argumentos y selección de servidor                                        | Adiciones independientes; no requieren servicios Kintare.                                                                                     |
| Archivos            | Conservación opcional, evaluación de reglas Mojang, extracción determinista y limpieza por componentes | Los mecanismos nuevos no requieren cambiar los manifiestos de AdminTool.                                                                      |
| Actualización       | Operaciones concurrentes compartidas en Bootstrap                                                      | Mantiene métodos, eventos y feed oficial.                                                                                                     |
| Reportes            | Mayor ocultación de datos y periodo de espera opcional                                                 | Conserva el formato de AdminTool y no añade un límite local por defecto.                                                                      |
| Distribución        | Paquete `@kintare/eml-lib`, declaraciones completas y rutas de compatibilidad                          | Puede instalarse con el nombre `eml-lib`; conserva exportaciones y aliases oficiales.                                                         |

## Ajustes realizados para mantener el soft fork

La edición local había cambiado dos valores predeterminados. En esta publicación se conserva el comportamiento oficial:

- La lista de limpieza predeterminada sigue siendo la de upstream. `cleaning.ignored` la reemplaza; `ignoredMode: 'extend'`, `additionalIgnored` y `USER_DATA_IGNORED_PATHS` permiten ampliar la protección explícitamente.
- `new CrashReport(url)` no aplica un periodo de espera local adicional. Un consumidor que lo quiera puede usar `new CrashReport(url, { cooldownMs: 600_000 })` y consultar `canSend()` antes de pedir consentimiento.

Las correcciones de memoria, reglas Mojang, extracción y protección de credenciales sí corrigen comportamientos defectuosos. No se promete reproducir esos fallos de upstream.

## EML AdminTool oficial

No se requiere un fork del servidor. Profile, News, Background, Maintenance, Bootstrap y las rutas de archivos siguen consumiendo la interfaz oficial. Los guardarropas y OIDC de Kintare son servicios adicionales opcionales de Kintare; no se presentan como endpoints de AdminTool.

Las reglas visuales, almacenamiento cifrado y ciclo de vida de Electron pertenecen al launcher consumidor. El transporte, la CSP y las decisiones de consentimiento siguen bajo control de esa aplicación.

## Evidencia de compatibilidad

- `test/fixtures/upstream-2.7.3.json` registra las 17 exportaciones de valor oficiales, los aliases del objeto predeterminado y sus métodos y getters públicos. Incluye el commit exacto que se usó para generar el contrato.
- `test/upstream-compat.test.mjs` comprueba esa superficie, los valores predeterminados y las rutas y cabeceras de AdminTool.
- `npm run test:unit` compila y ejecuta las pruebas offline, incluidas las regresiones de descarga, integridad y cancelación de la [primera entrega de fiabilidad](reliable-downloads.es.md).
- `npm run test:package` empaqueta e instala el tarball como `eml-lib` en un consumidor temporal, comprueba imports raíz y profundos y compila un consumidor TypeScript. No usa los fuentes del fork como alias de resolución.
- `npm run compare:upstream -- ../EML-Lib-upstream` contrasta la copia oficial compilada con el fork: ocho operaciones de AdminTool tienen respuestas y trazas de solicitud iguales; tres configuraciones sin extensiones tienen la misma configuración resuelta.

Estas pruebas usan respuestas controladas y no son una validación end-to-end contra un servidor AdminTool desplegado ni una partida real de Minecraft. La matriz de CI cubre Linux, Windows y macOS; su resultado se verifica por separado del resultado local.

## Mantenimiento

Los cambios se aplican sobre upstream y no importan el historial divergente de la edición local anterior. Para actualizar la base, integrar upstream, regenerar el contrato de la versión elegida y repetir las pruebas de consumidores antes de publicar. Mantener mejoras generales separables de los proveedores opcionales.
