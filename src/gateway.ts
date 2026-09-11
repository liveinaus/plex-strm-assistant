#!/usr/bin/env node
/**
 * Gateway mode: a reverse proxy that sits in front of Plex Media Server so
 * direct-play traffic for .strm items goes straight from the source (e.g. a
 * 115 CDN) to the client, instead of source -> PMS -> client.
 *
 * Clients connect to this gateway instead of PMS. Every request is passed
 * through to PMS untouched, except direct-play media part requests
 * (/library/parts/{id}/{ts}/file.ext) whose part resolves to a .strm file:
 * those are answered with a 302 to the final source URL, which Plex clients
 * follow. Transcoded playback is unaffected and still flows through PMS.
 *
 * The Plex database is opened read-only, so it is safe while Plex runs.
 */
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { normaliseStrmUrl, resolveRedirects, strmPathFromUrlPath } from './strm';

const STRM_ROOT = path.resolve(process.env.STRM_ROOT ?? '/strm');
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 32500);
const PLEX_UPSTREAM = new URL(process.env.PLEX_UPSTREAM ?? 'http://plex:32400');
const FOLLOW_REDIRECTS = process.env.FOLLOW_REDIRECTS === 'true';
const DB_PATH =
  process.env.DB_PATH ??
  '/plex-config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db';

// Direct-play media part URL, e.g. /library/parts/6/1751700000/file.mp4
const PART_PATH_RE = /^\/library\/parts\/(\d+)\/\d+\/file(?:\.\w+)?$/;

// Transcode decision endpoint: clients ask PMS how to play an item. For .strm
// items the query is rewritten to force direct play before reaching PMS.
const DECISION_PATH = '/video/:/transcode/universal/decision';

let db: DatabaseSync | null = null;

/** Looks up the stored file column for a media part. Returns null on any failure. */
function lookupPartFile(partId: string): string | null {
  try {
    db ??= new DatabaseSync(DB_PATH, { readOnly: true, timeout: 5000 });
    const row = db.prepare('SELECT file FROM media_parts WHERE id = ?').get(partId) as
      | { file: string }
      | undefined;
    return row?.file ?? null;
  } catch (err) {
    console.warn(`db lookup failed: ${(err as Error).message}`);
    db = null; // reopen on next request; the DB may not exist yet on first run
    return null;
  }
}

// Set to 'false' to skip token validation on media part redirects (LAN-only setups)
const VALIDATE_TOKEN = process.env.GATEWAY_VALIDATE_TOKEN !== 'false';
const TOKEN_CACHE_TTL_MS = 5 * 60_000;
// token -> cache expiry (epoch ms); only valid tokens are cached
const tokenCache = new Map<string, number>();

/** Extracts the Plex token from the query string or headers. */
function tokenFromRequest(req: http.IncomingMessage): string | null {
  try {
    const fromQuery = new URL(req.url ?? '/', 'http://gateway').searchParams.get('X-Plex-Token');
    if (fromQuery) return fromQuery;
  } catch {
    // fall through to the header
  }
  const header = req.headers['x-plex-token'];
  return (Array.isArray(header) ? header[0] : header) ?? null;
}

/**
 * True when PMS accepts the token. Valid tokens are cached briefly so play
 * requests do not hit PMS on every seek. Fails closed: an unreachable PMS or
 * invalid token means no redirect and the request falls through to Plex.
 */
async function isValidToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  const cachedUntil = tokenCache.get(token);
  if (cachedUntil && cachedUntil > Date.now()) return true;
  try {
    const response = await fetch(
      new URL(`/?X-Plex-Token=${encodeURIComponent(token)}`, PLEX_UPSTREAM),
      { signal: AbortSignal.timeout(5000) },
    );
    await response.body?.cancel();
    if (!response.ok) return false;
    // Bound the cache so unbounded token spam cannot grow it forever
    if (tokenCache.size > 1000) tokenCache.clear();
    tokenCache.set(token, Date.now() + TOKEN_CACHE_TTL_MS);
    return true;
  } catch (err) {
    console.warn(`token validation failed: ${(err as Error).message}`);
    return false;
  }
}

/** Maps a stored proxy URL to its .strm file on disk, or null if it is not one. */
function strmPathForStored(stored: string): string | null {
  if (!stored.startsWith('http')) return null;
  let urlPath: string;
  try {
    urlPath = new URL(stored).pathname;
  } catch {
    return null;
  }
  return strmPathFromUrlPath(STRM_ROOT, urlPath);
}

/** True when any media part of the metadata item resolves to a .strm file. */
function metadataHasStrmPart(metadataId: string): boolean {
  try {
    db ??= new DatabaseSync(DB_PATH, { readOnly: true, timeout: 5000 });
    const rows = db
      .prepare(
        `SELECT mp.file FROM media_parts mp
         JOIN media_items mi ON mp.media_item_id = mi.id
         WHERE mi.metadata_item_id = ? AND mp.deleted_at IS NULL`,
      )
      .all(metadataId) as { file: string }[];
    return rows.some((row) => row.file != null && strmPathForStored(row.file) !== null);
  } catch (err) {
    console.warn(`db lookup failed: ${(err as Error).message}`);
    db = null;
    return false;
  }
}

