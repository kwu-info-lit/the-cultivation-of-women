# EPUB Reader (GitHub Pages)

A dedicated reader for viewing `book.epub` in the browser with its vertical (tategaki) layout preserved. It has no external library dependencies.

## Structure

| File | Role |
| --- | --- |
| `index.html` | Page skeleton (toolbar, table of contents, search, display settings) |
| `reader.css` | UI styles and body typesetting (`@layer book` / `@layer reader`) |
| `reader.js` | Main application (controls, settings, progress, saving the reading position) |
| `lib/zip.js` | ZIP extraction (uses the browser's built-in `DecompressionStream`) |
| `lib/epub.js` | EPUB parsing (OPF, table of contents, stylesheets, fonts) |
| `lib/pager.js` | Pagination with CSS multi-column layout and reading-position (anchor) management |
| `lib/search.js` | Full-text search (matches against the body text with ruby removed) |

## Publishing

When changes are pushed to the `main` branch, GitHub Actions (`.github/workflows/pages.yml`) builds `book.epub` with Re:VIEW and publishes it to GitHub Pages together with the contents of this folder. Because `book.epub` is generated at build time, it is not kept in this folder (it is excluded by `.gitignore`).

## Previewing Locally

```sh
bundle exec rake epub
cp book.epub public/
cd public
python3 -m http.server 8000
# Open http://localhost:8000/
```

`fetch` does not work over `file://`, so always open the reader through an HTTP server.
