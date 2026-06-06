#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
import path from 'path';

const STRM_ROOT = path.resolve(process.env.STRM_ROOT ?? '/strm');
const PORT = Number(process.env.PORT ?? 3000);

http
  .createServer((req, res) => {
    // Strip query string and fragment, decode percent-encoding.
    // Avoid new URL() -- it can reject literal spaces sent by some HTTP clients.
    const rawPath = (req.url ?? '/').split(/[?#]/)[0];
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      decodedPath = rawPath;
    }

    let filePath = path.resolve(STRM_ROOT, '.' + decodedPath);

    if (!filePath.startsWith(STRM_ROOT + path.sep) && filePath !== STRM_ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    // Plex stores the proxy URL with a .mp4 extension (so it treats it as video).
    // Map it back to the real .strm file on disk.
    if (!fs.existsSync(filePath)) {
      const strmPath = filePath.replace(/\.[^./]+$/, '.strm');
      if (fs.existsSync(strmPath)) {
        filePath = strmPath;
      }
    }

    try {
      const url = fs.readFileSync(filePath, 'utf-8').trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        res.writeHead(422).end('Not an HTTP URL');
        return;
      }
      console.log(`302  ${decodedPath}  ->  ${url}`);
      res.writeHead(302, { Location: url }).end();
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(PORT, () => console.log(`strm-proxy on :${PORT}  root: ${STRM_ROOT}`));
