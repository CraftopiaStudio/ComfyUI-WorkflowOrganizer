# WorkflowOrganizer — Opname-script (6 filmpjes voor README)

Korte clips, elk ~10–20 sec. Geen audio nodig — de README-tekst legt het uit.
Tip: maak een paar dummy-mappen (folder 01, 02, 03) en dummy-workflows
(workflow 01–05) zodat er genoeg te slepen valt.

---

## 1. Drag & drop
**Toont:** workflows organiseren zonder page-refresh.

- Sleep `workflow 01` op `folder 01` → laat los.
- Sleep een workflow uit een map terug naar de ROOT (via de root-drop-balk).
- Klap een map open zodat je ziet dat het bestand er echt in zit.

➡️ Kernpunt: sidebar ververst direct, geen reload.

---

## 2. Folder management
**Toont:** rechtsklik-menu op een map.

- Rechtsklik `folder 01`.
- Loop het menu langs: **Rename → Duplicate → Move to… → Set Color →
  New Folder → New Sub Folder → Delete**.
- Doe een **Rename** (typ nieuwe naam, Enter).
- Doe een **Delete** → toon de undo-snackbar → klik undo, map komt terug.

➡️ Kernpunt: compleet eigen menu, met undo op delete.

---

## 3. Map-kleuren
**Toont:** mappen kleuren + gevulde iconen.

- Rechtsklik map → **Set Color**.
- Kies een preset-swatch → klik **Apply**.
- Open de **palette-swatch** (kleurenwiel-icoon) → kies een custom kleur via
  gradient/hex → Apply.
- Zet **Filled folder icons** aan → toon het verschil (outline vs gevuld).
- Optioneel: **Apply to all** → alle mappen in één keer.

➡️ Kernpunt: kleuren overleven rename/move (opgeslagen in `.wfo_meta.json`).

---

## 4. Bestandskleuren
**Toont:** workflow-iconen kleuren.

- Rechtsklik `workflow 01` → **Set Color**.
- Kies een paar workflows en geef ze elk een andere kleur.
- Toon de gekleurde bestand-iconen in de lijst naast elkaar.

➡️ Kernpunt: zelfde picker als mappen, kleurt het workflow-icoon.

---

## 5. Multi-select + bulk acties
**Toont:** meerdere workflows tegelijk selecteren en verplaatsen/verwijderen.

- **Ctrl + klik** = los item toevoegen aan de selectie (klik 3 losse workflows).
- **Shift + klik** = bereik selecteren (klik er één, dan Shift+klik een eind
  verderop → alles ertussen wordt geselecteerd).
- Sleep de hele selectie in één keer naar een map **OF** rechtsklik →
  **Move to…**.
- Rechtsklik op de selectie → **Delete N** → confirm-dialog met bestandslijst →
  bevestig → undo werkt.

➡️ Kernpunt: leg Ctrl (los) vs Shift (bereik) duidelijk uit — niet intuïtief.

---

## 6. Workflow duplicate
**Toont:** een workflow dupliceren als bestand.

- Rechtsklik `workflow 02` → **Duplicate**.
- Toon dat er een nieuw bestand `workflow 02 copy.json` naast het origineel
  verschijnt (niet een nieuw tabblad).
- Eventueel nog een keer → `workflow 02 copy 2.json`.

➡️ Kernpunt: dupliceert het bestand op schijf, opent geen tab.

---

### Volgorde-tip voor de README
Zet ze in deze volgorde: 1 (drag&drop) → 5 (multi-select) → 2 (folders) →
3 (map-kleuren) → 4 (bestandskleuren) → 6 (duplicate). Zo bouw je op van
de kernfunctie naar de extra's.
