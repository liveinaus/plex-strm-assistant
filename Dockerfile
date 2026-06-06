# Stage 1: build TypeScript
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: runtime image
FROM node:22-alpine
WORKDIR /app

# Production deps only (just 'commander' -- no native sqlite3, Node built-in is used)
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Plex DB directory mounted at /plex-db, strm files mounted at /strm
ENV DB_PATH="/plex-config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db"
ENV CONTAINER_PREFIX=/media/strm
ENV STRM_PROXY_HOST=strm-proxy
ENV STRM_ROOT=/strm
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
