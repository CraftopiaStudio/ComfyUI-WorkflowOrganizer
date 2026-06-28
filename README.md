<p align="center">
  <img src="assets/banner.svg" alt="ComfyUI Workflow Organizer" width="100%">
</p>

# ComfyUI-WorkflowOrganizer

Turn the ComfyUI **Workflows sidebar** into a proper file manager. Drag &
drop, color-coding, multi-select, rename, duplicate, and a clean custom
right-click menu — all without a single page refresh.

> A [CraftopiaStudio](https://github.com/CraftopiaStudio) extension.

<!--
  HOW TO ADD THE VIDEOS (do this on github.com after pushing):
  1. Open this README in the GitHub web editor (or a new issue as scratchpad).
  2. Drag each .mp4 into the editor — GitHub uploads it and inserts a
     https://github.com/user-attachments/assets/... URL.
  3. Replace each "PASTE VIDEO N URL HERE" line below with that URL
     (the URL on its own line renders an inline, playable video).
-->

---

## ✨ Features

- **Drag & drop** workflows *and* folders to reorganize — instantly, no reload
- **Custom right-click menu** for files and folders: Rename, Duplicate,
  Move to…, Set Color, New Folder, Delete
- **Color-coding** for both folders and workflow files, with filled folder icons
- **Multi-select** (Ctrl / Shift) with bulk move and bulk delete
- **Undo** for moves and deletes
- **Colors follow their files** when you move or rename them
- **Duplicate** creates a real file copy on disk (not a throwaway tab)
- Styled confirm dialogs that match ComfyUI's dark theme
- Multi-user aware · zero dependencies · **no custom nodes**

---

## 🎬 In action

### Drag & drop
Drag workflows and whole folders (with their contents) anywhere — drop onto a
folder to nest, or onto the root bar to move out. The sidebar updates instantly.

PASTE VIDEO 1 URL HERE — "1. Drag & drop.mp4"

### Multi-select + bulk actions
**Ctrl + click** to pick individual workflows, **Shift + click** to select a
range. Then move or delete the whole selection at once (with undo).

PASTE VIDEO 5 URL HERE — "5. Multi-select + bulk actions.mp4"

### Workflow menu
Right-click any workflow for Rename, Duplicate, Move to…, Set Color, New Folder
and Delete — all acting on the file itself, with undo on delete.

PASTE VIDEO 6 URL HERE — "6. Workflow menu.mp4"

### Folder menu
The same clean menu for folders: Rename, Duplicate, Move to…, Set Color,
New Folder, New Sub Folder, and Delete (with undo).

PASTE VIDEO 2 URL HERE — "2. Folder management.mp4"

### Folder colors
Color folders from a palette of presets or a custom gradient/hex picker. Toggle
filled folder icons, or apply one color to every folder at once.

PASTE VIDEO 3 URL HERE — "3. Folder colors.mp4"

### File colors
Color individual workflow icons with the same picker. Colors are saved and even
follow a workflow when you move or rename it.

PASTE VIDEO 4 URL HERE — "4. File colors.mp4"

---

## 📦 Installation

**Via ComfyUI Manager** *(recommended)*
Search for `WorkflowOrganizer` in the Manager and install.

**Manual**
```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/CraftopiaStudio/ComfyUI-WorkflowOrganizer.git
```

Restart ComfyUI. That's it.

---

## ✅ Requirements

- ComfyUI **v0.3.0+** (uses the built-in `/userdata/{file}/move/{dest}` endpoint)

---

## 🧠 How it works

The extension adds a small JavaScript layer plus a few lightweight Python
endpoints (no custom nodes). It:

1. Hooks into ComfyUI's Workflows sidebar tree
2. Makes workflows and folders draggable, and folders drop targets
3. Renders its own context menu and color picker over the sidebar
4. Performs file operations through ComfyUI's `/userdata` API and its own
   `/wfo/*` helper endpoints (create / rename / copy / trash folders & files)
5. Stores colors in a hidden `.wfo_meta.json` in your user folder, so they
   survive renames and moves

The real state always lives on disk — nothing is faked in the DOM.

---

## License

MIT
