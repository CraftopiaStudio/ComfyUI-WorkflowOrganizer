---
type: Project
status: 🟡 In Progress
project: "[[Knowledge & Workflow Control Center]]"
tags:
  - comfyui
  - github
  - registry
  - craftopiastudio
updated: 2026-06-24
---

# ComfyUI-WorkflowOrganizer

Up: [[2 - Projects/2 - Projects index|📂 Terug naar Projects Index]]

---

## Doel

Drag-and-drop workflow organisatie voor de ComfyUI sidebar. Gebruikers kunnen `.json` workflow bestanden naar folders slepen, mappen aanmaken/hernoemen/dupliceren/verwijderen, en workflows terug naar root slepen — zonder page refresh. Gepubliceerd onder CraftopiaStudio op de Comfy Registry.

---

## Architectuur

- **JS-extensie** (`js/workflowDragDrop.js`): drag-and-drop, context-menu's, drop-bar, badge-logica. Hangt aan de PrimeVue tree DOM via MutationObservers.
- **Python endpoints** (`__init__.py`, aiohttp via `PromptServer`): bestandsoperaties die de userdata-API niet kan, server-side en atomisch.
  - `POST /wfo/folder` — map aanmaken (`os.makedirs` + placeholder)
  - `DELETE /wfo/folder` — map verwijderen (`shutil.rmtree`, of placeholder + `os.rmdir`)
  - `POST /wfo/folder/rename` — map hernoemen (`os.rename`, één atomische operatie)
  - `POST /wfo/folder/copy` — map dupliceren (`shutil.copytree`, "naam copy")
  - `POST /wfo/ensure-placeholders` — scant de schijf, zet `placeholder.json` in elke lege map zodat die zichtbaar blijft
- Een dummy-node (`WorkflowOrganizerInfo`) bestaat alleen zodat ComfyUI de JS-extensie laadt.

**Kernprincipe:** de echte staat staat op schijf, niet in de DOM. We raden niets meer af op basis van de browser — de server kijkt naar de echte mappen. Een hernoemde map is weg van schijf → komt nooit terug; een leeggemaakte map staat er nog → krijgt een placeholder en blijft zichtbaar.

---

## Taken

### v0.1 — Live ✅
- [x] JavaScript drag-and-drop implementatie
- [x] Toast notificaties bij success/failure
- [x] README + demo GIF aanmaken
- [x] GitHub repo aanmaken onder CraftopiaStudio
- [x] pyproject.toml + LICENSE + publish_action.yml
- [x] Branch hernoemd naar `main`
- [x] Live op registry.comfy.org
- [x] Zichtbaar in ComfyUI Manager

### v0.2 — Folder management ✅

**New Folder**
- [x] "New Folder" via context menu (inline input met label + hint, geen browser popup)
- [x] Map aanmaken via Python `os.makedirs`; placeholder server-side gezet
- [x] `placeholder.json` automatisch verwijderd zodra er een echte workflow in komt

**Folder context menu (rechtermuisklik op map)**
- [x] "Rename Folder" — inline edit in de tree, via atomische `os.rename` (geen losse file-moves meer → geen race conditions, oude map blijft niet achter op schijf)
- [x] "Duplicate Folder" — `shutil.copytree` met slimme naamgeving ("naam copy", "copy 2", …)
- [x] "Delete Folder" — confirm + `shutil.rmtree` (rode/danger styling)
- [x] Native ComfyUI menu-items blijven werken (geen `stopPropagation` meer)

**Lege folders zichtbaar houden**
- [x] Server-side `ensure-placeholders` scant alle bestaande mappen en vult ontbrekende placeholders aan (vervangt het fragiele DOM-watching idee)
- [x] Leeggemaakte map blijft zichtbaar; hernoemde/verwijderde map komt niet terug

**Placeholder UX**
- [x] `placeholder` bestanden verborgen in de tree
- [x] Badge-count negeert de placeholder; badge verborgen als map alleen een placeholder bevat
- [x] Werkt bij startup zonder de map te hoeven openen (API-cache + synchrone DOM-update)

### v0.2.5 — Drop-to-Root + code review ✅
- [x] "Drop here to move to Root" balk verschijnt alleen tijdens slepen van een bestand dat ín een map zit
- [x] Balk zweeft over het "Browse" gebied — lijst zakt niet, dekt geen folder af
- [x] Breedte uitgelijnd op het zoekvak; volledige-breedte strip in **live thema-kleur** dekt "Browse" af (taal- en thema-onafhankelijk)
- [x] No-op drops afgevangen (bestand op eigen map of al in root → niets gebeurt, bestand verdwijnt niet)
- [x] Code review: alle HTTP via `api.fetchApi` (werkt achter sub-pad/auth), dode code verwijderd, `deleteFolder` gooit nu errors

### Later / Ideeën
- [ ] Nested moves: map → map slepen
- [ ] Multi-user: `_get_user_base` pakt nu de eerste user-map; voor multi-user setups consistenter maken
- [ ] `findBrowseLabel`-restanten weg (al vervangen door thema-bg cover) — opruimen indien nog aanwezig
- [ ] Werkt alleen met de default Workflows sidebar — third-party panel support onderzoeken
- [ ] Sidebar DOM-stabiliteit: kan breken bij ComfyUI frontend-updates (PrimeVue class-namen)

---

## Bestanden & Links

- GitHub: https://github.com/CraftopiaStudio/ComfyUI-WorkflowOrganizer
- Registry: https://registry.comfy.org (publisher: craftopiastudio)
- Lokale folder: `D:\AI\ComfyUI-Easy-Install\ComfyUI\custom_nodes\ComfyUI-WorkflowOrganizer`

---

## Notities

- Huidige versie: **v0.2.5**
- Zero dependencies. JS-extensie + lichte Python-endpoints (geen zware nodes).
- ComfyUI v0.3.0+ vereist (heeft `/userdata/{file}/move/{dest}` endpoint nodig).
- **Python-wijzigingen vereisen een ComfyUI-herstart; JS-wijzigingen alleen een browser refresh.**
- Lege folders zijn onzichtbaar in ComfyUI → opgelost via server-managed `placeholder.json` (geen handmatig bestandsbeheer meer).
- Versie ophogen in `pyproject.toml` → pushen → GitHub Action publiceert automatisch.
