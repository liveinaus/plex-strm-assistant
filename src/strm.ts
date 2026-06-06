import fs from 'fs';
import path from 'path';

/** Reads a .strm file and returns the URL it contains, or null if unreadable/invalid. */
export function readStrmUrl(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content.startsWith('http://') && !content.startsWith('https://')) return null;
    return content;
  } catch {
    return null;
  }
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
