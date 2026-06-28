# WorkflowOrganizer — Recording script (6 clips for the README)

Short clips, ~10–20 sec each. No audio needed — the README text explains it.
Tip: create a few dummy folders (folder 01, 02, 03) and dummy workflows
(workflow 01–05) so there's enough to drag around.

---

## 1. Drag & drop
**Shows:** organizing workflows and folders without a page refresh.

- Drag `workflow 01` onto `folder 01` → drop.
- Drag a workflow out of a folder back to the ROOT (via the root drop bar).
- Expand a folder to show the file is really inside it.
- **Folder drag:** drag `folder 02` onto `folder 01` → the whole folder (with
  its contents) now nests under folder 01.
- Drag a nested folder back to the ROOT via the root drop bar.

➡️ Key point: drag both files and folders; the sidebar updates instantly, no
reload. A folder moves with all its contents.

---

## 2. Folder management
**Shows:** the right-click menu on a folder.

- Right-click `folder 01`.
- Move the mouse down the menu so each item highlights: **Rename → Duplicate →
  Move to… → Set Color → New Folder → New Sub Folder → Delete**.
- Do a **Rename** (type a new name, Enter).
- Do a **Delete** → show the undo snackbar → click undo, the folder comes back.

➡️ Key point: fully custom menu, with undo on delete.

---

## 3. Folder colors
**Shows:** coloring folders + filled icons.

- Right-click a folder → **Set Color**.
- Pick a preset swatch → click **Apply**.
- Open the **palette swatch** (color-wheel icon) → pick a custom color via the
  gradient/hex field → Apply.
- Toggle **Filled folder icons** → show the difference (outline vs filled).
- Optional: **Apply to all** → all folders at once.

➡️ Key point: colors survive rename/move (stored in `.wfo_meta.json`).

---

## 4. File colors
**Shows:** coloring workflow icons.

- Right-click `workflow 01` → **Set Color**.
- Color a few workflows, each a different color.
- Show the colored file icons side by side in the list.
- **Color follows the move:** drag a colored workflow into another folder → the
  color stays. Drag a colored folder somewhere too → the folder color AND the
  colors of the workflows inside it are kept.

➡️ Key point: same picker as folders, colors the workflow icon; colors stick
when moving/renaming (no page refresh needed).

---

## 5. Multi-select + bulk actions
**Shows:** selecting multiple workflows at once and moving/deleting them.

- **Ctrl + click** = add a single item to the selection (click 3 separate
  workflows).
- **Shift + click** = select a range (click one, then Shift+click further down →
  everything in between is selected).
- Drag the whole selection into a folder at once **OR** right-click →
  **Move to…**.
- Right-click the selection → **Delete N** → confirm dialog with the file list →
  confirm → undo works.

➡️ Key point: clearly explain Ctrl (single) vs Shift (range) — it's not obvious.

---

## 6. Workflow menu (right-click on a file)
**Shows:** the complete right-click menu on a workflow.

- Right-click `workflow 02` → move the mouse down the menu so each item
  highlights: **Rename → Duplicate → Move to… → Set Color → New Folder →
  Delete**.
- **Rename:** click Rename → type a new name inline → Enter (the `.json` file is
  renamed, the color is kept).
- **Duplicate:** show that `workflow 02 copy.json` appears next to the original
  (not a new tab). Optionally again → `... copy 2.json`.
- **Delete:** click Delete → confirm dialog → confirm → show the undo snackbar →
  undo, the file comes back.

➡️ Key point: same clean menu as folders; all actions on the file itself, with
undo on delete and no stray browser tab on duplicate.

---

### Ordering tip for the README
Use this order: 1 (drag & drop) → 5 (multi-select) → 6 (workflow menu) →
2 (folder menu) → 3 (folder colors) → 4 (file colors). This builds up from the
core feature to the extras.
