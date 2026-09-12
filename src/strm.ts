import fs from 'fs';
import path from 'path';

/**
 * Normalises a URL from a .strm file so it is safe to use in an HTTP Location
 * header: percent-encodes spaces and non-ASCII characters while leaving
 * existing percent-encoding intact. Returns null if not a valid HTTP(S) URL.
 */
export function normaliseStrmUrl(raw: string): string | null {
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) return null;
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}

/** Reads a .strm file and returns the URL it contains, or null if unreadable/invalid. */
export async function readStrmUrl(filePath: string): Promise<string | null> {
  try {
    const contents = await fs.promises.readFile(filePath, 'utf-8');
    return normaliseStrmUrl(contents.trim());
  } catch {
    return null;
  }
}

/**
 * Maps a URL path (from a stored proxy URL or an incoming request) to the
 * .strm file on disk. Guards against path traversal and maps the .mp4
 * extension Plex stores back to .strm. Returns null if outside the root or
 * no file exists.
 */
export function strmPathFromUrlPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    decoded = urlPath;
  }
  const filePath = path.resolve(root, '.' + decoded);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) return null;
  if (fs.existsSync(filePath)) return filePath;
  const strmPath = filePath.replace(/\.[^./]+$/, '.strm');
  return fs.existsSync(strmPath) ? strmPath : null;
}

const MAX_REDIRECTS = 5;
const RESOLVE_TIMEOUT_MS = 10_000;

/**
 * Follows redirects from `url` and returns the final URL.
 * The caller's User-Agent is forwarded because some services (e.g. 115) bind
 * the resolved URL to the agent that requested it; the caller then follows
 * our 302 with the same agent, so the URL stays valid.
 * Falls back to the last known URL on any network error or redirect loop.
 */
export async function resolveRedirects(
  url: string,
  userAgent: string | undefined,
): Promise<string> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        headers: userAgent ? { 'user-agent': userAgent } : undefined,
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`resolve failed at ${current}: ${(err as Error).message}`);
      return current;
    }
    // Discard the body; only the status and Location header are needed
    await response.body?.cancel();

    if (response.status < 300 || response.status >= 400) return current;
    const location = response.headers.get('location');
    if (!location) return current;
    try {
      current = new URL(location, current).href;
    } catch {
      console.warn(`invalid redirect location "${location}" from ${current}`);
      return current;
    }
  }
  console.warn(`redirect limit (${MAX_REDIRECTS}) reached, using ${current}`);
  return current;
}

/** Recursively walks a directory and returns paths to all .strm files found. */
export function walkStrm(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkStrm(full));
    } else if (entry.isFile() && entry.name.endsWith('.strm')) {
      results.push(full);
    }
  }
  return results;
}
