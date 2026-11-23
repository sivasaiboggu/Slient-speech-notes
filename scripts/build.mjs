import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const pages = ['index.html', 'privacy.html', '404.html'];
const scripts = ['theme.js', 'app.js', 'note-store.js', 'notebook.js', 'tracker.mjs'];
const assets = [
  'grain.png', 'icon-192.png', 'icon-512.png', 'alegreya-sans-latin-400.woff2',
  'alegreya-sans-latin-700.woff2', 'alegreya-sans-OFL.txt', 'mark.svg', 'social.png',
];
const files = [
  ...pages, ...scripts, ...assets.map(asset => 'assets/' + asset),
  'tokens.css', 'style.css', 'manifest.webmanifest',
];

execFileSync(process.execPath, [fileURLToPath(new URL('scripts/design-tokens.mjs', root)), '--check']);
for (const script of scripts) {
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL(script, root))]);
}
for (const file of files) {
  if (!(await stat(new URL(file, root))).size) throw new Error('Empty build input: ' + file);
}

const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8'));
for (const { src } of manifest.icons) {
  if (!files.includes(src)) throw new Error('Manifest icon missing from build: ' + src);
}

await rm(dist, { recursive: true, force: true });
await mkdir(new URL('assets/', dist), { recursive: true });
for (const file of files) await cp(new URL(file, root), new URL(file, dist));
console.log('Built ' + files.length + ' static files in dist/');
