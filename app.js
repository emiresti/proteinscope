'use strict';

/* =====================================================================
   ProteinScope — 3D protein structure explorer
   Data: RCSB PDB (Data + Search API), UniProt REST. Viewer: 3Dmol.js
   ===================================================================== */

/* ---------- helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

let toastTimer;
function toast(msg, ok = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('ok', ok);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

/* ---------- config ---------- */
const API = {
  entry:  id => `https://data.rcsb.org/rest/v1/core/entry/${id}`,
  entity: (id, n) => `https://data.rcsb.org/rest/v1/core/polymer_entity/${id}/${n}`,
  search: 'https://search.rcsb.org/rcsbsearch/v2/query',
  pdb:    id => `https://files.rcsb.org/download/${id}.pdb`,
  cif:    id => `https://files.rcsb.org/download/${id}.cif`,
  uniprot: acc => `https://rest.uniprot.org/uniprotkb/${acc}.json`,
};

const EXAMPLES = [
  { id: '1TUP', label: 'p53 + DNA' },
  { id: '4HHB', label: 'Hemoglobin' },
  { id: '6VXX', label: 'SARS-CoV-2 spike' },
  { id: '1EMA', label: 'GFP' },
  { id: '1HSG', label: 'HIV-1 protease' },
  { id: '4INS', label: 'Insulin' },
  { id: '1BNA', label: 'B-DNA' },
  { id: '1UBQ', label: 'Ubiquitin' },
];

const WATER = ['HOH', 'WAT', 'DOD'];
const NUCLEOTIDES = ['DA', 'DT', 'DG', 'DC', 'DU', 'DI', 'A', 'U', 'G', 'C', 'T', 'I'];

/* ---------- state ---------- */
const state = {
  pdbId: null, style: 'cartoon', color: 'spectrum', spin: true, ligands: true,
  loaded: false, resMin: 0, resMax: 1, entities: [], entIdx: 0, token: 0,
};
const uniCache = new Map();
let viewer = null;

/* =====================================================================
   3D VIEWER
   ===================================================================== */
function initViewer() {
  if (typeof $3Dmol === 'undefined') {
    toast('3Dmol.js could not be loaded. Check your internet connection.');
    return false;
  }
  viewer = $3Dmol.createViewer($('#viewer'), { backgroundColor: '#060914', antialias: true });
  $('#viewer').addEventListener('pointerdown', () => {
    if (state.spin) { state.spin = false; $('#tSpin').classList.remove('active'); viewer.spin(false); }
  });
  return true;
}

function colorSpec() {
  switch (state.color) {
    case 'chain': return { colorscheme: 'chain' };
    case 'ss':    return { colorscheme: 'ssJmol' };
    case 'amino': return { colorscheme: 'amino' };
    default:      return { colorscheme: { prop: 'resi', gradient: 'roygb', min: state.resMin, max: state.resMax } };
  }
}

function applyStyle() {
  if (!viewer || !state.loaded) return;
  const col = colorSpec();
  viewer.removeAllSurfaces();

  let main;
  switch (state.style) {
    case 'stick':   main = { stick: { ...col, radius: 0.14 } }; break;
    case 'sphere':  main = { sphere: { ...col, scale: 0.9 } }; break;
    case 'line':    main = { line: { ...col } }; break;
    case 'surface': main = { cartoon: { ...col, opacity: 0.9, arrows: true } }; break;
    default:        main = { cartoon: { ...col, arrows: true, tubes: true } };
  }
  viewer.setStyle({}, main);

  // DNA/RNA bases as sticks so double helices look great in cartoon mode
  if (state.style === 'cartoon') {
    viewer.addStyle({ resn: NUCLEOTIDES }, { stick: { ...col, radius: 0.12 } });
  }

  // ligands & small molecules
  const ligSel = { hetflag: true, not: { resn: WATER } };
  viewer.setStyle(ligSel, state.ligands
    ? { stick: { radius: 0.22, colorscheme: 'orangeCarbon' }, sphere: { scale: 0.24, colorscheme: 'orangeCarbon' } }
    : {});
  // hide water
  viewer.setStyle({ resn: WATER }, {});

  if (state.style === 'surface') {
    viewer.addSurface($3Dmol.SurfaceType.VDW, { opacity: 0.72, ...col }, { hetflag: false });
  }
  viewer.render();
}

