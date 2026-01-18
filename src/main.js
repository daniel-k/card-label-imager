import "./style.css";
import { PDFDocument } from "pdf-lib";

const canvas = document.getElementById("cardCanvas");
const ctx = canvas.getContext("2d");
const imageInput = document.getElementById("imageInput");
const urlInput = document.getElementById("urlInput");
const loadUrlBtn = document.getElementById("loadUrl");
const scaleRange = document.getElementById("scaleRange");
const scaleReadout = document.getElementById("scaleReadout");
const addToPageBtn = document.getElementById("addToPage");
const downloadPdfBtn = document.getElementById("downloadPdf");
const downloadSetupBtn = document.getElementById("downloadSetup");
const importSetupBtn = document.getElementById("importSetup");
const importSetupInput = document.getElementById("importSetupInput");
const clearPageBtn = document.getElementById("clearPage");
const resetViewBtn = document.getElementById("resetView");
const pagePreview = document.getElementById("pagePreview");
const statusEl = document.getElementById("status");
const pdfProgress = document.getElementById("pdfProgress");
const pdfProgressBar = document.getElementById("pdfProgressBar");
const pdfProgressMeta = document.getElementById("pdfProgressMeta");
const oversizeInput = document.getElementById("oversizeInput");
const toggleTrimLineBtn = document.getElementById("toggleTrimLine");
const oversizeMeta = document.getElementById("oversizeMeta");
const labelMeta = document.getElementById("labelMeta");
const trimLineMeta = document.getElementById("trimLineMeta");

const PX_PER_MM = 10;
const KEYBOARD_MOVE_STEP = 10;
const KEYBOARD_ZOOM_STEP = 0.05;
const PDF_IMAGE_FORMAT = "image/jpeg";
const PDF_IMAGE_QUALITY = 0.85;
const PDF_IMAGE_BACKGROUND = "#ffffff";
const SOURCE_IMAGE_QUALITY = 0.9;
const STORAGE_KEY = "card-label-imager-state";
const STORAGE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 300;
const PREVIEW_RESIZE_DEBOUNCE_MS = 120;

const baseCard = {
  widthMm: 85.6,
  heightMm: 53.98,
  radiusMm: 3.6,
};

const layout = {
  columns: 2,
  rows: 4,
  a4WidthMm: 210,
  a4HeightMm: 297,
  marginMm: 15,
  oversizeMm: 1,
};

const render = {
  labelWidthPx: 0,
  labelHeightPx: 0,
  cardWidthPx: 0,
  cardHeightPx: 0,
  cardRadiusPx: 0,
  oversizePx: 0,
};

let showBleedOverlay = true;
let showTrimGuide = true;
let includeTrimInExport = false;

const state = {
  img: null,
  baseScale: 1,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  startOffsetX: 0,
  startOffsetY: 0,
  sourceDataUrl: null,
};

const cards = [];
const addToPageLabel = addToPageBtn?.textContent ?? "Add to page";
const downloadPdfLabel = downloadPdfBtn?.textContent ?? "Download PDF";
let isDownloading = false;
let persistTimeout = null;
let hasPersistError = false;
let previewResizeTimeout = null;
let editingCardId = null;
let cardPreviewRefreshToken = 0;

function getCardCount() {
  return cards.reduce((count, card) => count + (card ? 1 : 0), 0);
}

function trimTrailingEmptySlots() {
  let lastIndex = cards.length - 1;
  while (lastIndex >= 0 && !cards[lastIndex]) {
    lastIndex -= 1;
  }
  cards.length = lastIndex + 1;
}