/**
 * Rewrites a transcode decision URL to force direct play when the item being
 * decided is a .strm. Returns the rewritten path+query, or null to pass the
 * request through untouched.
 */
function forceDirectPlayDecision(rawUrl: string, headerProduct?: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://gateway');
  } catch {
    return null;
  }
  // Browsers cannot fetch cross-origin media (CORS), so leave web clients
  // untouched; they fall back to Direct Stream through PMS instead
  const product = url.searchParams.get('X-Plex-Product') ?? headerProduct ?? '';
  if (product === 'Plex Web') return null;

  const metadataMatch = (url.searchParams.get('path') ?? '').match(/^\/library\/metadata\/(\d+)$/);
  if (!metadataMatch || !metadataHasStrmPart(metadataMatch[1])) return null;

  url.searchParams.set('directPlay', '1');
  // Client quality caps would otherwise veto direct play
  url.searchParams.delete('videoBitrate');
  url.searchParams.delete('maxVideoBitrate');
  // Burned-in subtitles force a transcode; let Plex deliver them separately
  if (url.searchParams.get('subtitles') === 'burn') {
    url.searchParams.set('subtitles', 'auto');
  }
  return url.pathname + url.search;
}

/**
 * Resolves a media part to the final source URL if it is a .strm item.
 * Returns null when the part is a regular file or anything fails, in which
 * case the request falls through to PMS.
 */
async function directUrlForPart(
  partId: string,
  userAgent: string | undefined,
): Promise<string | null> {
  const stored = lookupPartFile(partId);
  if (!stored) return null;

  const strmPath = strmPathForStored(stored);
  if (!strmPath) return null;

  let url: string | null;
  try {
    url = normaliseStrmUrl(fs.readFileSync(strmPath, 'utf-8').trim());
  } catch {
    return null;
  }
  if (!url) return null;

  return FOLLOW_REDIRECTS ? resolveRedirects(url, userAgent) : url;
}

/** Streams a request through to PMS, optionally with a rewritten path+query. */
function proxyThrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlOverride?: string,
): void {
  const upstreamReq = http.request(
    {
      hostname: PLEX_UPSTREAM.hostname,
      port: PLEX_UPSTREAM.port,
      path: urlOverride ?? req.url ?? '/',
      method: req.method,
      headers: { ...req.headers, host: PLEX_UPSTREAM.host },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on('error', (err) => {
    console.error(`upstream error for ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(502).end('Plex upstream unavailable');
  });
  req.pipe(upstreamReq);
}

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = (req.url ?? '/').split(/[?#]/)[0];
    const partMatch =
      req.method === 'GET' || req.method === 'HEAD' ? urlPath.match(PART_PATH_RE) : null;

    if (partMatch) {
      // Validate before resolving: unauthenticated requests must not trigger
      // source URL resolution, and fall through to Plex's own auth (401)
      if (!VALIDATE_TOKEN || (await isValidToken(tokenFromRequest(req)))) {
        const target = await directUrlForPart(partMatch[1], req.headers['user-agent']);
        if (target) {
          console.log(`302  part ${partMatch[1]}  ->  ${target}`);
          res.writeHead(302, { Location: target }).end();
          return;
        }
      } else {
        console.warn(`401  part ${partMatch[1]}  (missing or invalid X-Plex-Token)`);
      }
    }

    if (req.method === 'GET' && urlPath === DECISION_PATH) {
      const productHeader = req.headers['x-plex-product'];
      const rewritten = forceDirectPlayDecision(
        req.url ?? '/',
        Array.isArray(productHeader) ? productHeader[0] : productHeader,
      );
      if (rewritten) {
        console.log(`MDE  forcing direct play  ${rewritten.slice(0, 120)}`);
        proxyThrough(req, res, rewritten);
        return;
      }
    }

    proxyThrough(req, res);
  } catch (err) {
    console.error(`error handling ${req.url}: ${(err as Error).message}`);
    if (!res.headersSent) res.writeHead(500).end('Internal error');
  }
});

// Plex clients use websockets (/:/websockets) -- tunnel upgrades to PMS raw
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(Number(PLEX_UPSTREAM.port || 80), PLEX_UPSTREAM.hostname, () => {
    let rawHead = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = name.toLowerCase() === 'host' ? PLEX_UPSTREAM.host : req.rawHeaders[i + 1];
      rawHead += `${name}: ${value}\r\n`;
    }
    upstream.write(rawHead + '\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(GATEWAY_PORT, () =>
  console.log(
    `strm-gateway on :${GATEWAY_PORT}  ->  ${PLEX_UPSTREAM.href}` +
      (FOLLOW_REDIRECTS ? '  (following upstream redirects)' : ''),
  ),
);
