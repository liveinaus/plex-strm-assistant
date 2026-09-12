#!/usr/bin/env node
/**
 * Gateway: a reverse proxy in front of Plex Media Server. Clients connect here
 * instead of PMS; everything passes through untouched except .strm items, which
 * are handled per GATEWAY_MODE:
 *
 *   direct-play (default): the client fetches the source directly -- the part
 *     request is answered with a 302 to the source URL, and the transcode
 *     decision is forced to Direct Play. Use when the source is reachable by
 *     clients (e.g. a public CDN).
 *
 *   direct-stream: the source is relayed instead -- the decision is forced to
 *     Direct Stream and the gateway streams the part bytes through itself. Use
 *     when the source is only reachable in-cluster, so an off-network client
 *     never has to reach it.
 *
 * The Plex database is opened read-only, so it is safe while Plex runs.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import path from 'path';
import { Readable, type Duplex } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { readStrmUrl, resolveRedirects, strmPathFromUrlPath } from './strm';

const STRM_ROOT = path.resolve(process.env.STRM_ROOT ?? '/strm');
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 32500);
const PLEX_UPSTREAM = new URL(process.env.PLEX_UPSTREAM ?? 'http://plex:32400');
const UPSTREAM_IS_HTTPS = PLEX_UPSTREAM.protocol === 'https:';
const UPSTREAM_PORT = Number(PLEX_UPSTREAM.port || (UPSTREAM_IS_HTTPS ? 443 : 80));
const FOLLOW_REDIRECTS = process.env.FOLLOW_REDIRECTS === 'true';
const DIRECT_STREAM = process.env.GATEWAY_MODE === 'direct-stream';
const ANALYZE_ON_PLAY = process.env.ANALYZE_ON_PLAY === 'true';
const DB_PATH =
  process.env.DB_PATH ??
  '/plex-config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db';

const GATEWAY_TLS = process.env.GATEWAY_TLS === 'true';
const PLEX_CONFIG_DIR = path.resolve(path.dirname(DB_PATH), '../..');

// Direct-play media part URL, e.g. /library/parts/6/1751700000/file.mp4
const PART_PATH_RE = /^\/library\/parts\/(\d+)\/\d+\/file(?:\.\w+)?$/;

// Transcode decision endpoint: clients ask PMS how to play an item. For .strm
// items the query is rewritten (direct play or direct stream) before reaching PMS.
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

function decisionMetadataId(rawUrl: string): string | undefined {
  try {
    const target = new URL(rawUrl, 'http://gateway').searchParams.get('path') ?? '';
    return /^\/library\/metadata\/(\d+)$/.exec(target)?.[1];
  } catch {
    return undefined;
  }
}

function metadataIdForPart(partId: string): string | undefined {
  try {
    db ??= new DatabaseSync(DB_PATH, { readOnly: true, timeout: 5000 });
    const row = db
      .prepare(
        `SELECT mi.metadata_item_id AS id FROM media_parts mp
         JOIN media_items mi ON mp.media_item_id = mi.id
         WHERE mp.id = ?`,
      )
      .get(partId) as { id: number } | undefined;
    return row ? String(row.id) : undefined;
  } catch (err) {
    console.warn(`db lookup failed: ${(err as Error).message}`);
    db = null;
    return undefined;
  }
}

/**
 * Rewrites a transcode decision URL for a .strm item -- to Direct Play, or to
 * Direct Stream in direct-stream mode. Returns the rewritten path+query, or null
 * to pass the request through untouched.
 */
function rewriteStrmDecision(rawUrl: string, headerProduct?: string): string | null {
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

  if (DIRECT_STREAM) {
    url.searchParams.set('directPlay', '0');
    url.searchParams.set('directStream', '1');
  } else {
    url.searchParams.set('directPlay', '1');
  }
  // Client quality caps would otherwise veto direct play / force a transcode
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

  const url = await readStrmUrl(strmPath);
  if (!url) return null;

  return FOLLOW_REDIRECTS ? resolveRedirects(url, userAgent) : url;
}