function ensureSlots(totalSlots) {
  while (cards.length < totalSlots) {
    cards.push(null);
  }
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setEditingCardId(cardId) {
  editingCardId = cardId;
  if (!addToPageBtn) {
    return;
  }
  addToPageBtn.textContent = cardId ? "Update card" : addToPageLabel;
}

function setPdfBusy(isBusy) {
  if (!downloadPdfBtn) {
    return;
  }
  downloadPdfBtn.disabled = isBusy;
  downloadPdfBtn.textContent = isBusy ? "Building PDF..." : downloadPdfLabel;
}

function setPdfProgress(visible, current = 0, total = 0) {
  if (!pdfProgress || !pdfProgressBar || !pdfProgressMeta) {
    return;
  }
  pdfProgress.classList.toggle("active", visible);
  pdfProgress.setAttribute("aria-hidden", (!visible).toString());
  if (!visible) {
    pdfProgressBar.style.width = "0%";
    pdfProgressMeta.textContent = "Preparing PDF...";
    return;
  }
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  pdfProgressBar.style.width = `${percent}%`;
  const label =
    total > 0
      ? `Generating PDF... ${current} of ${total}`
      : "Generating PDF...";
  pdfProgressMeta.textContent = label;
}

function safeRevokeObjectUrl(url) {
  if (typeof url === "string" && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

function buildPersistedState() {
  return {
    version: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    layout: {
      oversizeMm: layout.oversizeMm,
    },
    settings: {
      includeTrimInExport,
    },
    image:
      state.img && state.sourceDataUrl
        ? {
            dataUrl: state.sourceDataUrl,
            baseScale: state.baseScale,
            zoom: state.zoom,
            offsetX: state.offsetX,
            offsetY: state.offsetY,
          }
        : null,
    cards: cards.map((card) =>
      card && typeof card.dataUrl === "string"
        ? {
            id: card.id,
            dataUrl: card.dataUrl,
            sourceDataUrl:
              typeof card.sourceDataUrl === "string"
                ? card.sourceDataUrl
                : null,
            imageState:
              card.imageState && typeof card.imageState === "object"
                ? {
                    baseScale: card.imageState.baseScale,
                    zoom: card.imageState.zoom,
                    offsetX: card.imageState.offsetX,
                    offsetY: card.imageState.offsetY,
                  }
                : null,
          }
        : null,
    ),
  };
}

function persistState() {
  try {
    const payload = JSON.stringify(buildPersistedState());
    localStorage.setItem(STORAGE_KEY, payload);
    hasPersistError = false;
  } catch (error) {
    if (!hasPersistError) {
      setStatus(
        "Could not save to local storage. Use Download setup for backups.",
      );
      hasPersistError = true;
    }
  }
}

function schedulePersist() {
  if (persistTimeout) {
    clearTimeout(persistTimeout);
  }
  persistTimeout = setTimeout(() => {
    persistTimeout = null;
    persistState();
  }, PERSIST_DEBOUNCE_MS);
}

function captureSourceFromImage() {
  if (!state.img) {
    return null;
  }
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = state.img.width;
  sourceCanvas.height = state.img.height;
  const sourceCtx = sourceCanvas.getContext("2d");
  if (!sourceCtx) {
    return null;
  }
  sourceCtx.drawImage(state.img, 0, 0);
  const dataUrl = sourceCanvas.toDataURL("image/jpeg", SOURCE_IMAGE_QUALITY);
  state.sourceDataUrl = dataUrl;
  schedulePersist();
  return dataUrl;
}

function roundedRectPath(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function formatMm(value) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function getLabelSizeMm() {
  return {
    width: baseCard.widthMm + layout.oversizeMm * 2,
    height: baseCard.heightMm + layout.oversizeMm * 2,
  };
}

function updateLayoutMeta() {
  const labelSize = getLabelSizeMm();
  if (oversizeMeta) {
    oversizeMeta.textContent = `${formatMm(layout.oversizeMm)} mm per edge`;
  }
  if (labelMeta) {
    labelMeta.textContent = `${formatMm(labelSize.width)} × ${formatMm(
      labelSize.height,
    )} mm`;
  }
}

function updateTrimLineToggle() {
  const label = includeTrimInExport ? "On" : "Off";
  if (toggleTrimLineBtn) {
    toggleTrimLineBtn.textContent = `Trim line in PDF: ${label}`;
    toggleTrimLineBtn.setAttribute(
      "aria-pressed",
      includeTrimInExport.toString(),
    );
  }
  if (trimLineMeta) {
    trimLineMeta.textContent = label;
  }
}

function updateOversizeLock() {
  if (!oversizeInput) {
    return;
  }
  oversizeInput.disabled = false;
  oversizeInput.removeAttribute("aria-disabled");
  if (getCardCount() > 0) {
    oversizeInput.title = "Updates all cards on the sheet.";
  } else {
    oversizeInput.removeAttribute("title");
  }
}

function updateRenderMetrics() {
  const labelSize = getLabelSizeMm();
  render.cardWidthPx = Math.round(baseCard.widthMm * PX_PER_MM);
  render.cardHeightPx = Math.round(baseCard.heightMm * PX_PER_MM);
  render.cardRadiusPx = Math.round(baseCard.radiusMm * PX_PER_MM);
  render.oversizePx = layout.oversizeMm * PX_PER_MM;
  render.labelWidthPx = Math.round(labelSize.width * PX_PER_MM);
  render.labelHeightPx = Math.round(labelSize.height * PX_PER_MM);
  canvas.width = render.labelWidthPx;
  canvas.height = render.labelHeightPx;
  updateLayoutMeta();
}

function getTrimRect() {
  return {
    x: render.oversizePx,
    y: render.oversizePx,
    width: render.cardWidthPx,
    height: render.cardHeightPx,
    radius: render.cardRadiusPx,
  };
}

function clipToLabel() {
  clipContextToLabel(ctx);
}

function clipContextToLabel(context) {
  if (render.oversizePx === 0) {
    roundedRectPath(
      context,
      0,
      0,
      render.labelWidthPx,
      render.labelHeightPx,
      render.cardRadiusPx,
    );
  } else {
    context.beginPath();
    context.rect(0, 0, render.labelWidthPx, render.labelHeightPx);
  }
  context.clip();
}

function drawBleedOverlay() {
  if (!showBleedOverlay || render.oversizePx <= 0) {
    return;
  }
  const trim = getTrimRect();
  ctx.save();
  ctx.fillStyle = "rgba(31, 43, 42, 0.06)";
  ctx.beginPath();
  ctx.rect(0, 0, render.labelWidthPx, render.labelHeightPx);
  roundedRectPath(ctx, trim.x, trim.y, trim.width, trim.height, trim.radius);
  ctx.fill("evenodd");
  ctx.restore();
}

function drawTrimGuide() {
  if (!showTrimGuide) {
    return;
  }
  drawTrimLine(ctx);
}

function drawTrimLine(context) {
  const trim = getTrimRect();
  context.save();
  context.strokeStyle = "rgba(42, 106, 115, 0.6)";
  context.lineWidth = 3;
  roundedRectPath(
    context,
    trim.x,
    trim.y,
    trim.width,
    trim.height,
    trim.radius,
  );
  context.stroke();
  context.restore();
}

function drawPlaceholder() {
  ctx.save();
  clipToLabel();
  ctx.fillStyle = "#f1e7d8";
  ctx.fillRect(0, 0, render.labelWidthPx, render.labelHeightPx);
  ctx.strokeStyle = "rgba(31, 43, 42, 0.08)";
  ctx.lineWidth = 2;
  for (let i = -render.labelHeightPx; i < render.labelWidthPx; i += 40) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + render.labelHeightPx, render.labelHeightPx);
    ctx.stroke();
  }
  ctx.restore();

  drawBleedOverlay();
  drawTrimGuide();

  ctx.fillStyle = "#516261";
  ctx.font = '24px "Space Grotesk"';
  ctx.textAlign = "center";
  ctx.fillText(
    "Upload, paste, or load an image URL to start",
    render.labelWidthPx / 2,
    render.labelHeightPx / 2 + 8,
  );
}

function drawCard() {
  ctx.clearRect(0, 0, render.labelWidthPx, render.labelHeightPx);

  if (!state.img) {
    drawPlaceholder();
    return;
  }

  ctx.save();
  clipToLabel();

  const scale = state.baseScale * state.zoom;
  const imageWidth = state.img.width * scale;
  const imageHeight = state.img.height * scale;
  const x = render.labelWidthPx / 2 - imageWidth / 2 + state.offsetX;
  const y = render.labelHeightPx / 2 - imageHeight / 2 + state.offsetY;

  ctx.drawImage(state.img, x, y, imageWidth, imageHeight);
  ctx.restore();

  drawBleedOverlay();
  drawTrimGuide();
}

function clampOffset(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getOffsetBounds() {
  if (!state.img) {
    return {
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
    };
  }
  const scale = state.baseScale * state.zoom;
  const imageWidth = state.img.width * scale;
  const imageHeight = state.img.height * scale;
  const maxOffsetX = Math.max(0, (imageWidth - render.labelWidthPx) / 2);
  const maxOffsetY = Math.max(0, (imageHeight - render.labelHeightPx) / 2);

  return {
    minX: -maxOffsetX,
    maxX: maxOffsetX,
    minY: -maxOffsetY,
    maxY: maxOffsetY,
  };
}

function clampOffsets() {
  const { minX, maxX, minY, maxY } = getOffsetBounds();
  state.offsetX = clampOffset(state.offsetX, minX, maxX);
  state.offsetY = clampOffset(state.offsetY, minY, maxY);
}

function getScaleBounds() {
  const min = Number(scaleRange.min);
  const max = Number(scaleRange.max);
  return {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 1,
  };
}

function getScaleStep() {
  const step = Number(scaleRange.step);
  return Number.isFinite(step) && step > 0 ? step : KEYBOARD_ZOOM_STEP;
}

function getStepDecimals(step) {
  const [, decimals = ""] = step.toString().split(".");
  return decimals.length;
}

function resetView() {
  if (!state.img) {
    return;
  }
  const fitScale = Math.max(
    render.labelWidthPx / state.img.width,
    render.labelHeightPx / state.img.height,
  );
  state.baseScale = fitScale;
  state.zoom = 1;
  state.offsetX = 0;
  state.offsetY = 0;
  clampOffsets();
  scaleRange.value = "1";
  scaleReadout.textContent = "100%";
  drawCard();
  schedulePersist();
}

function applySavedImageState(saved) {
  if (!state.img || !saved) {
    return;
  }
  const baseScale = Number(saved.baseScale);
  if (!Number.isFinite(baseScale) || baseScale <= 0) {
    resetView();
    return;
  }
  const { min, max } = getScaleBounds();
  state.baseScale = baseScale;
  const zoomValue = Number(saved.zoom);
  const zoom = Number.isFinite(zoomValue) ? zoomValue : 1;
  state.zoom = clampOffset(zoom, min, max);
  const offsetX = Number(saved.offsetX);
  const offsetY = Number(saved.offsetY);
  state.offsetX = Number.isFinite(offsetX) ? offsetX : 0;
  state.offsetY = Number.isFinite(offsetY) ? offsetY : 0;
  clampOffsets();
  const step = getScaleStep();
  const decimals = getStepDecimals(step);
  scaleRange.value = state.zoom.toFixed(decimals);
  scaleReadout.textContent = `${Math.round(state.zoom * 100)}%`;
  drawCard();
  schedulePersist();
}

function applyOversize(value, options = {}) {
  const {
    announce = false,
    clearCards = false,
    persist = true,
    refreshCards = true,
  } = options;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return;
  }
  layout.oversizeMm = Math.max(0, numericValue);
  if (oversizeInput) {
    oversizeInput.value = layout.oversizeMm.toString();
  }
  const hadCards = getCardCount() > 0;
  if (hadCards && clearCards) {
    cards.length = 0;
    setEditingCardId(null);
    renderPagePreview();
  }
  updateRenderMetrics();
  if (state.img) {
    clampOffsets();
    drawCard();
  } else {
    drawCard();
  }
  renderPagePreview();
  if (hadCards && !clearCards && refreshCards) {
    refreshCardPreviews();
  }
  if (persist) {
    schedulePersist();
  }
  if (announce) {
    if (hadCards && clearCards) {
      setStatus("Oversize updated. Sheet cleared.");
      return;
    }
    if (hadCards) {
      setStatus("Oversize updated. Cards refreshed.");
      return;
    }
    setStatus("Oversize updated.");
  }
}

function updateZoom(value) {
  const zoomValue = Number(value);
  if (!Number.isFinite(zoomValue)) {
    return;
  }
  state.zoom = zoomValue;
  scaleReadout.textContent = `${Math.round(state.zoom * 100)}%`;
  clampOffsets();
  drawCard();
  schedulePersist();
}

function loadImage(source, options = {}) {
  const { successMessage, errorMessage, applyState, silent, clearEditing } =
    options;
  return new Promise((resolve) => {
    const isStringSource = typeof source === "string";
    state.sourceDataUrl = isStringSource ? source : null;
    const img = new Image();
    const imgSrc = isStringSource ? source : URL.createObjectURL(source);
    img.onload = () => {
      safeRevokeObjectUrl(imgSrc);
      state.img = img;
      captureSourceFromImage();
      if (applyState) {
        applySavedImageState(applyState);
      } else {
        resetView();
      }
      if (clearEditing) {
        setEditingCardId(null);
      }
      if (!silent) {
        setStatus(
          successMessage ??
            "Drag or use the arrow keys to position it. Use + and - to zoom.",
        );
      }
      resolve(true);
    };
    img.onerror = () => {
      safeRevokeObjectUrl(imgSrc);
      if (!silent) {
        setStatus(
          errorMessage ?? "Could not load that image. Try another file or URL.",
        );
      }
      resolve(false);
    };
    img.src = imgSrc;
  });
}

function handlePaste(event) {
  const items = event.clipboardData?.items;
  if (!items || items.length === 0) {
    return;
  }

  const imageItem = Array.from(items).find((item) =>
    item.type.startsWith("image/"),
  );
  if (!imageItem) {
    if (event.target === urlInput) {
      return;
    }
    setStatus(
      "Clipboard does not contain an image. Try copying an image first.",
    );
    return;
  }

  const file = imageItem.getAsFile();
  if (!file) {
    setStatus("Could not read image from clipboard.");
    return;
  }

  loadImage(file, {
    successMessage:
      "Image pasted from clipboard. Drag or use the arrow keys to position it. Use + and - to zoom.",
    clearEditing: true,
  });
}

function parseUrlList(rawInput) {
  if (!rawInput) {
    return [];
  }
  return rawInput
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function fetchImageBlob(rawUrl) {
  let resolvedUrl;
  try {
    resolvedUrl = new URL(rawUrl, window.location.href).toString();
  } catch (error) {
    return { error: "Enter a valid image URL." };
  }

  try {
    const response = await fetch(resolvedUrl);
    if (!response.ok) {
      return {
        error: `Could not fetch the image (HTTP ${response.status}).`,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    const blob = await response.blob();
    const blobType = blob.type || contentType;
    if (blobType && !blobType.startsWith("image/")) {
      return { error: "That URL does not point to an image file." };
    }
    return { blob };
  } catch (error) {
    return {
      error:
        "Could not load image from URL. Check the address and CORS settings.",
    };
  }
}

async function loadImageFromUrl(rawUrl) {
  setStatus("Loading image from URL...");
  const result = await fetchImageBlob(rawUrl);
  if (!result?.blob) {
    setStatus(
      result?.error ??
        "Could not load image from URL. Check the address and CORS settings.",
    );
    return false;
  }

  return loadImage(result.blob, {
    successMessage:
      "Image loaded from URL. Drag or use the arrow keys to position it. Use + and - to zoom.",
    errorMessage: "Could not load that image. Try another URL.",
    clearEditing: true,
  });
}

async function loadImagesFromUrlBatch(urls) {
  if (!urls.length) {
    return;
  }
  const addedIndices = [];
  let failedCount = 0;

  for (let i = 0; i < urls.length; i += 1) {
    setStatus(`Loading ${i + 1} of ${urls.length} image URLs...`);
    const result = await fetchImageBlob(urls[i]);
    if (!result?.blob) {
      failedCount += 1;
      continue;
    }

    const loaded = await loadImage(result.blob, {
      silent: true,
      clearEditing: true,
    });
    if (!loaded) {
      failedCount += 1;
      continue;
    }

    const cardItem = createCardItemFromState();
    if (!cardItem) {
      failedCount += 1;
      continue;
    }
    const index = appendCardItem(cardItem);
    addedIndices.push(index);
  }

  if (addedIndices.length === 0) {
    setStatus("Could not load any of those URLs.");
    return;
  }

  renderPagePreview();
  schedulePersist();
  const addedCount = addedIndices.length;
  const cardLabel = addedCount === 1 ? "card" : "cards";
  const urlLabel = urls.length === 1 ? "URL" : "URLs";
  const failureLine =
    failedCount > 0
      ? ` ${failedCount} of ${urls.length} ${urlLabel} failed.`
      : "";
  const successMessage = `Added ${addedCount} ${cardLabel} from ${urls.length} ${urlLabel}.${failureLine} Editing card ${addedIndices[0] + 1}. Adjust framing, then click Update card.`;
  editCard(addedIndices[0], { successMessage });
}

function getPointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function onPointerDown(event) {
  if (!state.img) {
    return;
  }
  state.dragging = true;
  const pos = getPointerPosition(event);
  state.dragStartX = pos.x;
  state.dragStartY = pos.y;
  state.startOffsetX = state.offsetX;
  state.startOffsetY = state.offsetY;
  canvas.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!state.dragging) {
    return;
  }
  const pos = getPointerPosition(event);
  state.offsetX = state.startOffsetX + (pos.x - state.dragStartX);
  state.offsetY = state.startOffsetY + (pos.y - state.dragStartY);
  clampOffsets();
  drawCard();
}

function onPointerUp(event) {
  if (!state.dragging) {
    return;
  }
  state.dragging = false;
  canvas.releasePointerCapture(event.pointerId);
  schedulePersist();
}

function isEditableTarget(target) {
  if (!target) {
    return false;
  }
  const tagName = target.tagName;
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    target.isContentEditable
  );
}

function handleKeyboardMove(deltaX, deltaY) {
  state.offsetX += deltaX;
  state.offsetY += deltaY;
  clampOffsets();
  drawCard();
  schedulePersist();
}

function handleKeyboardZoom(direction) {
  const { min, max } = getScaleBounds();
  const step = getScaleStep();
  const decimals = getStepDecimals(step);
  const next = clampOffset(state.zoom + direction * step, min, max);
  const snapped = clampOffset(Math.round(next / step) * step, min, max);
  scaleRange.value = snapped.toFixed(decimals);
  updateZoom(snapped);
}

function createCardItemFromState(cardId = null) {
  if (!state.img) {
    return null;
  }
  const previousBleedOverlay = showBleedOverlay;
  const previousTrimGuide = showTrimGuide;
  showBleedOverlay = false;
  showTrimGuide = includeTrimInExport;
  drawCard();
  if (PDF_IMAGE_FORMAT === "image/jpeg") {
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = PDF_IMAGE_BACKGROUND;
    ctx.fillRect(0, 0, render.labelWidthPx, render.labelHeightPx);
    ctx.restore();
  }
  const dataUrl = canvas.toDataURL(PDF_IMAGE_FORMAT, PDF_IMAGE_QUALITY);
  showBleedOverlay = previousBleedOverlay;
  showTrimGuide = previousTrimGuide;
  drawCard();
  return {
    id: cardId ?? Date.now().toString(16),
    dataUrl,
    sourceDataUrl: state.sourceDataUrl ?? captureSourceFromImage(),
    imageState: {
      baseScale: state.baseScale,
      zoom: state.zoom,
      offsetX: state.offsetX,
      offsetY: state.offsetY,
    },
  };
}

function normalizeCardImageState(imageState) {
  const baseScale = Number(imageState?.baseScale);
  const zoom = Number(imageState?.zoom);
  const offsetX = Number(imageState?.offsetX);
  const offsetY = Number(imageState?.offsetY);
  return {
    baseScale: Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1,
    zoom: Number.isFinite(zoom) ? zoom : 1,
    offsetX: Number.isFinite(offsetX) ? offsetX : 0,
    offsetY: Number.isFinite(offsetY) ? offsetY : 0,
  };
}

function drawCardToContext(context, img, imageState, includeTrimLine) {
  context.clearRect(0, 0, render.labelWidthPx, render.labelHeightPx);
  context.save();
  clipContextToLabel(context);
  const scale = imageState.baseScale * imageState.zoom;
  const imageWidth = img.width * scale;
  const imageHeight = img.height * scale;
  const x = render.labelWidthPx / 2 - imageWidth / 2 + imageState.offsetX;
  const y = render.labelHeightPx / 2 - imageHeight / 2 + imageState.offsetY;
  context.drawImage(img, x, y, imageWidth, imageHeight);
  context.restore();

  if (includeTrimLine) {
    drawTrimLine(context);
  }

  if (PDF_IMAGE_FORMAT === "image/jpeg") {
    context.save();
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = PDF_IMAGE_BACKGROUND;
    context.fillRect(0, 0, render.labelWidthPx, render.labelHeightPx);
    context.restore();
  }
}

function loadImageElement(source) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = source;
  });
}

