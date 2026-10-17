import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function download(url, target, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${new URL(url).pathname}`);
  const partial = `${target}.partial`;
  const handle = await fs.open(partial, 'w');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw new Error('Runtime download exceeded its expected size limit.');
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close();
    await fs.rm(partial, { force: true });
    throw error;
  }
  await handle.close();
  await fs.rename(partial, target);
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}

export async function downloadRuntime({ root = projectRoot } = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = manifest.devDependencies?.electron;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Electron must have an exact pinned version in devDependencies.');
  const filename = `electron-v${version}-win32-x64.zip`;
  const cache = path.join(root, 'build-runtime');
  await fs.mkdir(cache, { recursive: true });
  const checksumsPath = path.join(cache, `electron-v${version}-SHASUMS256.txt`);
  const base = `https://github.com/electron/electron/releases/download/v${version}`;
  try { await fs.access(checksumsPath); }
  catch { await download(`${base}/SHASUMS256.txt`, checksumsPath, 2 * 1024 * 1024); }
  const checksums = await fs.readFile(checksumsPath, 'utf8');
  const line = checksums.split(/\r?\n/).map(value => value.trim()).find(value => value.endsWith(` ${filename}`) || value.endsWith(` *${filename}`));
  const expected = line?.match(/^([a-f\d]{64})\s+\*?(.+)$/i);
  if (!expected || expected[2] !== filename) throw new Error('The official Electron checksum manifest does not list the Windows x64 runtime.');
  const archive = path.join(cache, filename);
  try { await fs.access(archive); }
  catch {
    console.log(`Downloading official Electron ${version} for Windows x64…`);
    await download(`${base}/${filename}`, archive, 512 * 1024 * 1024);
  }
  const actual = await digest(archive);
  if (actual !== expected[1].toLowerCase()) {
    throw new Error(`Electron checksum verification failed. Remove ${path.relative(root, archive)} and retry.`);
  }
  await fs.writeFile(path.join(cache, 'verified-runtime.json'), `${JSON.stringify({ version, filename, sha256: actual, source: `${base}/${filename}`, verifiedAt: new Date().toISOString() }, null, 2)}\n`);
  return { archive, version, sha256: actual };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await downloadRuntime();
  console.log(`Verified ${path.basename(result.archive)} (${result.sha256})`);
}
