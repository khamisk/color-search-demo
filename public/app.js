const state = {
  animals: [],
  selectedId: null,
  selectedIds: new Set(),
  libraryFilter: "all",
  libraryQuery: "",
  busy: false,
  hsv: { h: 22, s: 0.51, v: 0.55 }
};

const animalList = document.querySelector("#animal-list");
const selectedAnimal = document.querySelector("#selected-animal");
const selectedColors = document.querySelector("#selected-colors");
const addColorButton = document.querySelector("#add-color-button");
const undoColorButton = document.querySelector("#undo-color-button");
const manualColorInput = document.querySelector("#manual-color-input");
const resultSummary = document.querySelector("#result-summary");
const results = document.querySelector("#results");
const status = document.querySelector("#status");
const uploadForm = document.querySelector("#upload-form");
const imageInput = document.querySelector("#image-input");
const refreshButton = document.querySelector("#refresh-button");
const processSelectedButton = document.querySelector("#process-selected-button");
const processBatchButton = document.querySelector("#process-batch-button");
const processAllButton = document.querySelector("#process-all-button");
const updateAllColorsButton = document.querySelector("#update-all-colors-button");
const processModelSelect = document.querySelector("#process-model-select");
const selectAllButton = document.querySelector("#select-all-button");
const refreshColorsButton = document.querySelector("#refresh-colors-button");
const colorPicker = document.querySelector("#color-picker");
const colorPalette = document.querySelector("#color-palette");
const colorWheel = document.querySelector("#color-wheel");
const wheelMarker = document.querySelector("#wheel-marker");
const brightnessStrip = document.querySelector("#brightness-strip");
const brightnessMarker = document.querySelector("#brightness-marker");
const viewToggle = document.querySelector("#view-toggle");
const librarySummary = document.querySelector("#library-summary");
const libraryFilters = document.querySelector("#library-filters");
const librarySearch = document.querySelector("#library-search");
const progressArea = document.querySelector("#progress-area");
const progressFill = document.querySelector("#progress-fill");
const progressLabel = document.querySelector("#progress-label");
const progressPercent = document.querySelector("#progress-percent");
const selectedColorDot = document.querySelector("#selected-color-dot");
const selectedColorLabel = document.querySelector("#selected-color-label");
const manualColorList = document.querySelector("#manual-color-list");
const rgbInputs = {
  r: document.querySelector("#rgb-r"),
  g: document.querySelector("#rgb-g"),
  b: document.querySelector("#rgb-b")
};
const strictnessButtons = document.querySelectorAll("[data-threshold]");
const strictnessHelp = document.querySelector("#strictness-help");

let searchThreshold = 18;
let progressTimer = null;
let draggingWheel = false;
let draggingBrightness = false;
let searchFrame = null;
let colorUndoStack = [];
let lockedSearchScroll = null;
const MAX_MANUAL_COLORS = 8;

const presetColors = [
  { name: "black", hex: "#151515" },
  { name: "charcoal", hex: "#4A4A45" },
  { name: "gray", hex: "#8B8C86" },
  { name: "white", hex: "#F4F1E8" },
  { name: "tan", hex: "#C8A46F" },
  { name: "brown", hex: "#7A4E31" },
  { name: "orange", hex: "#D96A22" },
  { name: "yellow", hex: "#E9C63A" },
  { name: "red", hex: "#B8332D" },
  { name: "pink", hex: "#D782A8" },
  { name: "purple", hex: "#7654A8" },
  { name: "blue", hex: "#2B69B1" },
  { name: "teal", hex: "#168C8C" },
  { name: "green", hex: "#4D7C39" }
];

const strictnessCopy = {
  10: "Close keeps only very similar colors.",
  18: "Balanced finds visibly similar colors.",
  32: "Explore shows looser nearby colors too."
};

const processModelLabels = {
  "gemini-lite": "Fast cutout",
  "gemini-flash": "Detailed cutout",
  external: "manual cutout"
};

function setStatus(message) {
  status.textContent = message || "";
}

function setBusy(isBusy) {
  state.busy = isBusy;
  [
    processSelectedButton,
    processBatchButton,
    processAllButton,
    updateAllColorsButton,
    refreshColorsButton,
    addColorButton,
    undoColorButton,
    manualColorInput,
    refreshButton,
    uploadForm.querySelector("button"),
    imageInput,
    selectAllButton,
    processModelSelect
  ].forEach((control) => {
    control.disabled = isBusy;
  });
  renderLibrarySummary();
  updateColorEditorState();
}

function startProgress(message, estimatedSeconds = 24) {
  stopProgress(false);
  setBusy(true);
  progressArea.hidden = false;
  progressLabel.textContent = message;
  progressFill.style.width = "4%";
  progressPercent.textContent = "4%";

  const startedAt = Date.now();
  progressTimer = window.setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const percent = Math.min(92, Math.round(4 + (elapsed / estimatedSeconds) * 88));
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
  }, 500);
}

