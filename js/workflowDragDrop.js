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

async function moveToRoot() {
  if (!dragData) return;
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
  }, 10);

  const moveToRoot = document.createElement("div");
  moveToRoot.className = "wfo-context-item";
  moveToRoot.innerHTML = `<span class="pi pi-arrow-up wfo-icon"></span><span class="wfo-label">Move to root</span>`;

  // Klik event op de hele container
  moveToRoot.addEventListener("mousedown", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    
    let fileName = getLabel(item);
    let sourcePath = buildPath(item);
    if (!fileName.endsWith(".json")) { fileName += ".json"; sourcePath += ".json"; }
    
    try {
      const prefix = "workflows/";
      const src = sourcePath.startsWith(prefix) ? sourcePath : prefix + sourcePath;
      const dst = prefix + fileName;
      await moveUserDataFile(src, dst);
      try { app.extensionManager?.toast?.add({ severity: "success", summary: "Success", detail: `Moved to root`, life: 3000 }); } catch (_) {}
      await refreshWorkflowSidebar();
      item.style.display = "none";
    } catch (err) {
      try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
    }
    removeContextMenu();
  });

  const newFolder = document.createElement("div");
  newFolder.className = "wfo-context-item";
  newFolder.innerHTML = `<span class="pi pi-folder-plus wfo-icon"></span><span class="wfo-label">New Folder</span>`;

  newFolder.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    transformMenuToInput(menu, "", async (folderName) => {
      const name = folderName.replace(/[/\\]/g, "");
      if (!name) return;
      try {
        await createFolder(`workflows/${name}`);
        try { app.extensionManager?.toast?.add({ severity: "success", summary: "Folder created", detail: name, life: 3000 }); } catch (_) {}
        await refreshWorkflowSidebar();
      } catch (err) {
        try { app.extensionManager?.toast?.add({ severity: "error", summary: "Error", detail: err.message, life: 5000 }); } catch (_) {}
      }
    }, "New folder name:");
  });

  document.body.appendChild(menu);
  menu.appendChild(moveToRoot);
  menu.appendChild(newFolder);
  contextMenu = menu;
  
  const closeHandler = () => { removeContextMenu(); document.removeEventListener("mousedown", closeHandler); };
  setTimeout(() => document.addEventListener("mousedown", closeHandler), 100);
}

function showFolderContextMenu(e, item) {
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

  document.body.appendChild(menu);
  menu.appendChild(renameFolder);
  menu.appendChild(duplicateFolder_);
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
        dragData = { path, name, element: item };
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
        showContextMenu(e, item);
      });
    }

    if (isFolder(item)) {
      contentEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showFolderContextMenu(e, item);
      });
      contentEl.addEventListener("dragover", (e) => {
        if (!dragData) return;
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

        let sourcePath = dragData.path;
        let fileName = dragData.name;
        const folderPath = buildPath(item);
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
    }
    .wfo-context-item:hover { background: var(--content-hover-bg, #222); color: var(--content-hover-fg, #fff); }
    .wfo-icon { 
        font-size: 16.5px; 
        color: var(--descrip-text, #999); 
        width: 16px; 
        text-align: center; 
        margin-left: 2px; /* Dit schuift de pijl die laatste pixels naar rechts */
        margin-right: 10px; /* Ruimte tussen pijl en tekst */
        pointer-events: none;
    }
    .wfo-label {
        font-weight: 400;
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