async function rebuildCardDataUrl(
  cardItem,
  includeTrimLine,
  renderCanvas,
  renderContext,
) {
  if (!cardItem || !renderContext) {
    return null;
  }
  const source = cardItem.sourceDataUrl || cardItem.dataUrl;
  if (!source) {
    return null;
  }
  const img = await loadImageElement(source);
  if (!img) {
    return null;
  }
  const imageState = normalizeCardImageState(cardItem.imageState);
  drawCardToContext(renderContext, img, imageState, includeTrimLine);
  return renderCanvas.toDataURL(PDF_IMAGE_FORMAT, PDF_IMAGE_QUALITY);
}

async function refreshCardPreviews(includeTrimLine = includeTrimInExport) {
  if (cards.length === 0) {
    return;
  }
  const refreshToken = (cardPreviewRefreshToken += 1);
  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = render.labelWidthPx;
  renderCanvas.height = render.labelHeightPx;
  const renderContext = renderCanvas.getContext("2d");
  if (!renderContext) {
    return;
  }
  let updated = false;
  for (let i = 0; i < cards.length; i += 1) {
    if (refreshToken !== cardPreviewRefreshToken) {
      return;
    }
    const cardItem = cards[i];
    if (!cardItem) {
      continue;
    }
    const dataUrl = await rebuildCardDataUrl(
      cardItem,
      includeTrimLine,
      renderCanvas,
      renderContext,
    );
    if (refreshToken !== cardPreviewRefreshToken) {
      return;
    }
    if (dataUrl) {
      cardItem.dataUrl = dataUrl;
      updated = true;
    }
  }
  if (refreshToken !== cardPreviewRefreshToken) {
    return;
  }
  if (updated) {
    renderPagePreview();
    schedulePersist();
  }
}