function stopProgress(finished) {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }

  if (finished) {
    progressFill.style.width = "100%";
    progressPercent.textContent = "100%";
    window.setTimeout(() => {
      progressArea.hidden = true;
      progressFill.style.width = "0";
      progressPercent.textContent = "0%";
    }, 500);
  } else {
    progressArea.hidden = true;
    progressFill.style.width = "0";
    progressPercent.textContent = "0%";
  }

  setBusy(false);
  renderLibrarySummary();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeClientHex(value) {
  const color = String(value || "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(color) ? color : null;
}

function componentToHex(value) {
  return Math.round(value).toString(16).padStart(2, "0").toUpperCase();
}

function rgbToHex({ r, g, b }) {
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

function normalizeRgbChannel(value) {
  if (String(value).trim() === "") {
    return null;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(0, Math.min(255, Math.round(number)));
}

function colorFromRgbInputs() {
  const rgb = {
    r: normalizeRgbChannel(rgbInputs.r.value),
    g: normalizeRgbChannel(rgbInputs.g.value),
    b: normalizeRgbChannel(rgbInputs.b.value)
  };

  if (rgb.r === null || rgb.g === null || rgb.b === null) {
    return null;
  }

  return rgbToHex(rgb);
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255
  };
}

function hexToHsv(hex) {
  const value = normalizeClientHex(hex);
  if (!value) {
    return null;
  }

  const r = parseInt(value.slice(1, 3), 16) / 255;
  const g = parseInt(value.slice(3, 5), 16) / 255;
  const b = parseInt(value.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }

  return {
    h: (h + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max
  };
}

function currentHex() {
  return rgbToHex(hsvToRgb(state.hsv.h, state.hsv.s, state.hsv.v));
}

function drawColorWheel() {
  const context = colorWheel.getContext("2d", { willReadFrequently: false });
  const width = colorWheel.width;
  const height = colorWheel.height;
  const radius = Math.min(width, height) / 2 - 2;
  const innerRadius = radius * 0.34;
  const centerX = width / 2;
  const centerY = height / 2;
  const image = context.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const offset = (y * width + x) * 4;

      if (distance <= radius) {
        const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 360;
        const saturation = distance <= innerRadius
          ? 0
          : (distance - innerRadius) / (radius - innerRadius);
        const rgb = hsvToRgb(hue % 360, saturation, 1);
        image.data[offset] = rgb.r;
        image.data[offset + 1] = rgb.g;
        image.data[offset + 2] = rgb.b;
        image.data[offset + 3] = 255;
      } else {
        image.data[offset] = 255;
        image.data[offset + 1] = 255;
        image.data[offset + 2] = 255;
        image.data[offset + 3] = 0;
      }
    }
  }

  context.putImageData(image, 0, 0);
  const markerDistance = state.hsv.s === 0 ? 0 : innerRadius + state.hsv.s * (radius - innerRadius);
  const markerX = centerX + Math.cos((state.hsv.h * Math.PI) / 180) * markerDistance;
  const markerY = centerY + Math.sin((state.hsv.h * Math.PI) / 180) * markerDistance;
  wheelMarker.style.left = `${(markerX / colorWheel.width) * 100}%`;
  wheelMarker.style.top = `${(markerY / colorWheel.height) * 100}%`;
}

function syncBrightnessControl() {
  const topColor = rgbToHex(hsvToRgb(state.hsv.h, state.hsv.s, 1));
  const markerY = (1 - state.hsv.v) * 100;
  brightnessStrip.style.setProperty("--brightness-top", topColor);
  brightnessMarker.style.top = `${markerY}%`;
  brightnessStrip.setAttribute("aria-valuenow", String(Math.round(state.hsv.v * 100)));
}

function syncSelectedColor() {
  const color = currentHex();
  const rgb = hexToRgb(color);
  colorPicker.value = color;
  selectedColorDot.style.background = color;
  selectedColorLabel.textContent = color;
  if (rgb) {
    rgbInputs.r.value = rgb.r;
    rgbInputs.g.value = rgb.g;
    rgbInputs.b.value = rgb.b;
  }
  colorPalette.querySelectorAll("[data-color]").forEach((button) => {
    button.classList.toggle("active", normalizeClientHex(button.dataset.color) === color);
  });
  drawColorWheel();
  syncBrightnessControl();
}

function scheduleSearch() {
  if (state.busy) {
    return;
  }

  if (searchFrame) {
    window.cancelAnimationFrame(searchFrame);
  }

  searchFrame = window.requestAnimationFrame(() => {
    searchFrame = null;
    searchMatches({ quiet: true }).catch((error) => setStatus(error.message));
  });
}

function selectSearchColor(color, shouldSearch = false) {
  const hsv = hexToHsv(color);
  if (!hsv) {
    return;
  }

  state.hsv = hsv;
  syncSelectedColor();

  if (shouldSearch) {
    scheduleSearch();
  }
}

function updateWheelFromPointer(event, shouldSearch = false) {
  event.preventDefault();
  const rect = colorWheel.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const dx = x - centerX;
  const dy = y - centerY;
  const radius = Math.min(rect.width, rect.height) / 2 - 2;
  const innerRadius = radius * 0.34;
  const distance = Math.min(radius, Math.sqrt(dx * dx + dy * dy));

  state.hsv.h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  state.hsv.s = distance <= innerRadius ? 0 : (distance - innerRadius) / (radius - innerRadius);
  syncSelectedColor();

  if (shouldSearch) {
    scheduleSearch();
  }
}

function updateBrightnessFromPointer(event, shouldSearch = false) {
  event.preventDefault();
  const rect = brightnessStrip.getBoundingClientRect();
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  state.hsv.v = Math.max(0.08, Math.min(1, 1 - (y / rect.height)));
  syncSelectedColor();

  if (shouldSearch) {
    scheduleSearch();
  }
}

function colorControlIsDragging() {
  return draggingWheel || draggingBrightness;
}

function beginColorDrag() {
  lockedSearchScroll = {
    x: window.scrollX,
    y: window.scrollY,
    height: Math.ceil(results.getBoundingClientRect().height)
  };
  results.style.minHeight = `${Math.max(360, lockedSearchScroll.height)}px`;
  results.classList.add("is-live-searching");
  document.body.classList.add("color-control-dragging");
}

function endColorDrag() {
  window.setTimeout(() => {
    if (colorControlIsDragging()) {
      return;
    }
    results.classList.remove("is-live-searching");
    results.style.minHeight = "";
    document.body.classList.remove("color-control-dragging");
    lockedSearchScroll = null;
  }, 180);
}

function stabilizeSearchScroll() {
  if (!lockedSearchScroll) {
    return;
  }

  const currentHeight = Math.ceil(results.getBoundingClientRect().height);
  results.style.minHeight = `${Math.max(360, lockedSearchScroll.height, currentHeight)}px`;
  window.scrollTo(lockedSearchScroll.x, lockedSearchScroll.y);
}

function releasePointerCapture(control, pointerId) {
  try {
    if (control.hasPointerCapture(pointerId)) {
      control.releasePointerCapture(pointerId);
    }
  } catch {
    // Pointer capture can already be gone after browser-level cancellation.
  }
}

function renderColorPalette() {
  colorPalette.innerHTML = presetColors.map((color) => `
    <button
      type="button"
      class="color-chip"
      data-color="${escapeHtml(color.hex)}"
      style="--chip-color:${escapeHtml(color.hex)}"
      aria-label="Search ${escapeHtml(color.name)}"
      title="${escapeHtml(color.name)} ${escapeHtml(color.hex)}">
    </button>
  `).join("");
  syncSelectedColor();
}

function colorMarkup(colors, options = {}) {
  if (!colors || colors.length === 0) {
    return `<p class="empty-text">process an animal to generate colors</p>`;
  }

  return `<div class="colors">${colors.map((color) => `
    <span class="color-value ${options.editable ? "editable" : ""}">
      <span class="color-swatch" style="background:${escapeHtml(color)}"></span>
      ${escapeHtml(color)}
      ${options.editable ? `
        <button
          type="button"
          class="color-delete"
          data-delete-color="${escapeHtml(color)}"
          ${colors.length <= 1 ? "disabled" : ""}
          aria-label="Remove ${escapeHtml(color)}">
          Delete
        </button>
      ` : ""}
    </span>
  `).join("")}</div>`;
}

function colorSourceText(animal) {
  if (!animal?.hasMask) {
    return "Process the image first to generate searchable colors.";
  }

  if (animal.colorSource === "manual") {
    return "Edited colors.";
  }

  return "";
}

function updateColorEditorState(animal = selectedAnimalRecord()) {
  const canEdit = Boolean(animal?.hasMask);
  const canUndo = Boolean(animal && colorUndoStack.at(-1)?.id === animal.id);

  addColorButton.disabled = state.busy || !canEdit;
  manualColorInput.disabled = state.busy || !canEdit;
  undoColorButton.disabled = state.busy || !canUndo;
  refreshColorsButton.disabled = state.busy || !canEdit;

  addColorButton.title = canEdit
    ? "Use the eyedropper to add a reviewed searchable color."
    : "Process this animal before adding colors.";
  manualColorInput.title = canEdit
    ? "Choose a color to add without the eyedropper."
    : "Process this animal before adding colors.";
  undoColorButton.title = canUndo ? "Undo the last manual color edit." : "No manual color edit to undo.";
  refreshColorsButton.title = canEdit
    ? "Replace manual colors with automatic colors from the original image and cutout mask."
    : "Process this animal before resetting colors.";
}

function primaryAnimalName(animal) {
  return animal?.metadata?.scientificName || animal?.displayName || animal?.name || "Unknown animal";
}

function secondaryAnimalName(animal) {
  const displayName = animal?.displayName || animal?.name || "";
  const primary = primaryAnimalName(animal);
  if (!displayName || displayName === primary) {
    return "";
  }
  return displayName;
}

function metadataBlockMarkup(animal) {
  const metadata = animal?.metadata;
  if (!metadata) {
    return `
      <div class="metadata-block">
        <dl>
          <div><dt>Source file</dt><dd>${escapeHtml(animal?.name || "Unknown file")}</dd></div>
        </dl>
      </div>
    `;
  }

  const sourceFile = metadata.originalFilename || animal?.name;
  return `
    <div class="metadata-block">
      <dl>
        ${sourceFile ? `<div><dt>Source file</dt><dd>${escapeHtml(sourceFile)}</dd></div>` : ""}
        ${metadata.scientificName ? `<div><dt>Scientific name</dt><dd>${escapeHtml(metadata.scientificName)}</dd></div>` : ""}
      </dl>
    </div>
  `;
}

function qualityMarkup(animal, options = {}) {
  const quality = animal?.quality;
  if (!quality || quality.status === "unscored") {
    return options.always ? `<p class="quality-line unscored">no color cue</p>` : "";
  }

  if (quality.status === "reviewed") {
    return `
      <div class="quality-line reviewed">
        <p>reviewed: color check dismissed${quality.reasons?.length ? ` - ${escapeHtml(quality.reasons.join("; "))}` : ""}</p>
        <button type="button" data-quality-action="restore">Restore check</button>
      </div>
    `;
  }

  if (quality.status === "confident") {
    return "";
  }

  const label = "Needs review";
  const reasons = quality.reasons?.length ? quality.reasons.join("; ") : "";
  if (quality.status === "check") {
    return `
      <div class="quality-line check">
        <p>
          <strong>${escapeHtml(label)}</strong>
          ${reasons ? `<span>${escapeHtml(reasons)}</span>` : ""}
        </p>
        <button type="button" data-quality-action="reviewed">Mark reviewed</button>
      </div>
    `;
  }

  return `<p class="quality-line ${escapeHtml(quality.status)}">${escapeHtml(label)}${reasons ? ` - ${escapeHtml(reasons)}` : ""}</p>`;
}

function resultColorMarkup(colors) {
  if (!colors || colors.length === 0) {
    return "";
  }

  return `<div class="result-colors">${colors.map((color) => `
    <span class="result-color">
      <span class="result-color-block" style="background:${escapeHtml(color)}"></span>
      <span class="result-color-code">${escapeHtml(color)}</span>
    </span>
  `).join("")}</div>`;
}

function resultImageAlt(animal) {
  return animal?.metadata?.altTextDraft || primaryAnimalName(animal);
}

const SHOW_ALT_TEXT_BUTTON = true;

function resultAltControlMarkup(animal) {
  const description = animal?.metadata?.altTextDraft;
  if (!SHOW_ALT_TEXT_BUTTON || !description) {
    return "";
  }

  const panelId = `result-alt-${animal.id}`;
  const animalName = primaryAnimalName(animal);
  return `
    <details class="result-alt-control">
      <summary
        class="result-alt-toggle"
        aria-controls="${escapeHtml(panelId)}"
        aria-label="Show image description for ${escapeHtml(animalName)}"
        title="Show image description"
      >ALT</summary>
      <div
        class="result-alt-panel"
        id="${escapeHtml(panelId)}"
        role="note"
        aria-label="Image description for ${escapeHtml(animalName)}"
      >
        <span class="result-alt-title">Image description</span>
        <p>${escapeHtml(description)}</p>
      </div>
    </details>
  `;
}

function selectedAnimalRecord() {
  return state.animals.find((animal) => animal.id === state.selectedId) || state.animals[0] || null;
}

function unprocessedAnimals() {
  return state.animals.filter((animal) => animal.status !== "processed");
}

function statusLabel(status) {
  if (status === "processed") {
    return "ready";
  }
  if (status === "error") {
    return "needs retry";
  }
  return "unprocessed";
}

function qualityLabel(animal) {
  const status = animal?.quality?.status;
  if (status === "confident") {
    return "good";
  }
  if (status === "check") {
    return "needs review";
  }
  if (status === "reviewed") {
    return "reviewed";
  }
  if (status === "unscored") {
    return "no color cue";
  }
  return "";
}

function sidebarStatusMarkup(animal) {
  const badges = [];
  if (animal.status === "error") {
    badges.push(`<span class="status-badge error">${escapeHtml(statusLabel(animal.status))}</span>`);
  } else if (animal.status !== "processed") {
    badges.push(`<span class="status-badge ${escapeHtml(animal.status)}">${escapeHtml(statusLabel(animal.status))}</span>`);
  }

  if (animal.quality?.status === "check") {
    badges.push(`<span class="quality-badge check">needs review</span>`);
  }

  if (badges.length === 0) {
    return "";
  }

  return `
    <span class="row-status">
      ${badges.join("")}
    </span>
  `;
}

function selectedBatchIds() {
  return Array.from(state.selectedIds).filter((id) => state.animals.some((animal) => animal.id === id));
}

function libraryCounts() {
  return {
    all: state.animals.length,
    processed: state.animals.filter((animal) => animal.status === "processed").length,
    check: state.animals.filter((animal) => animal.quality?.status === "check").length,
    reviewed: state.animals.filter((animal) => animal.quality?.status === "reviewed").length
  };
}

function animalMatchesLibraryFilter(animal) {
  switch (state.libraryFilter) {
    case "processed":
      return animal.status === "processed";
    case "check":
      return animal.quality?.status === "check";
    case "reviewed":
      return animal.quality?.status === "reviewed";
    case "all":
    default:
      return true;
  }
}

function animalMatchesLibrarySearch(animal) {
  const query = state.libraryQuery.trim().toLowerCase();
  if (!query) {
    return true;
  }

  const searchableText = [
    animal.name,
    animal.displayName,
    primaryAnimalName(animal),
    secondaryAnimalName(animal),
    animal.status,
    statusLabel(animal.status),
    animal.quality?.status,
    qualityLabel(animal),
    ...(animal.quality?.reasons || []),
    ...(animal.quality?.expectedColors || []),
    animal.metadata?.scientificName,
    animal.metadata?.resourceId,
    animal.metadata?.originalFilename,
    animal.metadata?.altTextDraft,
    ...(animal.colors || [])
  ].filter(Boolean).join(" ").toLowerCase();

  return query.split(/\s+/).every((part) => searchableText.includes(part));
}

function filteredAnimals() {
  return state.animals.filter((animal) => animalMatchesLibraryFilter(animal) && animalMatchesLibrarySearch(animal));
}

function renderLibraryFilters(counts = libraryCounts()) {
  const filters = [
    ["all", "All", counts.all],
    ["processed", "Ready", counts.processed],
    ["check", "Needs review", counts.check],
    ["reviewed", "Reviewed", counts.reviewed]
  ];

  libraryFilters.innerHTML = filters.map(([key, label, count]) => `
    <button
      type="button"
      data-library-filter="${escapeHtml(key)}"
      class="${state.libraryFilter === key ? "active" : ""}"
      ${count === 0 && key !== "all" ? "disabled" : ""}>
      <span>${escapeHtml(label)}</span>
      <strong>${count}</strong>
    </button>
  `).join("");
}

function renderLibrarySummary() {
  const processed = state.animals.filter((animal) => animal.status === "processed").length;
  const unprocessed = unprocessedAnimals().length;
  const selectedCount = selectedBatchIds().length;
  const counts = libraryCounts();
  const summaryParts = [
    `${counts.all} animals`,
    `${counts.processed} ready`
  ];
  if (counts.check > 0) {
    summaryParts.push(`${counts.check} need review`);
  }
  librarySummary.textContent = summaryParts.join(" - ");
  renderLibraryFilters(counts);

  processBatchButton.classList.toggle("has-selection", selectedCount > 0);
  processBatchButton.disabled = state.busy || selectedCount === 0;
  processBatchButton.textContent = selectedCount > 0 ? `Process checked (${selectedCount})` : "Process checked";

  processAllButton.classList.toggle("has-work", unprocessed > 0);
  processAllButton.classList.toggle("no-work", unprocessed === 0);
  processAllButton.disabled = state.busy || unprocessed === 0;
  processAllButton.textContent = unprocessed > 0
    ? `Process unprocessed (${unprocessed})`
    : "All files processed";

  updateAllColorsButton.disabled = state.busy || processed === 0;
  updateAllColorsButton.textContent = processed > 0
    ? `Recalculate colors (${processed})`
    : "No processed colors";

  const visibleAnimals = filteredAnimals();
  const visibleChecked = visibleAnimals.filter((animal) => state.selectedIds.has(animal.id)).length;
  selectAllButton.disabled = state.busy || visibleAnimals.length === 0;
  selectAllButton.textContent = visibleChecked === visibleAnimals.length && visibleAnimals.length > 0
    ? "Clear visible checks"
    : "Check visible";
}

function renderAnimalList() {
  state.selectedIds = new Set(selectedBatchIds());

  if (state.animals.length === 0) {
    animalList.innerHTML = `<p class="empty-text">upload animal images to start</p>`;
    renderLibrarySummary();
    return;
  }

  const visibleAnimals = filteredAnimals();
  if (visibleAnimals.length === 0) {
    animalList.innerHTML = `<p class="empty-text">${state.libraryQuery.trim() ? "no animals match this search" : "no files in this filter"}</p>`;
    renderLibrarySummary();
    return;
  }

  animalList.innerHTML = visibleAnimals.map((animal) => `
    <div class="animal-row ${animal.id === state.selectedId ? "selected" : ""} ${state.selectedIds.has(animal.id) ? "checked" : ""}">
      <input
        type="checkbox"
        data-check-id="${escapeHtml(animal.id)}"
        ${state.selectedIds.has(animal.id) ? "checked" : ""}
        aria-label="Select ${escapeHtml(animal.name)}">
      <button type="button" class="animal-open" data-id="${escapeHtml(animal.id)}">
        <span class="animal-name">${escapeHtml(primaryAnimalName(animal))}</span>
        ${secondaryAnimalName(animal) ? `<span class="animal-subname">${escapeHtml(secondaryAnimalName(animal))}</span>` : ""}
        ${sidebarStatusMarkup(animal)}
      </button>
    </div>
  `).join("");
  renderLibrarySummary();
}

function renderSelectedAnimal() {
  const animal = selectedAnimalRecord();
  if (!animal) {
    selectedAnimal.innerHTML = `<p class="empty-text">choose an animal</p>`;
    selectedColors.textContent = "No colors.";
    manualColorList.innerHTML = "";
    processSelectedButton.disabled = true;
    updateColorEditorState(null);
    return;
  }

  state.selectedId = animal.id;
  processSelectedButton.disabled = state.busy;
  updateColorEditorState(animal);
  processSelectedButton.textContent = animal.status === "processed" ? "Reprocess active animal" : "Process active animal";

  selectedAnimal.innerHTML = `
    ${metadataBlockMarkup(animal)}
    ${qualityMarkup(animal)}
    <div class="selected-image-preview">
      <figure>
        <figcaption>Original</figcaption>
        <div class="image-frame">
          <img src="${escapeHtml(animal.originalUrl)}" alt="${escapeHtml(resultImageAlt(animal))}">
        </div>
      </figure>
    </div>
    ${animal.error ? `<p>${escapeHtml(animal.error)}</p>` : ""}
  `;

  const sourceText = colorSourceText(animal);
  selectedColors.innerHTML = `
    ${sourceText ? `<p class="color-source">${escapeHtml(sourceText)}</p>` : ""}
    ${colorMarkup(animal.colors)}
  `;
  manualColorList.innerHTML = colorMarkup(animal.colors, { editable: true });
  updateColorEditorState(animal);
}

function renderResults(matches) {
  const stabilize = colorControlIsDragging();
  const searchColor = normalizeClientHex(colorPicker.value) || "#8C5A44";
  if (!matches) {
    resultSummary.innerHTML = "";
    results.innerHTML = `<p class="empty-text">choose a color to search</p>`;
    if (stabilize) {
      stabilizeSearchScroll();
    }
    return;
  }

  if (matches.length === 0) {
    resultSummary.innerHTML = `
      <strong>0 matches</strong>
      <span>for</span>
      <span class="summary-swatch" style="background:${escapeHtml(searchColor)}"></span>
      <span class="summary-color">${escapeHtml(searchColor)}</span>
    `;
    results.innerHTML = `<p class="empty-text">no matches at this strictness</p>`;
    if (stabilize) {
      stabilizeSearchScroll();
    }
    return;
  }

  results.classList.remove("results-pop");
  resultSummary.innerHTML = `
    <strong>${matches.length} match${matches.length === 1 ? "" : "es"}</strong>
    <span>for</span>
    <span class="summary-swatch" style="background:${escapeHtml(searchColor)}"></span>
    <span class="summary-color">${escapeHtml(searchColor)}</span>
  `;
  results.innerHTML = `
    <div class="result-grid ${matches.length <= 3 ? "few-results" : ""}">${matches.map((match) => `
    <article class="result-tile">
      <div class="result-image">
        <img class="result-image-original" src="${escapeHtml(match.originalUrl)}" alt="${escapeHtml(resultImageAlt(match))}">
        ${resultAltControlMarkup(match)}
      </div>
      <div class="result-info">
        <h4 title="${escapeHtml(primaryAnimalName(match))}">${escapeHtml(primaryAnimalName(match))}</h4>
        ${secondaryAnimalName(match) ? `<span class="result-secondary-name">${escapeHtml(secondaryAnimalName(match))}</span>` : ""}
        <span class="accuracy">${escapeHtml(matchAccuracyLabel(match))}</span>
        ${closestColorMarkup(match.closestColor)}
        ${resultColorMarkup(match.colors)}
      </div>
    </article>
  `).join("")}</div>`;
  if (stabilize) {
    stabilizeSearchScroll();
    return;
  }
  window.requestAnimationFrame(() => results.classList.add("results-pop"));
}

function strictnessLabel() {
  const active = Array.from(strictnessButtons).find((button) => button.classList.contains("active"));
  return active ? active.textContent.trim() : "Balanced";
}

function matchAccuracyLabel(match) {
  const accuracy = Number.isFinite(match.accuracy)
    ? match.accuracy
    : Math.max(0, Math.min(100, Math.round(100 - Number(match.distance || 0))));
  return `${accuracy}% match`;
}

function closestColorMarkup(color) {
  const hex = normalizeClientHex(color);
  if (!hex) {
    return `<p class="closest-color">closest color unavailable</p>`;
  }

  return `
    <p class="closest-color">
      <span class="color-swatch" style="background:${escapeHtml(hex)}"></span>
      <span><span class="closest-label">closest color</span> <span class="closest-value">${escapeHtml(hex)}</span></span>
    </p>
  `;
}

function hexToRgb(hex) {
  const value = normalizeClientHex(hex);
  if (!value) {
    return null;
  }

  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16)
  };
}

