import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const src = new URL('./src/', import.meta.url);
const dist = new URL('./dist/', import.meta.url);
const [template, css, js] = await Promise.all([
  readFile(new URL('app.html', src), 'utf8'),
  readFile(new URL('styles.css', src), 'utf8'),
  build({
    entryPoints: [fileURLToPath(new URL('main.mjs', src))],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    minify: true,
    legalComments: 'inline',
  }),
]);
const html = template
  .replace('<script>/* PANEL_JS */</script>', () =>
    '<script type="module">' + js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script>')
  .replace('/* PANEL_CSS */', () => css);
await mkdir(dist, { recursive: true });
await writeFile(new URL('app.html', dist), html, 'utf8');

