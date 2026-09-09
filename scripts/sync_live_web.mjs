import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = new Map([
  ["live_player/web/vendor/hls.min.js", "frontend/live/vendor/hls.min.js"],
  ["live_player/web/vendor/LICENSE", "frontend/live/vendor/LICENSE"],
]);

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function checkSync() {
  const drift = [];
  for (const [source, target] of FILES) {
    const sourcePath = join(ROOT, source);
    const targetPath = join(ROOT, target);
    if (!existsSync(targetPath) || digest(sourcePath) !== digest(targetPath)) drift.push(target);
  }
  return drift;
}

export function sync({ write = false } = {}) {
  const drift = checkSync();
  if (write) {
    for (const [source, target] of FILES) copyFileSync(join(ROOT, source), join(ROOT, target));
    return checkSync();
  }
  return drift;
}

if (process.argv.includes("--write")) {
  const drift = sync({ write: true });
  if (drift.length) throw new Error(`live asset drift: ${drift.join(", ")}`);
  console.log("Live assets synchronized.");
} else if (process.argv.includes("--check")) {
  const drift = sync();
  if (drift.length) {
    console.error(`live asset drift: ${drift.join(", ")}`);
    process.exitCode = 1;
  } else console.log("Live assets are synchronized.");
}
