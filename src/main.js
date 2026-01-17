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
const clearPageBtn = document.getElementById("clearPage");
const resetViewBtn = document.getElementById("resetView");
const pagePreview = document.getElementById("pagePreview");
const statusEl = document.getElementById("status");

const card = {
  width: canvas.width,
  height: canvas.height,
  radius: 36,
};

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
};

const cards = [];

const layout = {
  columns: 2,
  rows: 4,
  a4WidthMm: 210,
  a4HeightMm: 297,
  cardWidthMm: 85.6,
  cardHeightMm: 53.98,
  marginMm: 10,
};

function setStatus(message) {
  statusEl.textContent = message;
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

function drawPlaceholder() {
  ctx.save();
  roundedRectPath(ctx, 0, 0, card.width, card.height, card.radius);
  ctx.clip();
  ctx.fillStyle = "#f1e7d8";
  ctx.fillRect(0, 0, card.width, card.height);
  ctx.strokeStyle = "rgba(31, 43, 42, 0.08)";
  ctx.lineWidth = 2;
  for (let i = -card.height; i < card.width; i += 40) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + card.height, card.height);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(42, 106, 115, 0.5)";
  ctx.lineWidth = 4;
  roundedRectPath(ctx, 2, 2, card.width - 4, card.height - 4, card.radius);
  ctx.stroke();

  ctx.fillStyle = "#516261";
  ctx.font = '24px "Space Grotesk"';
  ctx.textAlign = "center";
  ctx.fillText(
    "Upload, paste, or load an image URL to start",
    card.width / 2,
    card.height / 2 + 8,
  );
}

function drawCard() {
  ctx.clearRect(0, 0, card.width, card.height);

  if (!state.img) {
    drawPlaceholder();
    return;
  }

  ctx.save();
  roundedRectPath(ctx, 0, 0, card.width, card.height, card.radius);
  ctx.clip();
  ctx.fillStyle = "#f7f1e6";
  ctx.fillRect(0, 0, card.width, card.height);

  const scale = state.baseScale * state.zoom;
  const imageWidth = state.img.width * scale;
  const imageHeight = state.img.height * scale;
  const x = card.width / 2 - imageWidth / 2 + state.offsetX;
  const y = card.height / 2 - imageHeight / 2 + state.offsetY;

  ctx.drawImage(state.img, x, y, imageWidth, imageHeight);
  ctx.restore();

  ctx.strokeStyle = "rgba(42, 106, 115, 0.6)";
  ctx.lineWidth = 4;
  roundedRectPath(ctx, 2, 2, card.width - 4, card.height - 4, card.radius);
  ctx.stroke();
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
  const maxOffsetX = Math.max(0, (imageWidth - card.width) / 2);
  const maxOffsetY = Math.max(0, (imageHeight - card.height) / 2);

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

function resetView() {
  if (!state.img) {
    return;
  }
  const fitScale = Math.max(
    card.width / state.img.width,
    card.height / state.img.height,
  );
  state.baseScale = fitScale;
  state.zoom = 1;
  state.offsetX = 0;
  state.offsetY = 0;
  clampOffsets();
  scaleRange.value = "1";
  scaleReadout.textContent = "100%";
  drawCard();
}

function updateZoom(value) {
  state.zoom = Number(value);
  scaleReadout.textContent = `${Math.round(state.zoom * 100)}%`;
  clampOffsets();
  drawCard();
}

function loadImage(source, options = {}) {
  const { successMessage, errorMessage } = options;
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    state.img = img;
    resetView();
    setStatus(
      successMessage ?? "Drag the image to position it inside the card.",
    );
  };
  img.onerror = () => {
    URL.revokeObjectURL(img.src);
    setStatus(
      errorMessage ?? "Could not load that image. Try another file or URL.",
    );
  };
  img.src = URL.createObjectURL(source);
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
      "Image pasted from clipboard. Drag to position it inside the card.",
  });
}

