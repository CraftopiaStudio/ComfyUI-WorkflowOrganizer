/**
 * ComfyUI-WorkflowOrganizer
 * Drag-and-drop workflow organization for the Workflows sidebar:
 * move to folder/root, new/rename/duplicate/delete folder, and keep
 * empty folders visible via server-managed placeholders.
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXTENSION_NAME = "Craftopia.WorkflowOrganizer";

async function moveUserDataFile(source, destination) {
  const resp = await api.fetchApi(
    `/userdata/${encodeURIComponent(source)}/move/${encodeURIComponent(destination)}`,
    { method: "POST" }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Move failed (${resp.status}): ${text}`);
  }
  return resp;
}

async function createFolder(folderPath) {
  const resp = await api.fetchApi("/wfo/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folderPath }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Create folder failed (${resp.status}): ${text}`);
  }
}

async function deleteFolder(folderPath, recursive = false) {
  const resp = await api.fetchApi("/wfo/folder", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folderPath, recursive }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Delete folder failed (${resp.status}): ${text}`);
  }
  try { return await resp.json(); } catch (_) { return {}; }
}

// Restore a trashed folder back to destRel (relative to workflows/) — undo delete.
async function restoreTrash(token, destRel) {
  const resp = await api.fetchApi("/wfo/trash/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trash: token, dest: `workflows/${destRel}` }),
  });
  if (!resp.ok) throw new Error(await resp.text());
}

async function duplicateFile(filePath) {
  const resp = await api.fetchApi("/wfo/file/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: `workflows/${filePath}.json` }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Duplicate failed (${resp.status}): ${text}`);
  }
  return (await resp.json()).new_name;
}

async function duplicateFolder(folderPath) {
  const resp = await api.fetchApi("/wfo/folder/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folderPath }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Duplicate failed (${resp.status}): ${text}`);
  }
  return (await resp.json()).new_name;
}

async function deleteUserDataFile(path) {
  const resp = await api.fetchApi(
    `/userdata/${encodeURIComponent(path)}`,
    { method: "DELETE" }
  );
  if (!resp.ok && resp.status !== 404) {
    const text = await resp.text();
    throw new Error(`Delete failed (${resp.status}): ${text}`);
  }
}

function isFolder(el) {
  if (el.classList.contains("p-tree-node-leaf")) return false;
  const icon = el.querySelector(".pi-folder, .pi-folder-open");
  return !!icon || !el.classList.contains("p-tree-node-leaf");
}

function isFile(el) {
  return el.classList.contains("p-tree-node-leaf");
}

function getLabel(el) {
  const labelEl = el.querySelector(".p-tree-node-label");
  if (!labelEl) return null;
  const clone = labelEl.cloneNode(true);
  clone.querySelectorAll("span.p-badge, [class*='badge']").forEach((b) => b.remove());
  return clone.textContent.trim();
}

function buildPath(el) {
  const parts = [];
  let current = el;
  while (current) {
    const label = getLabel(current);
    if (label) parts.unshift(label);
    const group = current.parentElement?.closest("[role='group']");
    if (group) {
      current = group.closest("[role='treeitem']");
    } else {
      break;
    }
  }
  return parts.join("/");
}

function getPinia() {
  try {
    const root = document.querySelector("[data-v-app]")?.__vue_app__?._context?.provides;
    if (!root) return null;
    const piniaSymbol = Object.getOwnPropertySymbols(root).find((s) => root[s]?._s);
    if (!piniaSymbol) return null;
    return root[piniaSymbol];
  } catch (_) {
    return null;
  }
}

function getWorkflowStore() {
  const pinia = getPinia();
  if (!pinia) return null;
  const candidates = ["comfyWorkflow", "workflow", "workflowBookmark", "workflows"];
  for (const id of candidates) {
    const store = pinia._s.get(id);
    if (store) return store;
  }
  return null;
}

async function refreshWorkflowSidebar() {
  await loadPlaceholderFolders();
  const store = getWorkflowStore();
  if (store) {
    const refreshMethods = ["syncWorkflows", "loadWorkflows", "refreshWorkflows"];
    for (const method of refreshMethods) {
      if (typeof store[method] === "function") {
        try {
          await store[method]();
          return;
        } catch (err) { console.warn(err); }
      }
    }
  }
  const allBtns = document.querySelectorAll(".sidebar-icon-wrapper");
  const workflowBtn = [...allBtns].find((b) => b.querySelector("[class*='comfy--workflow'], [title*='orkflow']"));
  const otherBtn = [...allBtns].find((b) => b !== workflowBtn);
  if (workflowBtn && otherBtn) {
    otherBtn.click();
    await new Promise((r) => setTimeout(r, 100));
    workflowBtn.click();
  }
}

let contextMenu = null;
let dragData = null;
let rootDropBar = null;
// Set true by a tree item's contextmenu handler so the panel-level handler knows
// the right-click was on an item (not empty space) — reliable across DOM layouts.
let itemContextActive = false;

// ── Multi-select state (workflow files only) ────────────────────────────────
let selectedPaths = new Set();   // relative paths (no .json) of selected workflows
let selectionAnchor = null;      // path of the last clicked item, for shift-range

// Ordered list of visible workflow-file paths in the tree (for shift-range).
function getOrderedFilePaths(container) {
  return [...container.querySelectorAll("[role='treeitem']")]
    .filter((el) => el.classList.contains("p-tree-node-leaf") && el.style.display !== "none")
    .map((el) => buildPath(el))
    .filter(Boolean);
}

function clearSelection(container) {
  if (!selectedPaths.size) return;
  selectedPaths.clear();
  selectionAnchor = null;
  applySelectionStyles(container);
  updateSelectionBar(container);
}

function applySelectionStyles(container) {
  container.querySelectorAll("[role='treeitem']").forEach((el) => {
    if (!el.classList.contains("p-tree-node-leaf")) return;
    const content = el.querySelector(".p-tree-node-content");
    if (!content) return;
    content.classList.toggle("wfo-selected", selectedPaths.has(buildPath(el)));
  });
}

function selectRange(container, fromPath, toPath) {
  const order = getOrderedFilePaths(container);
  const i = order.indexOf(fromPath);
  const j = order.indexOf(toPath);
  if (i === -1 || j === -1) { selectedPaths.add(toPath); return; }
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  for (let k = lo; k <= hi; k++) selectedPaths.add(order[k]);
}

// Resolve a workflow-file tree item from an event target, if it's one of ours.
function fileItemFromEvent(e) {
  const t = e.target;
  if (!t || !t.closest) return null;
  const item = t.closest("[role='treeitem']");
  if (!item || !item.classList.contains("p-tree-node-leaf")) return null;
  const panel = findWorkflowsPanel();
  if (!panel || !panel.contains(item)) return null;
  if (getLabel(item) === "placeholder") return null;
  return { item, panel };
}

// Document-level capture handlers run before ComfyUI's, so a modifier-click can
// be claimed for selection while a plain click still loads the workflow.
function installSelectionHandlers() {
  const blockModifierDown = (e) => {
    try {
      if (e.button !== 0 && e.button !== undefined) return;
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
      if (!fileItemFromEvent(e)) return;
      e.preventDefault();
      e.stopPropagation();
    } catch (_) {}
  };
  document.addEventListener("pointerdown", blockModifierDown, true);
  document.addEventListener("mousedown", blockModifierDown, true);

  document.addEventListener("click", (e) => {
    try {
    const found = fileItemFromEvent(e);
    if (!found) return;
    const { item, panel } = found;
    const path = buildPath(item);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); e.stopPropagation();
      if (selectedPaths.has(path)) selectedPaths.delete(path);
      else selectedPaths.add(path);
      selectionAnchor = path;
      applySelectionStyles(panel);
      updateSelectionBar(panel);
    } else if (e.shiftKey && selectionAnchor) {
      e.preventDefault(); e.stopPropagation();
      selectRange(panel, selectionAnchor, path);
      applySelectionStyles(panel);
      updateSelectionBar(panel);
    } else {
      // Plain click: clear the multi-selection (let ComfyUI load) but remember
      // this row as the anchor for a later shift-click.
      if (selectedPaths.size) {
        selectedPaths.clear();
        applySelectionStyles(panel);
        updateSelectionBar(panel);
      }
      selectionAnchor = path;
    }
    } catch (_) {}
  }, true);
}

async function moveToRoot() {
  if (!dragData) return;
  if (dragData.isFolder) { await moveFolderTo(""); return; }
  const files = dragData.files || [dragData.path];
  dragData = null;
  try {
    const n = await performFileMoves(files, "");
    const panel = findWorkflowsPanel();
    if (panel) clearSelection(panel);
    if (n > 0) { try { app.extensionManager?.toast?.add({ severity: "success", summary: n === 1 ? "Moved to root" : `Moved ${n} workflows to root`, life: 3000 }); } catch (_) {} }
  } catch (err) {
    try { app.extensionManager?.toast?.add({ severity: "error", summary: "Move failed", detail: err.message, life: 5000 }); } catch (_) {}
  }
}

// Move the dragged folder (with all its contents) into destParentRel ("" = root),
// relative to the workflows dir. A move is an atomic os.rename to a new path.
async function moveFolderTo(destParentRel) {
  if (!dragData || !dragData.isFolder) return;
  const srcRel = dragData.path;
  const name = dragData.name;
  const movedElement = dragData.element;
  dragData = null;

  const srcParent = srcRel.includes("/") ? srcRel.slice(0, srcRel.lastIndexOf("/")) : "";
  if (srcParent === destParentRel) return;                          // already there — no-op
  if (destParentRel === srcRel || destParentRel.startsWith(srcRel + "/")) {
    try { app.extensionManager?.toast?.add({ severity: "warn", summary: "Can't move folder into itself", life: 4000 }); } catch (_) {}
    return;
  }

  const dstRel = destParentRel ? `${destParentRel}/${name}` : name;
  try {
    await apiRenameFolder(srcRel, dstRel);
    try { app.extensionManager?.toast?.add({ severity: "success", summary: "Folder moved", detail: name, life: 3000 }); } catch (_) {}
    await refreshWorkflowSidebar();
    if (movedElement) movedElement.style.display = "none";
    registerUndo(`Moved ${name}`, async () => {
      await apiRenameFolder(dstRel, srcRel);
      await refreshWorkflowSidebar();
    });
  } catch (err) {
    try { app.extensionManager?.toast?.add({ severity: "error", summary: "Move failed", detail: err.message, life: 5000 }); } catch (_) {}
  }
}

function showRootDropBar(panel) {
  if (rootDropBar) return;

  // Skip if the dragged file already lives in root (no folder in its path)
  if (!dragData || !dragData.path.includes("/")) return;

  // Only meaningful when there are folders to drag out of
  const allItems = [...panel.querySelectorAll("[role='treeitem']")];
  const rootItems = allItems.filter(el => !el.parentElement?.closest("[role='treeitem']"));
  const hasFolders = rootItems.some(el => !el.classList.contains("p-tree-node-leaf"));
  if (!hasFolders) return;

  // 0-height sticky wrapper so it overlays without pushing content down
  rootDropBar = document.createElement("div");
  rootDropBar.className = "wfo-root-bar-wrap";

  const bar = document.createElement("div");
  bar.className = "wfo-root-bar";
  bar.innerHTML = `<span class="pi pi-arrow-up wfo-root-bar-icon"></span><span>Drop here to move to Root</span>`;
  bar.addEventListener("dragover", (e) => {
    if (!dragData) return;
    e.preventDefault();
    e.stopPropagation();
    bar.classList.add("wfo-root-bar-active");
  });
  bar.addEventListener("dragleave", () => bar.classList.remove("wfo-root-bar-active"));
  bar.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    bar.classList.remove("wfo-root-bar-active");
    await moveToRoot();
  });

  rootDropBar.appendChild(bar);

  // Float over the header area (above the first folder), pinned to the panel's
  // top edge. Covers the "Browse" label during drag, never a folder.
  const rect = panel.getBoundingClientRect();
  // Align width to the search box above (find its visible rounded container)
  const sidebar = panel.parentElement || document.body;
  // Pick the search input that sits directly above this panel (ComfyUI has
  // several search boxes; match by horizontal overlap + being just above).
  const candidates = [...document.querySelectorAll("input[placeholder*='earch']")];
  let searchEl = null;
  let best = Infinity;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const overlaps = r.left < rect.right && r.right > rect.left;
    const above = r.bottom <= rect.top + 4;
    if (overlaps && above) {
      const dist = rect.top - r.bottom;
      if (dist >= 0 && dist < best) { best = dist; searchEl = el; }
    }
  }
  // The visible search box is the input's immediate wrapper (PrimeVue IconField).
  const box = searchEl ? (searchEl.parentElement || searchEl) : null;
  const ref = box ? box.getBoundingClientRect() : { left: rect.left + 4, width: rect.width - 8 };

  // The wrapper spans the full panel width with the live theme background, so it
  // fully covers the "Browse" header behind it (any language / theme). The
  // visible bar inside stays aligned to the search box above.
  rootDropBar.style.left = rect.left + "px";
  rootDropBar.style.width = rect.width + "px";
  rootDropBar.style.bottom = (window.innerHeight - rect.top) + "px";
  const themeBg = getEffectiveBackground(panel);
  if (themeBg) rootDropBar.style.setProperty("--wfo-bar-bg", themeBg);

  bar.style.width = ref.width + "px";
  bar.style.marginLeft = (ref.left - rect.left) + "px";

  sidebar.appendChild(rootDropBar);
}

// Walk up until a non-transparent background-color is found (the panel itself
// is often transparent and inherits from an ancestor).
function getEffectiveBackground(el) {
  let cur = el;
  while (cur) {
    const bg = getComputedStyle(cur).backgroundColor;
    if (bg && bg !== "transparent" && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) return bg;
    cur = cur.parentElement;
  }
  return null;
}

function hideRootDropBar() {
  if (rootDropBar) { rootDropBar.remove(); rootDropBar = null; }
}

function removeContextMenu() {
  if (contextMenu) { contextMenu.remove(); contextMenu = null; }
}

// Latest known-good native menu metrics. The folder menu has no native menu to
// read from, so it reuses what the file menu measured.
let nativeMenuMetrics = null;

function readMenuMetrics(realMenu) {
  if (!realMenu) return null;
  const textSample = realMenu.querySelector(
    ".p-menuitem-text, .p-contextmenu-item-label, .p-menuitem-link"
  );
  if (!textSample) return null;
  const cs = getComputedStyle(textSample);
  const iconSample = realMenu.querySelector(".p-menuitem-icon");
  const iconCs = iconSample ? getComputedStyle(iconSample) : null;
  const linkSample = realMenu.querySelector(".p-menuitem-link, .p-contextmenu-item-link, .p-menuitem-content");
  const ls = linkSample ? getComputedStyle(linkSample) : null;
  return {
    fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
    letterSpacing: cs.letterSpacing, lineHeight: cs.lineHeight, color: cs.color,
    iconFontSize: iconCs ? iconCs.fontSize : cs.fontSize,
    iconColor: iconCs ? iconCs.color : null,
    padTop: ls ? ls.paddingTop : null, padBottom: ls ? ls.paddingBottom : null,
    padLeft: ls ? ls.paddingLeft : null, padRight: ls ? ls.paddingRight : null,
  };
}

function applyMenuMetrics(menuEl, m) {
  if (!m) return;
  menuEl.querySelectorAll(".wfo-context-item, .wfo-label").forEach((el) => {
    el.style.fontFamily = m.fontFamily;
    el.style.fontSize = m.fontSize;
    el.style.fontWeight = m.fontWeight;
    el.style.letterSpacing = m.letterSpacing;
    el.style.lineHeight = m.lineHeight;
    if (!el.closest(".wfo-danger")) el.style.color = m.color;
  });
  menuEl.querySelectorAll(".wfo-icon").forEach((el) => {
    el.style.fontSize = m.iconFontSize;
    if (m.iconColor && !el.closest(".wfo-danger")) el.style.color = m.iconColor;
  });
  if (m.padTop) {
    menuEl.querySelectorAll(".wfo-context-item").forEach((el) => {
      el.style.paddingTop = m.padTop;
      el.style.paddingBottom = m.padBottom;
      el.style.paddingLeft = m.padLeft;
      el.style.paddingRight = m.padRight;
    });
  }
}

// Match our injected items to ComfyUI's native menu (font, colour, size, padding).
// Reads the live native menu when present and caches it; the folder menu (which
// has no native menu) falls back to the cached metrics.
function applyNativeMenuFont(menuEl, realMenu) {
  const m = readMenuMetrics(realMenu);
  if (m) nativeMenuMetrics = m;
  applyMenuMetrics(menuEl, nativeMenuMetrics);
}

function inlineRenameInTree(folderItem, onConfirm) {
  const labelEl = folderItem.querySelector(".p-tree-node-label");
  if (!labelEl) return;

  const currentText = getLabel(folderItem);
  const originalHTML = labelEl.innerHTML;
  let committed = false;

  const input = document.createElement("input");
  input.className = "wfo-tree-input";
  input.value = currentText;
  labelEl.innerHTML = "";
  labelEl.appendChild(input);

  setTimeout(() => { input.focus(); input.select(); }, 0);

  const restore = () => { labelEl.innerHTML = originalHTML; };

  const commit = async () => {
    if (committed) return;
    committed = true;
    const value = input.value.trim();
    restore();
    if (value && value !== currentText) await onConfirm(value);
  };

  const cancel = () => {
    if (committed) return;
    committed = true;
    restore();
  };

  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); await commit(); }
    else if (e.key === "Escape") { e.stopPropagation(); cancel(); }
  });
  input.addEventListener("blur", cancel);
}

function transformMenuToInput(menu, defaultValue, onConfirm, label = "Name:") {
  menu.innerHTML = "";
  menu.style.borderRadius = "4px";
  menu.style.borderTop = "1px solid var(--border-color, #4e4e4e)";
  menu.style.padding = "8px";
  menu.style.display = "flex";
  menu.style.flexDirection = "column";
  menu.style.gap = "6px";
  menu.style.minWidth = "180px";

  const lbl = document.createElement("span");
  lbl.className = "wfo-input-label";
  lbl.textContent = label;
  menu.appendChild(lbl);

  const input = document.createElement("input");
  input.className = "wfo-inline-input";
  input.value = defaultValue;
  menu.appendChild(input);

  const hint = document.createElement("span");
  hint.className = "wfo-input-hint";
  hint.textContent = "Enter ✓  ·  Esc ✕";
  menu.appendChild(hint);

  setTimeout(() => { input.focus(); input.select(); }, 0);

  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const value = input.value.trim();
      removeContextMenu();
      if (value) await onConfirm(value);
    } else if (e.key === "Escape") {
      removeContextMenu();
    }
  });
}

// Build a menu item that creates a folder under parentRel (relative to the
// workflows dir; "" = root). label/icon/prompt are customizable.
function makeNewFolderItem(menu, parentRel, label = "New Folder", icon = "pi-folder-plus", prompt = "New folder name:") {
  const newFolder = document.createElement("div");
  newFolder.className = "wfo-context-item";
  newFolder.innerHTML = `<span class="pi ${icon} wfo-icon"></span><span class="wfo-label">${label}</span>`;
  newFolder.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    transformMenuToInput(menu, "", async (folderName) => {
      const name = folderName.replace(/[/\\]/g, "");
      if (!name) return;
      const rel = parentRel ? `${parentRel}/${name}` : name;
      try {
        await createFolder(`workflows/${rel}`);
        try { app.extensionManager?.toast?.add({ severity: "success", summary: "Folder created", detail: name, life: 3000 }); } catch (_) {}
        await refreshWorkflowSidebar();
      } catch (err) {
        try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
      }
    }, prompt);
  });
  return newFolder;
}

// All folder paths (relative to workflows/) from the server — independent of
// which folders are currently expanded in the tree.
async function getAllFolders() {
  const folders = new Set();
  try {
    const resp = await api.fetchApi("/userdata?dir=workflows&recurse=true&split=false");
    if (resp.ok) {
      const files = await resp.json();
      for (const f of files) {
        const rel = f.replace(/^workflows\//, "").replace(/\\/g, "/");
        const parts = rel.split("/");
        for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
      }
    }
  } catch (_) {}
  return [...folders].sort((a, b) => a.localeCompare(b));
}

// Turn a context menu into a scrollable "Move to:" folder picker. isExcluded(rel)
// hides invalid destinations; currentRel is shown greyed/disabled (the item's
// current location); onPick(rel) runs the move ("" = root).
async function transformMenuToFolderList(menu, { isExcluded, currentRel, onPick }) {
  menu.innerHTML = "";
  menu.classList.add("wfo-standalone");
  menu.style.maxHeight = "340px";
  menu.style.overflowY = "auto";
  menu.style.overflowX = "hidden";
  menu.style.width = "240px";

  const heading = document.createElement("div");
  heading.className = "wfo-input-label";
  heading.textContent = "Move to:";
  heading.style.padding = "6px 10px 4px";
  menu.appendChild(heading);

  const folders = await getAllFolders();
  const entries = [{ rel: "", name: "Root", depth: 0, icon: "pi-home" }];
  for (const f of folders) {
    entries.push({ rel: f, name: f.split("/").pop(), depth: f.split("/").length, icon: "pi-folder" });
  }

  let any = false;
  for (const entry of entries) {
    if (isExcluded && isExcluded(entry.rel)) continue;
    const isCurrent = entry.rel === currentRel;
    const row = document.createElement("div");
    row.className = "wfo-context-item";
    row.title = isCurrent ? `${entry.rel || "Root"} (current)` : (entry.rel || "Root");
    row.innerHTML =
      `<span class="pi ${entry.icon} wfo-icon" style="margin-left:${entry.depth * 12}px"></span>` +
      `<span class="wfo-label">${entry.name}</span>` +
      (isCurrent ? `<span class="wfo-current-tag">current</span>` : "");
    if (isCurrent) {
      row.style.opacity = "0.45";
      row.style.cursor = "default";
    } else {
      any = true;
      row.addEventListener("mousedown", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        removeContextMenu();
        await onPick(entry.rel);
      });
    }
    menu.appendChild(row);
  }
  if (!any) {
    const empty = document.createElement("div");
    empty.className = "wfo-input-hint";
    empty.style.padding = "6px 10px";
    empty.textContent = "No other folders";
    menu.appendChild(empty);
  }
  applyMenuMetrics(menu, nativeMenuMetrics);
}

// Preset folder colors for the picker
const WFO_COLOR_PRESETS = [
  "#ef4444", "#f97316", "#eab308", "#84cc16",
  "#16a34a", "#00f7ff", "#38bdf8", "#6366f1", "#a855f7",
  "#ec4899", "#f700ff",
];

// ── Colour conversion ───────────────────────────────────────────────────────
function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function hexToHsv(hex) {
  let h6 = (hex || "").replace("#", "");
  if (h6.length === 3) h6 = h6.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h6)) return null;
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

// Drag helper: calls onMove(x, y) with 0–1 coords for pointerdown + drag.
function bindDragArea(el, onMove) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const apply = (ev) => {
      const r = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      onMove(x, y);
    };
    apply(e);
    const move = (ev) => apply(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

// Transform a context menu into a folder-color picker: inline gradient picker
// (SV area + hue slider) + vivid preset swatches + hex input + reset.
function transformMenuToColorPicker(menu, currentColor, onPick, { showFolderOptions = true } = {}) {
  menu.innerHTML = "";
  menu.classList.add("wfo-standalone");
  menu.style.width = "220px";
  menu.style.padding = "10px";

  const heading = document.createElement("div");
  heading.className = "wfo-input-label";
  heading.textContent = showFolderOptions ? "Folder color:" : "File color:";
  heading.style.marginBottom = "8px";
  menu.appendChild(heading);

  let hsv = hexToHsv(currentColor) || { h: 210, s: 0.7, v: 0.9 };

  // Preset swatches (vivid) — the common case, shown first
  const grid = document.createElement("div");
  grid.className = "wfo-color-grid";
  const swatchEls = [];
  for (const c of WFO_COLOR_PRESETS) {
    const sw = document.createElement("button");
    sw.className = "wfo-swatch";
    sw.style.background = c;
    sw.title = c;
    sw.dataset.color = c;
    // Selecting a preset only previews it; Apply / Apply to all commit it.
    sw.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hsv = hexToHsv(c) || hsv;
      render();
    });
    grid.appendChild(sw);
    swatchEls.push(sw);
  }

  // Rainbow swatch opens the custom gradient picker
  const rainbowSwatch = document.createElement("button");
  rainbowSwatch.className = "wfo-swatch wfo-swatch-rainbow";
  rainbowSwatch.title = "Custom color";
  rainbowSwatch.innerHTML = `<span class="pi pi-palette"></span>`;
  grid.appendChild(rainbowSwatch);

  menu.appendChild(grid);

  // Highlight the swatch matching the current color with a checkmark.
  function markActiveSwatch() {
    const cur = currentHex().toLowerCase();
    for (const sw of swatchEls) {
      const on = sw.dataset.color.toLowerCase() === cur;
      sw.classList.toggle("wfo-swatch-active", on);
      sw.innerHTML = on ? `<span class="pi pi-check wfo-swatch-check"></span>` : "";
    }
  }

  // Gradient picker (hidden until toggled via rainbow swatch)
  const gradientWrap = document.createElement("div");
  gradientWrap.className = "wfo-gradient-wrap";
  gradientWrap.style.display = "none";
  const sv = document.createElement("div");
  sv.className = "wfo-sv-area";
  const svHandle = document.createElement("div");
  svHandle.className = "wfo-sv-handle";
  sv.appendChild(svHandle);
  gradientWrap.appendChild(sv);

  const hue = document.createElement("div");
  hue.className = "wfo-hue-slider";
  const hueHandle = document.createElement("div");
  hueHandle.className = "wfo-hue-handle";
  hue.appendChild(hueHandle);
  gradientWrap.appendChild(hue);
  menu.appendChild(gradientWrap);

  rainbowSwatch.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = gradientWrap.style.display === "none";
    gradientWrap.style.display = open ? "block" : "none";
    rainbowSwatch.classList.toggle("wfo-swatch-active", open);
    if (open) render();
  });

  // Preview + hex + apply
  const row = document.createElement("div");
  row.className = "wfo-color-row";
  const preview = document.createElement("div");
  preview.className = "wfo-color-preview";
  const hexWrap = document.createElement("div");
  hexWrap.className = "wfo-hex-wrap";
  const hexHash = document.createElement("span");
  hexHash.className = "wfo-hex-hash";
  hexHash.textContent = "#";
  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "wfo-inline-input wfo-hex-input";
  hex.placeholder = "RRGGBB";
  hex.maxLength = 6;
  hexWrap.appendChild(hexHash);
  hexWrap.appendChild(hex);
  const apply = document.createElement("button");
  apply.className = "wfo-sel-btn wfo-btn-primary wfo-color-apply";
  apply.textContent = "Apply";
  row.appendChild(preview);
  row.appendChild(hexWrap);
  row.appendChild(apply);
  menu.appendChild(row);

  function currentHex() {
    const [r, g, b] = hsvToRgb(hsv.h, hsv.s, hsv.v);
    return rgbToHex(r, g, b);
  }
  function render(updateHexField = true) {
    sv.style.background =
      `linear-gradient(to top, #000, rgba(0,0,0,0)),` +
      `linear-gradient(to right, #fff, rgba(255,255,255,0)),` +
      `hsl(${hsv.h}, 100%, 50%)`;
    svHandle.style.left = hsv.s * 100 + "%";
    svHandle.style.top = (1 - hsv.v) * 100 + "%";
    hueHandle.style.left = (hsv.h / 360) * 100 + "%";
    const hx = currentHex();
    preview.style.background = hx;
    if (updateHexField) hex.value = hx.replace("#", "");
    markActiveSwatch();
  }

  bindDragArea(sv, (x, y) => { hsv.s = x; hsv.v = 1 - y; render(); });
  bindDragArea(hue, (x) => { hsv.h = x * 360; render(); });

  hex.addEventListener("mousedown", (e) => e.stopPropagation());
  hex.addEventListener("input", () => {
    const parsed = hexToHsv(hex.value.trim());
    if (parsed) { hsv = parsed; render(false); }
  });
  hex.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); removeContextMenu(); onPick(currentHex()); }
    else if (e.key === "Escape") { removeContextMenu(); }
  });
  apply.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); removeContextMenu(); onPick(currentHex()); });

  if (showFolderOptions) {
    const applyAllRow = document.createElement("div");
    applyAllRow.className = "wfo-apply-all-row";
    const applyAll = document.createElement("button");
    applyAll.className = "wfo-sel-btn wfo-apply-all-btn";
    applyAll.textContent = "Apply to all";
    applyAll.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const col = currentHex();
      removeContextMenu();
      showWfoConfirm({
        title: "Apply color to all folders?",
        body: `Set every folder to <span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${col};vertical-align:middle;margin:0 4px"></span><b>${col}</b>. Overwrites existing colors.`,
        confirmLabel: "Apply to all",
        onConfirm: () => applyColorToAllFolders(col).catch((err) => {
          try { app.extensionManager?.toast?.add({ severity: "error", summary: "Apply to all failed", detail: err.message, life: 5000 }); } catch (_) {}
        }),
      });
    });
    applyAllRow.appendChild(applyAll);
    menu.appendChild(applyAllRow);
  }

  // Divider between the color-picking section and the reset action
  const divider = document.createElement("div");
  divider.className = "wfo-menu-divider";
  menu.appendChild(divider);

  if (showFolderOptions) {
    const filledToggle = document.createElement("div");
    filledToggle.className = "wfo-context-item wfo-filled-toggle";
    const renderFilledToggle = () => {
      const on = getFilledMode();
      filledToggle.innerHTML =
        `<span class="wfo-checkbox ${on ? "wfo-checkbox-on" : ""}">${on ? '<span class="pi pi-check"></span>' : ""}</span>` +
        `<span class="wfo-label">Filled folder icons</span>`;
    };
    renderFilledToggle();
    filledToggle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setFilledMode(!getFilledMode());
      renderFilledToggle();
      const panel = findWorkflowsPanel();
      if (panel) applyFolderColors(panel);
    });
    menu.appendChild(filledToggle);
  }

  const reset = document.createElement("div");
  reset.className = "wfo-context-item wfo-color-reset";
  reset.innerHTML = `<span class="pi pi-times wfo-icon"></span><span class="wfo-label">Reset color</span>`;
  reset.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); removeContextMenu(); onPick(""); });
  menu.appendChild(reset);

  if (showFolderOptions) {
    const resetAll = document.createElement("div");
    resetAll.className = "wfo-context-item wfo-color-reset";
    resetAll.innerHTML = `<span class="pi pi-times-circle wfo-icon"></span><span class="wfo-label">Reset all colors</span>`;
    resetAll.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeContextMenu();
      showWfoConfirm({
        title: "Reset all folder colors?",
        body: "Clear the color of every folder. This can be undone.",
        confirmLabel: "Reset all",
        onConfirm: () => resetAllFolders().catch((err) => {
          try { app.extensionManager?.toast?.add({ severity: "error", summary: "Reset all failed", detail: err.message, life: 5000 }); } catch (_) {}
        }),
      });
    });
    menu.appendChild(resetAll);
  }

  render();
  applyMenuMetrics(menu, nativeMenuMetrics);
}

// ── Confirm dialog (styled, matches ComfyUI dark theme) ──────────────────
function showWfoConfirm({ title, body, onConfirm, confirmLabel = "Confirm", danger = false }) {
  const overlay = document.createElement("div");
  overlay.className = "wfo-dialog-overlay";
  const dialog = document.createElement("div");
  dialog.className = "wfo-dialog";
  dialog.innerHTML =
    `<div class="wfo-dialog-header"><span>${title}</span><button class="wfo-dialog-x">✕</button></div>` +
    `<div class="wfo-dialog-body">${body}</div>` +
    `<div class="wfo-dialog-footer">` +
    `<button class="wfo-dialog-cancel">Cancel</button>` +
    `<button class="wfo-dialog-ok${danger ? " wfo-dialog-danger" : ""}">${confirmLabel}</button>` +
    `</div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  dialog.querySelector(".wfo-dialog-x").addEventListener("click", close);
  dialog.querySelector(".wfo-dialog-cancel").addEventListener("click", close);
  dialog.querySelector(".wfo-dialog-ok").addEventListener("click", () => { close(); onConfirm(); });
}

// ── Undo support ──────────────────────────────────────────────────────────
let undoBar = null;
let undoTimer = null;

function hideUndoSnackbar() {
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  if (undoBar) { undoBar.remove(); undoBar = null; }
}

// Show a "… — Undo" snackbar; clicking Undo runs undoFn.
function registerUndo(message, undoFn) {
  hideUndoSnackbar();
  const bar = document.createElement("div");
  bar.className = "wfo-undo-bar";
  const msg = document.createElement("span");
  msg.className = "wfo-undo-msg";
  msg.textContent = message;
  const btn = document.createElement("button");
  btn.className = "wfo-undo-btn";
  btn.textContent = "Undo";
  btn.addEventListener("click", async () => {
    hideUndoSnackbar();
    try {
      await undoFn();
      try { app.extensionManager?.toast?.add({ severity: "success", summary: "Undone", life: 2500 }); } catch (_) {}
    } catch (err) {
      try { app.extensionManager?.toast?.add({ severity: "error", summary: "Undo failed", detail: err.message, life: 5000 }); } catch (_) {}
    }
  });
  bar.appendChild(msg);
  bar.appendChild(btn);
  document.body.appendChild(bar);

  // Anchor over the Workflows sidebar (not the whole screen) when we can find it
  const panel = findWorkflowsPanel();
  if (panel) {
    const r = panel.getBoundingClientRect();
    bar.style.left = (r.left + r.width / 2) + "px";
    bar.style.maxWidth = Math.max(180, r.width - 24) + "px";
  }

  undoBar = bar;
  undoTimer = setTimeout(hideUndoSnackbar, 6000);
}

async function apiRenameFolder(oldRel, newRel) {
  const resp = await api.fetchApi("/wfo/folder/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old: `workflows/${oldRel}`, new: `workflows/${newRel}` }),
  });
  if (!resp.ok) throw new Error(await resp.text());
}

// Move a file/folder to trash; returns its trash token.
async function trashPath(rel) {
  const resp = await api.fetchApi("/wfo/trash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: `workflows/${rel}` }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  return (await resp.json()).trash;
}

// ── Bulk / multi-file move ──────────────────────────────────────────────────
// Move a list of workflow paths (buildPath style, no .json) into destRel.
// Registers a single undo for the whole batch. Returns how many actually moved.
async function performFileMoves(filePaths, destRel) {
  const undos = [];
  for (const rel of filePaths) {
    const fileName = rel.split("/").pop();
    const src = `workflows/${rel}.json`;
    const dst = `workflows/${destRel ? destRel + "/" : ""}${fileName}.json`;
    if (src === dst) continue;
    try { await moveUserDataFile(src, dst); undos.push([dst, src]); } catch (_) {}
  }
  if (destRel) { try { await deleteUserDataFile(`workflows/${destRel}/placeholder.json`); } catch (_) {} }
  await refreshWorkflowSidebar();
  if (undos.length) {
    const label = undos.length === 1 ? "workflow" : "workflows";
    registerUndo(`Moved ${undos.length} ${label}`, async () => {
      for (const [from, to] of undos) { try { await moveUserDataFile(from, to); } catch (_) {} }
      await refreshWorkflowSidebar();
    });
  }
  return undos.length;
}

async function bulkMoveSelection(container, destRel) {
  const paths = [...selectedPaths];
  clearSelection(container);
  const n = await performFileMoves(paths, destRel);
  try { app.extensionManager?.toast?.add({ severity: "success", summary: `Moved ${n} workflows`, detail: destRel || "Root", life: 3000 }); } catch (_) {}
}

async function bulkDeleteSelection(container) {
  const paths = [...selectedPaths];
  const undos = []; // [token, destRel]
  for (const rel of paths) {
    try { const token = await trashPath(`${rel}.json`); undos.push([token, `${rel}.json`]); } catch (_) {}
  }
  clearSelection(container);
  await refreshWorkflowSidebar();
  try { app.extensionManager?.toast?.add({ severity: "success", summary: `Deleted ${undos.length} workflows`, life: 3000 }); } catch (_) {}
  if (undos.length) {
    registerUndo(`Deleted ${undos.length} workflows`, async () => {
      for (const [token, destRel] of undos) { try { await restoreTrash(token, destRel); } catch (_) {} }
      await refreshWorkflowSidebar();
    });
  }
}

function showBulkMovePicker(container) {
  removeContextMenu();
  const menu = document.createElement("div");
  menu.className = "wfo-context-menu wfo-standalone";
  document.body.appendChild(menu);
  contextMenu = menu;
  const bar = document.querySelector(".wfo-selection-bar");
  const r = (bar || document.body).getBoundingClientRect();
  menu.style.left = r.left + "px";
  menu.style.bottom = (window.innerHeight - r.top + 6) + "px";
  transformMenuToFolderList(menu, {
    currentRel: "__none__",
    isExcluded: () => false,
    onPick: (rel) => bulkMoveSelection(container, rel),
  });
  const closeHandler = (ev) => {
    if (menu.contains(ev.target)) return;
    removeContextMenu();
    document.removeEventListener("mousedown", closeHandler);
  };
  setTimeout(() => document.addEventListener("mousedown", closeHandler), 50);
}

// ── Selection action bar ────────────────────────────────────────────────────
let selectionBar = null;
function updateSelectionBar(container) {
  const n = selectedPaths.size;
  if (n === 0) { if (selectionBar) { selectionBar.remove(); selectionBar = null; } return; }
  if (!selectionBar) {
    selectionBar = document.createElement("div");
    selectionBar.className = "wfo-selection-bar";
    selectionBar.innerHTML =
      `<span class="wfo-sel-count"></span>` +
      `<button class="wfo-sel-btn wfo-sel-move"><span class="pi pi-arrow-right"></span> Move to…</button>` +
      `<button class="wfo-sel-btn wfo-sel-del"><span class="pi pi-trash"></span></button>` +
      `<button class="wfo-sel-btn wfo-sel-clear"><span class="pi pi-times"></span></button>`;
    document.body.appendChild(selectionBar);
    selectionBar.querySelector(".wfo-sel-move").addEventListener("click", () => showBulkMovePicker(container));
    selectionBar.querySelector(".wfo-sel-del").addEventListener("click", () => {
      const n = selectedPaths.size;
      const list = [...selectedPaths].map(p => `<li>${p.split("/").pop()}</li>`).join("");
      showWfoConfirm({
        title: `Delete ${n} workflow${n === 1 ? "" : "s"}?`,
        body: `Are you sure you want to delete these workflows?<ul>${list}</ul>`,
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => bulkDeleteSelection(container),
      });
    });
    selectionBar.querySelector(".wfo-sel-clear").addEventListener("click", () => clearSelection(container));
  }
  selectionBar.querySelector(".wfo-sel-count").textContent = `${n} selected`;
  const panel = findWorkflowsPanel();
  if (panel) {
    const pr = panel.getBoundingClientRect();
    selectionBar.style.left = (pr.left + pr.width / 2) + "px";
    selectionBar.style.maxWidth = Math.max(180, pr.width - 24) + "px";
  }
}
// ──────────────────────────────────────────────────────────────────────────

// Move a workflow file into destRel ("" = root).
async function moveFileToFolder(item, destRel) {
  let fileName = getLabel(item);
  let sourcePath = buildPath(item);
  if (!fileName.endsWith(".json")) { fileName += ".json"; sourcePath += ".json"; }
  const prefix = "workflows/";
  const src = sourcePath.startsWith(prefix) ? sourcePath : prefix + sourcePath;
  const dst = prefix + (destRel ? destRel + "/" : "") + fileName;
  if (src === dst) return;
  try {
    await moveUserDataFile(src, dst);
    if (destRel) await deleteUserDataFile(`workflows/${destRel}/placeholder.json`);
    try { app.extensionManager?.toast?.add({ severity: "success", summary: "Workflow moved", detail: destRel || "Root", life: 3000 }); } catch (_) {}
    await refreshWorkflowSidebar();
    registerUndo(`Moved ${fileName.replace(/\.json$/, "")}`, async () => {
      await moveUserDataFile(dst, src);
      await refreshWorkflowSidebar();
    });
  } catch (err) {
    try { app.extensionManager?.toast?.add({ severity: "error", summary: "Move failed", detail: err.message, life: 5000 }); } catch (_) {}
  }
}

// Move a folder (with contents) into destRel ("" = root) via atomic rename.
async function moveFolderToFolder(item, destRel) {
  const srcRel = buildPath(item);
  const name = getLabel(item);
  const dstRel = destRel ? `${destRel}/${name}` : name;
  try {
    await apiRenameFolder(srcRel, dstRel);
    try { app.extensionManager?.toast?.add({ severity: "success", summary: "Folder moved", detail: destRel || "Root", life: 3000 }); } catch (_) {}
    await refreshWorkflowSidebar();
    registerUndo(`Moved ${name}`, async () => {
      await apiRenameFolder(dstRel, srcRel);
      await refreshWorkflowSidebar();
    });
  } catch (err) {
    try { app.extensionManager?.toast?.add({ severity: "error", summary: "Move failed", detail: err.message, life: 5000 }); } catch (_) {}
  }
}

// Build a "Move to…" menu item that opens the folder picker for the given item.
function makeMoveToItem(menu, item, isFolderItem) {
  const moveTo = document.createElement("div");
  moveTo.className = "wfo-context-item";
  moveTo.innerHTML = `<span class="pi pi-arrow-right wfo-icon"></span><span class="wfo-label">Move to…</span>`;
  moveTo.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const srcRel = buildPath(item);
    const currentParent = srcRel.includes("/") ? srcRel.slice(0, srcRel.lastIndexOf("/")) : "";
    transformMenuToFolderList(menu, {
      currentRel: currentParent,
      isExcluded: (rel) => {
        // Only hide truly invalid targets (a folder into itself or a descendant)
        if (isFolderItem) return rel === srcRel || rel.startsWith(srcRel + "/");
        return false;
      },
      onPick: (rel) => {
        if (isFolderItem) return moveFolderToFolder(item, rel);
        // If the right-clicked workflow is part of a multi-selection, move all
        const p = buildPath(item);
        if (selectedPaths.size > 1 && selectedPaths.has(p)) {
          const paths = [...selectedPaths];
          const panel = findWorkflowsPanel();
          if (panel) clearSelection(panel);
          return performFileMoves(paths, rel).then((n) => {
            try { app.extensionManager?.toast?.add({ severity: "success", summary: `Moved ${n} workflows`, detail: rel || "Root", life: 3000 }); } catch (_) {}
          });
        }
        return moveFileToFolder(item, rel);
      },
    });
  });
  return moveTo;
}

// Context menu for empty sidebar space — lets you create a root folder even when
// there are no files/folders to right-click.
function showEmptyAreaMenu(e) {
  removeContextMenu();
  const menu = document.createElement("div");
  menu.className = "wfo-context-menu wfo-standalone";
  const cursorX = e.clientX;
  const cursorY = e.clientY;
  setTimeout(() => {
    menu.style.left = cursorX + "px";
    menu.style.top = cursorY + "px";
    applyNativeMenuFont(menu, document.querySelector(".p-contextmenu, .p-tieredmenu"));
  }, 10);
  menu.appendChild(makeNewFolderItem(menu, ""));
  document.body.appendChild(menu);
  contextMenu = menu;
  const closeHandler = () => { removeContextMenu(); document.removeEventListener("mousedown", closeHandler); };
  setTimeout(() => document.addEventListener("mousedown", closeHandler), 100);
}

function showContextMenu(e, item) {
  removeContextMenu();
  const menu = document.createElement("div");
  menu.className = "wfo-context-menu";
  
  setTimeout(() => {
    const realMenu = document.querySelector(".p-contextmenu, .p-tieredmenu");
    if (realMenu) {
        const rect = realMenu.getBoundingClientRect();
        menu.style.left = rect.left + "px";
        menu.style.top = (rect.bottom - 4) + "px";
        menu.style.width = rect.width + "px";
        // Replace native "Duplicate" (opens tab) with file copy on disk
        try {
          for (const el of realMenu.querySelectorAll("a, [class*='item-link'], [class*='item-content']")) {
            if (el.textContent.trim() === "Duplicate") {
              const clone = el.cloneNode(true);
              clone.addEventListener("click", async () => {
                const path = buildPath(item);
                try {
                  const newName = await duplicateFile(path);
                  try { app.extensionManager?.toast?.add({ severity: "success", summary: "Workflow duplicated", detail: newName.replace(/\.json$/, ""), life: 3000 }); } catch (_) {}
                  await refreshWorkflowSidebar();
                } catch (err) {
                  try { app.extensionManager?.toast?.add({ severity: "error", summary: "Duplicate failed", detail: err.message, life: 5000 }); } catch (_) {}
                }
              });
              el.parentNode.replaceChild(clone, el);
              break;
            }
          }
        } catch (_) {}
        // Replace native "Delete" with bulk delete when multiple items are selected
        if (selectedPaths.size > 1 && selectedPaths.has(buildPath(item))) {
          try {
            for (const el of realMenu.querySelectorAll("a, [class*='item-link'], [class*='item-content']")) {
              if (el.textContent.trim() === "Delete") {
                const n = selectedPaths.size;
                const paths = [...selectedPaths];
                const clone = el.cloneNode(true);
                clone.addEventListener("click", () => {
                  const list = paths.map(p => `<li>${p.split("/").pop()}</li>`).join("");
                  showWfoConfirm({
                    title: `Delete ${n} workflow${n === 1 ? "" : "s"}?`,
                    body: `Are you sure you want to delete these workflows?<ul>${list}</ul>`,
                    confirmLabel: "Delete",
                    danger: true,
                    onConfirm: () => { const panel = findWorkflowsPanel(); if (panel) bulkDeleteSelection(panel); },
                  });
                });
                el.parentNode.replaceChild(clone, el);
                break;
              }
            }
          } catch (_) {}
        }
    } else {
        menu.style.left = e.clientX + "px";
        menu.style.top = e.clientY + "px";
    }
    applyNativeMenuFont(menu, realMenu);
  }, 10);

  const moveTo = makeMoveToItem(menu, item, false);
  const newFolder = makeNewFolderItem(menu, "");

  const wfoDivider = document.createElement("div");
  wfoDivider.className = "wfo-context-divider";

  const setColorItem = document.createElement("div");
  setColorItem.className = "wfo-context-item";
  setColorItem.innerHTML = `<span class="pi pi-palette wfo-icon"></span><span class="wfo-label">Set Color</span>`;
  setColorItem.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const fileRel = buildPath(item);
    transformMenuToColorPicker(menu, fileColors[fileRel] || "", async (color) => {
      try {
        await setFileColor(fileRel, color);
      } catch (err) {
        try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
      }
    }, { showFolderOptions: false });
  });

  document.body.appendChild(menu);
  menu.appendChild(wfoDivider);
  menu.appendChild(moveTo);
  menu.appendChild(setColorItem);
  menu.appendChild(newFolder);
  contextMenu = menu;
  
  const closeHandler = () => { removeContextMenu(); document.removeEventListener("mousedown", closeHandler); };
  setTimeout(() => document.addEventListener("mousedown", closeHandler), 100);
}

function showFolderContextMenu(e, item) {
  removeContextMenu();
  const menu = document.createElement("div");
  menu.className = "wfo-context-menu wfo-standalone";

  // A folder has no native ComfyUI menu, so position at the cursor — never align
  // to a leftover native menu from a previous (file) right-click.
  const cursorX = e.clientX;
  const cursorY = e.clientY;
  setTimeout(() => {
    menu.style.left = cursorX + "px";
    menu.style.top = cursorY + "px";
    // realMenu (if any leftover) only feeds the font cache; harmless if stale
    applyNativeMenuFont(menu, document.querySelector(".p-contextmenu, .p-tieredmenu"));
  }, 10);

  const renameFolder = document.createElement("div");
  renameFolder.className = "wfo-context-item";
  renameFolder.innerHTML = `<span class="pi pi-pencil wfo-icon"></span><span class="wfo-label">Rename Folder</span>`;

  renameFolder.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    removeContextMenu();

    const oldLabel = getLabel(item);
    inlineRenameInTree(item, async (newName) => {
      const cleanName = newName.replace(/[/\\]/g, "");
      if (!cleanName || cleanName === oldLabel) return;

    const oldFolderPath = buildPath(item);
    const parts = oldFolderPath.split("/");
    parts[parts.length - 1] = cleanName;
    const newFolderPath = parts.join("/");

    try {
      const resp = await api.fetchApi("/wfo/folder/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old: `workflows/${oldFolderPath}`, new: `workflows/${newFolderPath}` }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      try { app.extensionManager?.toast?.add({ severity: "success", summary: "Folder renamed", detail: `${oldLabel} → ${cleanName}`, life: 3000 }); } catch (_) {}
      await refreshWorkflowSidebar();
    } catch (err) {
      try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
    }
    });
  });

  const deleteFolder_ = document.createElement("div");
  deleteFolder_.className = "wfo-context-item wfo-danger";
  deleteFolder_.innerHTML = `<span class="pi pi-trash wfo-icon"></span><span class="wfo-label">Delete Folder</span>`;

  deleteFolder_.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    removeContextMenu();
    const label = getLabel(item);
    const folderPath = buildPath(item);
    showWfoConfirm({
      title: "Delete folder?",
      body: `Delete "<b>${label}</b>" and all its contents? This can be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          const result = await deleteFolder(`workflows/${folderPath}`, true);
          try { app.extensionManager?.toast?.add({ severity: "success", summary: "Folder deleted", detail: label, life: 3000 }); } catch (_) {}
          await refreshWorkflowSidebar();
          if (result && result.trash) {
            registerUndo(`Deleted ${label}`, async () => {
              await restoreTrash(result.trash, folderPath);
              await refreshWorkflowSidebar();
            });
          }
        } catch (err) {
          try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
        }
      },
    });
  });

  const duplicateFolder_ = document.createElement("div");
  duplicateFolder_.className = "wfo-context-item";
  duplicateFolder_.innerHTML = `<span class="pi pi-copy wfo-icon"></span><span class="wfo-label">Duplicate Folder</span>`;

  duplicateFolder_.addEventListener("mousedown", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    removeContextMenu();

    try {
      const newName = await duplicateFolder(`workflows/${buildPath(item)}`);
      try { app.extensionManager?.toast?.add({ severity: "success", summary: "Folder duplicated", detail: newName, life: 3000 }); } catch (_) {}
      await refreshWorkflowSidebar();
    } catch (err) {
      try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
    }
  });

  const setColor = document.createElement("div");
  setColor.className = "wfo-context-item";
  setColor.innerHTML = `<span class="pi pi-palette wfo-icon"></span><span class="wfo-label">Set Color</span>`;
  setColor.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const folderRel = buildPath(item);
    transformMenuToColorPicker(menu, folderColors[folderRel] || "", async (color) => {
      try {
        await setFolderColor(folderRel, color);
      } catch (err) {
        try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
      }
    });
  });

  const moveTo = makeMoveToItem(menu, item, true);
  const newFolderRoot = makeNewFolderItem(menu, "", "New Folder");
  const newSubFolder = makeNewFolderItem(menu, buildPath(item), "New Sub Folder", "pi-folder-plus", "New subfolder name:");

  document.body.appendChild(menu);
  menu.appendChild(renameFolder);
  menu.appendChild(duplicateFolder_);
  menu.appendChild(moveTo);
  menu.appendChild(setColor);
  menu.appendChild(newFolderRoot);
  menu.appendChild(newSubFolder);
  menu.appendChild(deleteFolder_);
  contextMenu = menu;

  const closeHandler = () => { removeContextMenu(); document.removeEventListener("mousedown", closeHandler); };
  setTimeout(() => document.addEventListener("mousedown", closeHandler), 100);
}

function findWorkflowsPanel() {
  const treeItems = document.querySelectorAll("[role='treeitem']");
  if (treeItems.length > 0) {
    const first = treeItems[0];
    return first.closest(".p-tree") || first.closest("[class*='tree']") || first.parentElement;
  }
  return null;
}

function attachDragHandlers(container) {
  container.querySelectorAll("[role='treeitem']").forEach((item) => {
    if (item.dataset.wfoDrag === "1") return;
    item.dataset.wfoDrag = "1";
    const contentEl = item.querySelector(".p-tree-node-content");
    if (!contentEl) return;

    if (isFile(item)) {
      if (getLabel(item) === "placeholder") {
        item.style.display = "none";
        const parentFolder = item.parentElement?.closest("[role='treeitem']");
        if (parentFolder) {
          const badge = parentFolder.querySelector(".p-tree-node-label .p-badge, .p-tree-node-label [class*='badge']");
          if (badge) {
            const n = parseInt(badge.textContent, 10);
            if (!isNaN(n)) {
              const next = n - 1;
              if (next <= 0) badge.style.display = "none";
              else badge.textContent = String(next);
            }
          }
        }
        return;
      }
      contentEl.setAttribute("draggable", "true");
      contentEl.addEventListener("dragstart", (e) => {
        const path = buildPath(item);
        const name = getLabel(item);
        if (!path || !name) { e.preventDefault(); return; }
        // If dragging part of a multi-selection, carry the whole selection
        const files = (selectedPaths.size > 1 && selectedPaths.has(path)) ? [...selectedPaths] : [path];
        dragData = { path, name, element: item, isFolder: false, files };
        e.dataTransfer.effectAllowed = "move";
        contentEl.style.opacity = "0.4";
        setTimeout(() => showRootDropBar(container), 0);
      });
      contentEl.addEventListener("dragend", () => {
        contentEl.style.opacity = "1";
        dragData = null;
        container.querySelectorAll(".wfo-drop-highlight").forEach((el) => el.classList.remove("wfo-drop-highlight"));
        hideRootDropBar();
      });
      contentEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        itemContextActive = true;
        showContextMenu(e, item);
      });
    }

    if (isFolder(item)) {
      contentEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        itemContextActive = true;
        showFolderContextMenu(e, item);
      });

      // A folder is also a drag source (move folder + contents into another folder)
      contentEl.setAttribute("draggable", "true");
      contentEl.addEventListener("dragstart", (e) => {
        const path = buildPath(item);
        const name = getLabel(item);
        if (!path || !name) { e.preventDefault(); return; }
        dragData = { path, name, element: item, isFolder: true };
        e.dataTransfer.effectAllowed = "move";
        contentEl.style.opacity = "0.4";
        setTimeout(() => showRootDropBar(container), 0);
      });
      contentEl.addEventListener("dragend", () => {
        contentEl.style.opacity = "1";
        dragData = null;
        container.querySelectorAll(".wfo-drop-highlight").forEach((el) => el.classList.remove("wfo-drop-highlight"));
        hideRootDropBar();
      });

      // Is this folder a valid drop target for the current folder drag?
      const isInvalidFolderTarget = () => {
        if (!dragData || !dragData.isFolder) return false;
        const targetPath = buildPath(item);
        // Itself or one of its own descendants
        if (targetPath === dragData.path || targetPath.startsWith(dragData.path + "/")) return true;
        // The folder it already lives in (dropping here would be a no-op)
        const srcParent = dragData.path.includes("/")
          ? dragData.path.slice(0, dragData.path.lastIndexOf("/"))
          : "";
        return targetPath === srcParent;
      };

      contentEl.addEventListener("dragover", (e) => {
        if (!dragData) return;
        if (isInvalidFolderTarget()) {
          e.dataTransfer.dropEffect = "none";
          contentEl.classList.remove("wfo-drop-highlight");
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        contentEl.classList.add("wfo-drop-highlight");
      });
      contentEl.addEventListener("dragleave", () => contentEl.classList.remove("wfo-drop-highlight"));
      contentEl.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        contentEl.classList.remove("wfo-drop-highlight");
        if (!dragData) return;

        const folderPath = buildPath(item);

        // Folder dropped onto another folder → move folder + contents
        if (dragData.isFolder) { await moveFolderTo(folderPath); return; }

        // File(s) dropped onto a folder → move workflow(s)
        const files = dragData.files || [dragData.path];
        dragData = null;
        try {
          const n = await performFileMoves(files, folderPath);
          clearSelection(container);
          if (n > 0) { try { app.extensionManager?.toast?.add({ severity: "success", summary: n === 1 ? "Workflow moved" : `Moved ${n} workflows`, detail: folderPath, life: 3000 }); } catch (_) {} }
        } catch (err) {
          try { app.extensionManager?.toast?.add({ severity: "error", summary: "Move failed", detail: err.message, life: 5000 }); } catch (_) {}
        }
      });
    }
  });
}

function injectStyles() {
  if (document.getElementById("wfo-styles")) return;
  const style = document.createElement("style");
  style.id = "wfo-styles";
  style.textContent = `
    .wfo-root-bar-wrap {
      position: fixed;
      z-index: 9999;
      pointer-events: none;
      background: var(--wfo-bar-bg, var(--comfy-menu-bg, #1a1a1a));
    }
    .wfo-root-bar {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px dashed #666;
      background: transparent;
      color: #aaa;
      font-size: 11px;
      font-weight: 500;
      font-family: var(--comfy-font-family, Inter, Arial, sans-serif);
      pointer-events: auto;
      transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .wfo-root-bar * { pointer-events: none; }
    .wfo-root-bar-icon { font-size: 12px; }
    .wfo-root-bar.wfo-root-bar-active {
      background: var(--p-primary-color, #4a9eff);
      border-color: var(--p-primary-color, #4a9eff);
      border-style: solid;
      color: #fff;
    }
    .wfo-drop-highlight { background-color: var(--content-hover-bg, #222) !important; outline: 1px dashed var(--p-primary-color, #4a9eff); border-radius: 4px; }
    .wfo-context-menu {
        position: fixed;
        z-index: 1000000;
        background: var(--comfy-menu-bg, #171718);
        border: 1px solid var(--border-color, #4e4e4e);
        border-top: none;
        border-bottom-left-radius: 4px;
        border-bottom-right-radius: 4px;
        padding: 0;
        box-shadow: var(--bar-shadow, 0 4px 12px rgba(0,0,0,0.5));
        font-family: var(--comfy-font-family, Inter, Arial, sans-serif);
        box-sizing: border-box;
    }
    /* Standalone menus (folder / empty-area) have no native menu above them */
    .wfo-context-menu.wfo-standalone {
        border-top: 1px solid var(--border-color, #4e4e4e);
        border-radius: 4px;
        min-width: 180px;
    }
    .wfo-context-item {
        padding: 8px 12px;
        font-size: 16.5px;
        color: var(--input-text, #fff);
        cursor: pointer;
        display: flex;
        align-items: center;
        transition: background 0.1s;
        width: 100%;
        box-sizing: border-box;
        overflow: hidden;
    }
    .wfo-context-item:hover { background: var(--content-hover-bg, #222); color: var(--content-hover-fg, #fff); }
    .wfo-icon {
        font-size: 16.5px;
        color: var(--descrip-text, #999);
        width: 16px;
        flex: 0 0 auto;
        text-align: center;
        margin-left: 2px; /* Dit schuift de pijl die laatste pixels naar rechts */
        margin-right: 10px; /* Ruimte tussen pijl en tekst */
        pointer-events: none;
    }
    .wfo-label {
        font-weight: 400;
        pointer-events: none;
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .wfo-undo-bar {
        position: fixed;
        left: 50%;
        bottom: 24px;
        transform: translateX(-50%);
        z-index: 1000000;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 10px 12px 10px 16px;
        border-radius: 8px;
        background: var(--comfy-menu-bg, #1e1e1e);
        border: 1px solid var(--border-color, #4e4e4e);
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        color: var(--input-text, #fff);
        font-family: var(--comfy-font-family, Inter, Arial, sans-serif);
        font-size: 13px;
        animation: wfo-undo-in 0.15s ease-out;
    }
    @keyframes wfo-undo-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
    .wfo-undo-msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .wfo-undo-btn { flex: 0 0 auto; }
    .wfo-undo-btn {
        background: transparent;
        border: 1px solid var(--p-primary-color, #4a9eff);
        color: var(--p-primary-color, #4a9eff);
        font-weight: 600;
        font-size: 12px;
        padding: 4px 12px;
        border-radius: 5px;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.12s, color 0.12s;
    }
    .wfo-undo-btn:hover { background: var(--p-primary-color, #4a9eff); color: #fff; }
    .wfo-selected {
        background: color-mix(in srgb, var(--p-primary-color, #4a9eff) 22%, transparent) !important;
        box-shadow: inset 2px 0 0 var(--p-primary-color, #4a9eff);
        border-radius: 4px;
    }
    .wfo-selection-bar {
        position: fixed;
        bottom: 24px;
        transform: translateX(-50%);
        z-index: 1000000;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        background: var(--comfy-menu-bg, #1e1e1e);
        border: 1px solid var(--border-color, #4e4e4e);
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        color: var(--input-text, #fff);
        font-family: var(--comfy-font-family, Inter, Arial, sans-serif);
        font-size: 13px;
        animation: wfo-undo-in 0.15s ease-out;
    }
    .wfo-sel-count { white-space: nowrap; margin-right: 4px; font-weight: 500; }
    .wfo-sel-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: transparent;
        border: 1px solid var(--border-color, #4e4e4e);
        color: var(--input-text, #fff);
        font-size: 12px;
        padding: 5px 10px;
        border-radius: 5px;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .wfo-sel-btn:hover { background: var(--content-hover-bg, #333); }
    .wfo-sel-move:hover { border-color: var(--p-primary-color, #4a9eff); color: var(--p-primary-color, #4a9eff); }
    .wfo-sel-del:hover { border-color: #ff6b6b; color: #ff6b6b; }
    .wfo-color-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 6px;
        margin-bottom: 10px;
    }
    .wfo-swatch {
        width: 100%;
        aspect-ratio: 1 / 1;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.1s, border-color 0.1s;
    }
    .wfo-swatch:hover { transform: scale(1.15); }
    .wfo-swatch-active { border-color: var(--input-text, #fff); }
    .wfo-swatch-rainbow {
        background: var(--comfy-input-bg, #2a2a2a);
        border-color: var(--border-color, #4e4e4e);
        color: var(--input-text, #ccc);
        font-size: 16px;
        transform: scale(1.06);
    }
    .wfo-swatch-rainbow:hover { transform: scale(1.19); }
    .wfo-swatch-rainbow .pi { line-height: 1; }
    .wfo-swatch-check {
        color: #fff;
        font-size: 11px;
        font-weight: bold;
        text-shadow: 0 0 2px rgba(0,0,0,0.85), 0 0 3px rgba(0,0,0,0.6);
        pointer-events: none;
    }
    .wfo-color-row { display: flex; align-items: center; gap: 8px; margin: 10px 0 8px; }
    .wfo-hex-wrap {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 3px;
        border: 1px solid var(--border-color, #4e4e4e);
        border-radius: 4px;
        padding: 0 6px;
        background: var(--comfy-input-bg, #222);
    }
    .wfo-hex-hash { color: var(--descrip-text, #999); flex: 0 0 auto; }
    .wfo-hex-input {
        flex: 1 1 auto;
        min-width: 0;
        border: none !important;
        background: transparent !important;
        padding: 5px 0 !important;
        outline: none;
    }
    .wfo-folder-filled::before {
        content: "" !important;
        display: inline-block;
        width: 1rem;
        height: 1rem;
        vertical-align: middle;
        background-color: currentColor;
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='2 4 20 16'%3E%3Cpath d='M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'/%3E%3C/svg%3E") center / contain no-repeat;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='2 4 20 16'%3E%3Cpath d='M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'/%3E%3C/svg%3E") center / contain no-repeat;
    }
    .pi-folder-open.wfo-folder-filled::before {
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 576 512'%3E%3Cpath d='M572.694 292.093L500.27 416.248A63.997 63.997 0 0 1 444.989 448H45.025c-18.523 0-30.064-20.093-20.731-36.093l72.424-124.155A64 64 0 0 1 152.999 256h399.964c18.523 0 30.064 20.093 20.731 36.093zM152.999 224h328.66l-7.736-31.471A48 48 0 0 0 427.13 160H272V104a48 48 0 0 0-48-48H48A48 48 0 0 0 0 104v292.293l69.044-118.36C86.347 248.351 117.886 224 152.999 224z'/%3E%3C/svg%3E") center / contain no-repeat;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 576 512'%3E%3Cpath d='M572.694 292.093L500.27 416.248A63.997 63.997 0 0 1 444.989 448H45.025c-18.523 0-30.064-20.093-20.731-36.093l72.424-124.155A64 64 0 0 1 152.999 256h399.964c18.523 0 30.064 20.093 20.731 36.093zM152.999 224h328.66l-7.736-31.471A48 48 0 0 0 427.13 160H272V104a48 48 0 0 0-48-48H48A48 48 0 0 0 0 104v292.293l69.044-118.36C86.347 248.351 117.886 224 152.999 224z'/%3E%3C/svg%3E") center / contain no-repeat;
    }
    .wfo-color-preview {
        width: 26px; height: 26px; flex: 0 0 auto;
        border-radius: 4px; border: 1px solid var(--border-color, #4e4e4e);
    }
    .wfo-color-apply { flex: 0 0 auto; padding: 5px 10px; }
    .wfo-btn-primary {
        background: var(--p-primary-color, #4a8cff);
        border-color: var(--p-primary-color, #4a8cff);
        color: #fff;
        font-weight: 500;
    }
    .wfo-btn-primary:hover {
        background: var(--p-primary-color, #4a8cff);
        filter: brightness(1.12);
    }
    .wfo-color-reset { padding: 6px 4px; border-radius: 4px; }
    .wfo-apply-all-row { margin: 0 0 4px; }
    .wfo-apply-all-btn { width: 100%; justify-content: center; padding: 6px 10px; }
    .wfo-menu-divider {
        height: 1px;
        background: var(--border-color, #6a6a6a);
        opacity: 1;
        margin: 10px -10px 8px;
    }
    .wfo-context-divider {
        height: 1px;
        background: var(--border-color, #4e4e4e);
        margin: 0;
    }
    .wfo-checkbox {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        margin-left: 0;
        margin-right: 12px;
        box-sizing: border-box;
        border: 1.5px solid var(--border-color, #888);
        border-radius: 3px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: #fff;
        pointer-events: none;
    }
    .wfo-checkbox-on {
        background: var(--p-primary-color, #4a8cff);
        border-color: var(--p-primary-color, #4a8cff);
    }
    .wfo-custom-toggle { padding: 6px 4px; border-radius: 4px; }
    .wfo-custom-chevron {
        margin-left: auto;
        font-size: 11px;
        opacity: 0.7;
        transition: transform 0.15s;
    }
    .wfo-custom-open .wfo-custom-chevron { transform: rotate(180deg); }
    .wfo-gradient-wrap { margin-top: 8px; }
    .wfo-sv-area {
        position: relative;
        width: 100%;
        height: 120px;
        border-radius: 5px;
        cursor: crosshair;
        touch-action: none;
    }
    .wfo-sv-handle {
        position: absolute;
        width: 12px; height: 12px;
        border: 2px solid #fff;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 2px rgba(0,0,0,0.7);
        pointer-events: none;
    }
    .wfo-hue-slider {
        position: relative;
        width: 100%;
        height: 14px;
        margin-top: 8px;
        border-radius: 7px;
        cursor: pointer;
        touch-action: none;
        background: linear-gradient(to right,
            #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);
    }
    .wfo-hue-handle {
        position: absolute;
        top: 50%;
        width: 14px; height: 14px;
        border: 2px solid #fff;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 2px rgba(0,0,0,0.7);
        pointer-events: none;
    }
    .wfo-current-tag {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--descrip-text, #999);
        border: 1px solid var(--border-color, #4e4e4e);
        border-radius: 3px;
        padding: 1px 4px;
        margin-left: 8px;
        flex: 0 0 auto;
        pointer-events: none;
    }
    .wfo-danger { color: #ff6b6b !important; }
    .wfo-danger .wfo-icon { color: #ff6b6b !important; }
    .wfo-danger:hover { background: rgba(255,107,107,0.15) !important; }
    .wfo-tree-input {
      background: transparent;
      border: none;
      border-bottom: 1px solid var(--p-primary-color, #4a9eff);
      color: inherit;
      font: inherit;
      outline: none;
      padding: 0;
      width: 100%;
      min-width: 80px;
    }
    .wfo-input-label {
      font-size: 11px;
      color: var(--descrip-text, #999);
      font-family: var(--comfy-font-family, Inter, Arial, sans-serif);
    }
    .wfo-input-hint {
      font-size: 10px;
      color: var(--descrip-text, #666);
      font-family: var(--comfy-font-family, Inter, Arial, sans-serif);
      text-align: right;
    }
    .wfo-inline-input {
      width: 100%;
      background: var(--comfy-input-bg, #1a1a1a);
      border: 1px solid var(--p-primary-color, #4a9eff);
      border-radius: 3px;
      color: var(--input-text, #fff);
      font-size: 14px;
      padding: 5px 8px;
      outline: none;
      box-sizing: border-box;
      font-family: var(--comfy-font-family, Inter, Arial, sans-serif);
    }
    .wfo-dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 9999999;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .wfo-dialog {
      background: var(--comfy-menu-bg, #1e1e1e);
      border: 1px solid var(--border-color, #4e4e4e);
      border-radius: 8px;
      min-width: 320px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      font-family: var(--comfy-font-family, Inter, Arial, sans-serif);
      color: var(--input-text, #fff);
    }
    .wfo-dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 14px;
      font-size: 16px;
      font-weight: 600;
      border-bottom: 1px solid var(--border-color, #4e4e4e);
    }
    .wfo-dialog-x {
      background: none;
      border: none;
      color: var(--descrip-text, #999);
      cursor: pointer;
      font-size: 13px;
      padding: 0;
      line-height: 1;
    }
    .wfo-dialog-x:hover { color: var(--input-text, #fff); }
    .wfo-dialog-body {
      padding: 16px 20px;
      font-size: 14px;
      color: var(--input-text, #ccc);
      line-height: 1.5;
    }
    .wfo-dialog-body ul { margin: 8px 0 0 16px; padding: 0; }
    .wfo-dialog-body li { margin: 3px 0; font-size: 13px; color: var(--descrip-text, #999); }
    .wfo-dialog-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 4px 20px 16px;
    }
    .wfo-dialog-cancel {
      background: transparent;
      border: 1px solid var(--border-color, #4e4e4e);
      color: var(--input-text, #fff);
      padding: 8px 18px;
      border-radius: 5px;
      cursor: pointer;
      font-family: inherit;
      font-size: 14px;
    }
    .wfo-dialog-cancel:hover { background: var(--content-hover-bg, #333); }
    .wfo-dialog-ok {
      background: var(--p-primary-color, #4a8cff);
      border: 1px solid var(--p-primary-color, #4a8cff);
      color: #fff;
      padding: 8px 18px;
      border-radius: 5px;
      cursor: pointer;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
    }
    .wfo-dialog-ok:hover { filter: brightness(1.1); }
    .wfo-dialog-danger {
      background: #e53e3e;
      border-color: #e53e3e;
    }
    .wfo-dialog-danger:hover { background: #c53030; border-color: #c53030; filter: none; }
  `;
  document.head.appendChild(style);
}

// Cache of folder paths (relative to workflows/) that contain only placeholder.json
let placeholderOnlyFolders = new Set();

// Ask the server to add placeholder.json to any folder on disk that has none,
// so emptied folders stay visible. Server-side & idempotent: it never recreates
// a renamed/deleted folder (those are gone from disk). Triggers one refresh if
// it actually created anything.
let ensureScheduled = false;
function ensurePlaceholders() {
  if (ensureScheduled) return;
  ensureScheduled = true;
  setTimeout(async () => {
    ensureScheduled = false;
    try {
      const resp = await api.fetchApi("/wfo/ensure-placeholders", { method: "POST" });
      if (!resp.ok) return;
      const { created } = await resp.json();
      if (created > 0) await refreshWorkflowSidebar();
    } catch (_) {}
  }, 500);
}

async function loadPlaceholderFolders() {
  try {
    const resp = await api.fetchApi("/userdata?dir=workflows&recurse=true&split=false");
    if (!resp.ok) return;
    const files = await resp.json();
    const folderFiles = {};
    for (const f of files) {
      const rel = f.replace(/^workflows\//, "");
      const parts = rel.split("/");
      if (parts.length < 2) continue;
      const key = parts.slice(0, parts.length - 1).join("/");
      if (!folderFiles[key]) folderFiles[key] = [];
      folderFiles[key].push(parts[parts.length - 1]);
    }
    placeholderOnlyFolders = new Set(
      Object.entries(folderFiles)
        .filter(([, fs]) => fs.length === 1 && fs[0] === "placeholder.json")
        .map(([key]) => key.split("/").pop())
    );
  } catch (_) {}
}

function applyPlaceholderBadges(panel) {
  const allItems = [...panel.querySelectorAll("[role='treeitem']")];
  for (const item of allItems) {
    if (item.classList.contains("p-tree-node-leaf")) continue;
    const label = getLabel(item);
    if (!label) continue;
    const badge = item.querySelector(".p-tree-node-label .p-badge, .p-tree-node-label [class*='badge']");
    if (!badge) continue;
    badge.style.display = placeholderOnlyFolders.has(label) ? "none" : "";
  }
}

// Map of file rel-path → hex color
let fileColors = {};
async function loadFileColors() {
  try {
    const resp = await api.fetchApi("/wfo/file/colors");
    if (resp.ok) fileColors = await resp.json();
  } catch (_) {}
}

function applyFileColors(panel) {
  panel.querySelectorAll("[role='treeitem']").forEach((el) => {
    if (!el.classList.contains("p-tree-node-leaf")) return;
    if (getLabel(el) === "placeholder") return;
    const icon = el.querySelector(".pi-file, [class*='pi-file']");
    if (!icon) return;
    const color = fileColors[buildPath(el)];
    icon.style.color = color || "";
  });
}

async function setFileColor(fileRel, color) {
  const resp = await api.fetchApi("/wfo/file/colors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fileRel, color: color || "" }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  await loadFileColors();
  const panel = findWorkflowsPanel();
  if (panel) applyFileColors(panel);
}

// Map of folder rel-path → hex color
let folderColors = {};
async function loadFolderColors() {
  try {
    const resp = await api.fetchApi("/wfo/colors");
    if (resp.ok) folderColors = await resp.json();
  } catch (_) {}
}

// Global "filled folder icons" look — a per-browser display preference.
// Default on (matches the look colors shipped with). Only colored folders
// are filled; uncolored ones keep ComfyUI's default outline icon.
function getFilledMode() {
  try { return localStorage.getItem("wfo_filled") !== "0"; } catch (_) { return true; }
}
function setFilledMode(on) {
  try { localStorage.setItem("wfo_filled", on ? "1" : "0"); } catch (_) {}
}

function applyFolderColors(panel) {
  const filled = getFilledMode();
  panel.querySelectorAll("[role='treeitem']").forEach((el) => {
    if (el.classList.contains("p-tree-node-leaf")) return;
    const icon = el.querySelector(".pi-folder, .pi-folder-open");
    if (!icon) return;
    const color = folderColors[buildPath(el)];
    icon.style.color = color || "";
    icon.classList.toggle("wfo-folder-filled", !!color && filled);
  });
}

async function setFolderColor(folderRel, color) {
  const resp = await api.fetchApi("/wfo/colors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folderRel, color: color || "" }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  await loadFolderColors();
  const panel = findWorkflowsPanel();
  if (panel) applyFolderColors(panel);
}

// Replace the whole color map in one request (used by "Apply to all" + undo).
async function bulkSetColors(map) {
  const resp = await api.fetchApi("/wfo/colors/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ colors: map }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  await loadFolderColors();
  const panel = findWorkflowsPanel();
  if (panel) applyFolderColors(panel);
}

// Set every folder to one color at once (overwrites existing colors); undoable.
async function applyColorToAllFolders(color) {
  const folders = await getAllFolders();
  if (!folders.length) return;
  const prev = { ...folderColors };
  const next = {};
  for (const f of folders) next[f] = color;
  await bulkSetColors(next);
  registerUndo("Colored all folders", () => bulkSetColors(prev));
}

// Clear the color of every folder at once; undoable.
async function resetAllFolders() {
  const prev = { ...folderColors };
  if (!Object.keys(prev).length) return;
  await bulkSetColors({});
  registerUndo("Cleared all folder colors", () => bulkSetColors(prev));
}

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    injectStyles();
    installSelectionHandlers();
    let wfoPanelReady = false;
    let wfoReadyTimer;
    const bodyObserver = new MutationObserver(() => {
      try {
      const panel = findWorkflowsPanel();
      if (panel && !panel.dataset.wfoInit) {
        wfoPanelReady = true;
        clearTimeout(wfoReadyTimer);
        panel.dataset.wfoInit = "1";
        attachDragHandlers(panel);
        ensurePlaceholders();
        loadPlaceholderFolders().then(() => applyPlaceholderBadges(panel));
        loadFolderColors().then(() => applyFolderColors(panel));
        loadFileColors().then(() => applyFileColors(panel));
        // Right-click on empty sidebar space → create a root folder.
        // Climb to the full-height sidebar container (same column width as the
        // tree) so empty space below the list is covered too.
        const panelW = panel.getBoundingClientRect().width;
        let shell = panel;
        let p = panel.parentElement;
        while (p && Math.abs(p.getBoundingClientRect().width - panelW) < 40) {
          shell = p;
          p = p.parentElement;
        }
        // Item handlers set itemContextActive; if they did, this was on an item.
        shell.addEventListener("contextmenu", (e) => {
          try {
            if (itemContextActive) { itemContextActive = false; return; }
            if (e.target.closest("input, textarea, button, [role='treeitem'], .p-inputtext, [class*='search']")) return;
            e.preventDefault();
            showEmptyAreaMenu(e);
          } catch (_) {}
        });
        const treeObserver = new MutationObserver(() => {
          try {
            attachDragHandlers(panel);
            applyPlaceholderBadges(panel);
            applyFolderColors(panel);
            applyFileColors(panel);
            ensurePlaceholders();
            if (selectedPaths.size) applySelectionStyles(panel);
          } catch (err) {
            console.warn("[WFO] treeObserver error, continuing:", err);
          }
        });
        treeObserver.observe(panel, { childList: true, subtree: true });
      }
      } catch (err) {
        console.warn("[WFO] bodyObserver error, continuing:", err);
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    wfoReadyTimer = setTimeout(() => {
      if (!wfoPanelReady) console.warn("[WFO] WorkflowOrganizer: tree panel not found — ComfyUI frontend may have changed, extension inactive.");
    }, 15000);

    // Escape clears the current selection
    document.addEventListener("keydown", (e) => {
      try {
        if (e.key === "Escape" && selectedPaths.size) {
          const panel = findWorkflowsPanel();
          if (panel) clearSelection(panel);
        }
      } catch (_) {}
    });
  },
});