function setSpin(on) {
  state.spin = on;
  $('#tSpin').classList.toggle('active', on);
  if (!viewer) return;
  if (on) viewer.spin('y', 0.6); else viewer.spin(false);
}

function setupHover() {
  viewer.setHoverable({}, true,
    (atom, v) => {
      if (atom.label) return;
      atom.label = v.addLabel(`${atom.resn} ${atom.resi}:${atom.chain} · ${atom.atom}`, {
        position: atom, backgroundColor: '#050814', backgroundOpacity: 0.9,
        fontColor: '#67e8f9', fontSize: 12, borderColor: '#22d3ee', borderThickness: 1, inFront: true,
      });
    },
    (atom, v) => {
      if (atom.label) { v.removeLabel(atom.label); delete atom.label; }
    });
}

function setLoading(on, msg) {
  $('#loader').classList.toggle('hidden', !on);
  if (msg) $('#loaderMsg').textContent = msg;
}

/* =====================================================================
   LOAD A STRUCTURE
   ===================================================================== */
async function loadStructure(rawId) {
  const id = rawId.trim().toUpperCase();
  const token = ++state.token;

  $('#app').classList.remove('hidden');
  $('#results').classList.add('hidden');
  setLoading(true, `Fetching ${id} from RCSB PDB…`);
  setTimeout(() => $('#app').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);

  try {
    const entry = await fetchJSON(API.entry(id));
    if (token !== state.token) return;

    let text, fmt = 'pdb';
    try { text = await fetchText(API.pdb(id)); }
    catch { text = await fetchText(API.cif(id)); fmt = 'cif'; }
    if (token !== state.token) return;

    state.pdbId = id;
    renderEntry(id, entry);

    if (!viewer) return;
    viewer.clear();
    viewer.addModel(text, fmt);

    const atoms = viewer.selectedAtoms({});
    let lo = Infinity, hi = -Infinity;
    for (const a of atoms) {
      if (typeof a.resi === 'number') { if (a.resi < lo) lo = a.resi; if (a.resi > hi) hi = a.resi; }
    }
    state.resMin = isFinite(lo) ? lo : 0;
    state.resMax = isFinite(hi) && hi > lo ? hi : state.resMin + 1;
    state.loaded = true;

    applyStyle();
    setupHover();
    viewer.zoomTo();
    viewer.render();
    setSpin(state.spin);
    setLoading(false);

    history.replaceState(null, '', `#${id}`);
    document.title = `${id} · ProteinScope`;

    loadEntities(id, entry, token);
  } catch (err) {
    console.error(err);
    setLoading(false);
    toast(`Could not load "${id}". Check the PDB ID and try again.`);
  }
}

