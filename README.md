# plex-strm-assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker Hub](https://img.shields.io/docker/pulls/liveinaus/plex-strm-assistant)](https://hub.docker.com/r/liveinaus/plex-strm-assistant)

Enables `.strm` file playback in Plex. Plex dropped native `.strm` support, so this tool bridges the gap with two components:

- **strm-proxy** — a lightweight HTTP server that reads a `.strm` file and returns a `302` redirect to the URL inside it.
- **SQLite triggers** — installed once into the Plex database. Whenever Plex scans a `.strm` file, the trigger rewrites the stored path to a proxy URL (`http://strm-proxy:3000/...`). Rescans are handled automatically — no re-patching needed.

---

## Prerequisites

- Docker
- A Plex Media Server (Dockerised or native) that has completed initial setup at least once

---

## `.strm` file format

Each `.strm` file contains a single HTTP/HTTPS URL:

```text
https://example.com/path/to/video.mp4
```

Organise them the same way you would real media files:

```text
strm/
  Movies/
    Big Buck Bunny (2008)/
      Big Buck Bunny (2008).strm
  TV Shows/
    Some Show/
      Season 01/
        Some Show - S01E01.strm
```

---

## Setup

### 1. Stop Plex

> **Important:** Plex must be stopped during trigger installation. Writing to the Plex database while Plex is running risks database corruption.

### 2. Run the proxy container

**Docker run:**

```bash
docker run -d \
  --name strm-proxy \
  -p 3000:3000 \
  -v /path/to/your/strm:/strm:ro \
  -v /path/to/plex/config:/plex-config \
  -e STRM_PROXY_HOST=<hostname-or-ip-reachable-by-plex-clients> \
  liveinaus/plex-strm-assistant
```

**Docker Compose:**

```yaml
services:
  strm-proxy:
    image: liveinaus/plex-strm-assistant
    container_name: strm-proxy
    ports:
      - '3000:3000'
    environment:
      - STRM_PROXY_HOST=<hostname-or-ip-reachable-by-plex-clients>
    volumes:
      - /path/to/your/strm:/strm:ro
      - /path/to/plex/config:/plex-config
    restart: unless-stopped
```

- `/path/to/plex/config` — the root of your Plex config directory (the one that contains `Library/Application Support/...`)
- `STRM_PROXY_HOST` — must be an address reachable by both the Plex server and Plex clients, typically the Docker host IP or a LAN hostname

Wait for the log line:

```text
strm-proxy | Setup complete. Plex rescans and new .strm files are now handled automatically.
strm-proxy | strm-proxy on :3000  root: /strm
```

### 3. Start Plex

Start Plex again, add a library pointing at your `.strm` folder, and scan. Files will be playable immediately.

---

## Multiple `.strm` directories

If your `.strm` files live in separate directories, mount each one as a subdirectory under `/strm`. The trigger matches everything under the prefix recursively so no code changes are needed.

```bash
docker run -d \
  --name strm-proxy \
  -p 3000:3000 \
  -v /path/to/movies-strm:/strm/Movies:ro \
  -v /path/to/tv-strm:/strm/TV:ro \
  -v /path/to/plex/config:/plex-config \
  -e STRM_PROXY_HOST=<hostname-or-ip> \
  liveinaus/plex-strm-assistant
```

Mount the same directories into Plex under `/media/strm/Movies` and `/media/strm/TV` respectively so the paths align.

---

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Port the proxy listens on (also used to build stored proxy URLs) |
| `STRM_PROXY_HOST` | `strm-proxy` | Hostname used in proxy URLs stored in the Plex DB |
| `STRM_ROOT` | `/strm` | Mount point for `.strm` files inside the proxy container |
| `CONTAINER_PREFIX` | `/media/strm` | Path where `.strm` files are mounted inside the Plex container |
| `DB_PATH` | *(see Dockerfile)* | Full path to `com.plexapp.plugins.library.db` inside the proxy container |
| `SKIP_SETUP` | `false` | Set to `true` to skip trigger installation on container start (safe while Plex is running) |

---

## Restarting the proxy

The proxy can be restarted at any time without stopping Plex by setting `SKIP_SETUP=true`:

```bash
docker run ... -e SKIP_SETUP=true liveinaus/plex-strm-assistant
```

---

## Database recovery

If Plex reports *"database disk image is malformed"*:

```bash
# Stop Plex first
DB="/path/to/plex/config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db"
sqlite3 "$DB" ".recover" | sqlite3 "${DB}.fresh"
mv "$DB" "${DB}.dead" && mv "${DB}.fresh" "$DB"
rm -f "${DB}-wal" "${DB}-shm"
# Start Plex again
```

---

## Roadmap

- [x] HTTP proxy that resolves `.strm` files to stream URLs via `302` redirect
- [x] SQLite triggers to survive Plex rescans automatically
- [x] Inject H.264/AAC codec metadata to force direct play (no transcoding)
- [x] Docker container — installs triggers on start, then runs proxy
- [x] Multi-platform image (amd64, arm64)
- [x] Safe first-run handling — waits for Plex DB, `SKIP_SETUP` flag for restarts
- [ ] Disable unnecessary Plex processing on `.strm` items (analysis, thumbnail generation, etc.)
- [ ] Follow 302 redirects from the source URL before returning to Plex — enables compatibility with services that require a redirect step (e.g. 115 Drive)

---

## Support

If this project saves you some time, a GitHub star would be appreciated!
[github.com/liveinaus/plex-strm-assistant](https://github.com/liveinaus/plex-strm-assistant)

---

## Disclaimer

This project is an independent, community-built tool and is not affiliated with, endorsed by, or supported by Plex Inc. in any way.

Using this tool involves writing directly to the Plex SQLite database and modifying internal data structures. This may conflict with Plex's Terms of Service or void any support entitlements. Use it at your own risk.

The author accepts no responsibility for data loss, database corruption, account suspension, or any other consequence arising from the use of this software.

---

## Licence

MIT — free to use and modify. You must retain the copyright notice and a link back to this repository in any copies or derivatives. See [LICENSE](LICENSE) for the full text.
