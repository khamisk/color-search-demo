Animal Color Search Demo - Implementation Overview

Purpose

This doc explains how the demo is implemented for someone else on the team who needs to understand or improve the code. It is still high level, but includes the main files, data flow, storage format, and image/color processing details.


Quick Summary

This is a local Node/Express + vanilla JavaScript app.

The app:

1. Reads animal images from `animals/`.
2. Accepts uploaded images through the browser.
3. Uses Gemini image editing to create background-removed cutouts.
4. Uses the cutout as a mask to extract colors from the original image.
5. Stores processed metadata and colors in `data/color-cache.json`.
6. Lets the user search animals by color similarity.

Why some choices changed during the demo:

- Color extraction moved from "use the processed cutout image as the color source" to "use the processed cutout as a mask, then sample the original image." The reason was that generated cutouts sometimes changed color, missed important colors, or introduced white/gray matte artifacts.

- Gemini background removal replaced the first local background-removal approach because the local cutouts were too harsh on detailed animals and corals.

- Display thumbnails were added because transparent cutouts can have large invisible canvas space, which made animals appear visually far away from their labels in the gallery.

- The full color search view was added because the processing/review UI is useful for explaining the workflow, but too busy for the actual search demo.

- Manual color editing was kept as a fallback, but hidden under manual color fix because the intended direction is automatic processing with minimal manual review.


How To Run

Install dependencies:

`npm install`

Create or check `.env`:

`GEMINI_API_KEY=...`

Start the app:

`npm start`

Open:

`http://127.0.0.1:3000`

Useful checks:

`npm test`

`node --check server.js`

`node --check public/app.js`

`npm audit --omit=dev`


Main Files

`server.js`

Backend server. Handles API routes, image upload, folder scanning, Gemini cutout generation, color extraction, metadata import, search ranking, and cache writes.

`public/app.js`

Frontend behavior. Handles UI state, sidebar library, selected animal review, color wheel interaction, live search, manual color editing, and view switching.

`public/index.html`

HTML structure for the demo view and full color search view.

`public/styles.css`

Layout and styling for the sidebar, review area, color search controls, and gallery cards.

`data/color-cache.json`

Local JSON cache. This acts like the demo database.

`animals/`

Original image library.

`data/processed/`

Background-removed cutout PNGs.

`data/thumbs/`

Trimmed display thumbnails used in the result gallery.


Data Storage

The demo does not use a database. It uses local folders plus `data/color-cache.json`.

The original image files stay in `animals/`. The JSON cache stores references to those files and references to the generated cutouts.

Each cache entry stores:

- `sourceRelPath`: original image path inside `animals/`
- `sourceHash`: hash of the original image
- `processedRelPath`: generated cutout path
- `backgroundModel`: selected Gemini processing mode
- `backgroundModelName`: actual Gemini model name
- `processingProvider`: currently `gemini`
- `estimatedCostUsd`: estimated output-image cost
- `transparency`: how transparency was handled
- `colors`: saved searchable hex colors
- `colorSource`: `auto` or `manual`
- `status`: `processed`, `processing`, `error`, or unprocessed state
- `updatedAt`: last update timestamp
- `error`: processing error message when something fails

The `sourceHash` is important. If the original image changes, the old cache entry is treated as stale and the image needs to be processed again.

Reason for this structure:

- Local folders make the MVP simple to run and inspect.
- The JSON cache makes processing reusable across server restarts without needing a database.
- Storing file references instead of image pixels keeps the cache readable and small.


Animal Loading

The main loading endpoint is:

`GET /api/animals`

Implementation path:

1. `getAnimalRecords()` scans `animals/`.
2. Each file gets a stable ID from its relative path.
3. The source image is hashed.
4. The server checks `data/color-cache.json` for a matching current cache entry.
5. If processed output exists, the app exposes URLs for the original image, cutout, and thumbnail.
6. Spreadsheet metadata is joined when a filename match is found.
7. The server returns public animal objects to the frontend.


Upload Flow

The upload endpoint is:

`POST /api/upload`

Uploaded images are saved into `animals/`.

