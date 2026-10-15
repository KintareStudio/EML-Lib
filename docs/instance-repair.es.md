# Comprobación de Java, inspección y reparación

La segunda entrega reutiliza el flujo de preparación de Launcher y el descargador verificado. No necesita servicios Kintare ni cambios en EML AdminTool oficial.

```ts
const report = await launcher.inspect({ signal: controller.signal })
console.log(report.downloads, report.downloadSize, report.java)

await launcher.repair({ signal: controller.signal })
await launcher.launch({ signal: controller.signal, optimization: true })
```

## Java antes de preparar la instancia

`Java.check(path, requiredVersion, { signal })` ejecuta la JVM con `-XshowSettings:properties -version`. Lee su versión, arquitectura y nombre de máquina virtual, exige una salida exitosa y rechaza versiones inferiores al mínimo solicitado o arquitecturas distintas de `process.arch`. Un programa que imprime cualquier texto o termina con error ya no se acepta como Java. Reconoce versiones como `1.8.0_462`, `21.0.12+7` y `25-ea`, y normaliza `amd64`/`x86_64`, `aarch64` y `x86`/`i386`.

El resultado conserva `version` y `arch` y añade `majorVersion`, `architecture` y `vmName`. El evento `java_info` conserva su forma anterior. Un fallo sigue siendo `JAVA_ERROR`; cancelar es `OPERATION_CANCELLED`.

Launcher hace esta comprobación antes de escribir en la instancia. Usa el mínimo del manifiesto de Minecraft y lo eleva si el manifiesto del loader declara uno mayor. Si necesita descargar un instalador Forge/NeoForge para leer ese dato, lo verifica en un temporal, que después elimina. Solo tras superar la comprobación lo instala usando el mismo descargador atómico, sin otra petición de red.

En modo manual no cambia el ejecutable seleccionado ni instala otra JVM como alternativa. En modo automático, un runtime ausente o inválido permite descargar los archivos oficiales del runtime y volver a comprobarlo antes de descargar el resto del contenido o ejecutar procesadores. La comprobación verifica el mínimo declarado y la arquitectura; no garantiza que un mod antiguo admita cualquier versión de Java posterior. Una JVM x64 bajo emulación y un proceso Node arm64 se consideran arquitecturas diferentes.

## Inspección

`inspect()` devuelve:

- `downloads`: archivos descargables del manifiesto que faltan o no coinciden con su tamaño o SHA-1, incluido el instalador del loader cuando corresponde.
- `downloadSize`: suma de los tamaños declarados de esos archivos; los tamaños desconocidos cuentan como cero.
- `java`: `requiredVersion` y la información de la JVM, o `error` con el motivo de incompatibilidad.

La inspección no crea ni modifica la carpeta de la instancia. Consulta los manifiestos por red y usa un directorio temporal para los metadatos y, cuando haga falta, el instalador del loader. Esto no es un modo sin conexión. Respeta `cleaning.preserveExisting`: un archivo existente protegido se conserva aunque difiera del manifiesto. Sin tamaño ni hash declarados, solo puede comprobarse su existencia.

El informe revisa los archivos descargables declarados y, desde la [tercera entrega](diagnostics-integrity.es.md), añade los motivos de revisión y las salidas de procesadores declaradas por el instalador. No certifica todos los archivos derivados por natives o mods sin metadatos de integridad. `repair()` vuelve a preparar esos contenidos mediante los mecanismos existentes. En loaders antiguos que mezclan Forge con el JAR vanilla, el JAR resultante puede diferir del hash de entrada y volver a aparecer como descarga necesaria.

## Reparación

`repair()` repite la inspección vigente, descarga únicamente el contenido pendiente y ejecuta la preparación del loader, la extracción de natives y la copia de assets. Devuelve el mismo tipo de informe: `downloads` describe las descargas seleccionadas en esa operación, no una lista de errores posteriores.

No inicia Minecraft ni ejecuta la limpieza, aunque `cleaning.enabled` esté activado. Los archivos ajenos al manifiesto quedan intactos y los existentes bajo `preserveExisting` mantienen su contenido. `cleaning.ignored` conserva su significado original de exclusión de borrado; no impide actualizar un archivo gestionado por el manifiesto. El motor de reparación conserva las garantías por archivo y los límites de cancelación de la [primera entrega](reliable-downloads.es.md).

Una instancia de Launcher acepta una sola operación de lanzamiento, inspección o reparación simultánea. Todas admiten cancelación y liberan sus temporales antes de devolver el resultado.

## Opciones de JVM

`launch({ optimization: true, debug: true })` añade opciones según la JVM detectada sin modificar `config.java.args`. Se mantienen las opciones manuales; un recolector indicado manualmente tiene prioridad sobre la selección automática. Sin estas opciones, la lista manual se usa como antes.

La selección automática usa ZGC en HotSpot/OpenJDK desde Java 15. Añade `ZGenerational` solamente en Java 21 y 22; desde Java 23 el modo generacional es el predeterminado. No añade estas opciones de HotSpot a OpenJ9. Las referencias son las publicaciones de OpenJDK sobre [ZGC en producción](https://inside.java/2023/11/28/gen-zgc-explainer/) y [el modo generacional predeterminado en JDK 23](https://openjdk.org/jeps/474).

El helper anterior `jvmArguments(options, existing)` conserva su comportamiento para consumidores existentes. Para seleccionar según una JVM comprobada, usar `jvmArguments(options, existing, javaInfo)` o las opciones de `Launcher.launch`.

## Validación

Las regresiones incluyen una JVM real, propiedades de versiones y arquitecturas, selección de opciones, snapshots de archivos antes/después de inspeccionar, reparación selectiva e idempotente, cancelación y temporales, preservación de archivos personales y requisitos de Java leídos desde un instalador ZIP real. El arranque final del juego se sustituye por una captura de argumentos en la prueba de Launcher; estas pruebas no representan una partida real ni un servidor AdminTool desplegado.