function isUnanalysedStrm(metadataId: string): boolean {
  try {
    db ??= new DatabaseSync(DB_PATH, { readOnly: true, timeout: 5000 });
    const rows = db
      .prepare(
        `SELECT mp.file FROM media_parts mp
         JOIN media_items mi ON mp.media_item_id = mi.id
         WHERE mi.metadata_item_id = ? AND mp.deleted_at IS NULL AND IFNULL(mp.duration, 0) = 0`,
      )
      .all(metadataId) as { file: string }[];
    return rows.some((row) => row.file != null && strmPathForStored(row.file) !== null);
  } catch (err) {
    console.warn(`db lookup failed: ${(err as Error).message}`);
    db = null;
    return false;
  }
}

const analyzeRequested = new Set<string>();
function analyzeOnPlay(metadataId: string): void {
  if (!ANALYZE_ON_PLAY || analyzeRequested.has(metadataId) || !isUnanalysedStrm(metadataId)) return;
  analyzeRequested.add(metadataId);
  let token: string | undefined;
  try {
    // The playing user's token may not be allowed to trigger analysis.
    token = plexPreference('PlexOnlineToken');
    if (!token) throw new Error('no PlexOnlineToken in it');
  } catch (err) {
    console.warn(`analyze-on-play: cannot use Preferences.xml: ${(err as Error).message}`);
    return;
  }
  (UPSTREAM_IS_HTTPS ? https : http)
    .request(
      new URL(`/library/metadata/${metadataId}/analyze`, PLEX_UPSTREAM),
      { method: 'PUT', headers: { 'X-Plex-Token': token } },
      (res) => {
        res.resume();
        if ((res.statusCode ?? 0) >= 400) {
          console.warn(`analyze-on-play: PMS rejected metadata ${metadataId} (HTTP ${res.statusCode})`);
        }
      },
    )
    .on('error', (err) => console.warn(`analyze-on-play: cannot reach PMS: ${err.message}`))
    .end();
  console.log(`analyze  metadata ${metadataId}`);
}

const RELAY_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'cache-control',
];

async function relayPart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
): Promise<void> {
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  // We relay the upstream content-length verbatim, and
  // fetch would otherwise decompress the body while the length stayed compressed.
  const headers: Record<string, string> = { 'accept-encoding': 'identity' };
  const range = req.headers['range'];
  if (typeof range === 'string') headers.range = range;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') headers['user-agent'] = ua;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(`relay fetch failed for ${target}: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(502).end('Source unavailable');
    }
    return;
  }

  const out: Record<string, string> = {};
  for (const h of RELAY_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('error', () => res.destroy());
  body.pipe(res);
}

function isBrowserRequest(req: http.IncomingMessage): boolean {
  return !!(
    req.headers['sec-fetch-mode'] ||
    req.headers['sec-fetch-dest'] ||
    req.headers['origin']
  );
}

