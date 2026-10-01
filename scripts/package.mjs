// Builds a key-free copy of the extension and zips it for the Chrome Web Store:
// release/clownmeter-<version>.zip. Leaves your personal dist/ build untouched.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "release", "build");

execFileSync(process.execPath, [path.join(root, "scripts/build.mjs"), "--no-keys", `--out=${buildDir}`], { stdio: "inherit" });

const files = readdirSync(buildDir, { recursive: true })
  .map(String)
  .filter((file) => statSync(path.join(buildDir, file)).isFile())
  .sort();

// Belt and braces: refuse to package if any API key from .env ended up in the build.
const envPath = path.join(root, ".env");
if (existsSync(envPath)) {
  const keys = Object.entries(parseEnv(readFileSync(envPath, "utf8")))
    .filter(([name, value]) => /_API_KEY$/.test(name) && value.trim())
    .map(([, value]) => value.trim());
  const leaked = files.filter((file) => {
    const content = readFileSync(path.join(buildDir, file), "latin1");
    return keys.some((key) => content.includes(key));
  });
  if (leaked.length) {
    console.error(`Refusing to package: an API key from .env was found in ${leaked.join(", ")}.`);
    process.exit(1);
  }
}

const { version } = JSON.parse(readFileSync(path.join(buildDir, "manifest.json"), "utf8"));
const zipPath = path.join(root, "release", `clownmeter-${version}.zip`);
mkdirSync(path.dirname(zipPath), { recursive: true });
writeFileSync(zipPath, zip(files.map((file) => ({ name: file.split(path.sep).join("/"), data: readFileSync(path.join(buildDir, file)) }))));
console.log(`\nPackaged ${files.length} files → ${path.relative(root, zipPath)} (${(statSync(zipPath).size / 1024).toFixed(0)} KB). No API keys included.`);

// ---- Minimal ZIP writer (deflate, no external dependencies) ----

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const shared = (header) => {
      header.writeUInt16LE(20, 0); // version needed
      header.writeUInt16LE(0x0800, 2); // UTF-8 names
      header.writeUInt16LE(8, 4); // deflate
      header.writeUInt16LE(time, 6);
      header.writeUInt16LE(date, 8);
      header.writeUInt32LE(crc, 10);
      header.writeUInt32LE(compressed.length, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt16LE(nameBytes.length, 22);
    };

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    shared(local.subarray(4));
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    shared(central.subarray(6));
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