async function loadImageFromUrl(rawUrl) {
  let resolvedUrl;
  try {
    resolvedUrl = new URL(rawUrl, window.location.href).toString();
  } catch (error) {
    setStatus("Enter a valid image URL.");
    return;
  }

  setStatus("Loading image from URL...");
  try {
    const response = await fetch(resolvedUrl);
    if (!response.ok) {
      setStatus(`Could not fetch the image (HTTP ${response.status}).`);
      return;
    }

    const contentType = response.headers.get("content-type") || "";
    const blob = await response.blob();
    const blobType = blob.type || contentType;
    if (blobType && !blobType.startsWith("image/")) {
      setStatus("That URL does not point to an image file.");
      return;
    }

    loadImage(blob, {
      successMessage:
        "Image loaded from URL. Drag to position it inside the card.",
      errorMessage: "Could not load that image. Try another URL.",
    });
  } catch (error) {
    setStatus(
      "Could not load image from URL. Check the address and CORS settings.",
    );
  }
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
}

function addToPage() {
  if (!state.img) {
    setStatus(
      "Upload, paste, or load an image URL before adding it to the sheet.",
    );
    return;
  }
  const dataUrl = canvas.toDataURL("image/png");
  cards.push({
    id: Date.now().toString(16),
    dataUrl,
  });
  renderPagePreview();
  setStatus(
    `Added ${cards.length} card${cards.length === 1 ? "" : "s"} to the sheet.`,
  );
}

function removeCard(index) {
  cards.splice(index, 1);
  renderPagePreview();
  if (cards.length === 0) {
    setStatus("Sheet cleared. Add a new card when ready.");
  }
}

function renderPagePreview() {
  pagePreview.innerHTML = "";
  if (cards.length === 0) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.textContent = "No cards on the sheet yet.";
    pagePreview.appendChild(empty);
    return;
  }

  cards.forEach((cardItem, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "card-thumb";

    const img = document.createElement("img");
    img.src = cardItem.dataUrl;
    img.alt = `Card preview ${index + 1}`;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Remove";
    button.addEventListener("click", () => removeCard(index));

    wrapper.appendChild(img);
    wrapper.appendChild(button);
    pagePreview.appendChild(wrapper);
  });
}

function clearPage() {
  cards.length = 0;
  renderPagePreview();
  setStatus("Sheet cleared.");
}

function mmToPt(mm) {
  return (mm * 72) / 25.4;
}

async function downloadPdf() {
  if (cards.length === 0) {
    setStatus("Add at least one card before downloading the PDF.");
    return;
  }

  const pdfDoc = await PDFDocument.create();
  const pageWidth = mmToPt(layout.a4WidthMm);
  const pageHeight = mmToPt(layout.a4HeightMm);
  const cardWidth = mmToPt(layout.cardWidthMm);
  const cardHeight = mmToPt(layout.cardHeightMm);
  const margin = mmToPt(layout.marginMm);

  const gapX =
    layout.columns > 1
      ? (pageWidth - margin * 2 - cardWidth * layout.columns) /
        (layout.columns - 1)
      : 0;
  const gapY =
    layout.rows > 1
      ? (pageHeight - margin * 2 - cardHeight * layout.rows) / (layout.rows - 1)
      : 0;

  const perPage = layout.columns * layout.rows;
  let page = null;

  for (let i = 0; i < cards.length; i += 1) {
    if (i % perPage === 0) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
    }

    const position = i % perPage;
    const column = position % layout.columns;
    const row = Math.floor(position / layout.columns);

    const x = margin + column * (cardWidth + gapX);
    const y = pageHeight - margin - cardHeight - row * (cardHeight + gapY);

    const pngBytes = await fetch(cards[i].dataUrl).then((res) =>
      res.arrayBuffer(),
    );
    const png = await pdfDoc.embedPng(pngBytes);
    page.drawImage(png, {
      x,
      y,
      width: cardWidth,
      height: cardHeight,
    });
  }

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "card-labels.pdf";
  link.click();
  URL.revokeObjectURL(url);

  setStatus("PDF downloaded. Print at 100% scale for accurate labels.");
}

imageInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) {
    loadImage(file);
  }
  event.target.value = "";
});

scaleRange.addEventListener("input", (event) => {
  updateZoom(event.target.value);
});

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointerleave", onPointerUp);
window.addEventListener("paste", handlePaste);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadUrlBtn.click();
  }
});
loadUrlBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Paste an image URL to load.");
    return;
  }
  loadImageFromUrl(url);
});

addToPageBtn.addEventListener("click", addToPage);
clearPageBtn.addEventListener("click", clearPage);
resetViewBtn.addEventListener("click", resetView);
downloadPdfBtn.addEventListener("click", downloadPdf);

renderPagePreview();
drawCard();
