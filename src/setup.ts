#!/usr/bin/env node
/**
 * One-time setup: installs SQLite triggers that automatically convert .strm
 * file paths to proxy URLs whenever Plex inserts or updates a media_parts row.
 *
 * After this runs, no further patching is needed:
 *   - New .strm files: Plex scans → INSERT trigger → proxy URL stored
 *   - Rescans:         Plex reverts path → UPDATE trigger → proxy URL restored
 *   - URL changes in .strm files: proxy reads the file fresh on every play request
 *
 * URL encoding is intentionally left to Plex's HTTP client. Storing the raw
 * path (spaces, non-ASCII, etc.) is correct -- HTTP clients encode URLs before
 * sending them, and the proxy decodes whatever it receives with decodeURIComponent.
 * Encoding in a SQLite trigger would require custom functions and still couldn't
 * handle non-ASCII characters.
 */
import { Command } from 'commander';
import { DEFAULT_DB_PATH, openDb } from './db';

const program = new Command();

program
  .name('plex-strm-setup')
  .description('Installs auto-patch DB triggers for .strm → proxy URL conversion')
  .option('-d, --db <path>', 'Path to Plex library database', DEFAULT_DB_PATH)
  .option('--container-prefix <path>', 'Container path where strm dir is mounted', '/media/strm')
  .option('--proxy-base <url>', 'Base URL of the strm-proxy service', 'http://strm-proxy:3000')
  .option('--dry-run', 'Print trigger SQL without writing to the database')
  .parse(process.argv);

const opts = program.opts<{
  db: string;
  containerPrefix: string;
  proxyBase: string;
  dryRun: boolean;
}>();

// Strip the container prefix, swap .strm → .mp4, and prepend the proxy base.
// Plex ignores HTTP URLs ending in .strm (removed native support), so we
// present the path as .mp4. The proxy maps it back to the .strm file on disk.
function proxyUrlExpr(pathExpr: string): string {
  const base = opts.proxyBase.replace(/\/$/, '');
  const prefix = opts.containerPrefix;
  // substr strips the container prefix; the REPLACE swaps the extension.
  return `'${base}' || REPLACE(substr(${pathExpr}, length('${prefix}') + 1), '.strm', '.mp4')`;
}

const likePattern = `${opts.containerPrefix}/%.strm`;

// Stream info block injected into both triggers.
// Inserts placeholder H.264/AAC stream entries so Plex's MDE has codec data
// and chooses direct play instead of transcoding -- only for these items.
const streamInfoSql = `
  DELETE FROM media_streams WHERE media_part_id = NEW.id;
  INSERT INTO media_streams
    (stream_type_id, media_item_id, media_part_id, codec, "index", created_at, updated_at)
  VALUES (1, NEW.media_item_id, NEW.id, 'h264', 0, strftime('%s','now'), strftime('%s','now'));
  INSERT INTO media_streams
    (stream_type_id, media_item_id, media_part_id, codec, channels, "index", created_at, updated_at)
  VALUES (2, NEW.media_item_id, NEW.id, 'aac', 2, 1, strftime('%s','now'), strftime('%s','now'));
  UPDATE media_items SET video_codec = 'h264', audio_codec = 'aac', container = 'mp4'
  WHERE id = NEW.media_item_id;`;

const insertTriggerSql = `
CREATE TRIGGER IF NOT EXISTS strm_auto_patch_insert
AFTER INSERT ON media_parts
WHEN NEW.file LIKE '${likePattern}'
BEGIN
  UPDATE media_parts
  SET file = ${proxyUrlExpr('NEW.file')}
  WHERE id = NEW.id;
  ${streamInfoSql}
END`;

const updateTriggerSql = `
CREATE TRIGGER IF NOT EXISTS strm_auto_patch_update
AFTER UPDATE OF file ON media_parts
WHEN NEW.file LIKE '${likePattern}'
BEGIN
  UPDATE media_parts
  SET file = ${proxyUrlExpr('NEW.file')}
  WHERE id = NEW.id;
  ${streamInfoSql}
END`;

const patchExistingSql = `
UPDATE media_parts
SET file = ${proxyUrlExpr('file')}
WHERE file LIKE '${likePattern}'`;

if (opts.dryRun) {
  console.log('-- INSERT trigger\n' + insertTriggerSql);
  console.log('\n-- UPDATE trigger\n' + updateTriggerSql);
  console.log('\n-- Patch existing rows\n' + patchExistingSql);
  process.exit(0);
}

const db = openDb(opts.db);

// Drop old triggers so they are replaced with the updated SQL
db.exec(`DROP TRIGGER IF EXISTS strm_proxy_guard`);
db.exec(`DROP TRIGGER IF EXISTS strm_auto_patch_insert`);
db.exec(`DROP TRIGGER IF EXISTS strm_auto_patch_update`);

db.exec(insertTriggerSql);
console.log('Installed trigger: strm_auto_patch_insert');

db.exec(updateTriggerSql);
console.log('Installed trigger: strm_auto_patch_update');

const result = db.prepare(patchExistingSql).run();
console.log(`Patched ${result.changes} existing .strm row(s) to proxy URLs.`);

// Seed stream info for rows already carrying a proxy URL (not matched by likePattern above)
const seedStreamsSql = `
  INSERT OR IGNORE INTO media_streams
    (stream_type_id, media_item_id, media_part_id, codec, "index", created_at, updated_at)
  SELECT 1, mp.media_item_id, mp.id, 'h264', 0, strftime('%s','now'), strftime('%s','now')
  FROM media_parts mp
  WHERE mp.file LIKE '${opts.proxyBase.replace(/\/$/, '')}%'
    AND mp.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM media_streams ms
      WHERE ms.media_part_id = mp.id AND ms.stream_type_id = 1)`;

const seedAudioSql = `
  INSERT OR IGNORE INTO media_streams
    (stream_type_id, media_item_id, media_part_id, codec, channels, "index", created_at, updated_at)
  SELECT 2, mp.media_item_id, mp.id, 'aac', 2, 1, strftime('%s','now'), strftime('%s','now')
  FROM media_parts mp
  WHERE mp.file LIKE '${opts.proxyBase.replace(/\/$/, '')}%'
    AND mp.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM media_streams ms
      WHERE ms.media_part_id = mp.id AND ms.stream_type_id = 2)`;

const seedMediaItemsSql = `
  UPDATE media_items SET video_codec = 'h264', audio_codec = 'aac', container = 'mp4'
  WHERE id IN (
    SELECT DISTINCT media_item_id FROM media_parts
    WHERE file LIKE '${opts.proxyBase.replace(/\/$/, '')}%' AND deleted_at IS NULL)`;

db.exec(seedStreamsSql);
db.exec(seedAudioSql);
const itemsUpdated = db.prepare(seedMediaItemsSql).run();
if (itemsUpdated.changes > 0) {
  console.log(`Seeded stream info (h264/aac) for ${itemsUpdated.changes} existing proxy item(s).`);
}

console.log('\nSetup complete. Plex rescans and new .strm files are now handled automatically.');
