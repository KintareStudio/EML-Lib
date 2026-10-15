# Diagnóstico e integridad

La tercera entrega mantiene las llamadas anteriores de EML-Lib y el contrato de EML AdminTool oficial. Reutiliza el descargador, la preparación del launcher y la gestión de procesos de las entregas anteriores.

## Comprobación de Java con plazo máximo

`Java.check(path, requiredVersion, { signal, timeoutMs })` usa treinta segundos por defecto, para admitir también el primer arranque de una JVM en un sistema ocupado. Launcher permite configurar ese plazo con `javaTimeoutMs` en `launch()`, `inspect()` y `repair()`.

```ts
await java.check('java', 21, { signal, timeoutMs: 5_000 })
await launcher.repair({ signal, javaTimeoutMs: 5_000 })
```

Agotar el plazo produce `JAVA_ERROR`, con un mensaje que identifica el timeout. Cancelar mediante la señal del consumidor sigue produciendo `OPERATION_CANCELLED`. En ambos casos se detiene el proceso de comprobación y se espera su cierre antes de rechazar la promesa. El plazo no limita una partida que ya se esté ejecutando.

## Motivos de inspección

`InstallationReport` mantiene `downloads`, `downloadSize` y `java` y añade `issues`:

```ts
const report = await launcher.inspect({ signal })
for (const { file, reason } of report.issues) {
  console.log(file.path, file.name, reason)
}
```

Cada entrada identifica un archivo y uno de tres motivos: `missing`, `size_mismatch` o `hash_mismatch`. Si el tamaño ya difiere, no hace falta leer todo el archivo para comprobar también el hash. Los archivos existentes bajo `preserveExisting` se excluyen tanto de las descargas como de estos motivos.

`Downloader.inspect(files, { signal })` ofrece la misma comprobación sin crear directorios y también acepta archivos locales sin URL, como las salidas de procesadores. `getFilesToDownload()` conserva su resultado anterior y solo selecciona archivos con URL. Sus opciones pueden incluir `onIssue` para observar los motivos de esa misma revisión, sin volver a calcular hashes.

El informe de `repair()` describe los problemas y descargas seleccionados antes de repararlos. Para obtener un diagnóstico posterior se puede llamar de nuevo a `inspect()`.

## Salidas de Forge y NeoForge

El patcher interpreta `processors.outputs` del formato del instalador: claves de artefactos Maven entre corchetes, directamente o mediante referencias a `data`, y valores SHA-1 literales o mediante esas referencias. Se procesan las salidas del lado cliente; las del servidor se excluyen. La referencia del formato es el [modelo del instalador oficial de Forge](https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/json/Install.java).

Una salida existente con hash incorrecto obliga a repetir su procesador. Una salida válida permite omitirlo. Terminar con código cero no basta: las salidas declaradas se vuelven a comprobar antes de aceptar el resultado. Un resultado ausente o corrupto produce `PATCHER_ERROR` y conserva la marca de preparación incompleta. No encontrar la clase principal de un procesador también produce ese error.

La inspección de Launcher incluye los problemas encontrados en estas salidas, aunque no tengan una URL descargable. La reparación las obtiene ejecutando sus procesadores, no añadiéndolas a `downloads`. Si el instalador no declara hashes de salida, se conserva la comprobación de existencia anterior. Los archivos generados sin metadatos de integridad no reciben una garantía de hash inventada.

## Protección compartida de logs

`redactSecrets(text, launcher.config, args)` oculta credenciales conocidas, sus representaciones en URLs o JSON, cabeceras Bearer, JWT y asignaciones de credenciales en argumentos, propiedades JVM y consultas de URLs. El vector opcional de argumentos permite reconocer valores completos, incluso cuando contienen espacios.

Launcher usa esa protección en sus eventos de texto, mensajes almacenados y avisos. CrashReport aplica la misma protección junto con su anonimización anterior de nombres, correo e IP. Los argumentos y la configuración reales conservan sus valores para ejecutar Minecraft; los eventos estructurados existentes, como `launch_launch`, mantienen su contrato. Un consumidor que comparta esos objetos debe construir su resumen o aplicar la protección al texto que vaya a compartir.

El helper cubre las credenciales conocidas y los patrones descritos; no puede reconocer cualquier secreto arbitrario sin nombre identificable. No modifica los valores que se entregan al proceso del juego.

## Exclusión por carpeta

Los objetos `Launcher` de un mismo proceso coordinan sus operaciones por la ruta real de la instancia, resolviendo también alias mediante enlaces de directorio. Una segunda operación sobre esa carpeta devuelve `INVALID_OPERATION`. El bloqueo se libera al terminar, fallar o cancelar; no crea archivos en la instancia ni deja bloqueos persistentes tras cerrar el proceso.

En un lanzamiento se mantiene hasta que termina el proceso del juego. Esta coordinación pertenece al proceso Node que carga la biblioteca: no es un bloqueo distribuido ni coordina procesos independientes o copias independientes del paquete.

## Espacio disponible

`inspect()` añade `space` con `requiredBytes`, `availableBytes` y `sufficient`. La estimación reserva el doble del tamaño declarado de las descargas pendientes más 64 MiB para reemplazos temporales, metadatos y extracción. Los tamaños desconocidos no se pueden sumar. Los temporales del instalador se comprueban también en su volumen.

Antes de descargar el contenido, `launch()` y `repair()` rechazan espacio insuficiente con `FILE_ERROR` y `serverCode: 'INSUFFICIENT_SPACE'`. La inspección devuelve el diagnóstico de espacio sin modificar la instancia. Se puede omitir esta estimación con `{ diskSpace: false }`, manteniendo el tratamiento normal de errores reales de escritura.

Se utiliza [`fs.statfs`](https://nodejs.org/api/fs.html#fspromisesstatfspath-options) sobre la carpeta existente más cercana. Si la API o el sistema de archivos no lo admiten, la disponibilidad queda sin determinar y no bloquea la operación. La estimación no reserva espacio ni garantiza el tamaño de salidas de procesadores o archivos extraídos: las escrituras siguen gestionando sus propios errores.

## Evidencia

Las pruebas nuevas incluyen un proceso real detenido por timeout y por cancelación, un procesador Java compilado y ejecutado con salidas correctas e incorrectas, inspección de hashes, exclusión de carpetas mediante enlaces, liberación tras fallo/cancelación, simulación de poco espacio y comparación entre argumentos reales y logs protegidos. El transporte de manifiestos continúa controlado en las pruebas; no se representa una partida real ni una ejecución contra un AdminTool desplegado.