function rgbToLab({ r, g, b }) {
  const toLinear = (component) => {
    const normalized = component / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const linearR = toLinear(r);
  const linearG = toLinear(g);
  const linearB = toLinear(b);
  const x = (linearR * 0.4124564 + linearG * 0.3575761 + linearB * 0.1804375) / 0.95047;
  const y = linearR * 0.2126729 + linearG * 0.7151522 + linearB * 0.072175;
  const z = (linearR * 0.0193339 + linearG * 0.119192 + linearB * 0.9503041) / 1.08883;
  const toLabAxis = (value) => value > 0.008856 ? value ** (1 / 3) : (7.787 * value) + (16 / 116);
  const fx = toLabAxis(x);
  const fy = toLabAxis(y);
  const fz = toLabAxis(z);

  return {
    l: (116 * fy) - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians) {
  return (radians * 180) / Math.PI;
}

function normalizeDegrees(degrees) {
  return (degrees + 360) % 360;
}

function hueDegrees(a, b) {
  if (a === 0 && b === 0) {
    return 0;
  }
  return normalizeDegrees(radiansToDegrees(Math.atan2(b, a)));
}

function colorDistanceCiede2000(colorA, colorB) {
  const rgbA = hexToRgb(colorA);
  const rgbB = hexToRgb(colorB);
  if (!rgbA || !rgbB) {
    return Number.POSITIVE_INFINITY;
  }

  const labA = rgbToLab(rgbA);
  const labB = rgbToLab(rgbB);
  const c1 = Math.sqrt((labA.a ** 2) + (labA.b ** 2));
  const c2 = Math.sqrt((labB.a ** 2) + (labB.b ** 2));
  const cBar = (c1 + c2) / 2;
  const cBar7 = cBar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + (25 ** 7))));
  const a1Prime = (1 + g) * labA.a;
  const a2Prime = (1 + g) * labB.a;
  const c1Prime = Math.sqrt((a1Prime ** 2) + (labA.b ** 2));
  const c2Prime = Math.sqrt((a2Prime ** 2) + (labB.b ** 2));
  const h1Prime = hueDegrees(a1Prime, labA.b);
  const h2Prime = hueDegrees(a2Prime, labB.b);
  const deltaLPrime = labB.l - labA.l;
  const deltaCPrime = c2Prime - c1Prime;
  let deltaHPrimeDegrees = h2Prime - h1Prime;

  if (c1Prime * c2Prime === 0) {
    deltaHPrimeDegrees = 0;
  } else if (deltaHPrimeDegrees > 180) {
    deltaHPrimeDegrees -= 360;
  } else if (deltaHPrimeDegrees < -180) {
    deltaHPrimeDegrees += 360;
  }

  const deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(degreesToRadians(deltaHPrimeDegrees / 2));
  const lBarPrime = (labA.l + labB.l) / 2;
  const cBarPrime = (c1Prime + c2Prime) / 2;
  let hBarPrime = h1Prime + h2Prime;

  if (c1Prime * c2Prime === 0) {
    hBarPrime = h1Prime + h2Prime;
  } else if (Math.abs(h1Prime - h2Prime) <= 180) {
    hBarPrime = (h1Prime + h2Prime) / 2;
  } else if (h1Prime + h2Prime < 360) {
    hBarPrime = (h1Prime + h2Prime + 360) / 2;
  } else {
    hBarPrime = (h1Prime + h2Prime - 360) / 2;
  }

  const t = 1
    - (0.17 * Math.cos(degreesToRadians(hBarPrime - 30)))
    + (0.24 * Math.cos(degreesToRadians(2 * hBarPrime)))
    + (0.32 * Math.cos(degreesToRadians((3 * hBarPrime) + 6)))
    - (0.20 * Math.cos(degreesToRadians((4 * hBarPrime) - 63)));
  const deltaTheta = 30 * Math.exp(-(((hBarPrime - 275) / 25) ** 2));
  const cBarPrime7 = cBarPrime ** 7;
  const rC = 2 * Math.sqrt(cBarPrime7 / (cBarPrime7 + (25 ** 7)));
  const sL = 1 + ((0.015 * ((lBarPrime - 50) ** 2)) / Math.sqrt(20 + ((lBarPrime - 50) ** 2)));
  const sC = 1 + (0.045 * cBarPrime);
  const sH = 1 + (0.015 * cBarPrime * t);
  const rT = -Math.sin(degreesToRadians(2 * deltaTheta)) * rC;
  const lTerm = deltaLPrime / sL;
  const cTerm = deltaCPrime / sC;
  const hTerm = deltaHPrime / sH;

  return Math.sqrt((lTerm ** 2) + (cTerm ** 2) + (hTerm ** 2) + (rT * cTerm * hTerm));
}

