Animal Color Search Demo - High Level Design Brief

Purpose

This demo shows how someone could search an aquarium image collection by color.

The user picks a color, and the app shows animals with the closest matching saved colors. The goal is not to capture every tiny color in every image. The goal is to save the colors a normal user would reasonably search for.

Basic flow:

1. Add animal images.
2. Remove the background.
3. Detect the main searchable colors.
4. Pick a color.
5. Show the closest matching animals first.


What The Demo Shows

There are two views:

- Demo view: shows the full workflow, including the image library, processing, cutout preview, detected colors, and search.
- Full color search view: a cleaner search-only gallery. This is the main user-facing demo screen.

The demo view is useful for explaining how the system prepares the images. The full color search view is the better screen for showing the final experience.


How Data Is Stored In The Demo

This MVP stores everything locally.

- Original uploaded images are stored in `animals/`.
- Background-removed cutouts are stored in `data/processed/`.
- Trimmed cutout thumbnails for processing/review support are stored in `data/thumbs/`.
- Image status, detected colors, and processing metadata are stored in `data/color-cache.json`.

The JSON file acts like a small local database for the demo. It does not store the actual image pixels. Instead, it stores references to the image files plus metadata about each image.

For each animal, the JSON cache stores things like:

- original filename
- processed cutout filename
- detected searchable hex colors
- processing status
- background removal model used
- whether the colors were automatic or manually edited
- any processing error

Example of the kind of color data stored:

`["#202B3A", "#514E3F", "#203F6A", "#FFE404"]`

For production, this JSON file would likely become a real database, while images would move to cloud storage.


How Background Removal Works

The app uses Gemini image editing to remove the background.

The background-removed image is used for two things:

- to show a clean animal preview
- to create a mask showing where the animal is

The mask is important because it tells the app which parts of the original image belong to the animal and which parts are background.


How Colors Are Chosen

The app does not mainly trust the generated cutout for color.

Instead:

1. The cutout tells the app where the animal is.
2. The app samples colors from the original image inside that animal area.
3. It ignores likely background, white matte, edge artifacts, shadows, and tiny accents.
4. It saves 1-4 useful searchable hex colors.

This matters because generated cutouts can slightly change colors. Using the original image for color extraction keeps the saved colors closer to the real animal.


How Search Works

The user can pick a color using preset swatches, a color wheel, a shade slider, or RGB/hex input.

Search uses the saved hex colors in `data/color-cache.json`. It does not reprocess images during search.

For each animal, the app compares the selected color against that animal's saved colors, keeps the closest one, and ranks the animals by similarity.

The similarity uses perceptual color distance, which is closer to how people see color than simple RGB math.

Search modes:

- Close: only very similar colors.
- Balanced: the default; good visible matches.
- Explore: broader related colors.


Spreadsheet Metadata

CSV is the preferred metadata format for handoff and integration. The app reads `Shedd_Go_AltText_Drafts.csv` for full metadata or `Shedd_Go_AltText_Demo_Sample.csv` for a demo subset. XLSX remains supported as a fallback.

The public repo includes a sanitized fallback XLSX containing only rows for the demo images. Full-library metadata files stay outside the public repository.

When the metadata filename matches the image filename, the app uses the scientific name and source filename for display. Draft alt text remains attached to the image record and is applied to the HTML image `alt` attribute; it is not shown as visible result copy.

This improves the gallery display, but it does not replace the color search logic. Search still uses the saved hex colors.


Cost And Processing Options

Most cost comes from background removal, because that uses Gemini image editing. The demo uses 1K output images.

There are two separate decisions. They affect the final price together, but they are not the same thing.

Decision 1: which model makes the cutout?

- Fast cutout: cheaper model. Good default for a large first pass.
- Detailed cutout: stronger model. Better for hard images, fine coral branches, hair, fins, or animals that blend into the background.

Decision 2: how is the work submitted?

- Standard processing: normal request. Better for live demos or small sets because results come back immediately.
- Batch processing: lower-cost bulk request. Better for hundreds or thousands of images because it is cheaper, but less immediate.

The cost scenarios combine one model choice with one submission mode.

Cost estimates:

```txt
Scenario              Per Image   100 Images    1,800 Images    Best Use
Fast + Batch          $0.0168     about $1.68   about $30.24    Cheapest large first pass
Fast + Standard       $0.0336     about $3.36   about $60.48    Small sets or live demo
Detailed + Batch      $0.0340     about $3.40   about $61.20    Better cutouts in bulk
Detailed + Standard   $0.0670     about $6.70   about $120.60   Immediate detailed processing
```

Input token cost is additional, and actual cost can change with retries or future pricing changes.

Practical recommendation:

- Use Fast + Batch for the large first pass.
- Re-run difficult images with Detailed cutout if the cutout quality is not good enough.

Pricing source:

https://ai.google.dev/gemini-api/docs/pricing

If This Became Production

The core idea would stay the same:

Cutout for processing preview and masking. Original image for user-facing search display and real color extraction.

The main production changes would be:

- database instead of local JSON
- cloud storage instead of local folders
- batch jobs for large image sets
- progress tracking and retries
- confidence scores for color quality
- review queue only for low-confidence images
- filters by animal group, habitat, exhibit, or collection
