import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = resolve(ROOT, '..');
const ALLOWED_ROOTS = new Set(['manifest.json', 'src', 'popup', 'player']);
const PRIVATE_NAME_PATTERN = /^(?:\.env.*|.*(?:credential|cookie|secret|password|token).*)$/i;

export function assertAllowed(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  const root = segments[0];
  if (!ALLOWED_ROOTS.has(root) || segments.some((segment) => PRIVATE_NAME_PATTERN.test(segment)) || /(?:^|[\\/])(?:data|_run_logs)(?:[\\/]|$)/i.test(relativePath)) {
    throw new Error(`private or unexpected build input: ${relativePath}`);
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name); const crc = crc32(data);
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26); n.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42); n.copy(central, 46);
    centrals.push(central); offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function collectFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(full, rel) : [rel];
  });
}

export function buildExtension({ output = join(PROJECT_ROOT, 'dist') } = {}) {
  const dist = resolve(output); const extension = join(dist, 'edge-extension');
  rmSync(extension, { recursive: true, force: true }); mkdirSync(extension, { recursive: true });
  const mappings = [
    ['manifest.json', 'manifest.json'], ['src', 'src'], ['popup', 'popup'], ['player', 'player'],
    ['vendor/hls.min.js', 'player/vendor/hls.min.js'], ['vendor/LICENSE', 'player/vendor/LICENSE'],
  ];
  for (const [source, target] of mappings) {
    const sourcePath = join(ROOT, source);
    if (existsSync(sourcePath) && !source.includes('/')) {
      if (source === 'src' || source === 'popup' || source === 'player') {
        for (const file of collectFiles(sourcePath)) {
          const rel = `${source}/${file}`; assertAllowed(rel); const dest = join(extension, rel); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, readFileSync(join(sourcePath, file)));
        }
      } else { assertAllowed(source); writeFileSync(join(extension, target), readFileSync(sourcePath)); }
    } else if (existsSync(sourcePath)) {
      const dest = join(extension, target); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, readFileSync(sourcePath));
    }
  }
  const files = collectFiles(extension).sort();
  files.forEach(assertAllowed);
  const entries = files.map((file) => [file, readFileSync(join(extension, file))]);
  mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, 'fudan-icourse-live-edge.zip'), zipStore(entries));
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = buildExtension();
  console.log(`Built ${files.length} files in dist/edge-extension and fudan-icourse-live-edge.zip`);
}
