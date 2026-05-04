# Nginx Config

`emmelrogue.emmel.tv.conf` — Nginx Vhost für emmelrogue.emmel.tv.

## Deploy

Die Live-Datei liegt unter `/etc/nginx/sites-enabled/emmelrogue.emmel.tv`. Aktuell **kein Symlink** — die Datei in diesem Repo ist eine versionierte Kopie. Bei Änderungen entweder:

- **Manuell syncen:** `cp nginx/emmelrogue.emmel.tv.conf /etc/nginx/sites-enabled/emmelrogue.emmel.tv && nginx -t && nginx -s reload`
- **Symlink setzen** (einmalig, dann sind beide identisch): `ln -sf /var/www/emmelrogue.emmel.tv/nginx/emmelrogue.emmel.tv.conf /etc/nginx/sites-enabled/emmelrogue.emmel.tv && nginx -s reload`

## Wichtige Stellen

- `/community/`, `/lobby/`, `/overlay/`, `/api/`, `/socket.io/` — public, kein Auth (Zuschauer/OBS).
- `/images/`, `/sounds/`, `/assets/`, `/fonts/`, `/locales/` — public, sonst sehen nicht-eingeloggte User keine Sprites/Sounds.
- `location /` — Auth-Wall via `emmel-auth.conf` (Game selbst, Admin).
