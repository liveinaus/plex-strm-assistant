#!/usr/bin/env node
import http from 'http';
import path from 'path';
import { readStrmUrl, resolveRedirects, strmPathFromUrlPath } from './strm';

const STRM_ROOT = path.resolve(process.env.STRM_ROOT ?? '/strm');
const PORT = Number(process.env.PORT ?? 3000);
// Follow the source URL's redirect chain server-side and hand Plex the final
// URL. Needed for services where the .strm URL is a redirector, e.g. 115 Drive.
const FOLLOW_REDIRECTS = process.env.FOLLOW_REDIRECTS === 'true';

const server = http.createServer(async (req, res) => {
  try {
    // Strip query string and fragment. Avoid new URL() -- it can reject
    // literal spaces sent by some HTTP clients.
    const rawPath = (req.url ?? '/').split(/[?#]/)[0];

    const filePath = strmPathFromUrlPath(STRM_ROOT, rawPath);
    if (!filePath) {
      res.writeHead(404).end('Not found');
      return;
    }

    // readStrmUrl normalises the URL -- raw spaces or non-ASCII characters
    // in the Location header are rejected by Node and by upstream servers
    let url = await readStrmUrl(filePath);
    if (!url) {
      res.writeHead(422).end('Not a valid HTTP URL');
      return;
    }

    if (FOLLOW_REDIRECTS) {
      url = await resolveRedirects(url, req.headers['user-agent']);
    }

    console.log(`302  ${rawPath}  ->  ${url}`);
    res.writeHead(302, { Location: url }).end();
  } catch (err) {
    console.error(`error handling ${req.url}: ${(err as Error).message}`);
    if (!res.headersSent) res.writeHead(500).end('Internal error');
  }
});

server.listen(PORT, () =>
  console.log(
    `strm-proxy on :${PORT}  root: ${STRM_ROOT}` +
      (FOLLOW_REDIRECTS ? '  (following upstream redirects)' : ''),
  ),
);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
