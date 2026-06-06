import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';

export type StrmPart = {
  id: number;
  file: string;
  size: number | null;
  mediaItemId: number;
  extraData: string | null;
  strmSource: string | null;
};

export type UpdateOutcome = {
  urlUpdated: boolean; // file column changed
  sourceSeeded: boolean; // strm_source added to extra_data for the first time
};

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Plex/Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db',
);

export function openDb(dbPath = DEFAULT_DB_PATH): DatabaseSync {
  // timeout: wait up to 5 s if Plex holds a brief write lock (DB is in WAL mode so reads never block us)
  return new DatabaseSync(dbPath, { timeout: 5000 });
}

/**
 * Finds the media_parts row for a given .strm file.
 * Tries three lookups in order:
 *   1. file = containerPath          (never patched yet)
 *   2. extra_data has strm_source    (patched by this tool)
 *   3. file = urlHint                (patched before strm_source tracking was added)
 */
export function findPartByContainerPath(
  db: DatabaseSync,
  containerPath: string,
  urlHints: string[] = [],
): StrmPart | null {
  const select = `
    SELECT id, file, size, media_item_id AS mediaItemId, extra_data AS extraData
    FROM media_parts
    WHERE deleted_at IS NULL AND `;

  // 1. File is still the .strm container path (never patched)
  const byFile = db.prepare(select + 'file = ?').get(containerPath) as RawPart | undefined;
  if (byFile) return toStrmPart(byFile);

  // 2. Previously patched by this tool -- strm_source recorded in extra_data
  // JSON pattern: {"strm_source":"/the/path"} -- container paths have no " so safe
  const pattern = `%"strm_source":${JSON.stringify(containerPath)}%`;
  const bySource = db.prepare(select + 'extra_data LIKE ?').get(pattern) as RawPart | undefined;
  if (bySource) return toStrmPart(bySource);

  // 3. Patched before strm_source tracking -- try matching by stored URL
  for (const hint of urlHints) {
    const byUrl = db.prepare(select + 'file = ?').get(hint) as RawPart | undefined;
    if (byUrl) return toStrmPart(byUrl);
  }

  return null;
}

export function updatePartFile(
  db: DatabaseSync,
  part: StrmPart,
  containerPath: string,
  url: string,
  dryRun: boolean,
): UpdateOutcome {
  // strmSource already set means this was patched before -- keep the original path.
  const sourceToStore = part.strmSource ?? containerPath;
  const newExtraData = injectStrmSource(part.extraData, sourceToStore);

  const urlChanged = part.file !== url;
  const sourceSeeded = part.strmSource === null;

  if (!urlChanged && !sourceSeeded) {
    return { urlUpdated: false, sourceSeeded: false };
  }

  if (!dryRun) {
    db.prepare(
      `UPDATE media_parts
       SET file = ?, extra_data = ?, updated_at = strftime('%s','now')
       WHERE id = ?`,
    ).run(url, newExtraData, part.id);
  }

  return { urlUpdated: urlChanged, sourceSeeded };
}

// -- types & helpers --

type RawPart = Omit<StrmPart, 'strmSource'> & { extraData: string | null };

function toStrmPart(raw: RawPart): StrmPart {
  return { ...raw, strmSource: parseStrmSource(raw.extraData) };
}

function parseStrmSource(extraData: string | null): string | null {
  if (!extraData) return null;
  try {
    const obj = JSON.parse(extraData) as Record<string, unknown>;
    const val = obj['strm_source'];
    return typeof val === 'string' ? val : null;
  } catch {
    return null;
  }
}

function injectStrmSource(extraData: string | null, strmPath: string): string {
  let obj: Record<string, unknown> = {};
  if (extraData) {
    try {
      obj = JSON.parse(extraData) as Record<string, unknown>;
    } catch {
      obj = { _raw: extraData };
    }
  }
  obj['strm_source'] = strmPath;
  return JSON.stringify(obj);
}

/**
 * Installs a BEFORE UPDATE trigger that prevents Plex rescans from reverting
 * proxy URLs back to .strm file paths.
 *
 * When Plex rescans and tries:
 *   UPDATE media_parts SET file = '/media/strm/...' WHERE id = ?
 * and the current value is our proxy URL, the trigger calls RAISE(IGNORE).
 * SQLite silently skips the update; Plex gets a success return with 0 rows
 * affected and carries on -- no errors, no crash, proxy URL stays intact.
 */
export function installGuardTrigger(db: DatabaseSync): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS strm_proxy_guard
    BEFORE UPDATE OF file ON media_parts
    WHEN NEW.file LIKE '%.strm' AND OLD.file LIKE 'http%strm-proxy%'
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
}

export function guardTriggerExists(db: DatabaseSync): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'strm_proxy_guard'`)
    .get();
  return row != null;
}

export { DEFAULT_DB_PATH };
