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

async function moveToRoot() {
  if (!dragData) return;
  if (dragData.isFolder) { await moveFolderTo(""); return; }
  let fileName = dragData.name;
  let sourcePath = dragData.path;
  const movedElement = dragData.element;
  dragData = null;
  if (!fileName.endsWith(".json")) { fileName += ".json"; sourcePath += ".json"; }
  const prefix = "workflows/";
  const src = sourcePath.startsWith(prefix) ? sourcePath : prefix + sourcePath;
  const dst = prefix + fileName;
  if (src === dst) return;
  try {
    await moveUserDataFile(src, dst);
    try { app.extensionManager?.toast?.add({ severity: "success", summary: "Moved to root", detail: fileName, life: 3000 }); } catch (_) {}
    await refreshWorkflowSidebar();
    if (movedElement) movedElement.style.display = "none";
    registerUndo(`Moved ${fileName.replace(/\.json$/, "")} to root`, async () => {
      await moveUserDataFile(dst, src);
      await refreshWorkflowSidebar();
    });
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
      onPick: (rel) => isFolderItem ? moveFolderToFolder(item, rel) : moveFileToFolder(item, rel),
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
        menu.style.top = rect.bottom + "px";
        menu.style.width = rect.width + "px";
    } else {
        menu.style.left = e.clientX + "px";
        menu.style.top = e.clientY + "px";
    }
    applyNativeMenuFont(menu, realMenu);
  }, 10);

  const moveTo = makeMoveToItem(menu, item, false);
  const newFolder = makeNewFolderItem(menu, "");

  document.body.appendChild(menu);
  menu.appendChild(moveTo);
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

  deleteFolder_.addEventListener("mousedown", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    removeContextMenu();

    const label = getLabel(item);
    if (!confirm(`Delete folder "${label}" and all its contents?`)) return;

    const folderPath = buildPath(item);
    try {
      await deleteFolder(`workflows/${folderPath}`, true);
      try { app.extensionManager?.toast?.add({ severity: "success", summary: "Folder deleted", detail: label, life: 3000 }); } catch (_) {}
      await refreshWorkflowSidebar();
    } catch (err) {
      try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
    }
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

  const moveTo = makeMoveToItem(menu, item, true);
  const newFolderRoot = makeNewFolderItem(menu, "", "New Folder");
  const newSubFolder = makeNewFolderItem(menu, buildPath(item), "New Sub Folder", "pi-folder-plus", "New subfolder name:");

  document.body.appendChild(menu);
  menu.appendChild(renameFolder);
  menu.appendChild(duplicateFolder_);
  menu.appendChild(moveTo);
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
        dragData = { path, name, element: item, isFolder: false };
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

        // File dropped onto a folder → move workflow
        let sourcePath = dragData.path;
        let fileName = dragData.name;
        if (!fileName.endsWith(".json")) { fileName += ".json"; sourcePath += ".json"; }
        const destPath = folderPath + "/" + fileName;

        const movedElement = dragData.element;
        dragData = null;

        const prefix = "workflows/";
        const src = sourcePath.startsWith(prefix) ? sourcePath : prefix + sourcePath;
        const dst = destPath.startsWith(prefix) ? destPath : prefix + destPath;
        if (src === dst) return;  // dropped onto its own folder — no-op

        try {
          await moveUserDataFile(src, dst);
          await deleteUserDataFile(`workflows/${folderPath}/placeholder.json`);
          try { app.extensionManager?.toast?.add({ severity: "success", summary: "Workflow moved", detail: fileName, life: 3000 }); } catch (_) {}
          await refreshWorkflowSidebar();
          if (movedElement) movedElement.style.display = "none";
          registerUndo(`Moved ${fileName.replace(/\.json$/, "")}`, async () => {
            await moveUserDataFile(dst, src);
            await refreshWorkflowSidebar();
          });
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

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    injectStyles();
    const bodyObserver = new MutationObserver(() => {
      const panel = findWorkflowsPanel();
      if (panel && !panel.dataset.wfoInit) {
        panel.dataset.wfoInit = "1";
        attachDragHandlers(panel);
        ensurePlaceholders();
        loadPlaceholderFolders().then(() => applyPlaceholderBadges(panel));
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
          if (itemContextActive) { itemContextActive = false; return; }
          // Ignore the search box, headers, buttons, and any tree item
          if (e.target.closest("input, textarea, button, [role='treeitem'], .p-inputtext, [class*='search']")) return;
          e.preventDefault();
          showEmptyAreaMenu(e);
        });
        const treeObserver = new MutationObserver(() => {
          attachDragHandlers(panel);
          applyPlaceholderBadges(panel);
          ensurePlaceholders();
        });
        treeObserver.observe(panel, { childList: true, subtree: true });
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  },
});