function appendCardItem(cardItem) {
  const emptySlotIndex = cards.findIndex((card) => !card);
  if (emptySlotIndex === -1) {
    cards.push(cardItem);
    return cards.length - 1;
  }
  cards[emptySlotIndex] = cardItem;
  return emptySlotIndex;
}

function onKeyDown(event) {
  if (!state.img || isEditableTarget(event.target)) {
    return;
  }

  const isZoomIn =
    event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
  const isZoomOut =
    event.key === "-" || event.key === "_" || event.code === "NumpadSubtract";

  if (isZoomIn || isZoomOut) {
    event.preventDefault();
    handleKeyboardZoom(isZoomIn ? 1 : -1);
    return;
  }

  switch (event.key) {
    case "ArrowUp":
      event.preventDefault();
      handleKeyboardMove(0, -KEYBOARD_MOVE_STEP);
      break;
    case "ArrowDown":
      event.preventDefault();
      handleKeyboardMove(0, KEYBOARD_MOVE_STEP);
      break;
    case "ArrowLeft":
      event.preventDefault();
      handleKeyboardMove(-KEYBOARD_MOVE_STEP, 0);
      break;
    case "ArrowRight":
      event.preventDefault();
      handleKeyboardMove(KEYBOARD_MOVE_STEP, 0);
      break;
    default:
      break;
  }
}