The server validates:

- file extension
- MIME type
- file size
- supported image formats

Supported formats:

- JPG/JPEG
- PNG
- WebP
- AVIF

Uploaded filenames are sanitized and made unique before saving.


Processing Flow

The process endpoint is:

`POST /api/process`

It can process selected image IDs or all unprocessed images.

Main function:

`processAnimal()`

Processing steps:

1. Normalize the original image with Sharp.
2. Send the image to Gemini for background removal.
3. Save the generated cutout as a PNG in `data/processed/`.
4. Extract searchable colors.
5. Save all processing metadata into `data/color-cache.json`.

Processing is currently sequential. After each animal is processed, the cache is written so progress is not lost if a later image fails.


Background Removal

Main functions:

`removeBackgroundWithGemini()`

`prepareCutoutForStorage()`

`analyzeCutoutPixels()`

`removeWhiteEdgeMatte()`

The app sends Gemini a prompt asking it to preserve the full animal/coral/fish body and remove only the background.

Gemini was chosen after the first local background-removal path produced cutouts that were too aggressive on some detailed images. Some coral branches, soft edges, and fine animal detail were being removed or washed out.

Gemini may return:

- a transparent image
- a white-background image
- an opaque image

The app normalizes the output with Sharp. If the image already has transparency, it stores it directly. If Gemini returns a white matte, the app tries to remove connected white areas from the edge of the image. This is meant to remove the page-like white background without deleting white parts inside the animal.

The transparency result is stored in the cache, for example:

- `native-transparent`
- `post-processed-white-edge`
- `white-matte`
- `opaque-output`


Thumbnail Generation

Gallery display uses thumbnails from:

`data/thumbs/`

Main function:

`ensureDisplayThumbnail()`

Some generated cutouts have a large transparent canvas around the animal. The thumbnail step trims that empty space and creates a better display image for the search gallery.

The thumbnail does not replace the processed cutout. It is only used for display.

Reason for this step:

Some processed PNGs have correct transparency but keep a large canvas around the animal. In the gallery, that invisible space made the animal image look disconnected from the name and match details below it. The thumbnail trims display whitespace while leaving the real processed cutout untouched.


Color Extraction

Main functions:

`assignSearchableColors()`

`extractSearchableColors()`

`extractSearchableColorsFromCutout()`

`chooseSearchableColorsFromBuckets()`

The most important design choice is that the processed cutout is used mainly as a mask, not as the color source.

Reason for this change:

Earlier color extraction from only the processed cutout produced bad cases. The cutout could have altered colors, added white/gray matte areas, or lost colors that were visible in the original image. Sampling from the original image inside the cutout mask keeps the saved colors closer to the real animal while still ignoring the background.

The flow is:

1. Read the processed cutout.
2. Determine which pixels are subject pixels using alpha transparency or by ignoring likely white matte pixels.
3. Resize the original image to match the mask sampling size.
4. Refine the subject mask so edge pixels are less likely to include background bleed.
5. Sample RGB pixels from the original image only where the mask says the animal exists.
6. Group similar pixels into color buckets.
7. Score buckets by frequency, saturation, value, and usefulness.
8. Filter likely artifacts, such as matte white, background, shadows, and very tiny accents.
9. Keep a small set of distinct searchable colors.
10. Save 1-4 uppercase `#RRGGBB` values.

There is also a fallback:

- If original-image masked extraction fails, the app extracts colors directly from the cutout.
- If optional Codex color assignment is enabled, Codex colors can be reconciled with local extraction.

Current default:

- local image analysis is used for color extraction
- Codex color assignment is optional and off unless `USE_CODEX_COLOR_ASSIGNMENT=1`

The extraction tries to balance two goals:

- avoid storing background or artifact colors
- still rescue meaningful smaller saturated colors, such as blue, green, yellow, or purple markings that are important for search

The output is intentionally small. Four colors is the maximum for automatic extraction because this is a search system, not a full color palette generator.

Reason for limiting colors:

