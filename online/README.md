# Boxshelf Online · guía del servidor

Servidor ligero de perfiles y amigos (v1). Cero dependencias: solo Node.js.
Corre en cualquier VPS chico (Ubuntu 24.04) — 1 núcleo y 1 GB de RAM sobran.

## Qué es y qué no es

- Cada jugador tiene un **código de amigo** (12 dígitos) y un **token secreto** que es su llave.
- El servidor guarda solo la **copia online** del perfil: nombre, descripción, horas, favoritos,
  avatar y banner. El juego y la biblioteca viven en cada PC, como siempre.
- Si el servidor está apagado, Boxshelf funciona igual que hoy.

## 1 · VPS chico

Opciones de menor a mayor costo:
- **Oracle Cloud (capa gratuita perpetua)** — 1 VM ARM (4 núcleos, 24 GB RAM) gratis de por vida.
  Requiere tarjeta para verificar, y hay que pedir la VM con "Always Free" marcado.
- **Hetzner / Netcup** — ~€4/mes, sin complicaciones, ideal si Oracle te da problemas.

Al crear la VM elige **Ubuntu 24.04**, y conéctate con SSH:

```
ssh root@IP-DEL-SERVIDOR
apt update && apt install -y nodejs
```

(Cualquier Node ≥ 18 sirve; si `apt` trae uno muy viejo, usa NodeSource:
`curl -fsSL https://deb.nodesource.com/setup_22.x | bash && apt install -y nodejs`)

## 2 · Copiar el servidor y probarlo

```
sudo mkdir -p /opt/boxshelf-online
sudo cp server.js /opt/boxshelf-online/     # (desde la carpeta online/ de este proyecto)
cd /opt/boxshelf-online && sudo -u nobody node server.js   # prueba rápida: Ctrl+C para salir
```

## 3 · Servicio siempre encendido (systemd)

```
sudo tee /etc/systemd/system/boxshelf-online.service > /dev/null <<'EOF'
[Unit]
Description=Boxshelf Online (perfiles y amigos)
After=network-online.target

[Service]
User=nobody
WorkingDirectory=/opt/boxshelf-online
ExecStart=/usr/bin/node /opt/boxshelf-online/server.js
Environment=BS_PORT=8787
Environment=BS_DATA=/opt/boxshelf-online/data
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/boxshelf-online/data

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now boxshelf-online
curl -s http://127.0.0.1:8787/v1/ping   # debe contestar {"ok":true,...}
```

## 4 · HTTPS en frente (elige una)

**Opción A — Cloudflare Tunnel (recomendada, sin abrir puertos):**
necesita un dominio propio en Cloudflare (hay dominios baratos, o el túnel de prueba
`--url` da una dirección aleatoria sin cuenta):

```
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
install cloudflared /usr/local/bin/
cloudflared tunnel --url http://localhost:8787     # PRUEBA: da una URL https://…trycloudflare.com
cloudflared tunnel login
cloudflared tunnel create boxshelf
cloudflared tunnel route dns boxshelf online.tudominio.com
cloudflared tunnel run boxshelf &                  # (o como servicio: cloudflared service install)
```

**Opción B — puerto abierto con TLS propio (Caddy):**

```
ufw allow 8787/tcp && ufw enable
apt install -y caddy   # Caddy da HTTPS solo si apuntas un dominio A/AAAA a la IP del VPS
```
(Caddyfile: `online.tudominio.com { reverse_proxy 127.0.0.1:8787 }` — Caddy gestiona los
certificados solo. Sin dominio, mejor quédate con la opción A.)

Con la opción A el firewall queda cerrado salvo SSH:
`ufw allow OpenSSH && ufw enable`. Con la B, también `ufw allow 8787/tcp`.

## 5 · Backups (no los saltes)

```
sudo tee /etc/cron.d/boxshelf-backup > /dev/null <<'EOF'
30 4 * * * root tar czf /var/backups/boxshelf-online-$(date +\%a).tgz -C /opt/boxshelf-online data
EOF
```
(Guarda 7 copias rotativas, una por día de la semana. La BD es un solo JSON: también
se puede copiar a mano o a otra unidad con rsync.)

## 6 · Datos y limpieza

- `data/online.json` — todos los perfiles y amistades (un archivo JSON legible).
- `data/img/` — avatares y banners como archivos sueltos con nombre por contenido.
- Los tokens son la única llave de cada cuenta: **nunca se envían por el juego ni se
  muestran dos veces**. Para cambiar de PC, la app exporta el token a un archivo.

## API (v1)

| Ruta | Qué hace |
|---|---|
| `GET /v1/ping` | ¿está vivo? (sin sesión) |
| `POST /v1/register` {name} | crea cuenta → `{friendCode, token}` |
| `GET /v1/me` | tu perfil completo |
| `PUT /v1/me` {name, description, totalMs, playing, favorites[]} | sincroniza tu perfil |
| `POST /v1/me/avatar` · `/v1/me/banner` | imagen binaria (JPG/PNG/WebP, ≤400 KB) |
| `GET /v1/profile/<código>` | perfil de otro (con `isFriend`) |
| `GET /v1/friends` | amigos + solicitudes recibidas/enviadas |
| `POST /v1/friends` {code} | pedir amistad (mutua → amigos al instante) |
| `DELETE /v1/friends/<código>` | quitar amigo/solicitud |
| `GET /img/<archivo>` | imágenes servidas con caché inmutable |

Todas las respuestas: `{ok:true,data}` o `{ok:false,error}`. Todo exige sesión
(Bearer token) salvo `ping`, `register` y las imágenes.
