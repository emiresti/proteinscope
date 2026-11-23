# ProteinScope · 3D Protein Structure Explorer

Search any protein by name, gene or PDB ID, rotate its 3D structure, read its biology
(function, diseases, location) and analyse its sequence (MW, pI, GRAVY, composition).
Everything runs in the browser, no backend and no build step.

**Data:** RCSB PDB (Data + Search API), UniProt REST  
**Viewer:** 3Dmol.js

## Run locally (VS Code)

1. Open this folder in VS Code.
2. Install the **Live Server** extension (Ritwick Dey).
3. Right-click `index.html` → **Open with Live Server**.

(You can also open `index.html` directly, but Live Server is more reliable.)

## Before you share it

Replace these placeholders:

- `index.html`: `YOUR-USERNAME`, `YOUR-PROFILE` (top bar links) and `YOUR NAME` (footer)

## Publish for free with GitHub Pages

1. Create a new public repo on GitHub, e.g. `proteinscope`.
2. Upload `index.html`, `style.css`, `app.js` and `README.md`.
3. Repo → **Settings → Pages → Branch: main / root → Save**.
4. After about a minute your site is live at `https://YOUR-USERNAME.github.io/proteinscope/`.

Deep links work: `.../proteinscope/#4HHB` opens hemoglobin directly.

## Ideas to extend

- Mutation viewer: highlight a residue (e.g. R175 in p53) on the structure
- AlphaFold models via the AlphaFold DB API
- Sequence alignment tab (Needleman-Wunsch) written from scratch
- Compare two structures side by side