function addToPage() {
  if (!state.img) {
    setStatus(
      "Upload, paste, or load an image URL before adding it to the sheet.",
    );
    return;
  }
  const editingIndex =
    editingCardId !== null
      ? cards.findIndex((card) => card?.id === editingCardId)
      : -1;
  const cardItem = createCardItemFromState(editingCardId ?? null);
  if (!cardItem) {
    return;
  }
  if (editingIndex >= 0) {
    cards[editingIndex] = cardItem;
  } else {
    appendCardItem(cardItem);
  }
  renderPagePreview();
  schedulePersist();
  if (editingIndex >= 0) {
    setStatus(`Updated card in slot ${editingIndex + 1}.`);
  } else {
    const totalCards = getCardCount();
    setStatus(
      `Added ${totalCards} card${totalCards === 1 ? "" : "s"} to the sheet.`,
    );
  }
}

function removeCard(index) {
  if (!Number.isInteger(index) || index < 0 || index >= cards.length) {
    return;
  }
  const cardItem = cards[index];
  if (!cardItem) {
    return;
  }
  if (cardItem.id === editingCardId) {
    setEditingCardId(null);
  }
  cards[index] = null;
  trimTrailingEmptySlots();
  renderPagePreview();
  schedulePersist();
  if (getCardCount() === 0) {
    setStatus("Sheet cleared. Add a new card when ready.");
  }
}