The project is about color search, not exhaustive palette extraction. Too many colors would make search noisy, especially if tiny accents, lighting artifacts, or background bleed were stored as searchable colors.


Manual Color Editing

Manual color editing is available under the manual color fix area.

Endpoint:

`POST /api/colors/:id`

Manual edits replace the stored color list and mark `colorSource` as `manual`.

This exists as a demo/debug fallback. The intended production direction is automatic extraction with review only for low-confidence cases.


Search Implementation

Search endpoint:

`POST /api/search`

Main backend functions:

`closestAnimalMatch()`

`matchAccuracy()`

Frontend local search:

`localSearchMatches()`

Search uses the saved hex colors in `data/color-cache.json`. It does not reprocess images.

For each animal:

1. Compare the selected color against every stored color for that animal.
2. Keep the smallest perceptual distance.
3. Exclude results outside the selected threshold.
4. Sort closest matches first.

Color distance uses CIEDE2000 from `culori`, which is closer to human color perception than raw RGB distance.

Current search modes:

- Close: strict threshold
- Balanced: default threshold
- Explore: broader threshold

The frontend performs fast local search from already-loaded animal data so the gallery updates immediately while dragging the color wheel.

Reason for local live search:

The color wheel should feel immediate while dragging through colors. Since all saved colors are already loaded in the browser, local search avoids a server round trip for every tiny color movement.


Frontend State And Rendering

The frontend keeps a single state object in `public/app.js`.

Important functions:

- `loadAnimals()`: fetches animal data from the server
- `render()`: refreshes the main UI
- `renderAnimalList()`: renders the left sidebar
- `renderSelectedAnimal()`: renders the selected animal review area
- `renderResults()`: renders search result cards
- `searchMatches()`: updates search results
- `localSearchMatches()`: ranks animals client-side
- `updateWheelFromPointer()`: updates selected color from the wheel
- `updateBrightnessFromPointer()`: updates selected shade

The UI has two views:

- `#demo`
- `#search`

The hash controls which view is shown. The same search controls and result rendering are reused across both views.

Reason for two views:

The demo view is for explaining the workflow and reviewing processing results. The full search view is for showing the cleaner user-facing search experience without the sidebar and processing controls.

Live search is designed to update while the user drags through the color wheel. Scroll stabilization keeps the page from jumping when results update.


Spreadsheet Metadata

The app can read:

`Shedd_Go_AltText_Demo_Sample.xlsx`

The public repo includes a sample XLSX extracted from the original working spreadsheet. It only contains rows for the demo images in this repo.

Main function:

`getMetadataIndex()`

The XLSX file is parsed with:

- `fflate`
- `fast-xml-parser`

Rows are matched by original filename. When there is a match, the app can display:

- resource ID
- attribution
- scientific name
- original filename
- draft alt text
- reviewed flag

This metadata improves display, but color search still uses saved hex colors.


Quality Hints

Main function:

`evaluateAnimalQuality()`

The app can compare broad color words from alt text against stored hex colors.

Example:

- alt text says "blue"
- extracted colors contain no blue-like family
- the animal can be marked as needing review

This is only a confidence hint. It does not replace color extraction and does not change search ranking.


API Summary

`GET /api/animals`

Returns the scanned image library with cache data, metadata, quality hints, colors, and image URLs.

`POST /api/upload`

Uploads images into `animals/`.

`POST /api/process`

Runs background removal and color extraction.

`POST /api/recolor`

Recalculates colors for already processed animals without re-running background removal.

`POST /api/colors/:id`

Saves manual color edits.

`POST /api/quality/:id`

Marks or restores quality review state.

`POST /api/search`

Runs backend color search using saved hex values.


Known MVP Limitations

- local-only app
- JSON file instead of database
- no authentication
- sequential processing
- targeted automated coverage for color extraction only; most server and frontend flows still rely on manual checks
- Gemini output quality can vary
- color extraction is heuristic
- cost tracking is estimated, not exact billing


Sensitive Files

`.env` may contain API keys. Do not commit or share real keys.

`data/color-cache.json` contains local demo state. It is useful for review, but should not be treated as a production database.
