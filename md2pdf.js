#!/usr/bin/env node
/*
 * md2pdf — convert markdown files into themed, branded PDFs.
 *
 * Usage:
 *   md2pdf <file.md> [file2.md ...] [options]
 *
 * Options:
 *   --theme    NAME|DIR  Theme to use (default: "default"). See "Themes" below.
 *   --logo     PATH      Use this logo instead of the theme's (SVG recommended)
 *   --accent   COLOR     Override the theme's accent color, e.g. "#cf163d"
 *   --title    "..."     Cover title (default: first H1 in the file, else filename)
 *   --subtitle "..."     Cover subtitle (default: current "Month Year")
 *   --out      PATH      Output PDF path (single input only; default: <input>.pdf)
 *   --no-cover           Omit the cover block (keeps the in-document H1)
 *   --serve              Live preview in the browser; auto-reloads on save (no PDF written)
 *   --port N             Port for --serve (default: 4900)
 *   --list-themes        List the themes that --theme can find
 *   --help               Show this help
 *
 * Themes:
 *   A theme is a folder with a theme.json (name, logo, colors, fonts, page size
 *   and margins, footer layout), an optional logo, and an optional theme.css.
 *   Any key a theme leaves out falls back to themes/default/theme.json.
 *   --theme takes a folder path, or a name looked up in
 *   $XDG_CONFIG_HOME/md2pdf/themes (default ~/.config/md2pdf/themes), then in
 *   the themes/ folder next to this script.
 *
 * Page breaks:
 *   Put `\pagebreak` (or `<!-- pagebreak -->`) on its own line in the markdown
 *   to force everything after it onto a new page. Headings, table rows, list
 *   items, and code blocks are kept intact across pages automatically.
 *
 * Requires: pandoc on PATH. PDF output also needs Google Chrome / Chromium
 * (override with the CHROME_PATH environment variable). --serve needs neither
 * Chrome nor puppeteer — it renders in your own browser.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync, execFileSync, spawn } = require('child_process');

const HERE = __dirname;
const BASE_CSS_PATH = path.join(HERE, 'base.css');
const BUILTIN_THEMES = path.join(HERE, 'themes');
const USER_THEMES = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'md2pdf', 'themes');

// Page sizes that both Chrome's PDF printer and CSS @page understand.
const PAGE_SIZES = ['Letter', 'Legal', 'Tabloid', 'Ledger', 'A3', 'A4', 'A5'];
const IMAGE_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function fail(msg) { console.error(`md2pdf: ${msg}`); process.exit(1); }

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  fail('could not locate Chrome/Chromium. Set CHROME_PATH to the browser binary.');
}

function parseArgs(argv) {
  const opts = { files: [], theme: 'default', logo: null, accent: null, title: null, subtitle: null,
    out: null, cover: null, serve: false, port: 4900 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--theme') opts.theme = argv[++i];
    else if (a === '--logo') opts.logo = argv[++i];
    else if (a === '--accent') opts.accent = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--subtitle') opts.subtitle = argv[++i];
    else if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--no-cover') opts.cover = false;
    else if (a === '--serve') opts.serve = true;
    else if (a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '--list-themes') opts.listThemes = true;
    else if (a.startsWith('--')) fail(`unknown option: ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Themes

function themeDirs() {
  const found = new Map();
  for (const root of [BUILTIN_THEMES, USER_THEMES]) {   // user themes shadow built-ins
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, d, 'theme.json'))) found.set(d, path.join(root, d));
    }
  }
  return found;
}

function resolveThemeDir(spec) {
  if (fs.existsSync(path.join(spec, 'theme.json'))) return path.resolve(spec);
  const dir = themeDirs().get(spec);
  if (!dir) fail(`theme not found: ${spec} (run --list-themes, or pass a folder containing theme.json)`);
  return dir;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail(`could not read ${file}: ${e.message}`); }
}

// Theme values end up inside a <style> block, so refuse anything that could
// close a declaration or the block itself.
function cssValue(v, where) {
  if (typeof v !== 'string' || /[<>{};]/.test(v)) fail(`invalid value for ${where}: ${JSON.stringify(v)}`);
  return v;
}

function dataUri(file) {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) fail(`unsupported logo type: ${file} (use .svg, .png or .jpg)`);
  if (!fs.existsSync(file)) fail(`logo not found: ${file}`);
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

// Load a theme on top of the default theme, then apply command-line overrides.
function loadTheme(opts) {
  const defaults = readJson(path.join(BUILTIN_THEMES, 'default', 'theme.json'));
  const dir = resolveThemeDir(opts.theme);
  const own = readJson(path.join(dir, 'theme.json'));
  const t = {
    ...defaults, ...own,
    page: { ...defaults.page, ...own.page, margin: { ...defaults.page.margin, ...(own.page || {}).margin } },
    colors: { ...defaults.colors, ...own.colors },
    fonts: { ...defaults.fonts, ...own.fonts },
    footer: { ...defaults.footer, ...own.footer },
    dir,
  };
  if (opts.accent) t.colors.accent = opts.accent;
  if (opts.cover != null) t.cover = opts.cover;

  const size = PAGE_SIZES.find(s => s.toLowerCase() === String(t.page.size).toLowerCase());
  if (!size) fail(`unsupported page size "${t.page.size}" (use one of: ${PAGE_SIZES.join(', ')})`);
  t.page.size = size;
  for (const [k, v] of Object.entries(t.page.margin)) cssValue(v, `page.margin.${k}`);
  for (const [k, v] of Object.entries(t.colors)) {
    if (/['"\\]/.test(cssValue(v, `colors.${k}`))) fail(`invalid value for colors.${k}: ${JSON.stringify(v)}`);
  }
  for (const [k, v] of Object.entries(t.fonts)) cssValue(v, `fonts.${k}`);
  // The accent is used outside the stylesheet (PDF footer), so it must be a literal color.
  if (/var\(/.test(t.colors.accent)) fail('colors.accent must be a literal color, not var(...)');

  const logoPath = opts.logo ? path.resolve(opts.logo) : t.logo ? path.join(dir, t.logo) : null;
  t.logoUri = logoPath ? dataUri(logoPath) : null;

  const themeCss = path.join(dir, 'theme.css');
  t.cssFiles = [BASE_CSS_PATH, ...(fs.existsSync(themeCss) ? [themeCss] : [])];
  t.css = [
    ':root {',
    ...Object.entries(t.colors).map(([k, v]) => `  --${k}: ${v};`),
    ...Object.entries(t.fonts).map(([k, v]) => `  --font-${k}: ${v};`),
    '}',
    ...t.cssFiles.map(f => fs.readFileSync(f, 'utf8')),
  ].join('\n');
  return t;
}

// ---------------------------------------------------------------------------
// Rendering

function defaultSubtitle() {
  const d = new Date();
  return `${d.toLocaleString('en-US', { month: 'long' })} ${d.getFullYear()}`;
}

function firstH1(md) {
  const m = md.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/[*_`]/g, '').trim() : null;
}

function stripFirstH1Html(html) { return html.replace(/<h1[^>]*>[\s\S]*?<\/h1>/, ''); }

// Turn a forced-break marker on its own line into a raw-HTML break div.
// Accepts: \pagebreak, \newpage, or <!-- pagebreak -->
function applyPageBreaks(md) {
  return md.replace(
    /^[ \t]*(?:\\(?:pagebreak|newpage)|<!--\s*pagebreak\s*-->)[ \t]*$/gim,
    '\n<div class="page-break"></div>\n');
}

function bodyHtml(md) {
  return execSync('pandoc -f gfm+raw_html -t html --wrap=none',
    { input: md, encoding: 'utf8', maxBuffer: 1 << 26 });
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Footer slots are text with {logo} {title} {subtitle} {page} {pages} placeholders.
// PDF footer: Chrome's header/footer template HTML.
function footerHtml(slot, theme, { title, subtitle }) {
  if (!slot) return '';
  const logo = theme.logoUri
    ? `<img src="${theme.logoUri}" style="height:9px; vertical-align:middle;">`
    : `<b style="color:${esc(theme.colors.accent)}; font-size:8pt;">${esc(theme.name)}</b>`;
  return esc(slot)
    .replace(/\{logo\}/g, logo)
    .replace(/\{title\}/g, esc(title))
    .replace(/\{subtitle\}/g, esc(subtitle))
    .replace(/\{page\}/g, '<span class="pageNumber"></span>')
    .replace(/\{pages\}/g, '<span class="totalPages"></span>');
}

// Preview footer: a CSS `content` value for a Paged.js margin box. Margin boxes
// can't size an image, so {logo} shows the theme name in the accent color.
function footerContent(slot, theme, { title, subtitle }) {
  return slot.split(/(\{(?:logo|title|subtitle|page|pages)\})/).filter(Boolean).map(tok => ({
    '{logo}': JSON.stringify(theme.name), '{title}': JSON.stringify(title),
    '{subtitle}': JSON.stringify(subtitle), '{page}': 'counter(page)', '{pages}': 'counter(pages)',
  })[tok] || JSON.stringify(tok)).join(' ');
}

function previewFooterCss(theme, meta) {
  return ['left', 'center', 'right'].filter(pos => theme.footer[pos]).map(pos => {
    const slot = theme.footer[pos];
    const style = slot.includes('{logo}')
      ? `color: ${theme.colors.accent}; font: 700 8pt ${theme.fonts.body};`
      : `color: #888; font: 7pt ${theme.fonts.body};`;
    return `    @bottom-${pos} { content: ${footerContent(slot, theme, meta)}; ${style} }`;
  }).join('\n');
}

function marginCss(m) { return `${m.top} ${m.right} ${m.bottom} ${m.left}`; }

// Build the full document HTML shared by PDF output and live preview.
// In preview mode, Paged.js paginates the page in-browser so real page breaks
// and a footer (title + page numbers) are visible, and an auto-reload client
// refreshes on save. None of this affects the PDF path.
function buildPage(md, theme, { title, subtitle, preview = false }) {
  let body = bodyHtml(applyPageBreaks(md));
  let coverHtml = '';
  if (theme.cover) {
    body = stripFirstH1Html(body);
    const logo = theme.logoUri ? `<img class="logo" src="${theme.logoUri}" alt="${esc(theme.name)}">` : '';
    coverHtml = `<div class="cover">${logo}
<div class="doctitle">${esc(title)}</div><div class="docmeta">${esc(subtitle)}</div></div>`;
  }

  // Preview-only styling: @page size/margins/footer matching the PDF, plus a
  // gray backdrop and a status bar. The footer is drawn by Paged.js margin boxes.
  const previewHead = preview ? `
<style>
  @page {
    size: ${theme.page.size};
    margin: ${marginCss(theme.page.margin)};
${previewFooterCss(theme, { title, subtitle })}
  }
  html { background: #5f6368; }
  .pagedjs_page { background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,.45); margin: 22px auto; }
  .pagedjs_pages { padding-top: 44px; }
</style>` : '';

  const previewScripts = preview ? `
<script>
  // Add the status bar once Paged.js has finished laying out the pages, so it
  // isn't consumed as page content. (PagedConfig must be set before the lib loads.)
  window.PagedConfig = { auto: true, after: () => {
    if (document.getElementById('mp-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'mp-bar';
    // Inline styles: Paged.js reprocesses <style> tags, so don't rely on them here.
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;height:36px;' +
      'background:${theme.colors.accent};color:#fff;padding:0 14px;' +
      'font:12px/36px -apple-system,Helvetica,Arial,sans-serif;';
    bar.innerHTML = '<b style="font-weight:700">' + ${JSON.stringify(esc(theme.name))} + ' preview</b> &nbsp;' +
      '<span style="opacity:.85">paginated with Paged.js (approximates the printed PDF) · auto-reloads on save</span>';
    document.body.appendChild(bar);
  }};
</script>
<script src="/paged.polyfill.js"></script>
<script>
  const es = new EventSource('/events');
  es.onmessage = () => location.reload();
  es.onerror = () => es.close();
</script>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${theme.css}</style>${previewHead}</head>
<body>${coverHtml}${body}${previewScripts}</body></html>`;
}

function docMeta(file, md, opts) {
  return {
    title: opts.title || firstH1(md) || path.basename(file, path.extname(file)),
    subtitle: opts.subtitle != null ? opts.subtitle : defaultSubtitle(),
  };
}

// ---------------------------------------------------------------------------
// Live preview

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
}

function serve(file, opts) {
  if (!fs.existsSync(file)) fail(`not found: ${file}`);
  const PAGED_JS = fs.readFileSync(path.join(HERE, 'vendor', 'paged.polyfill.js'));
  const clients = new Set();

  // Reload the theme on every request so theme edits show up on refresh.
  function render() {
    const md = fs.readFileSync(file, 'utf8');
    const theme = loadTheme(opts);
    return buildPage(md, theme, { ...docMeta(file, md, opts), preview: true });
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/paged.polyfill.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(PAGED_JS);
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(render());
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Render error:\n' + (e.stderr || e.message));
    }
  });

  const reload = () => { for (const c of clients) c.write('data: reload\n\n'); };
  let timer = null;
  const onChange = () => { clearTimeout(timer); timer = setTimeout(reload, 120); };
  // Watch the document, the base stylesheet, and the theme folder.
  const theme = loadTheme(opts);
  for (const target of [file, BASE_CSS_PATH, theme.dir]) {
    try { fs.watch(target, onChange); } catch { /* ignore */ }
  }

  // Loopback only: the preview may be a private document, so don't expose it
  // to everyone else on the network.
  server.listen(opts.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${opts.port}`;
    console.log(`md2pdf preview serving ${path.basename(file)} with theme "${theme.name}" at ${url}`);
    console.log('Editing the markdown, base.css or the theme reloads the page. Ctrl-C to stop.');
    openInBrowser(url);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') fail(`port ${opts.port} is in use. Pass --port N to pick another.`);
    fail(e.message);
  });
}

// ---------------------------------------------------------------------------
// PDF output

async function generate(opts) {
  const theme = loadTheme(opts);
  const chrome = findChrome();
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch { fail('dependencies not installed. Run `npm install` in ' + HERE); }

  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });

  for (const f of opts.files) {
    if (!fs.existsSync(f)) { console.error(`skip (not found): ${f}`); continue; }
    const md = fs.readFileSync(f, 'utf8');
    const meta = docMeta(f, md, opts);
    const outPath = opts.out || f.replace(/\.(md|markdown)$/i, '') + '.pdf';

    const html = buildPage(md, theme, meta);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const m = theme.page.margin;
    const footer = `<div style="width:100%; font-size:7pt; color:#888; font-family:Helvetica,Arial,sans-serif;
      padding:0 ${m.right} 0 ${m.left}; display:flex; align-items:center; justify-content:space-between;">
      <span style="flex:1; text-align:left;">${footerHtml(theme.footer.left, theme, meta)}</span>
      <span style="flex:2; text-align:center;">${footerHtml(theme.footer.center, theme, meta)}</span>
      <span style="flex:1; text-align:right;">${footerHtml(theme.footer.right, theme, meta)}</span></div>`;
    await page.pdf({ path: outPath, format: theme.page.size, printBackground: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer,
      margin: { top: m.top, bottom: m.bottom, left: m.left, right: m.right } });
    await page.close();
    console.log(`✓ ${outPath}`);
  }
  await browser.close();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.listThemes) {
    for (const [name, dir] of themeDirs()) console.log(`${name.padEnd(16)} ${dir}`);
    return;
  }
  if (opts.help || opts.files.length === 0) {
    const banner = (fs.readFileSync(__filename, 'utf8').match(/\/\*([\s\S]*?)\*\//) || [, ''])[1];
    console.log(banner.replace(/^ \* ?/gm, '').trim());
    process.exit(opts.help ? 0 : 1);
  }

  // Verify pandoc (needed for both modes).
  try { execFileSync('pandoc', ['--version'], { stdio: 'ignore' }); }
  catch { fail('pandoc not found on PATH. Install it (e.g. `brew install pandoc`).'); }

  if (opts.serve) {
    if (opts.files.length > 1) console.error(`(previewing only the first file: ${opts.files[0]})`);
    return serve(opts.files[0], opts);
  }

  if (opts.files.length > 1 && (opts.out || opts.title)) {
    fail('--out and --title apply to a single input file only.');
  }
  await generate(opts);
}

main().catch(e => { console.error(e); process.exit(1); });
