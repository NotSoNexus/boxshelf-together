# Boxshelf Online · Worker de Cloudflare

La misma API v1 (perfiles, códigos de amigo, amigos) pero corriendo **en la red de
Cloudflare**. Gratis, sin tarjeta, sin nada encendido en casa, dominio incluido.

## Tu parte (15 minutos, una sola vez)

1. **Cuenta gratis**: crea una en dash.cloudflare.com (plan Free, no pide tarjeta).
2. En una terminal de tu PC (Node ≥ 18; este proyecto ya lo trae en `.tools\node`):

```powershell
cd online\worker
npx wrangler@latest login          # abre el navegador: acepta
npx wrangler@latest d1 create boxshelf-online
#   → copia el "database_id" que imprime y pégalo en wrangler.toml
npx wrangler@latest kv namespace create IMG
#   → copia el "id" que imprime y pégalo en wrangler.toml
npx wrangler@latest d1 execute boxshelf-online --remote --file=schema.sql
npx wrangler@latest deploy
```

Al final imprime tu URL: `https://boxshelf-online.<tu-subdominio>.workers.dev`.
Esa URL es la que irá en Boxshelf → Ajustes → Online. Nada más que hacer.

## Actualizar el servidor después

Cuando cambie el código del Worker: `npx wrangler@latest deploy` y listo.

## Qué despliega

| Archivo | Qué es |
|---|---|
| `src/worker.js` | La API completa (port del `server.js`, sin dependencias) |
| `wrangler.toml` | Config: nombre, base de datos D1 y KV de imágenes |
| `schema.sql` | Tablas (usuarios + registro de altas); se aplica una vez |

## Límites del plan gratis (muy lejos de alcancé)

- 100,000 peticiones/día · 5 GB de base de datos · 1 GB de imágenes (avatares ≤ 400 KB)
- Si algún día hiciera falta más: la API es la misma, se muda a un VPS sin reescribir la app.

## API

La misma que `online/README.md` documenta para server.js — ruta por ruta.
La única diferencia: TLS y CDN los pone Cloudflare, y el Worker escucha en el dominio
`*.workers.dev` (o tu dominio propio si lo conectas después).