/* ---------- entry card ---------- */
function renderEntry(id, e) {
  const info = e.rcsb_entry_info || {};
  const res = info.resolution_combined?.[0];
  const cit = e.rcsb_primary_citation;
  const rows = [
    ['PDB ID', `<a href="https://www.rcsb.org/structure/${esc(id)}" target="_blank" rel="noopener">${esc(id)} ↗</a>`],
    ['Method', esc(e.exptl?.[0]?.method || '—')],
    ['Resolution', res ? `${res.toFixed(2)} Å` : 'n/a'],
    ['Released', esc(e.rcsb_accession_info?.initial_release_date?.slice(0, 10) || '—')],
    ['Atoms', info.deposited_atom_count ? info.deposited_atom_count.toLocaleString() : '—'],
    ['Molecules', info.polymer_entity_count ?? '—'],
    ['Class', esc(e.struct_keywords?.pdbx_keywords || '—')],
  ];
  if (cit?.title) {
    const doi = cit.pdbx_database_id_doi;
    const label = esc(cit.title.length > 90 ? cit.title.slice(0, 88) + '…' : cit.title);
    rows.push(['Paper', doi ? `<a href="https://doi.org/${esc(doi)}" target="_blank" rel="noopener">${label}</a>` : label]);
  }
  $('#pdbBadge').textContent = id;
  $('#title').textContent = e.struct?.title || id;
  $('#entryList').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

/* ---------- entities (molecules) ---------- */
function parseEntity(e) {
  const ids = e.rcsb_polymer_entity_container_identifiers || {};
  const src = e.rcsb_entity_source_organism?.[0] || {};
  return {
    id: ids.entity_id,
    type: e.entity_poly?.rcsb_entity_polymer_type || 'Unknown',
    desc: e.rcsb_polymer_entity?.pdbx_description || 'Unnamed molecule',
    seq: (e.entity_poly?.pdbx_seq_one_letter_can || '').replace(/[^A-Za-z]/g, '').toUpperCase(),
    organism: src.ncbi_scientific_name || null,
    gene: src.rcsb_gene_name?.[0]?.value || null,
    chains: ids.auth_asym_ids || [],
    uniprot: ids.uniprot_ids || [],
  };
}

async function loadEntities(id, entry, token) {
  $('#entityChips').innerHTML = '<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>';
  $('#bioBody').innerHTML = '';
  const nums = entry.rcsb_entry_container_identifiers?.polymer_entity_ids || ['1'];
  const res = await Promise.all(nums.slice(0, 10).map(n => fetchJSON(API.entity(id, n)).catch(() => null)));
  if (token !== state.token) return;
  state.entities = res.filter(Boolean).map(parseEntity);

  if (!state.entities.length) {
    $('#entityChips').innerHTML = '<p class="empty">No polymer data available.</p>';
    $('#stats').innerHTML = $('#comp').innerHTML = $('#seq').innerHTML = $('#legend').innerHTML = '';
    return;
  }
  $('#entityChips').innerHTML = state.entities.map((e, i) => {
    const na = /DNA|RNA/i.test(e.type);
    const chains = e.chains.length ? ` · chain ${e.chains.slice(0, 4).join(', ')}${e.chains.length > 4 ? '…' : ''}` : '';
    return `<button class="ent" data-i="${i}"><span class="kind ${na ? 'na' : ''}">${esc(na ? e.type : 'Protein')}</span><span class="nm">${esc(e.desc)}${esc(chains)}</span></button>`;
  }).join('');
  $$('#entityChips .ent').forEach(b => b.addEventListener('click', () => selectEntity(+b.dataset.i)));

  // prefer the first protein with a UniProt mapping
  let first = state.entities.findIndex(e => e.uniprot.length);
  if (first < 0) first = 0;
  selectEntity(first);
}

function selectEntity(i) {
  state.entIdx = i;
  $$('#entityChips .ent').forEach((b, k) => b.classList.toggle('active', k === i));
  const ent = state.entities[i];
  renderSequence(ent);
  renderBiology(ent, i);
}

/* =====================================================================
   BIOLOGY (UniProt)
   ===================================================================== */
const tagsHTML = list => {
  const items = list.filter(Boolean).map(([k, v]) => `<span class="tag"><em>${esc(k)}</em>${esc(v)}</span>`);
  return items.length ? `<div class="tags">${items.join('')}</div>` : '';
};

async function getUniprot(acc) {
  if (uniCache.has(acc)) return uniCache.get(acc);
  const j = await fetchJSON(API.uniprot(acc));
  const c = type => (j.comments || []).filter(x => x.commentType === type);
  const data = {
    name: j.proteinDescription?.recommendedName?.fullName?.value
       || j.proteinDescription?.submissionNames?.[0]?.fullName?.value || null,
    gene: j.genes?.[0]?.geneName?.value || null,
    organism: j.organism?.scientificName || null,
    func: c('FUNCTION')[0]?.texts?.[0]?.value || null,
    diseases: c('DISEASE').map(x => x.disease).filter(Boolean),
    locations: [...new Set(c('SUBCELLULAR LOCATION').flatMap(x => (x.subcellularLocations || []).map(s => s.location?.value)).filter(Boolean))],
    keywords: (j.keywords || []).map(k => k.name),
  };
  uniCache.set(acc, data);
  return data;
}

async function renderBiology(ent, idx) {
  const box = $('#bioBody');
  const tk = state.token;
  const acc = ent.uniprot[0];
  const head = `<div class="bio-title">${esc(ent.desc)}</div>` +
    tagsHTML([ent.gene && ['Gene', ent.gene], ent.organism && ['Organism', ent.organism]]);

  if (!acc) {
    box.innerHTML = head + `<p class="empty" style="margin-top:10px">No UniProt entry is linked to this molecule (for example synthetic or nucleic-acid chains).</p>`;
    return;
  }
  box.innerHTML = head + '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton" style="width:60%"></div>';

  try {
    const u = await getUniprot(acc);
    if (tk !== state.token || idx !== state.entIdx) return;

    let html = `<div class="bio-title">${esc(u.name || ent.desc)}</div>` + tagsHTML([
      (u.gene || ent.gene) && ['Gene', u.gene || ent.gene],
      (u.organism || ent.organism) && ['Organism', u.organism || ent.organism],
    ]);
    html += `<div class="tags"><span class="tag"><em>UniProt</em><a href="https://www.uniprot.org/uniprotkb/${esc(acc)}" target="_blank" rel="noopener">${esc(acc)} ↗</a></span></div>`;

    html += '<h4>Function</h4>';
    if (u.func) {
      html += `<p class="clamp">${esc(u.func)}</p>` + (u.func.length > 300 ? '<button class="more">Read more</button>' : '');
    } else html += '<p class="empty">No function annotation available.</p>';

    html += '<h4>Disease associations</h4>';
    if (u.diseases.length) {
      html += '<ul class="dis">' + u.diseases.slice(0, 5).map(d =>
        `<li><b>${esc(d.diseaseId || 'Disease')}</b>${d.acronym ? `<span class="acr">${esc(d.acronym)}</span>` : ''}${d.description ? `<p>${esc(d.description)}</p>` : ''}</li>`).join('') + '</ul>';
      if (u.diseases.length > 5) html += `<p class="empty" style="margin-top:8px">+ ${u.diseases.length - 5} more on UniProt</p>`;
    } else html += '<p class="empty">No disease annotations in UniProt.</p>';

    if (u.locations.length) {
      html += '<h4>Subcellular location</h4><div class="tags">' + u.locations.slice(0, 8).map(l => `<span class="tag">${esc(l)}</span>`).join('') + '</div>';
    }
    if (u.keywords.length) {
      html += '<h4>Keywords</h4><div class="tags">' + u.keywords.slice(0, 12).map(k => `<span class="tag k">${esc(k)}</span>`).join('') + '</div>';
    }
    box.innerHTML = html;
    $$('.more', box).forEach(b => b.addEventListener('click', () => {
      const p = b.previousElementSibling;
      p.classList.toggle('open');
      b.textContent = p.classList.contains('open') ? 'Show less' : 'Read more';
    }));
  } catch (err) {
    console.error(err);
    if (tk === state.token && idx === state.entIdx) {
      box.innerHTML = head + '<p class="empty" style="margin-top:10px">UniProt details are unavailable right now.</p>';
    }
  }
}

/* =====================================================================
   SEQUENCE ANALYSIS
   ===================================================================== */
const MASS = { A: 71.0788, R: 156.1875, N: 114.1038, D: 115.0886, C: 103.1388, E: 129.1155, Q: 128.1307, G: 57.0519, H: 137.1411, I: 113.1594, L: 113.1594, K: 128.1741, M: 131.1926, F: 147.1766, P: 97.1167, S: 87.0782, T: 101.1051, W: 186.2132, Y: 163.176, V: 99.1326 };
const KD   = { A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, Q: -3.5, E: -3.5, G: -0.4, H: -3.2, I: 4.5, L: 3.8, K: -3.9, M: 1.9, F: 2.8, P: -1.6, S: -0.8, T: -0.7, W: -0.9, Y: -1.3, V: 4.2 };
const AA_CLASS = { A: 'h', V: 'h', L: 'h', I: 'h', M: 'h', F: 'h', W: 'h', C: 'h', S: 'p', T: 'p', N: 'p', Q: 'p', Y: 'p', K: 'pos', R: 'pos', H: 'pos', D: 'neg', E: 'neg', G: 'sp', P: 'sp' };
const CLASS_NAME = { h: 'Hydrophobic', p: 'Polar', pos: 'Positive', neg: 'Negative', sp: 'Gly / Pro' };
const AA_ORDER = 'AVLIMFWCSTNQYKRHDEGP'.split('');
const NA_CLASS = { A: 'n-a', T: 'n-t', U: 'n-t', G: 'n-g', C: 'n-c' };

function netCharge(cnt, pH) {
  let c = 1 / (1 + 10 ** (pH - 8.6)) - 1 / (1 + 10 ** (3.55 - pH));
  const pos = { K: 10.54, R: 12.48, H: 6.04 };
  const neg = { D: 3.9, E: 4.07, C: 8.3, Y: 10.1 };
  for (const k in pos) c += (cnt[k] || 0) / (1 + 10 ** (pH - pos[k]));
  for (const k in neg) c -= (cnt[k] || 0) / (1 + 10 ** (neg[k] - pH));
  return c;
}
function isoelectric(cnt) {
  let lo = 0, hi = 14;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (netCharge(cnt, mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function count(seq) {
  const cnt = {};
  for (const ch of seq) cnt[ch] = (cnt[ch] || 0) + 1;
  return cnt;
}

const statTile = (v, l, unit = '') => `<div class="stat"><div class="v">${v}${unit ? `<small>${unit}</small>` : ''}</div><div class="l">${l}</div></div>`;

function renderSequence(ent) {
  const seq = ent.seq;
  const isNA = /DNA|RNA/i.test(ent.type);
  if (!seq) {
    $('#stats').innerHTML = '';
    $('#comp').innerHTML = '<p class="empty">No sequence available for this molecule.</p>';
    $('#seq').innerHTML = '';
    $('#legend').innerHTML = '';
    return;
  }
  const cnt = count(seq);
  const n = seq.length;

  let stats, items, stackHTML = '';

  if (isNA) {
    const gc = ((cnt.G || 0) + (cnt.C || 0)) / n * 100;
    const pur = ((cnt.A || 0) + (cnt.G || 0)) / n * 100;
    stats = statTile(n.toLocaleString(), 'Length', 'nt') + statTile(gc.toFixed(1), 'GC content', '%') +
            statTile(pur.toFixed(1), 'Purines (A+G)', '%') + statTile(esc(ent.type), 'Type');
    items = ['A', 'T', 'U', 'G', 'C'].filter(k => cnt[k]).map(k => ({ k, c: cnt[k], cls: NA_CLASS[k] }));
    $('#legend').innerHTML = items.map(it => `<span class="${it.cls}">${it.k}</span>`).join('');
  } else {
    let mass = 18.01524, kd = 0, known = 0;
    for (const ch of seq) if (MASS[ch]) { mass += MASS[ch]; kd += KD[ch]; known++; }
    const charged = ((cnt.K || 0) + (cnt.R || 0) + (cnt.D || 0) + (cnt.E || 0)) / n * 100;
    stats = statTile(n.toLocaleString(), 'Length', 'aa') + statTile((mass / 1000).toFixed(1), 'Mol. weight', 'kDa') +
            statTile(isoelectric(cnt).toFixed(2), 'Isoelectric point') +
            statTile(known ? (kd / known).toFixed(2) : '—', 'GRAVY (hydropathy)') +
            statTile(netCharge(cnt, 7).toFixed(1), 'Net charge @ pH 7') +
            statTile(charged.toFixed(1), 'Charged residues', '%');
    items = AA_ORDER.map(k => ({ k, c: cnt[k] || 0, cls: 'c-' + AA_CLASS[k] }));

    const groups = {};
    for (const it of items) { const g = AA_CLASS[it.k]; groups[g] = (groups[g] || 0) + it.c; }
    const order = ['h', 'p', 'pos', 'neg', 'sp'];
    stackHTML = '<div class="stack">' + order.map(g => `<i class="c-${g}" style="width:0" data-w="${(groups[g] / n * 100).toFixed(2)}"></i>`).join('') + '</div>';
    $('#legend').innerHTML = order.map(g => `<span class="c-${g}">${CLASS_NAME[g]} ${(groups[g] / n * 100).toFixed(0)}%</span>`).join('');
  }

  $('#stats').innerHTML = stats;

  const max = Math.max(...items.map(i => i.c), 1);
  $('#comp').innerHTML = stackHTML + '<div class="chart">' + items.map(it => {
    const pct = (it.c / n * 100);
    return `<div class="col" title="${it.k}: ${it.c} (${pct.toFixed(1)}%)"><div class="track"><div class="bar ${it.cls}" data-h="${(it.c / max * 100).toFixed(1)}"></div></div><span class="lab">${it.k}</span></div>`;
  }).join('') + '</div>';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$('#comp .bar').forEach(b => b.style.height = b.dataset.h + '%');
    $$('#comp .stack i').forEach(s => s.style.width = s.dataset.w + '%');
  }));

  // sequence viewer: lines of 50, blocks of 10
  const cls = ch => isNA ? (NA_CLASS[ch] || '') : ('c-' + (AA_CLASS[ch] || ''));
  let out = '';
  for (let i = 0; i < n; i += 50) {
    const line = seq.slice(i, i + 50);
    let blocks = '';
    for (let j = 0; j < line.length; j += 10) {
      blocks += '<span class="blk">' + [...line.slice(j, j + 10)].map(ch => `<i class="${cls(ch)}" title="${ch}${i + j + 1}">${ch}</i>`).join('') + '</span>';
    }
    out += `<div class="ln"><span class="no">${i + 1}</span>${blocks}</div>`;
  }
  $('#seq').innerHTML = out;
}

function copyFasta() {
  const ent = state.entities[state.entIdx];
  if (!ent?.seq) return toast('No sequence to copy.');
  const wrapped = ent.seq.match(/.{1,60}/g).join('\n');
  const fasta = `>${state.pdbId}_${ent.id} ${ent.desc}${ent.organism ? ' [' + ent.organism + ']' : ''}\n${wrapped}`;
  navigator.clipboard.writeText(fasta).then(
    () => toast('FASTA copied to clipboard', true),
    () => toast('Clipboard not available in this browser.'));
}

/* =====================================================================
   SEARCH
   ===================================================================== */
const looksLikePdbId = q => /^[1-9][A-Za-z0-9]{3}$/.test(q);

async function searchText(q) {
  const box = $('#results');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="note">Searching RCSB PDB…</div>';
  const query = {
    query: { type: 'terminal', service: 'full_text', parameters: { value: q } },
    return_type: 'entry',
    request_options: { paginate: { start: 0, rows: 8 }, sort: [{ sort_by: 'score', direction: 'desc' }] },
  };
  try {
    const r = await fetch(`${API.search}?json=${encodeURIComponent(JSON.stringify(query))}`);
    if (r.status === 204) { box.innerHTML = `<div class="note">No structures found for “${esc(q)}”. Try another name or a PDB ID.</div>`; return; }
    if (!r.ok) throw new Error('search failed');
    const ids = (await r.json()).result_set.map(x => x.identifier);
    const entries = await Promise.allSettled(ids.map(id => fetchJSON(API.entry(id))));
    box.innerHTML = entries.map((p, i) => {
      const id = ids[i];
      const e = p.status === 'fulfilled' ? p.value : {};
      const res = e.rcsb_entry_info?.resolution_combined?.[0];
      const meta = [e.exptl?.[0]?.method, res ? res.toFixed(1) + ' Å' : null, e.rcsb_accession_info?.initial_release_date?.slice(0, 4)].filter(Boolean).join(' · ');
      return `<button class="res" data-id="${esc(id)}"><div class="id">${esc(id)}</div><div class="t">${esc(e.struct?.title || 'Structure ' + id)}</div><div class="m">${esc(meta)}</div></button>`;
    }).join('');
    $$('.res', box).forEach(b => b.addEventListener('click', () => loadStructure(b.dataset.id)));
  } catch (err) {
    console.error(err);
    box.innerHTML = '<div class="note">Search is unavailable right now. Please try again.</div>';
  }
}

function handleQuery(q) {
  q = q.trim();
  if (!q) return;
  if (looksLikePdbId(q)) loadStructure(q); else searchText(q);
}

/* =====================================================================
   UI WIRING
   ===================================================================== */
function bindUI() {
  // examples
  $('#chips').innerHTML = EXAMPLES.map(e => `<button class="chip" data-id="${e.id}"><b>${e.id}</b>${esc(e.label)}</button>`).join('');
  $$('#chips .chip').forEach(c => c.addEventListener('click', () => { $('#q').value = c.dataset.id; loadStructure(c.dataset.id); }));

  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); handleQuery($('#q').value); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); $('#q').select(); }
  });

  // segmented controls
  $$('.seg').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', seg).forEach(x => x.classList.toggle('active', x === b));
    state[seg.dataset.group] = b.dataset.val;
    applyStyle();
  }));

  $('#tSpin').addEventListener('click', () => setSpin(!state.spin));
  $('#tLig').addEventListener('click', () => {
    state.ligands = !state.ligands;
    $('#tLig').classList.toggle('active', state.ligands);
    applyStyle();
  });
  $('#bReset').addEventListener('click', () => { if (viewer) { viewer.zoomTo(); viewer.render(); } });
  $('#bShot').addEventListener('click', () => {
    if (!viewer || !state.loaded) return;
    const a = document.createElement('a');
    a.href = viewer.pngURI();
    a.download = `ProteinScope_${state.pdbId}.png`;
    a.click();
  });
  $('#bFull').addEventListener('click', () => {
    const w = $('#viewerWrap');
    if (document.fullscreenElement) document.exitFullscreen(); else w.requestFullscreen?.();
  });
  document.addEventListener('fullscreenchange', () => setTimeout(() => viewer && viewer.resize(), 150));
  window.addEventListener('resize', () => viewer && viewer.resize());

  $('#bCopy').addEventListener('click', copyFasta);

  // spotlight glow on cards
  document.addEventListener('pointermove', e => {
    const c = e.target.closest?.('.card');
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', `${e.clientX - r.left}px`);
    c.style.setProperty('--my', `${e.clientY - r.top}px`);
  });

  window.addEventListener('hashchange', route);
}

