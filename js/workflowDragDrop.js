/**
 * ComfyUI-WorkflowOrganizer v1.7
 * Final attempt: Stable hitbox + precision icon placement.
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

function removeContextMenu() {
  if (contextMenu) { contextMenu.remove(); contextMenu = null; }
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

  document.body.appendChild(menu);
  menu.appendChild(moveToRoot);
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
      contentEl.setAttribute("draggable", "true");
      contentEl.addEventListener("dragstart", (e) => {
        const path = buildPath(item);
        const name = getLabel(item);
        if (!path || !name) { e.preventDefault(); return; }
        dragData = { path, name, element: item };
        e.dataTransfer.effectAllowed = "move";
        contentEl.style.opacity = "0.4";
      });
      contentEl.addEventListener("dragend", () => {
        contentEl.style.opacity = "1";
        dragData = null;
        container.querySelectorAll(".wfo-drop-highlight").forEach((el) => el.classList.remove("wfo-drop-highlight"));
      });
      contentEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e, item);
      });
    }

    if (isFolder(item)) {
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

        try {
          const prefix = "workflows/";
          const src = sourcePath.startsWith(prefix) ? sourcePath : prefix + sourcePath;
          const dst = destPath.startsWith(prefix) ? destPath : prefix + destPath;
          await moveUserDataFile(src, dst);
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
  `;
  document.head.appendChild(style);
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
        const treeObserver = new MutationObserver(() => attachDragHandlers(panel));
        treeObserver.observe(panel, { childList: true, subtree: true });
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  },
});