import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadRuntime } from './download-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const folder = path.join(release, 'RizeLocal-Windows-x64');
const appFolder = path.join(folder, 'resources', 'app');
const archive = path.join(release, 'rize-local-windows-x64.zip');
const python = process.env.CODEX_PRIMARY_RUNTIME_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function runPython(program, args) {
  const result = spawnSync(python, ['-c', program, ...args], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw new Error(`Python 3 is required for portable packaging: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Packaging failed: ${result.stderr || result.stdout}`);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function assertPe64(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    await handle.read(header, 0, 64, 0);
    if (header.readUInt16LE(0) !== 0x5a4d) throw new Error(`Missing Windows PE header: ${path.basename(file)}`);
    const pe = Buffer.alloc(6);
    await handle.read(pe, 0, 6, header.readUInt32LE(0x3c));
    if (pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664) throw new Error(`Expected Windows x64 binary: ${path.basename(file)}`);
  } finally { await handle.close(); }
}

const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
for (const required of ['dist/index.html', 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/store.cjs', 'desktop/tracking-engine.cjs', 'desktop/native-window.cjs']) {
  if (!(await exists(path.join(root, required)))) throw new Error(`Missing ${required}. Run npm ci and npm run build before packaging.`);
}
const runtime = await downloadRuntime({ root });
await fs.mkdir(release, { recursive: true });
await fs.rm(folder, { recursive: true, force: true });
await fs.mkdir(folder, { recursive: true });
runPython(`import os,sys,zipfile,stat
archive,target=sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    for item in z.infolist():
        name=item.filename.replace('\\\\','/')
        if name.startswith('/') or ':' in name or '..' in name.split('/') or stat.S_ISLNK(item.external_attr >> 16):
            raise ValueError('Unsafe runtime archive member')
    z.extractall(target)
`, [runtime.archive, folder]);
await assertPe64(path.join(folder, 'electron.exe'));
await fs.rename(path.join(folder, 'electron.exe'), path.join(folder, 'RizeLocal.exe'));
await fs.rm(path.join(folder, 'resources', 'default_app.asar'), { force: true });
await fs.mkdir(appFolder, { recursive: true });
for (const directory of ['dist', 'desktop', 'native']) {
  if (await exists(path.join(root, directory))) await fs.cp(path.join(root, directory), path.join(appFolder, directory), { recursive: true, dereference: false });
}
await fs.writeFile(path.join(appFolder, 'package.json'), `${JSON.stringify({ name: manifest.name, productName: 'Rize Local', version: manifest.version, description: 'Independent local Windows time tracker', main: 'desktop/main.cjs', private: true, dependencies: { '@paymoapp/active-window': manifest.dependencies['@paymoapp/active-window'] } }, null, 2)}\n`);
for (const dependency of ['@paymoapp/active-window', 'node-gyp-build']) {
  const source = path.join(root, 'node_modules', dependency);
  if (!(await exists(path.join(source, 'package.json')))) throw new Error(`Missing runtime dependency: ${dependency}`);
  await fs.cp(source, path.join(appFolder, 'node_modules', dependency), { recursive: true, dereference: true });
}
const addonFolder = path.join(appFolder, 'node_modules', '@paymoapp', 'active-window', 'prebuilds', 'win32-x64');
const addons = (await fs.readdir(addonFolder)).filter(name => name.endsWith('.node'));
if (!addons.length) throw new Error('The Windows x64 native foreground helper is missing.');
for (const addon of addons) await assertPe64(path.join(addonFolder, addon));
for (const document of ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'docs/RECONSTRUCTION.md']) {
  if (await exists(path.join(root, document))) await fs.copyFile(path.join(root, document), path.join(folder, path.basename(document)));
}
await fs.cp(path.join(root, 'docs', 'licenses'), path.join(folder, 'licenses'), { recursive: true, dereference: false });
await fs.writeFile(path.join(folder, 'START-HERE.txt'), `RIZE LOCAL — WINDOWS x64\r\n\r\nExtract the entire ZIP to a folder, then open RizeLocal.exe.\r\nKeep its resources and other files beside the executable.\r\n\r\nThis is an independent reconstruction, not an official Rize application.\r\nThe first-run screen lets you create a local workspace or explore sample data.\r\nAutomatic activity collection starts only after you explicitly enable it in Settings.\r\nData starts local. Optional team/AI integrations share reviewed records only with configured services. Use Settings to export a JSON backup or workspace CSV.\r\nThe native executable has not been code-signed.\r\n\r\nSource code is included in rize-local-source.zip.\r\n`);
await fs.writeFile(path.join(folder, 'BUILD-INFO.json'), `${JSON.stringify({ appVersion: manifest.version, electron: runtime.version, platform: 'win32', architecture: 'x64', officialRuntimeSha256: runtime.sha256, builtAt: new Date().toISOString(), signed: false }, null, 2)}\n`);
runPython(`import os,sys,zipfile
root,target=sys.argv[1:]
allowed=['src','public','desktop','native','scripts','tests','docs','server','.github']
files=['package.json','package-lock.json','index.html','vite.config.mjs','README.md','LICENSE','THIRD-PARTY-NOTICES.md','.gitignore']
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for name in files:
        p=os.path.join(root,name)
        if os.path.isfile(p): z.write(p,'rize-local/'+name)
    for name in allowed:
        directory=os.path.join(root,name)
        if not os.path.isdir(directory): continue
        for base,dirs,names in os.walk(directory,followlinks=False):
            dirs[:]=sorted(d for d in dirs if not os.path.islink(os.path.join(base,d)))
            for filename in sorted(names):
                p=os.path.join(base,filename)
                if not os.path.islink(p): z.write(p,'rize-local/'+os.path.relpath(p,root).replace(os.sep,'/'))
`, [root, path.join(folder, 'rize-local-source.zip')]);
runPython(`import os,sys,zipfile
folder,target=sys.argv[1:]
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for base,dirs,names in os.walk(folder):
        dirs.sort()
        for name in sorted(names):
            p=os.path.join(base,name)
            z.write(p,os.path.relpath(p,os.path.dirname(folder)).replace(os.sep,'/'))
with zipfile.ZipFile(target) as z:
    bad=z.testzip()
    if bad: raise ValueError('ZIP integrity failure: '+bad)
    if 'RizeLocal-Windows-x64/RizeLocal.exe' not in z.namelist(): raise ValueError('Executable missing')
`, [folder, archive]);
const hash = crypto.createHash('sha256');
const handle = await fs.open(archive, 'r');
try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
finally { await handle.close(); }
const checksum = hash.digest('hex');
await fs.writeFile(`${archive}.sha256`, `${checksum}  ${path.basename(archive)}\n`);
console.log(`Portable Windows x64 package: ${archive}`);
console.log(`SHA256: ${checksum}`);
