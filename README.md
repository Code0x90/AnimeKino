# AnimeAV1 para Kino

Plugin comunitario para buscar anime en [AnimeAV1](https://animeav1.com), mostrarlo en Inicio y resolver episodios usando solo PlayerZilla y Voe.

## Incluye

- Búsqueda por título.
- Una fila de animes recientes en Inicio, con paginación del catálogo.
- Fichas de series y sus episodios. Si AnimeAV1 no declara temporadas dentro de una ficha, los episodios se presentan en la temporada 1; los grupos de 50 de la web son páginas, no temporadas.
- Resolución de PlayerZilla: convierte el enlace `/play/<id>` al manifiesto `/m3u8/<id>` y envía los encabezados del reproductor.
- Resolución de Voe: sigue la redirección JavaScript del embed, decodifica su payload y devuelve el HLS con el `Referer` de Voe.
- El reproductor distingue las fuentes por servidor e idioma: PlayerZilla · Japonés, PlayerZilla · Latino, Voe · Japonés y Voe · Latino, según lo que ofrezca cada episodio. Si una fuente falla, Kino puede probar la alternativa disponible.
- El MAL ID de cada anime se obtiene de su ficha de AnimeAV1. AniList aporta la portada de mayor tamaño disponible al catálogo y a la ficha, además del banner panorámico; la imagen de AnimeAV1 queda como respaldo.
- La lista de episodios solo entrega temporada, número y referencia de reproducción; el plugin no añade nombres, sinopsis, imágenes, fecha ni duración de capítulos. La ficha pasa los IDs de MAL y AniList que conoce para que Kino pueda enriquecer sus propios metadatos.
- Los registros detallan Inicio/búsqueda, ficha, capítulos e imágenes: MAL ID, coincidencia de AniList, proveedor elegido y ruta pública de imagen. En Kino se consultan en el registro del plugin (activa el modo debug si hace falta); en el SDK aparecen en la salida de `node sdk/run.mjs`.

No requiere cuenta ni configuración. Esta versión no declara descargas sin conexión ni un resolutor externo. Excluye los títulos que identifica como contenido adulto para no mostrarlos sin el control +18 de Kino.

## Pruebas locales

El kit `sdk/` proviene de la plantilla oficial de Kino. Las pruebas usan respuestas guardadas en `fixtures/` y no necesitan conexión:

```powershell
node sdk/validate.mjs .
node --test test/plugin.test.mjs
```

Para consultar la fuente en vivo manualmente:

```powershell
node sdk/run.mjs . home
node sdk/run.mjs . search "Frieren"
node sdk/run.mjs . episodes one-piece
node sdk/run.mjs . resolve "one-piece|1"
```

## Permisos de red

El manifiesto declara los hosts del catálogo, `player.zilla-networks.com`, `voe.sx` y AniList. Voe usa redirecciones y CDN variables, así que el plugin solicita acceso a hosts públicos HTTPS para buscar el embed redirigido y reproducir su HLS. AniList proporciona imágenes de alta resolución por MAL ID. Kino muestra estos permisos al instalarlo.
