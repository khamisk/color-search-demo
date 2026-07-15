# Animal Color Search Demo

Local demo for searching aquarium animal images by color.

![Animal color search demo](docs/images/demo-preview.png)

The included demo images have already been processed and reviewed, so reviewers can run the current demo without reprocessing images or using an API key.

## Run

```bash
npm install
npm start
```

Open:

```txt
http://127.0.0.1:3000
```

## Processing New Images

Gemini is only needed if you want to process new uploaded images or regenerate cutouts.

Create a `.env` file:

```txt
GEMINI_API_KEY=your_key_here
```

Do not commit `.env`.

## What's Included

- `animals/` - original demo images
- `data/processed/` - background-removed cutouts
- `data/thumbs/` - gallery thumbnails
- `data/color-cache.json` - saved image/color metadata
- `Shedd_Go_AltText_Demo_Sample.xlsx` - public sample metadata for the included demo images
- `public/` - frontend HTML, CSS, and JavaScript
- `server.js` - local Express server, image processing, and search API
- `docs/` - design notes and code review guide

## Review Notes

This is a local MVP/demo, not production infrastructure.

The included XLSX is a small public sample from the original working spreadsheet. It only contains rows for the demo images in this repo.

## CSV Alt Text Metadata

CSV metadata is supported as an alternative to XLSX. Place either of these files in the project root and restart the server:

- `Shedd_Go_AltText_Drafts.csv` for the full working metadata
- `Shedd_Go_AltText_Demo_Sample.csv` for demo metadata

The CSV must have a filename column so rows can be matched to images. The current spreadsheet headers work as-is, including `Original filename` and `Alt Text DRAFT`. Shorter headers such as `filename` and `alt_text` also work.

Minimal example:

```csv
filename,alt_text
Abudefdufsaxatilis_Sergeantmajor.png,"Silver fish with five bold black vertical stripes."
```

When matching files exist, full metadata takes priority over demo metadata and CSV takes priority over XLSX at the same level. CSV fields may contain commas, quotes, or line breaks when enclosed in double quotes.

The color search uses automated image analysis tuned for the included demo set. New uploaded images may need review after automatic processing.

For implementation details, see:

- `docs/code-review-guide.md`
- `docs/aquarium-demo-design.md`
- `docs/gemini-prompt-engineering.md`

## Do Not Commit

- `.env`
- `node_modules/`
- logs
- temporary output files
- `Shedd_Go_AltText_Drafts.csv`