function localSearchMatches(color) {
  return state.animals
    .filter((animal) => animal.status === "processed" && animal.colors?.length > 0)
    .map((animal) => {
      let closestColor = animal.colors[0];
      let distance = Number.POSITIVE_INFINITY;

      animal.colors.forEach((storedColor) => {
        const currentDistance = colorDistanceCiede2000(color, storedColor);
        if (currentDistance < distance) {
          closestColor = storedColor;
          distance = currentDistance;
        }
      });

      return {
        ...animal,
        closestColor,
        distance,
        accuracy: Math.max(0, Math.min(100, Math.round(100 - distance)))
      };
    })
    .filter((match) => match.distance <= searchThreshold)
    .sort((a, b) => a.distance - b.distance || primaryAnimalName(a).localeCompare(primaryAnimalName(b)));
}

function viewModeFromHash() {
  return window.location.hash === "#search" ? "search" : "demo";
}

function applyViewMode() {
  const mode = viewModeFromHash();
  document.body.dataset.view = mode;
  viewToggle.textContent = mode === "search" ? "Back to demo" : "Full color search";
  viewToggle.setAttribute("aria-pressed", mode === "search" ? "true" : "false");
  if (mode === "search") {
    searchMatches({ quiet: true, force: true }).catch((error) => setStatus(error.message));
  }
}