function moveCard(fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
    return;
  }
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return;
  }
  const movingCard = cards[fromIndex];
  if (!movingCard) {
    return;
  }
  if (toIndex >= cards.length) {
    ensureSlots(toIndex + 1);
  }
  const targetCard = cards[toIndex] ?? null;
  cards[toIndex] = movingCard;
  cards[fromIndex] = targetCard;
  trimTrailingEmptySlots();
  renderPagePreview();
  schedulePersist();
  setStatus(`Moved card to slot ${toIndex + 1}.`);
}

function editCard(index, options = {}) {
  if (!Number.isInteger(index) || index < 0 || index >= cards.length) {
    return;
  }
  const cardItem = cards[index];
  if (!cardItem) {
    return;
  }
  const { successMessage, errorMessage } = options;
  const hasSource = typeof cardItem.sourceDataUrl === "string";
  const source = hasSource ? cardItem.sourceDataUrl : cardItem.dataUrl;
  const applyState =
    hasSource && cardItem.imageState && typeof cardItem.imageState === "object"
      ? cardItem.imageState
      : null;
  const successLabel =
    successMessage ??
    `Editing card ${index + 1}. Adjust framing, then click Update card.`;
  const errorLabel = errorMessage ?? "Could not load that card for editing.";
  setEditingCardId(cardItem.id);
  loadImage(source, {
    applyState,
    successMessage: successLabel,
    errorMessage: errorLabel,
  });
}

function renderPagePreview() {
  pagePreview.innerHTML = "";
  updateOversizeLock();
  const totalCards = getCardCount();
  if (totalCards === 0) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.textContent = "No cards on the sheet yet.";
    pagePreview.appendChild(empty);
    return;
  }

  const perPage = layout.columns * layout.rows;
  const totalPages = Math.ceil(cards.length / perPage);

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const page = document.createElement("div");
    page.className = "preview-page";

    const label = document.createElement("span");
    label.className = "preview-page-label";
    label.textContent = `Page ${pageIndex + 1}`;
    page.appendChild(label);

    const grid = document.createElement("div");
    grid.className = "preview-grid";

    for (let slot = 0; slot < perPage; slot += 1) {
      const cardIndex = pageIndex * perPage + slot;
      const slotWrap = document.createElement("div");
      slotWrap.className = "preview-slot";
      slotWrap.dataset.index = cardIndex.toString();

      const cardItem = cards[cardIndex];
      if (!cardItem) {
        slotWrap.classList.add("empty");
      }

      if (cardItem) {
        slotWrap.setAttribute("draggable", "true");

        const img = document.createElement("img");
        img.src = cardItem.dataUrl;
        img.alt = `Card preview ${cardIndex + 1}`;

        const actions = document.createElement("div");
        actions.className = "preview-actions";

        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "preview-edit preview-action";
        edit.textContent = "Edit";
        edit.draggable = false;
        edit.addEventListener("dragstart", (event) => event.preventDefault());
        edit.addEventListener("click", () => editCard(cardIndex));

        const button = document.createElement("button");
        button.type = "button";
        button.className = "preview-remove preview-action";
        button.textContent = "Remove";
        button.draggable = false;
        button.addEventListener("dragstart", (event) => event.preventDefault());
        button.addEventListener("click", () => removeCard(cardIndex));

        slotWrap.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData("text/plain", cardIndex.toString());
          event.dataTransfer?.setDragImage(slotWrap, 0, 0);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
          }
          slotWrap.classList.add("dragging");
        });
        slotWrap.addEventListener("dragend", () => {
          slotWrap.classList.remove("dragging");
          pagePreview
            .querySelectorAll(".preview-slot.drag-over")
            .forEach((slot) => slot.classList.remove("drag-over"));
        });

        actions.appendChild(edit);
        actions.appendChild(button);
        slotWrap.appendChild(img);
        slotWrap.appendChild(actions);
      }

      slotWrap.addEventListener("dragover", (event) => {
        if (slotWrap.classList.contains("dragging")) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        slotWrap.classList.add("drag-over");
      });
      slotWrap.addEventListener("dragleave", () => {
        slotWrap.classList.remove("drag-over");
      });
      slotWrap.addEventListener("drop", (event) => {
        event.preventDefault();
        slotWrap.classList.remove("drag-over");
        const fromIndex = Number(event.dataTransfer?.getData("text/plain"));
        const toIndex = Number(slotWrap.dataset.index);
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
          return;
        }
        moveCard(fromIndex, toIndex);
      });

      grid.appendChild(slotWrap);
    }

    page.appendChild(grid);
    pagePreview.appendChild(page);
  }

  requestAnimationFrame(updatePreviewSizing);
}

