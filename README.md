# md2pdf

Convert markdown into themed, branded PDFs: a cover with your logo, your
colors and fonts, and a footer with page numbers. A live preview mode shows
the paginated document in your browser and reloads when you save.

## Requirements

- [Node.js](https://nodejs.org) 22.12 or newer (required by `puppeteer-core`)
- [pandoc](https://pandoc.org) on your `PATH` (`brew install pandoc`)
- Google Chrome, Chromium, or Edge (auto-detected; override with `CHROME_PATH`)

```sh
npm install          # installs puppeteer-core
npm link             # optional: exposes the `md2pdf` command globally
```

## Usage

```sh
node md2pdf.js report.md                              # writes report.pdf
node md2pdf.js report.md --theme ./my-theme           # use a theme folder
node md2pdf.js report.md --accent "#0b7285" --logo logo.svg
node md2pdf.js a.md b.md c.md                          # several files at once
node md2pdf.js report.md --serve                       # live preview at http://127.0.0.1:4900
```

| Option | Purpose |
|---|---|
| `--theme NAME\|DIR` | Theme to use (default: `default`). |
| `--logo PATH` | Use this logo instead of the theme's. SVG recommended. |
| `--accent COLOR` | Override the theme's accent color. |
| `--title "..."` | Cover title (default: first H1, else the file name). |
| `--subtitle "..."` | Cover subtitle (default: current month and year). |
| `--out PATH` | Output path (single input only; default: `<input>.pdf`). |
| `--no-cover` | Omit the cover block and keep the document's H1. |
| `--serve` | Live preview in the browser; no PDF is written. |
| `--port N` | Port for `--serve` (default: 4900). |
| `--list-themes` | List the themes `--theme` can find by name. |

The preview server listens on `127.0.0.1` only, so the document isn't
reachable from other machines on your network.

### Page breaks

Put `\pagebreak` (or `<!-- pagebreak -->`) on its own line to start a new page.
Headings, list items, table rows and code blocks are kept together across
pages automatically, and long lines in code blocks wrap.

## Themes

A theme is a folder:

```
my-theme/
  theme.json   # required: name, logo, colors, fonts, page, footer
  logo.svg     # optional
  theme.css    # optional: extra CSS loaded after base.css
```

Any key a theme leaves out falls back to
[`themes/default/theme.json`](themes/default/theme.json), so a theme can be as
small as a name, a logo and an accent color. See
[`examples/acme-theme`](examples/acme-theme) for a small working example:

```sh
node md2pdf.js examples/sample.md --theme examples/acme-theme --serve
```

`--theme` accepts a folder path, or a name looked up in
`$XDG_CONFIG_HOME/md2pdf/themes/<name>` (default `~/.config/md2pdf/themes`)
and then in this repository's `themes/` folder. Keeping your own themes in
`~/.config/md2pdf/themes` means you never have to edit the tool itself.

### theme.json

| Key | Meaning |
|---|---|
| `name` | Shown in the preview status bar, and in the footer when there is no logo. |
| `logo` | Logo file, relative to the theme folder, or `null`. `.svg`, `.png` or `.jpg`. |
| `cover` | `true` to add the cover block (logo, title, subtitle). |
| `page.size` | `Letter`, `Legal`, `Tabloid`, `Ledger`, `A3`, `A4` or `A5`. |
| `page.margin` | `top`, `right`, `bottom`, `left` as CSS lengths. Used by both the PDF and the preview. |
| `colors` | Become CSS variables (`--accent`, `--h2`, …). A value can reference another, e.g. `"var(--accent)"`; `accent` itself must be a literal color. |
| `fonts` | `body`, `heading`, `mono` font stacks, as `--font-body` etc. |
| `footer` | `left`, `center`, `right` text with placeholders `{logo}`, `{title}`, `{subtitle}`, `{page}`, `{pages}`. Use `""` to leave a slot empty. |

Use an SVG logo where you can. It stays sharp at any zoom or print size,
whereas a PNG needs roughly four times its printed size in pixels.

In the live preview, `{logo}` in the footer shows the theme name instead of
the image, because the preview's footer can't size an image. The PDF shows the
logo.

## How it works

pandoc turns the GitHub-flavored markdown into HTML. md2pdf wraps it in
`base.css`, the theme's colors and fonts, the theme's `theme.css` and a cover,
then headless Chrome (via `puppeteer-core`) prints it to PDF with the footer.
The preview paginates the same HTML in your browser with
[Paged.js](https://pagedjs.org) (vendored in `vendor/`, MIT licensed). Chrome
is the authority on exact pagination, so the preview is a close approximation.