function render() {
  renderAnimalList();
  renderSelectedAnimal();
}

function scrollToSelectedAnimalReview() {
  const previewSection = document.querySelector(".preview-section");
  if (!previewSection) {
    return;
  }
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.requestAnimationFrame(() => {
    previewSection.scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion ? "auto" : "smooth"
    });
  });
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function loadAnimals() {
  setStatus("Loading animals...");
  const data = await requestJson("/api/animals");
  state.animals = data.animals;
  if (!state.selectedId || !state.animals.some((animal) => animal.id === state.selectedId)) {
    state.selectedId = state.animals[0]?.id || null;
  }
  render();
  setStatus("");
}

async function searchMatches(options = {}) {
  if (state.busy && !options.force) {
    return;
  }

  const color = normalizeClientHex(colorPicker.value);
  if (!color) {
    setStatus("Use a #RRGGBB color.");
    return;
  }

  if (!options.quiet) {
    setStatus("Searching...");
  }
  renderResults(localSearchMatches(color));
  setStatus("");
}

function reviewedColorList(colors) {
  const normalized = [];
  colors.forEach((color) => {
    const hex = normalizeClientHex(color);
    if (hex && !normalized.includes(hex)) {
      normalized.push(hex);
    }
  });
  return normalized.slice(0, MAX_MANUAL_COLORS);
}