function updatePreviewSizing() {
  if (!pagePreview) {
    return;
  }
  const labelSize = getLabelSizeMm();
  const pages = pagePreview.querySelectorAll(".preview-page");
  if (pages.length === 0) {
    return;
  }
  let needsRetry = false;
  pages.forEach((page) => {
    const grid = page.querySelector(".preview-grid");
    if (!grid) {
      return;
    }
    const pageWidth = page.clientWidth;
    const pageHeight = page.clientHeight;
    if (!pageWidth || !pageHeight) {
      needsRetry = true;
      return;
    }
    const marginX = (layout.marginMm / layout.a4WidthMm) * pageWidth;
    const marginY = (layout.marginMm / layout.a4HeightMm) * pageHeight;
    const labelWidth = (labelSize.width / layout.a4WidthMm) * pageWidth;
    const labelHeight = (labelSize.height / layout.a4HeightMm) * pageHeight;
    const gapX =
      layout.columns > 1
        ? (pageWidth - marginX * 2 - labelWidth * layout.columns) /
          (layout.columns - 1)
        : 0;
    const gapY =
      layout.rows > 1
        ? (pageHeight - marginY * 2 - labelHeight * layout.rows) /
          (layout.rows - 1)
        : 0;

    grid.style.padding = `${marginY}px ${marginX}px`;
    grid.style.columnGap = `${Math.max(0, gapX)}px`;
    grid.style.rowGap = `${Math.max(0, gapY)}px`;
    grid.style.gridTemplateColumns = `repeat(${layout.columns}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${layout.rows}, 1fr)`;
  });
  if (needsRetry) {
    schedulePreviewSizing();
  }
}

function schedulePreviewSizing() {
  if (previewResizeTimeout) {
    clearTimeout(previewResizeTimeout);
  }
  previewResizeTimeout = setTimeout(() => {
    previewResizeTimeout = null;
    updatePreviewSizing();
  }, PREVIEW_RESIZE_DEBOUNCE_MS);
}

function clearPage() {
  cards.length = 0;
  setEditingCardId(null);
  renderPagePreview();
  schedulePersist();
  setStatus("Sheet cleared.");
}

function mmToPt(mm) {
  return (mm * 72) / 25.4;
}

async function downloadPdf() {
  const totalCards = getCardCount();
  if (totalCards === 0) {
    setStatus("Add at least one card before downloading the PDF.");
    return;
  }
  if (isDownloading) {
    setStatus("PDF generation is already in progress.");
    return;
  }

  const totalSlots = cards.length;
  isDownloading = true;
  setPdfBusy(true);
  setPdfProgress(true, 0, totalCards);
  setStatus(`Generating PDF... 0 of ${totalCards}`);

  try {
    const pdfDoc = await PDFDocument.create();
    const pageWidth = mmToPt(layout.a4WidthMm);
    const pageHeight = mmToPt(layout.a4HeightMm);
    const labelSize = getLabelSizeMm();
    const labelWidth = mmToPt(labelSize.width);
    const labelHeight = mmToPt(labelSize.height);
    const margin = mmToPt(layout.marginMm);

    const gapX =
      layout.columns > 1
        ? (pageWidth - margin * 2 - labelWidth * layout.columns) /
          (layout.columns - 1)
        : 0;
    const gapY =
      layout.rows > 1
        ? (pageHeight - margin * 2 - labelHeight * layout.rows) /
          (layout.rows - 1)
        : 0;

    const perPage = layout.columns * layout.rows;
    let page = null;

    let renderedCards = 0;
    for (let i = 0; i < totalSlots; i += 1) {
      if (i % perPage === 0) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
      }

      const position = i % perPage;
      const column = position % layout.columns;
      const row = Math.floor(position / layout.columns);

      const x = margin + column * (labelWidth + gapX);
      const y = pageHeight - margin - labelHeight - row * (labelHeight + gapY);

      const cardItem = cards[i];
      if (!cardItem) {
        continue;
      }

      const imageBytes = await fetch(cardItem.dataUrl).then((res) =>
        res.arrayBuffer(),
      );
      const isJpeg =
        cardItem.dataUrl.startsWith("data:image/jpeg") ||
        cardItem.dataUrl.startsWith("data:image/jpg");
      const image = isJpeg
        ? await pdfDoc.embedJpg(imageBytes)
        : await pdfDoc.embedPng(imageBytes);
      page.drawImage(image, {
        x,
        y,
        width: labelWidth,
        height: labelHeight,
      });

      renderedCards += 1;
      setPdfProgress(true, renderedCards, totalCards);
      setStatus(`Generating PDF... ${renderedCards} of ${totalCards}`);
    }

    setStatus("Finalizing PDF...");
    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "card-labels.pdf";
    link.click();
    URL.revokeObjectURL(url);

    setStatus("PDF downloaded. Print at 100% scale for accurate labels.");
  } catch (error) {
    setStatus("Could not generate the PDF. Please try again.");
  } finally {
    isDownloading = false;
    setPdfBusy(false);
    setPdfProgress(false);
  }
}

