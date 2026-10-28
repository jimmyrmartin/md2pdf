# md2pdf sample document

This file exercises the elements md2pdf styles, so you can check a theme
quickly: `md2pdf examples/sample.md --serve`.

## Text and lists

Paragraphs wrap normally. **Bold**, *italic*, `inline code` and
[links](https://example.com) pick up the theme's colors.

- A bullet list item
- Another item, long enough to wrap onto a second line so you can see how
  list items keep their indentation across lines
  - A nested item

1. A numbered step
2. Another step

> A blockquote uses the accent color for its left rule.

## Code

Long lines wrap inside the block instead of running off the page:

```
md2pdf report.md --theme ./themes/acme --accent "#0b7285" --subtitle "Quarterly review" --out build/report-final.pdf
curl -s "https://example.com/api/v1/items?filter=status:active,owner:platform-team,region:us-east-1&limit=500&sort=-updated"
```

### Tables

| Option     | Purpose                                  | Default      |
|------------|------------------------------------------|--------------|
| `--theme`  | Theme name or folder                     | `default`    |
| `--logo`   | Logo file (SVG recommended)              | theme's logo |
| `--accent` | Accent color                             | theme's      |

\pagebreak

## After a forced page break

Everything after a `\pagebreak` line starts on a new page.