function pushColorUndo(animal) {
  colorUndoStack.push({
    id: animal.id,
    colors: reviewedColorList(animal.colors || [])
  });

  if (colorUndoStack.length > 25) {
    colorUndoStack.shift();
  }
}

function clearColorUndo(ids = null) {
  if (!ids) {
    colorUndoStack = [];
    return;
  }

  const idSet = new Set(ids);
  colorUndoStack = colorUndoStack.filter((entry) => !idSet.has(entry.id));
}

async function saveManualColors(colors, options = {}) {
  const animal = selectedAnimalRecord();
  if (!animal) {
    setStatus("Select an animal first.");
    return;
  }

  const nextColors = reviewedColorList(colors);
  if (nextColors.length === 0) {
    setStatus("Keep at least one searchable color.");
    return;
  }

  if (options.pushUndo !== false) {
    pushColorUndo(animal);
  }

  setBusy(true);
  try {
    const data = await requestJson(`/api/colors/${encodeURIComponent(animal.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colors: nextColors })
    });
    state.animals = data.animals;
    render();
    await searchMatches({ quiet: true, force: true });
    setStatus(options.message || "Manual colors saved.");
  } catch (error) {
    if (options.pushUndo !== false) {
      colorUndoStack.pop();
    }
    setStatus(error.message);
  } finally {
    setBusy(false);
    renderSelectedAnimal();
  }
}

async function addManualColor(color) {
  const animal = selectedAnimalRecord();
  const hex = normalizeClientHex(color);
  if (!animal || !hex) {
    return;
  }

  manualColorInput.value = hex.toLowerCase();
  const currentColors = reviewedColorList(animal.colors || []);
  if (currentColors.includes(hex)) {
    setStatus(`${hex} is already stored for this animal.`);
    return;
  }

  if (currentColors.length >= MAX_MANUAL_COLORS) {
    setStatus(`Keep this to ${MAX_MANUAL_COLORS} searchable colors or fewer.`);
    return;
  }

  await saveManualColors([...currentColors, hex], {
    message: `Added ${hex} as a reviewed searchable color.`
  });
}

async function removeManualColor(color) {
  const animal = selectedAnimalRecord();
  if (!animal) {
    return;
  }

  const hex = normalizeClientHex(color);
  const currentColors = reviewedColorList(animal.colors || []);
  if (!hex || !currentColors.includes(hex)) {
    return;
  }

  if (currentColors.length <= 1) {
    setStatus("Keep at least one searchable color.");
    return;
  }

  await saveManualColors(currentColors.filter((storedColor) => storedColor !== hex), {
    message: `Removed ${hex} from searchable colors.`
  });
}

async function saveQualityReview(reviewState) {
  const animal = selectedAnimalRecord();
  if (!animal) {
    return;
  }

  setBusy(true);
  try {
    const data = await requestJson(`/api/quality/${encodeURIComponent(animal.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewState })
    });
    state.animals = data.animals;
    render();
    await searchMatches({ quiet: true, force: true });
    setStatus(reviewState === "reviewed" ? "Marked this check as reviewed." : "Restored automatic quality check.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
    renderSelectedAnimal();
  }
}