function downloadSetup() {
  const payload = JSON.stringify(buildPersistedState(), null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `card-label-setup-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("Setup downloaded.");
}

function importSetup(file) {
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const contents = typeof reader.result === "string" ? reader.result : "";
    const parsed = parsePersistedState(contents);
    if (!parsed) {
      setStatus("That file does not contain a valid setup export.");
      return;
    }
    applyPersistedState(parsed);
    schedulePersist();
    setStatus("Setup imported.");
  };
  reader.onerror = () => {
    setStatus("Could not read that setup file.");
  };
  reader.readAsText(file);
}

function parsePersistedState(raw) {
  try {
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (parsed.version && Number(parsed.version) !== Number(STORAGE_VERSION)) {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function loadPersistedState() {
  return parsePersistedState(localStorage.getItem(STORAGE_KEY));
}

function applyPersistedState(saved) {
  if (!saved) {
    return false;
  }
  setEditingCardId(null);

  const savedOversize = Number(saved.layout?.oversizeMm);
  if (Number.isFinite(savedOversize)) {
    applyOversize(savedOversize, {
      announce: false,
      clearCards: false,
      persist: false,
      refreshCards: false,
    });
  }

  if (typeof saved.settings?.includeTrimInExport === "boolean") {
    includeTrimInExport = saved.settings.includeTrimInExport;
    updateTrimLineToggle();
  }

  cards.length = 0;
  if (Array.isArray(saved.cards)) {
    saved.cards.forEach((card) => {
      if (card && typeof card.dataUrl === "string") {
        cards.push({
          id: card.id ?? Date.now().toString(16),
          dataUrl: card.dataUrl,
          sourceDataUrl:
            typeof card.sourceDataUrl === "string" ? card.sourceDataUrl : null,
          imageState:
            card.imageState && typeof card.imageState === "object"
              ? {
                  baseScale: card.imageState.baseScale,
                  zoom: card.imageState.zoom,
                  offsetX: card.imageState.offsetX,
                  offsetY: card.imageState.offsetY,
                }
              : null,
        });
        return;
      }
      cards.push(null);
    });
  }
  trimTrailingEmptySlots();
  renderPagePreview();

  if (saved.image && typeof saved.image.dataUrl === "string") {
    drawCard();
    loadImage(saved.image.dataUrl, {
      applyState: saved.image,
      silent: true,
    });
  } else {
    drawCard();
  }

  if (getCardCount() > 0 || saved.image?.dataUrl) {
    setStatus("Restored your last session.");
  }

  return true;
}

if (oversizeInput) {
  const startingOversize = Number(oversizeInput.value);
  if (Number.isFinite(startingOversize)) {
    layout.oversizeMm = Math.max(0, startingOversize);
  }
}
updateRenderMetrics();
updateTrimLineToggle();
const restoredState = applyPersistedState(loadPersistedState());

imageInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) {
    loadImage(file, { clearEditing: true });
  }
  event.target.value = "";
});

scaleRange.addEventListener("input", (event) => {
  updateZoom(event.target.value);
});

if (oversizeInput) {
  oversizeInput.addEventListener("input", (event) => {
    applyOversize(event.target.value, { announce: true });
  });
}

if (toggleTrimLineBtn) {
  toggleTrimLineBtn.addEventListener("click", () => {
    includeTrimInExport = !includeTrimInExport;
    updateTrimLineToggle();
    setStatus(
      `Trim line in PDF ${includeTrimInExport ? "enabled" : "disabled"}.`,
    );
    refreshCardPreviews();
    schedulePersist();
  });
}

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointerleave", onPointerUp);
window.addEventListener("paste", handlePaste);
window.addEventListener("keydown", onKeyDown);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    loadUrlBtn.click();
  }
});
loadUrlBtn.addEventListener("click", () => {
  const raw = urlInput.value.trim();
  if (!raw) {
    setStatus("Paste an image URL to load.");
    return;
  }
  const urls = parseUrlList(raw);
  if (urls.length <= 1) {
    loadImageFromUrl(urls[0]);
    return;
  }
  loadImagesFromUrlBatch(urls);
});

addToPageBtn.addEventListener("click", addToPage);
clearPageBtn.addEventListener("click", clearPage);
resetViewBtn.addEventListener("click", resetView);
downloadPdfBtn.addEventListener("click", downloadPdf);
if (downloadSetupBtn) {
  downloadSetupBtn.addEventListener("click", downloadSetup);
}
if (importSetupBtn && importSetupInput) {
  importSetupBtn.addEventListener("click", () => {
    importSetupInput.click();
  });
  importSetupInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) {
      importSetup(file);
    }
    event.target.value = "";
  });
}
window.addEventListener("beforeunload", persistState);
window.addEventListener("resize", schedulePreviewSizing);
window.addEventListener("load", updatePreviewSizing);

if (!restoredState) {
  renderPagePreview();
  drawCard();
}