/** Streams a request through to PMS, optionally with a rewritten path+query. */
function proxyThrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlOverride?: string,
): void {
  const upstreamReq = (UPSTREAM_IS_HTTPS ? https : http).request(
    {
      hostname: PLEX_UPSTREAM.hostname,
      port: UPSTREAM_PORT,
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

function resolveCertPath(): string {
  const cacheDir = path.join(PLEX_CONFIG_DIR, 'Cache');
  const preferred = path.join(cacheDir, 'cert-v2.p12');
  if (fs.existsSync(preferred)) return preferred;
  const found = fs.readdirSync(cacheDir).find((f) => f.endsWith('.p12'));
  if (!found) throw new Error(`no .p12 cert found in ${cacheDir}`);
  return path.join(cacheDir, found);
}

function plexPreference(name: string): string | undefined {
  const prefs = fs.readFileSync(path.join(PLEX_CONFIG_DIR, 'Preferences.xml'), 'utf-8');
  return new RegExp(`${name}="([^"]+)"`).exec(prefs)?.[1];
}

function loadPlexTls(): { pfx: Buffer; passphrase: string } {
  const id = plexPreference('ProcessedMachineIdentifier');
  if (!id) throw new Error('ProcessedMachineIdentifier missing from Preferences.xml');
  const passphrase = crypto.createHash('sha512').update('plex' + id).digest('hex');
  const pfx = fs.readFileSync(resolveCertPath());
  tls.createSecureContext({ pfx, passphrase });
  return { pfx, passphrase };
}

const handleRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
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
          const metadataId = metadataIdForPart(partMatch[1]);
          if (metadataId) analyzeOnPlay(metadataId);
          // Browsers can't follow a cross-origin 302 (CORS).
          if (DIRECT_STREAM || isBrowserRequest(req)) {
            console.log(`relay  part ${partMatch[1]}  ->  ${target}`);
            await relayPart(req, res, target);
          } else {
            console.log(`302  part ${partMatch[1]}  ->  ${target}`);
            res.writeHead(302, { Location: target }).end();
          }
          return;
        }
      } else {
        console.warn(`401  part ${partMatch[1]}  (missing or invalid X-Plex-Token)`);
      }
    }

    if (req.method === 'GET' && urlPath === DECISION_PATH) {
      const metadataId = decisionMetadataId(req.url ?? '/');
      if (metadataId) analyzeOnPlay(metadataId);
      const productHeader = req.headers['x-plex-product'];
      const rewritten = rewriteStrmDecision(
        req.url ?? '/',
        Array.isArray(productHeader) ? productHeader[0] : productHeader,
      );
      if (rewritten) {
        console.log(
          `MDE  forcing ${DIRECT_STREAM ? 'direct stream' : 'direct play'}  ${rewritten.slice(0, 120)}`,
        );
        proxyThrough(req, res, rewritten);
        return;
      }
    }

    proxyThrough(req, res);
  } catch (err) {
    console.error(`error handling ${req.url}: ${(err as Error).message}`);
    if (!res.headersSent) res.writeHead(500).end('Internal error');
  }
};

function buildServer(): http.Server {
  if (!GATEWAY_TLS) return http.createServer(handleRequest);
  let tlsOpts: { pfx: Buffer; passphrase: string };
  try {
    tlsOpts = loadPlexTls();
  } catch (err) {
    console.error(`FATAL: cannot load Plex TLS cert: ${(err as Error).message}`);
    console.error('Fix the Plex config mount, or set GATEWAY_TLS=false to run over plain HTTP.');
    process.exit(1);
  }
  const s = https.createServer(tlsOpts, handleRequest);
  setInterval(() => {
    try {
      s.setSecureContext(loadPlexTls());
    } catch (err) {
      console.warn(`gateway: TLS cert reload failed: ${(err as Error).message}`);
    }
  }, 21_600_000).unref();
  return s;
}

const server = buildServer();

const tunnels = new Set<Duplex>();

// Plex clients use websockets (/:/websockets) -- tunnel upgrades to PMS raw
server.on('upgrade', (req, socket, head) => {
  tunnels.add(socket);
  socket.on('close', () => tunnels.delete(socket));
  const relay = (): void => {
    let rawHead = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = name.toLowerCase() === 'host' ? PLEX_UPSTREAM.host : req.rawHeaders[i + 1];
      rawHead += `${name}: ${value}\r\n`;
    }
    upstream.write(rawHead + '\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  };
  const upstream = UPSTREAM_IS_HTTPS
    ? tls.connect(UPSTREAM_PORT, PLEX_UPSTREAM.hostname, { servername: PLEX_UPSTREAM.hostname }, relay)
    : net.connect(UPSTREAM_PORT, PLEX_UPSTREAM.hostname, relay);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

const scheme = GATEWAY_TLS ? 'https' : 'http';
server.listen(GATEWAY_PORT, () =>
  console.log(
    `strm-gateway on ${scheme}://:${GATEWAY_PORT}  ->  ${PLEX_UPSTREAM.href}  [${DIRECT_STREAM ? 'direct-stream' : 'direct-play'}]` +
      (FOLLOW_REDIRECTS ? '  (following upstream redirects)' : '') +
      (ANALYZE_ON_PLAY ? '  (analyze on play)' : ''),
  ),
);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => {
      db?.close();
      process.exit(0);
    });
    server.closeAllConnections();
    for (const socket of tunnels) socket.destroy();
  });
}