async function chooseManualColor() {
  const animal = selectedAnimalRecord();
  if (!animal?.hasMask) {
    setStatus("Process this animal before adding colors.");
    return;
  }

  if ("EyeDropper" in window) {
    try {
      const result = await new window.EyeDropper().open();
      const hex = normalizeClientHex(result.sRGBHex);
      if (!hex) {
        setStatus("The eyedropper returned an invalid color. Try the color swatch next to the button.");
        return;
      }
      manualColorInput.value = hex.toLowerCase();
      await addManualColor(hex);
      return;
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      setStatus("Eyedropper failed. Use the color swatch next to the button.");
    }
  }

  manualColorInput.value = currentHex().toLowerCase();
  manualColorInput.click();
}

async function processAnimals(ids, label, estimatedSeconds) {
  if (ids && ids.length === 0) {
    setStatus("Select at least one animal.");
    return;
  }

  setStatus(label);
  startProgress(label, estimatedSeconds);
  try {
    const body = {
      model: processModelSelect.value
    };
    if (ids) {
      body.ids = ids;
    }

    const data = await requestJson("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    state.animals = data.animals;
    clearColorUndo(ids);
    render();
    setStatus(`Processing finished with ${processModelLabels[data.model] || data.model}.`);
    stopProgress(true);
    await searchMatches();
  } catch (error) {
    setStatus(error.message);
    stopProgress(false);
  }
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!imageInput.files || imageInput.files.length === 0) {
    setStatus("Choose at least one image.");
    return;
  }

  setStatus("Uploading...");
  const formData = new FormData(uploadForm);
  try {
    const data = await requestJson("/api/upload", {
      method: "POST",
      body: formData
    });
    state.animals = data.animals;
    state.selectedId = data.uploaded?.[0]?.id || state.animals[0]?.id || null;
    state.selectedIds.clear();
    imageInput.value = "";
    render();
    setStatus("Uploaded and saved to ./animals.");
  } catch (error) {
    setStatus(error.message);
  }
});

refreshButton.addEventListener("click", () => {
  loadAnimals()
    .then(() => searchMatches())
    .catch((error) => setStatus(error.message));
});

selectAllButton.addEventListener("click", () => {
  const visibleAnimals = filteredAnimals();
  const visibleIds = visibleAnimals.map((animal) => animal.id);
  const allVisibleChecked = visibleIds.length > 0 && visibleIds.every((id) => state.selectedIds.has(id));
  if (allVisibleChecked) {
    visibleIds.forEach((id) => state.selectedIds.delete(id));
  } else {
    visibleIds.forEach((id) => state.selectedIds.add(id));
  }
  renderAnimalList();
});

libraryFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-library-filter]");
  if (!button) {
    return;
  }

  state.libraryFilter = button.dataset.libraryFilter || "all";
  renderAnimalList();
});

librarySearch.addEventListener("input", () => {
  state.libraryQuery = librarySearch.value;
  renderAnimalList();
});

animalList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-check-id]");
  if (!checkbox) {
    return;
  }

  if (checkbox.checked) {
    state.selectedIds.add(checkbox.dataset.checkId);
  } else {
    state.selectedIds.delete(checkbox.dataset.checkId);
  }
  renderAnimalList();
});

animalList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-id]");
  if (!button) {
    return;
  }
  state.selectedId = button.dataset.id;
  render();
  scrollToSelectedAnimalReview();
});

selectedAnimal.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quality-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.qualityAction;
  saveQualityReview(action === "reviewed" ? "reviewed" : null).catch((error) => setStatus(error.message));
});

manualColorList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-color]");
  if (!button) {
    return;
  }
  removeManualColor(button.dataset.deleteColor).catch((error) => setStatus(error.message));
});

addColorButton.addEventListener("click", () => {
  chooseManualColor().catch((error) => setStatus(error.message));
});