function route() {
  const id = location.hash.replace('#', '').trim();
  if (looksLikePdbId(id) && id.toUpperCase() !== state.pdbId) {
    $('#q').value = id.toUpperCase();
    loadStructure(id);
  }
}

/* =====================================================================
   ANIMATED BACKGROUND — drifting molecular network
   ===================================================================== */
(function background() {
  const cv = $('#bg');
  const ctx = cv.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w, h, dpr, pts = [];
  const mouse = { x: -9999, y: -9999 };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = cv.width = Math.floor(innerWidth * dpr);
    h = cv.height = Math.floor(innerHeight * dpr);
    const n = Math.min(120, Math.floor(innerWidth * innerHeight / 13000));
    pts = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - .5) * .28 * dpr, vy: (Math.random() - .5) * .28 * dpr,
      r: (Math.random() * 1.7 + .7) * dpr, hue: Math.random() < .55 ? 188 : (Math.random() < .5 ? 265 : 330),
    }));
  }
  function frame() {
    ctx.clearRect(0, 0, w, h);
    const link = 150 * dpr;
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      const dx = p.x - mouse.x, dy = p.y - mouse.y, d = Math.hypot(dx, dy);
      if (d < 130 * dpr) { p.x += dx / d * 1.2; p.y += dy / d * 1.2; }
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < link) {
          ctx.strokeStyle = `hsla(${a.hue},90%,65%,${(1 - d / link) * .22})`;
          ctx.lineWidth = dpr * .8;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      ctx.fillStyle = `hsla(${a.hue},95%,70%,.85)`;
      ctx.shadowColor = `hsla(${a.hue},95%,65%,.9)`;
      ctx.shadowBlur = 10 * dpr;
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    if (!reduce && !document.hidden) requestAnimationFrame(frame);
  }
  addEventListener('resize', resize);
  addEventListener('pointermove', e => { mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !reduce) requestAnimationFrame(frame); });
  resize();
  frame();
})();

/* =====================================================================
   START
   ===================================================================== */
bindUI();
if (initViewer()) {
  const fromHash = location.hash.replace('#', '').trim();
  loadStructure(looksLikePdbId(fromHash) ? fromHash : '1TUP');
}