manualColorInput.addEventListener("change", () => {
  addManualColor(manualColorInput.value).catch((error) => setStatus(error.message));
});

undoColorButton.addEventListener("click", async () => {
  const animal = selectedAnimalRecord();
  const previous = colorUndoStack.pop();
  if (!animal || !previous || previous.id !== animal.id) {
    updateColorEditorState(animal);
    setStatus("No manual color edit to undo for this animal.");
    return;
  }

  await saveManualColors(previous.colors, {
    pushUndo: false,
    message: "Manual color edit undone."
  });
});

processSelectedButton.addEventListener("click", async () => {
  if (!state.selectedId) {
    setStatus("Select an animal first.");
    return;
  }

  const animal = selectedAnimalRecord();
  await processAnimals([state.selectedId], `Processing ${animal?.name || "active animal"}...`, 35);
});

refreshColorsButton.addEventListener("click", async () => {
  if (!state.selectedId) {
    setStatus("Select an animal first.");
    return;
  }

  const animal = selectedAnimalRecord();
  if (!animal?.hasMask) {
    setStatus("Process this animal before refreshing colors.");
    return;
  }

  setBusy(true);
  setStatus(`Recalculating colors for ${animal.name} from the original image and cutout mask...`);
  try {
    const data = await requestJson("/api/recolor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [state.selectedId] })
    });
    state.animals = data.animals;
    clearColorUndo([state.selectedId]);
    render();
    await searchMatches({ quiet: true });
    setStatus("Automatic colors updated from the original image and cutout mask.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
    renderSelectedAnimal();
  }
});

updateAllColorsButton.addEventListener("click", async () => {
  const processedCount = state.animals.filter((animal) => animal.status === "processed" && animal.hasMask).length;
  if (processedCount === 0) {
    setStatus("No processed animals have cutouts to update.");
    return;
  }

  startProgress(`Recalculating colors for ${processedCount} processed animals...`, Math.max(8, processedCount * 0.35));
  try {
    const data = await requestJson("/api/recolor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    state.animals = data.animals;
    clearColorUndo();
    render();
    await searchMatches({ quiet: true });
    stopProgress(true);
    setStatus(`Recalculated colors for ${data.recolored} processed animals from original images and cutout masks.`);
  } catch (error) {
    stopProgress(false);
    setStatus(error.message);
  }
});

processBatchButton.addEventListener("click", async () => {
  const ids = selectedBatchIds();
  await processAnimals(ids, `Processing ${ids.length} checked file${ids.length === 1 ? "" : "s"}...`, Math.max(35, ids.length * 28));
});

processAllButton.addEventListener("click", async () => {
  const count = unprocessedAnimals().length;
  if (count === 0) {
    return;
  }

  await processAnimals(null, `Processing ${count} unprocessed animal${count === 1 ? "" : "s"}...`, Math.max(35, count * 28));
});

colorPicker.addEventListener("input", () => {
  const color = normalizeClientHex(colorPicker.value);
  if (color) {
    selectSearchColor(color, true);
  }
});

colorPicker.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchMatches().catch((error) => setStatus(error.message));
  }
});

Object.values(rgbInputs).forEach((input) => {
  input.addEventListener("input", () => {
    const color = colorFromRgbInputs();
    if (!color) {
      return;
    }
    selectSearchColor(color, true);
  });

  input.addEventListener("blur", () => {
    const color = colorFromRgbInputs();
    if (color) {
      selectSearchColor(color, true);
      return;
    }
    syncSelectedColor();
  });
});

colorPalette.addEventListener("click", (event) => {
  const button = event.target.closest("[data-color]");
  if (!button) {
    return;
  }
  selectSearchColor(button.dataset.color, true);
});

colorWheel.addEventListener("pointerdown", (event) => {
  draggingWheel = true;
  beginColorDrag();
  colorWheel.setPointerCapture(event.pointerId);
  updateWheelFromPointer(event, true);
});

colorWheel.addEventListener("pointermove", (event) => {
  if (!draggingWheel) {
    return;
  }
  updateWheelFromPointer(event, true);
});

colorWheel.addEventListener("pointerup", (event) => {
  draggingWheel = false;
  releasePointerCapture(colorWheel, event.pointerId);
  scheduleSearch();
  endColorDrag();
});

colorWheel.addEventListener("pointercancel", (event) => {
  draggingWheel = false;
  releasePointerCapture(colorWheel, event.pointerId);
  endColorDrag();
});

brightnessStrip.addEventListener("pointerdown", (event) => {
  draggingBrightness = true;
  beginColorDrag();
  brightnessStrip.setPointerCapture(event.pointerId);
  updateBrightnessFromPointer(event, true);
});

brightnessStrip.addEventListener("pointermove", (event) => {
  if (!draggingBrightness) {
    return;
  }
  updateBrightnessFromPointer(event, true);
});

brightnessStrip.addEventListener("pointerup", (event) => {
  draggingBrightness = false;
  releasePointerCapture(brightnessStrip, event.pointerId);
  scheduleSearch();
  endColorDrag();
});

brightnessStrip.addEventListener("pointercancel", (event) => {
  draggingBrightness = false;
  releasePointerCapture(brightnessStrip, event.pointerId);
  endColorDrag();
});

brightnessStrip.addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  if (event.key === "Home") {
    state.hsv.v = 1;
  } else if (event.key === "End") {
    state.hsv.v = 0.08;
  } else {
    const direction = event.key === "ArrowUp" ? 1 : -1;
    state.hsv.v = Math.max(0.08, Math.min(1, state.hsv.v + (direction * 0.04)));
  }
  syncSelectedColor();
  scheduleSearch();
});

strictnessButtons.forEach((button) => {
  button.addEventListener("click", () => {
    strictnessButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    searchThreshold = Number(button.dataset.threshold);
    strictnessHelp.textContent = strictnessCopy[searchThreshold];
    searchMatches().catch((error) => setStatus(error.message));
  });
});

viewToggle.addEventListener("click", () => {
  window.location.hash = viewModeFromHash() === "search" ? "#demo" : "#search";
  applyViewMode();
});

window.addEventListener("hashchange", applyViewMode);

renderColorPalette();
applyViewMode();
selectSearchColor("#8C5A44", false);
loadAnimals()
  .then(() => {
    applyViewMode();
    return searchMatches();
  })
  .catch((error) => setStatus(error.message));
