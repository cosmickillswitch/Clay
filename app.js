/* Clayframe editor: modes (Sculpt, Objects, Rig, Pose, Stage), touch navigation, gizmo, timeline, storage and export. */
(function () {
  'use strict';
  const { v3, q, m4, clamp, decompose } = window.CM;
  const S = window.CScene, MESHLIB = window.CMesh, SC = window.CSculpt, RND = window.CRender;
  const $ = id => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const round = (v, d) => { const k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; };
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'style') e.setAttribute('style', v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  let toastT = 0;
  function toast(msg, ms) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 2600); }

  // ---------- state ----------
  let scene = null, projId = null;
  const MESH = new Map();          // object id → { m: mesh, morphs: { shapeId: Float32Array }, skin: { bi, bw, bones } | null }
  let sel = null, selBone = null, mode = 'sculpt';
  let time = 0, playing = false, playT0 = 0, dirty = true;
  let autoKey = false, camView = false, tlOpen = true;
  const cam = { target: [0, 0.9, 0], yaw: 0.6, pitch: 0.25, dist: 5.2, fov: 40 };
  const brush = Object.assign({ tool: 'clay', radius: 50, strength: 0.45, invert: false, sym: true, color: '#C8553D' }, store.get('clayframe.brush', {}));
  let shapeEdit = null;            // { id, mid, base }
  let rigChain = null;             // { id, last: [x,y,z], parent: boneId|null, mlast, mparent }
  let ik = Object.assign({ on: true, len: 2 }, store.get('clayframe.ik', {}));
  let lastEval = null, camNow = null;
  const selObj = () => (scene && scene.objects.find(o => o.id === sel)) || null;
  const objById = id => scene.objects.find(o => o.id === id) || null;

  // ---------- storage: IndexedDB holds projects (meshes are big binary arrays) ----------
  const db = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => { try { const r = indexedDB.open('clayframe', 1); r.onupgradeneeded = () => r.result.createObjectStore('projects'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }));
    const tx = (mode, fn) => open().then(d => new Promise((res, rej) => { const t = d.transaction('projects', mode), st = t.objectStore('projects'); const r = fn(st); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }));
    return { put: (id, v) => tx('readwrite', s => s.put(v, id)), get: id => tx('readonly', s => s.get(id)), del: id => tx('readwrite', s => s.delete(id)) };
  })();
  let memProjects = new Map();     // fallback when IndexedDB is unavailable
  const listMeta = () => store.get('clayframe.projects', []);
  function packMeshes() {
    const out = {};
    for (const [id, M] of MESH) out[id] = { pos: M.m.pos, idx: M.m.idx, col: M.m.col, mask: M.m.mask, morphs: M.morphs, skin: M.skin };
    return out;
  }
  function unpackMeshes(meshes) {
    MESH.clear();
    for (const [id, d] of Object.entries(meshes || {})) {
      const m = MESHLIB.make(d.pos, d.idx);
      if (d.col && d.col.length === m.col.length) m.col.set(d.col);
      if (d.mask && d.mask.length === m.mask.length) m.mask.set(d.mask);
      MESH.set(id, { m, morphs: d.morphs || {}, skin: d.skin || null });
    }
  }
  let saveT = 0, saving = false;
  function saveSoon() { clearTimeout(saveT); saveT = setTimeout(saveNow, 1200); }
  let saveAgain = false;
  async function saveNow() {
    if (!scene) return;
    if (saving) { saveAgain = true; return; }
    saving = true;
    const rec = { id: projId, scene: JSON.parse(JSON.stringify(scene)), meshes: packMeshes(), at: Date.now() };
    try { await db.put(projId, rec); } catch (e) { memProjects.set(projId, rec); }
    const meta = listMeta().filter(p => p.id !== projId);
    meta.unshift({ id: projId, name: scene.name, at: rec.at });
    store.set('clayframe.projects', meta);
    store.set('clayframe.current', projId);
    saving = false;
    if (saveAgain) { saveAgain = false; await saveNow(); }
  }
  async function loadProject(id) {
    let rec = null;
    try { rec = await db.get(id); } catch (e) { rec = memProjects.get(id); }
    if (!rec) return false;
    openScene(rec.scene, rec.meshes, id);
    return true;
  }
  function openScene(sc, meshes, id) {
    scene = sc; projId = id;
    scene.camKeys = scene.camKeys || [];
    unpackMeshes(meshes);
    sel = scene.objects[0] ? scene.objects[0].id : null; selBone = null;
    time = 0; playing = false; hist.length = 0; redoStack.length = 0;
    shapeEdit = null; rigChain = null;
    Object.assign(cam, scene.view || { target: [0, 0.6, 0], yaw: 0.6, pitch: 0.3, dist: 4, fov: 40 });
    fillProjects(); setMode(mode === 'stage' ? 'objects' : mode); renderTimeline(); dirty = true;
    $('dur').textContent = scene.duration; setTime(0);
  }
  function fillProjects() {
    const sel_ = $('proj'); sel_.innerHTML = '';
    for (const p of listMeta()) sel_.append(h('option', { value: p.id }, p.name));
    sel_.value = projId;
  }

  // ---------- undo ----------
  const hist = [], redoStack = [];
  function snapScene() { return { kind: 'scene', json: JSON.stringify(scene) }; }
  function snapMesh(id) { const M = MESH.get(id); return { kind: 'mesh', id, m: M.m, pos: M.m.pos.slice(), col: M.m.col.slice(), mask: M.m.mask.slice(), morphs: Object.assign({}, M.morphs), skin: M.skin, json: JSON.stringify(scene) }; }
  function pushUndo(s) { hist.push(s); if (hist.length > 40) hist.shift(); redoStack.length = 0; updUndo(); }
  function restore(s) {
    const cur = s.kind === 'mesh' ? snapMesh(s.id) : snapScene();
    if (s.kind === 'mesh') {
      const M = MESH.get(s.id);
      if (M) {
        if (M.m !== s.m) { M.m = s.m; }
        M.m.pos.set(s.pos); M.m.col.set(s.col); M.m.mask.set(s.mask);
        M.morphs = s.morphs; M.skin = s.skin;
        MESHLIB.normals(M.m); M.m.ver++; M.m.cver = (M.m.cver || 0) + 1;
      }
    }
    if (s.json) { const keepSel = sel; scene = JSON.parse(s.json); if (!objById(keepSel)) sel = null; }
    return cur;
  }
  function undo() { const s = hist.pop(); if (!s) return; redoStack.push(restore(s)); after(); }
  function redo() { const s = redoStack.pop(); if (!s) return; hist.push(restore(s)); after(); }
  function after() { updUndo(); renderTools(); renderTimeline(); refreshSheet(); dirty = true; saveSoon(); }
  function updUndo() { $('undo').disabled = !hist.length; $('redo').disabled = !redoStack.length; }
  // record the scene before a change; call changed() after
  const before = () => pushUndo(snapScene());
  function changed(opts) { dirty = true; saveSoon(); if (!opts || opts.tl !== false) renderTimelineSoon(); updKeyBtn(); }

  // ---------- objects ----------
  function newObj(over) {
    return Object.assign({ id: uid(), name: 'Object', type: 'mesh', parent: null, parentBone: null, pos: [0, 0, 0], rot: [0, 0, 0], scl: [1, 1, 1], color: '#D9D4CF', matcap: 'clay', flat: false, visible: true, keys: {}, bones: [], morphs: [] }, over || {});
  }
  function addMesh(m, over) {
    const o = newObj(over);
    MESH.set(o.id, { m, morphs: {}, skin: null });
    scene.objects.push(o);
    return o;
  }
  const countName = base => { let n = 1; while (scene.objects.some(o => o.name === base + ' ' + n)) n++; return base + ' ' + n; };
  function addPrim(kind) {
    before();
    const m = MESHLIB.PRIMS[kind].make(), b = MESHLIB.bounds(m);
    const o = addMesh(m, { name: countName(MESHLIB.PRIMS[kind].label), pos: [0, round(-b.min[1], 3), 0] });
    if (kind === 'plane') o.scl = [3, 1, 3];
    sel = o.id; selBone = null;
    changed(); renderTools(); closeSheet(); renderTimeline();
    if (scene.objects.length === 1) { draw(); frameSel(); }
    toast('Added ' + o.name + (mode === 'sculpt' ? '. One finger sculpts, two fingers move the view.' : ''));
  }
  function descendants(o) { const out = []; const walk = p => scene.objects.forEach(c => { if (c.parent === p.id && !out.includes(c)) { out.push(c); walk(c); } }); walk(o); return out; }

  // ---------- channels: static values, or keyframes when animated ----------
  function chanList(o) {
    const L = [['pos', 'Move'], ['rot', 'Turn'], ['scl', 'Size']];
    for (const b of o.bones || []) L.push(['bone:' + b.id, b.name]);
    for (const mo of o.morphs || []) L.push(['morph:' + mo.id, mo.name]);
    if ((o.keys.color || []).length) L.push(['color', 'Colour']);
    return L;
  }
  function staticVal(o, ch) {
    if (ch === 'pos' || ch === 'rot' || ch === 'scl') return o[ch];
    if (ch === 'color') return o.color;
    if (ch.startsWith('bone:')) { const b = o.bones.find(x => x.id === ch.slice(5)); return b ? (b.rot || [0, 0, 0, 1]) : [0, 0, 0, 1]; }
    if (ch.startsWith('morph:')) { const mo = o.morphs.find(x => x.id === ch.slice(6)); return mo ? mo.w || 0 : 0; }
  }
  const getChan = (o, ch, t) => S.keyVal(o.keys, ch, t == null ? time : t, staticVal(o, ch));
  function setChan(o, ch, v) {
    const keyed = o.keys[ch] && o.keys[ch].length;
    if (keyed || autoKey) { S.setKey(o.keys, ch, round(time, 3), v); return; }
    if (ch === 'pos' || ch === 'rot' || ch === 'scl') o[ch] = v;
    else if (ch === 'color') o.color = v;
    else if (ch.startsWith('bone:')) { const b = o.bones.find(x => x.id === ch.slice(5)); if (b) b.rot = v; }
    else if (ch.startsWith('morph:')) { const mo = o.morphs.find(x => x.id === ch.slice(6)); if (mo) mo.w = v; }
  }
  const keysAt = (o, t) => Object.entries(o.keys).filter(([, k]) => k.some(x => Math.abs(x.t - t) < 1e-3));
  function toggleKeyAll() {
    const o = selObj(); if (!o) { toast('Select something to keyframe'); return; }
    before();
    const t = round(time, 3), here = keysAt(o, t);
    if (here.length) { for (const [ch, k] of here) { o.keys[ch] = k.filter(x => Math.abs(x.t - t) >= 1e-3); if (!o.keys[ch].length) delete o.keys[ch]; } toast('Keyframe removed'); }
    else { for (const [ch] of chanList(o)) S.setKey(o.keys, ch, t, getChan(o, ch)); toast('Keyframed ' + o.name + ' at ' + t.toFixed(2) + 's'); }
    changed(); renderTimeline();
  }
  function updKeyBtn() {
    const o = selObj(), b = $('keyBtn');
    const at = o && keysAt(o, round(time, 3)).length, some = o && Object.keys(o.keys).length;
    b.className = 'keybtn big' + (at ? ' on' : some ? ' some' : '');
    b.textContent = at ? '◆' : '◇';
  }

  // ---------- frame evaluation and drawing ----------
  const view = $('view'), ov = $('ov'), octx = ov.getContext('2d');
  const R = RND.create(view);
  if (!R) { document.body.innerHTML = '<p style="padding:24px">This device or browser doesn’t support WebGL 2, which Clayframe needs for 3D.</p>'; return; }
  let dpr = 1, W = 1, H = 1, camObj = null;
  function resize() {
    if (exporting) return;
    const r = view.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width * dpr)); H = Math.max(1, Math.round(r.height * dpr));
    if (view.width !== W || view.height !== H) { view.width = W; view.height = H; ov.width = W; ov.height = H; }
    dirty = true;
  }
  new ResizeObserver(resize).observe($('viewWrap'));
  const restMode = () => mode === 'sculpt' || mode === 'rig';
  function boneArray(M, rec) {
    const arr = new Float32Array(48 * 16);
    M.skin.bones.forEach((id, i) => { if (i < 48) arr.set(rec.bones && rec.bones.S.get(id) || m4.id(), i * 16); });
    for (let i = M.skin.bones.length; i < 48; i++) arr.set(m4.id(), i * 16);
    return arr;
  }
  function displayFor(M, w) {
    const key = JSON.stringify(w) + '|' + M.m.ver;
    if (M._dk === key) return M._disp;
    M._dk = key; M._disp = S.morphed(M.m, M.morphs, w);
    return M._disp;
  }
  function viewCam() {
    if (camView || (exporting && exporting.cam)) { const c = S.camAt(scene, time); if (c) return c; }
    return cam;
  }
  function draw(opt) {
    opt = opt || {};
    const rest = !opt.final && restMode();
    const pose = opt.pose || null;
    const ev = S.evaluate(scene, time, { rest, pose, over: opt.over });
    lastEval = ev;
    camNow = viewCam();
    camObj = RND.camera(camNow, W, H);
    const items = [];
    for (const o of scene.objects) {
      if (o.type !== 'mesh') continue;
      const rec = ev.get(o.id), M = MESH.get(o.id);
      if (!rec || !M || !rec.visible) continue;
      const editingShape = shapeEdit && shapeEdit.id === o.id;
      const display = rest || editingShape ? null : displayFor(M, rec.morphW);
      const bones = !rest && M.skin && o.bones.length ? boneArray(M, rec) : null;
      items.push({ id: o.id, mesh: M.m, display, skin: M.skin, bones, model: rec.world, color: S.hex(rec.color), matcap: o.matcap, flat: o.flat, selected: !opt.final && o.id === sel && mode !== 'stage', alpha: 1 });
    }
    R.draw(items, camObj, { grid: !opt.final && scene.grid !== false, bg: S.hex(scene.bg || '#24242A') });
    if (!opt.final) drawOverlay(ev);
    else octx.clearRect(0, 0, W, H);
  }

  // ---------- picking ----------
  function worldOf(o) { const r = lastEval && lastEval.get(o.id); return r ? r.world : m4.id(); }
  function boundsOf(M) { if (M._bv !== M.m.ver) { M._b = MESHLIB.bounds(M.m); M._bv = M.m.ver; } return M._b; }
  // nearest mesh under a canvas pixel (only = one object id)
  function pick(px, py, only) {
    const r = camObj.ray(px, py);
    let best = null;
    for (const o of scene.objects) {
      if (o.type !== 'mesh' || (only && o.id !== only)) continue;
      const rec = lastEval.get(o.id); if (!rec || !rec.visible) continue;
      const M = MESH.get(o.id); if (!M) continue;
      const Wm = rec.world, Wi = m4.inv(Wm);
      const lo = m4.point(Wi, r.o), ld = v3.norm(m4.dir(Wi, r.d));
      const b = boundsOf(M), oc = v3.sub(b.c, lo), tc = v3.dot(oc, ld);
      if (v3.dot(oc, oc) - tc * tc > b.r * b.r * 1.02) continue;
      const hit = MESHLIB.raycast(M.m, lo, ld, true);
      if (!hit) continue;
      const wp = m4.point(Wm, hit.p), d = v3.dist(camObj.eye, wp);
      if (!best || d < best.d) best = { o, M, hit, wp, d, lo, ld, Wm, Wi };
    }
    return best;
  }

  // ---------- overlay: brush ring, gizmo, bones ----------
  let hover = null;
  const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], AXC = ['#F2685B', '#7BD389', '#5B9BFF'];
  function parentWorld(o) {
    if (!o.parent) return m4.id();
    const pr = lastEval && lastEval.get(o.parent);
    if (!pr) return m4.id();
    let M = pr.world;
    if (o.parentBone && pr.bones && pr.bones.S.has(o.parentBone)) M = m4.mul(M, pr.bones.S.get(o.parentBone));
    return M;
  }
  function gizmoGeom(o) {
    const Wm = worldOf(o), c = [Wm[12], Wm[13], Wm[14]], cs = camObj.project(c);
    if (cs[2] <= 0) return null;
    const px = camObj.pxSize(c), L = 92 * dpr * px, ringR = 62 * dpr * px;
    const axes = AX.map((e, i) => ({ i, e, tip: camObj.project(v3.add(c, v3.scale(e, L))), L }));
    const rings = AX.map((e, i) => {
      const u = AX[(i + 1) % 3], w = AX[(i + 2) % 3], pts = [];
      for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; pts.push(camObj.project(v3.add(c, v3.add(v3.scale(u, Math.cos(a) * ringR), v3.scale(w, Math.sin(a) * ringR))))); }
      return { i, e, pts };
    });
    return { c, cs, axes, rings, outer: 118 * dpr };
  }
  function bonePts(o, ev) {
    const rec = ev.get(o.id); if (!rec || !rec.bones) return [];
    return o.bones.map(b => {
      const hw = m4.point(rec.world, rec.bones.head.get(b.id)), tw = m4.point(rec.world, rec.bones.tail.get(b.id));
      return { b, hw, tw, h: camObj.project(hw), t: camObj.project(tw) };
    });
  }
  function drawOverlay(ev) {
    const x = octx; x.clearRect(0, 0, W, H);
    const k = dpr, o = selObj();
    if (camView || (scene.camKeys.length && mode === 'stage')) frameGuide(x);
    if (mode === 'sculpt' && hover && !playing) {
      x.strokeStyle = brush.invert ? '#5BC0FF' : '#FFFFFF'; x.lineWidth = 1.5 * k; x.globalAlpha = 0.8;
      x.beginPath(); x.arc(hover[0], hover[1], brush.radius * k, 0, 7); x.stroke();
      x.globalAlpha = 0.35; x.beginPath(); x.arc(hover[0], hover[1], brush.radius * k * brush.strength, 0, 7); x.stroke(); x.globalAlpha = 1;
    }
    if (mode === 'objects' && o && !playing) {
      const g = gizmoGeom(o);
      if (g) {
        x.lineCap = 'round';
        x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1.5 * k; x.beginPath(); x.arc(g.cs[0], g.cs[1], g.outer, 0, 7); x.stroke();
        g.rings.forEach(r => { x.strokeStyle = AXC[r.i]; x.globalAlpha = 0.7; x.lineWidth = 2.5 * k; x.beginPath(); r.pts.forEach((p, j) => j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.stroke(); });
        x.globalAlpha = 1;
        g.axes.forEach(a => {
          x.strokeStyle = x.fillStyle = AXC[a.i]; x.lineWidth = 3.5 * k;
          x.beginPath(); x.moveTo(g.cs[0], g.cs[1]); x.lineTo(a.tip[0], a.tip[1]); x.stroke();
          x.beginPath(); x.arc(a.tip[0], a.tip[1], 8 * k, 0, 7); x.fill();
        });
        x.fillStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.arc(g.cs[0], g.cs[1], 7 * k, 0, 7); x.fill();
      }
    }
    if ((mode === 'rig' || mode === 'pose') && o && o.bones.length) {
      for (const p of bonePts(o, ev)) {
        const on = p.b.id === selBone, dx = p.t[0] - p.h[0], dy = p.t[1] - p.h[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, w = Math.min(14 * k, L * 0.16);
        const mx = p.h[0] + dx * 0.18, my = p.h[1] + dy * 0.18;
        x.fillStyle = on ? 'rgba(91,192,255,.55)' : 'rgba(255,214,130,.38)'; x.strokeStyle = on ? '#5BC0FF' : 'rgba(255,214,130,.95)'; x.lineWidth = 1.5 * k;
        x.beginPath(); x.moveTo(p.h[0], p.h[1]); x.lineTo(mx + nx * w, my + ny * w); x.lineTo(p.t[0], p.t[1]); x.lineTo(mx - nx * w, my - ny * w); x.closePath(); x.fill(); x.stroke();
        x.fillStyle = on ? '#5BC0FF' : '#FFD682';
        x.beginPath(); x.arc(p.t[0], p.t[1], 7 * k, 0, 7); x.fill();
        if (!p.b.parent) { x.beginPath(); x.arc(p.h[0], p.h[1], 8 * k, 0, 7); x.strokeStyle = '#fff'; x.lineWidth = 2 * k; x.stroke(); }
      }
      if (mode === 'pose' && selBone && !playing) {
        const g = boneRings(o, ev);
        if (g) g.rings.forEach(r => { x.strokeStyle = AXC[r.i]; x.globalAlpha = 0.75; x.lineWidth = 2.5 * k; x.beginPath(); r.pts.forEach((p, j) => j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.stroke(); x.globalAlpha = 1; });
      }
    }
    if (mode === 'rig' && rigChain && rigChain.lastW && hover) {
      const a = camObj.project(rigChain.lastW);
      x.setLineDash([6 * k, 6 * k]); x.strokeStyle = '#FFD682'; x.lineWidth = 2 * k; x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(hover[0], hover[1]); x.stroke(); x.setLineDash([]);
    }
  }
  function frameGuide(x) {
    const [aw, ah] = String(scene.aspect || '16:9').split(':').map(Number), r = aw / ah;
    let fw = W, fh = W / r; if (fh > H) { fh = H; fw = H * r; }
    const x0 = (W - fw) / 2, y0 = (H - fh) / 2;
    x.fillStyle = 'rgba(0,0,0,.45)';
    x.fillRect(0, 0, W, y0); x.fillRect(0, y0 + fh, W, H - y0 - fh); x.fillRect(0, y0, x0, fh); x.fillRect(x0 + fw, y0, W - x0 - fw, fh);
    x.strokeStyle = 'rgba(255,255,255,.4)'; x.lineWidth = dpr; x.strokeRect(x0, y0, fw, fh);
  }
  function boneRings(o, ev) {
    const pt = bonePts(o, ev).find(p => p.b.id === selBone); if (!pt) return null;
    const c = pt.hw, px = camObj.pxSize(c), R0 = 46 * dpr * px;
    return { c, cs: camObj.project(c), rings: AX.map((e, i) => { const u = AX[(i + 1) % 3], w = AX[(i + 2) % 3], pts = []; for (let k = 0; k <= 40; k++) { const a = k / 40 * Math.PI * 2; pts.push(camObj.project(v3.add(c, v3.add(v3.scale(u, Math.cos(a) * R0), v3.scale(w, Math.sin(a) * R0))))); } return { i, e, pts }; }) };
  }
  const nearPoly = (pts, x, y, tol) => { for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i]; const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1, u = clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1); if (Math.hypot(ax + dx * u - x, ay + dy * u - y) < tol) return true; } return false; };

  // ---------- pointer input ----------
  const pointers = new Map();
  let act = null, gest = null;
  const cpx = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  function viewChanged() {
    if (camView) { const c = S.camAt(scene, time); if (c) Object.assign(cam, JSON.parse(JSON.stringify(c))); camView = false; $('camViewBtn').setAttribute('aria-pressed', 'false'); toast('Back to the free view. 🎥◆ keyframes the camera here.'); }
    scene.view = { target: cam.target.slice(), yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, fov: cam.fov };
    dirty = true; saveSoon();
  }
  const orbitAct = (onTap) => ({ type: 'orbit', moved: false, move(px, py, e, d) { viewChanged(); cam.yaw -= d[0] / dpr * 0.008; cam.pitch = clamp(cam.pitch + d[1] / dpr * 0.008, -1.5, 1.5); }, up() { if (!this.moved && onTap) onTap(); } });
  function panBy(dx, dy) {
    const px = camObj.pxSize(cam.target), e = camObj.eye, f = v3.norm(v3.sub(cam.target, e)), r = v3.norm(v3.cross(f, [0, 1, 0])), u = v3.cross(r, f);
    cam.target = v3.add(cam.target, v3.add(v3.scale(r, -dx * px), v3.scale(u, dy * px)));
  }
  view.addEventListener('pointerdown', e => {
    if (stageOn && stageDown(e)) return;
    const p = cpx(e);
    pointers.set(e.pointerId, { x: p[0], y: p[1], sx: p[0], sy: p[1] });
    try { view.setPointerCapture(e.pointerId); } catch (err) {}
    if (pointers.size >= 2) {
      if (act && act.cancel) act.cancel(); else if (act && act.up) act.up(true);
      act = null;
      const [a, b] = [...pointers.values()];
      gest = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      return;
    }
    if (e.button === 1 || e.button === 2 || e.altKey) { act = e.button === 1 || e.shiftKey ? { type: 'pan', move(px, py, ev, d) { viewChanged(); panBy(d[0], d[1]); } } : orbitAct(); act.last = p; return; }
    act = downFor(p[0], p[1], e) || orbitAct();
    act.last = p; act.start = p;
  });
  view.addEventListener('pointermove', e => {
    const p = cpx(e), pt = pointers.get(e.pointerId);
    if (stageOn && stageMove(e)) return;
    if (!pt) { if (e.pointerType === 'mouse') { hover = p; if (mode === 'sculpt' || mode === 'rig') dirty = true; } return; }
    pt.x = p[0]; pt.y = p[1];
    if (gest && pointers.size >= 2) {
      const [a, b] = [...pointers.values()], cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      viewChanged(); panBy(cx - gest.cx, cy - gest.cy); cam.dist = clamp(cam.dist * gest.d / d, 0.2, 200);
      gest.cx = cx; gest.cy = cy; gest.d = d;
      return;
    }
    if (!act) return;
    const d = [p[0] - act.last[0], p[1] - act.last[1]];
    if (!act.moved && Math.hypot(p[0] - act.start[0], p[1] - act.start[1]) < 6 * dpr) return;
    act.moved = true;
    if (e.pointerType !== 'mouse' || mode === 'sculpt') hover = p;
    act.move(p[0], p[1], e, d);
    act.last = p;
    dirty = true;
  });
  const endPtr = e => {
    if (stageOn && stageUp(e)) return;
    pointers.delete(e.pointerId);
    if (gest) { if (pointers.size < 2) gest = null; if (!pointers.size) act = null; return; }
    if (act) { const a = act; act = null; if (a.up) a.up(false); }
    if (e.pointerType !== 'mouse') hover = null;
    dirty = true;
  };
  view.addEventListener('pointerup', endPtr);
  view.addEventListener('pointercancel', endPtr);
  view.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pointers.size) { hover = null; dirty = true; } });
  view.addEventListener('contextmenu', e => e.preventDefault());
  view.addEventListener('wheel', e => { e.preventDefault(); viewChanged(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 0.2, 200); }, { passive: false });
  view.addEventListener('dblclick', () => frameSel());

  function selectObj(id) {
    if (sel === id) return;
    sel = id; selBone = null; rigChain = null;
    renderTools(); renderTimeline(); refreshSheet(); updKeyBtn(); dirty = true;
  }
  // what a one-finger press does, by mode
  function downFor(px, py, e) {
    if (playing && mode !== 'stage') setPlaying(false);
    const o = selObj();
    if (mode === 'sculpt') {
      const hit = o && pick(px, py, o.id);
      if (hit) return strokeAct(hit, px, py);
      return orbitAct(() => { const h2 = pick(px, py); if (h2) { selectObj(h2.o.id); toast('Selected ' + h2.o.name + '. Sculpt away.'); } });
    }
    if (mode === 'objects') {
      if (o) { const g = gizmoAct(o, px, py); if (g) return g; }
      const hit = pick(px, py);
      if (hit && hit.o.id === (o && o.id)) return dragObjAct(hit.o, px, py);
      return orbitAct(() => selectObj(hit ? hit.o.id : null));
    }
    if (mode === 'rig') {
      if (!o) return orbitAct(() => { const h2 = pick(px, py); if (h2) selectObj(h2.o.id); });
      const j = jointAt(o, px, py);
      if (j) return jointDragAct(o, j);
      const hit = pick(px, py, o.id);
      return orbitAct(() => { if (hit) addJoint(o, hit, px, py); else { const h2 = pick(px, py); if (h2 && h2.o.id !== o.id) selectObj(h2.o.id); } });
    }
    if (mode === 'pose') {
      if (o && o.bones.length) {
        const j = jointAt(o, px, py);
        if (j) return poseDragAct(o, j, px, py);
        const r = selBone && ringAct(o, px, py);
        if (r) return r;
      }
      return orbitAct(() => { const h2 = pick(px, py); selectObj(h2 ? h2.o.id : null); if (h2 && !h2.o.bones.length) toast(h2.o.name + ' has no bones yet: add them in Rig'); });
    }
    return null;
  }
  function frameSel() {
    const o = selObj();
    if (!o || !MESH.get(o.id)) { cam.target = [0, 0.8, 0]; cam.dist = 5; viewChanged(); return; }
    const b = boundsOf(MESH.get(o.id)), Wm = worldOf(o), c = m4.point(Wm, b.c), s = Math.hypot(Wm[0], Wm[1], Wm[2]);
    cam.target = c; cam.dist = clamp(b.r * s * 3.2, 0.5, 100); viewChanged();
  }

  // ---------- sculpting ----------
  let hintedSub = false;
  function strokeAct(hit, px, py) {
    const o = hit.o, M = hit.M, m = M.m;
    pushUndo(snapMesh(o.id));
    const sc = (Math.hypot(hit.Wm[0], hit.Wm[1], hit.Wm[2]) + Math.hypot(hit.Wm[4], hit.Wm[5], hit.Wm[6]) + Math.hypot(hit.Wm[8], hit.Wm[9], hit.Wm[10])) / 3;
    const rpx = brush.radius * dpr, rL = rpx * camObj.pxSize(hit.wp) / sc;
    const changedV = new Set();
    const col = S.hex(brush.color);
    const tool = brush.tool;
    const opts = P => ({ tool, P, N: P.n, r: rL, s: brush.strength, invert: brush.invert, color: col });
    const dabAt = (p, n) => {
      SC.dab(m, Object.assign(opts({}), { P: p, N: n })).forEach(i => changedV.add(i));
      if (brush.sym && Math.abs(p[0]) > rL * 0.05) SC.dab(m, Object.assign(opts({}), { P: [-p[0], p[1], p[2]], N: [-n[0], n[1], n[2]] })).forEach(i => changedV.add(i));
      else if (brush.sym) { /* on the mirror line one dab covers both sides */ }
    };
    const flush = () => {
      if (!changedV.size) return;
      if (tool === 'mask' || tool === 'paint') { changedV.clear(); dirty = true; return; }
      const all = new Set(changedV);
      for (const v of changedV) for (let k = m.nbStart[v]; k < m.nbStart[v + 1]; k++) all.add(m.nb[k]);
      MESHLIB.normals(m, all);
      m.ver++; changedV.clear(); dirty = true;
    };
    if (tool === 'move') {
      const grab = SC.grabStart(m, hit.hit.p, rL);
      const lp = hit.hit.p, gsym = brush.sym && Math.abs(lp[0]) > rL * 0.3 ? SC.grabStart(m, [-lp[0], lp[1], lp[2]], rL) : null;
      const n = v3.norm(v3.sub(camObj.eye, hit.wp)), p0 = hit.wp;
      return {
        type: 'stroke', move(x, y) {
          const r = camObj.ray(x, y), dn = v3.dot(r.d, n); if (Math.abs(dn) < 1e-6) return;
          const t = v3.dot(v3.sub(p0, r.o), n) / dn, wp = v3.add(r.o, v3.scale(r.d, t));
          const dl = m4.dir(hit.Wi, v3.sub(wp, p0));
          SC.grabMove(m, grab, dl).forEach(i => changedV.add(i));
          if (gsym) SC.grabMove(m, gsym, [-dl[0], dl[1], dl[2]]).forEach(i => changedV.add(i));
          flush();
        },
        up() { MESHLIB.normals(m); m.ver++; changed({ tl: false }); }
      };
    }
    dabAt(hit.hit.p, hit.hit.n); flush();
    if (!hintedSub && brush.tool !== 'smooth' && brush.tool !== 'mask' && brush.tool !== 'paint' && m.pos.length / 3 < 3000) { hintedSub = true; toast('Low detail: tap Subdivide for finer sculpting'); }
    const spacing = Math.max(2, rpx * 0.22);
    let last = [px, py];
    return {
      type: 'stroke',
      move(x, y) {
        const d = Math.hypot(x - last[0], y - last[1]);
        if (d < spacing) return;
        const n = Math.floor(d / spacing);
        for (let k = 1; k <= n; k++) {
          const sx = last[0] + (x - last[0]) * k / n, sy = last[1] + (y - last[1]) * k / n;
          const r = camObj.ray(sx, sy), lo = m4.point(hit.Wi, r.o), ld = v3.norm(m4.dir(hit.Wi, r.d));
          const h2 = MESHLIB.raycast(m, lo, ld, true);
          if (h2) dabAt(h2.p, h2.n);
        }
        last = [x, y];
        flush();
      },
      up() { if (tool === 'mask' || tool === 'paint') m.cver = (m.cver || 0) + 1; else { MESHLIB.normals(m); m.ver++; } changed({ tl: false }); }
    };
  }

  // ---------- moving objects: drag on the object, or the gizmo's arrows, rings and outer circle ----------
  const viewN = p => v3.norm(v3.sub(camObj.eye, p));
  function planeHit(px, py, p0, n) { const r = camObj.ray(px, py), dn = v3.dot(r.d, n); if (Math.abs(dn) < 1e-6) return null; return v3.add(r.o, v3.scale(r.d, v3.dot(v3.sub(p0, r.o), n) / dn)); }
  function setWorldPos(o, wp) { const P = parentWorld(o); setChan(o, 'pos', m4.point(m4.inv(P), wp).map(v => round(v, 4))); }
  function dragObjAct(o, px, py) {
    const Wm = worldOf(o), c0 = [Wm[12], Wm[13], Wm[14]], n = viewN(c0), h0 = planeHit(px, py, c0, n);
    let started = false;
    return { type: 'drag', move(x, y) { if (!started) { before(); started = true; } const p = planeHit(x, y, c0, n); if (p && h0) setWorldPos(o, v3.add(c0, v3.sub(p, h0))); changed({ tl: false }); }, up(c) { if (started) changed(); } };
  }
  function gizmoAct(o, px, py) {
    const g = gizmoGeom(o); if (!g) return null;
    const tol = 14 * dpr;
    let hitAxis = null, hitRing = null;
    for (const a of g.axes) if (Math.hypot(a.tip[0] - px, a.tip[1] - py) < tol * 1.3 || nearPoly([[g.cs[0] + (a.tip[0] - g.cs[0]) * 0.35, g.cs[1] + (a.tip[1] - g.cs[1]) * 0.35], a.tip], px, py, tol * 0.8)) { hitAxis = a; break; }
    if (!hitAxis) for (const r of g.rings) if (nearPoly(r.pts, px, py, tol * 0.7)) { hitRing = r; break; }
    const dc = Math.hypot(px - g.cs[0], py - g.cs[1]);
    const onOuter = !hitAxis && !hitRing && Math.abs(dc - g.outer) < tol;
    const onCentre = !hitAxis && !hitRing && dc < tol * 1.2;
    if (!hitAxis && !hitRing && !onOuter && !onCentre) return null;
    before();
    const Wm = worldOf(o), c0 = g.c;
    if (onCentre) return dragObjAct(o, px, py);
    if (hitAxis) {
      const sa = [hitAxis.tip[0] - g.cs[0], hitAxis.tip[1] - g.cs[1]], sl = Math.hypot(sa[0], sa[1]) || 1;
      return { type: 'axis', move(x, y) { const dd = ((x - px) * sa[0] + (y - py) * sa[1]) / sl; setWorldPos(o, v3.add(c0, v3.scale(hitAxis.e, dd / sl * hitAxis.L))); changed({ tl: false }); }, up() { changed(); } };
    }
    if (onOuter) {
      const s0 = getChan(o, 'scl').slice();
      return { type: 'scale', move(x, y) { const f = Math.max(0.02, Math.hypot(x - g.cs[0], y - g.cs[1]) / (dc || 1)); setChan(o, 'scl', s0.map(v => round(v * f, 4))); changed({ tl: false }); }, up() { changed(); } };
    }
    // ring: turn about a world axis
    const r0 = q.fromEuler(getChan(o, 'rot')), pr = decompose(parentWorld(o)).r;
    const facing = v3.dot(hitRing.e, v3.sub(camObj.eye, c0)) > 0 ? 1 : -1;
    const a0 = Math.atan2(-(py - g.cs[1]), px - g.cs[0]);
    return {
      type: 'ring', move(x, y) {
        let da = Math.atan2(-(y - g.cs[1]), x - g.cs[0]) - a0;
        const qw = q.axisAngle(hitRing.e, da * facing);
        const nl = q.mul(q.mul(q.mul(q.inv(pr), qw), pr), r0);
        setChan(o, 'rot', q.toEuler(nl).map(v => round(v, 2)));
        changed({ tl: false });
      }, up() { changed(); }
    };
  }

  // ---------- rigging: tap inside a limb to drop joints ----------
  function jointAt(o, px, py) {
    if (!lastEval) return null;
    let best = null;
    for (const p of bonePts(o, lastEval)) {
      const dt = Math.hypot(p.t[0] - px, p.t[1] - py), dh = Math.hypot(p.h[0] - px, p.h[1] - py);
      if (dt < 18 * dpr && (!best || dt < best.d)) best = { b: p.b, end: 'tail', d: dt, w: p.tw };
      if (!p.b.parent && dh < 18 * dpr && (!best || dh < best.d)) best = { b: p.b, end: 'head', d: dh, w: p.hw };
    }
    return best;
  }
  function insidePoint(o, hit, px, py) {
    const r = camObj.ray(px, py), lo = m4.point(hit.Wi, r.o), ld = v3.norm(m4.dir(hit.Wi, r.d));
    const ts = MESHLIB.raycastAll(hit.M.m, lo, ld);
    if (ts.length >= 2) return v3.add(lo, v3.scale(ld, (ts[0] + ts[1]) / 2));
    return hit.hit.p;
  }
  const mirrorOf = (o, b) => b && o.bones.find(x => x.id === b.mirror);
  function addJoint(o, hit, px, py) {
    const p = insidePoint(o, hit, px, py).map(v => round(v, 4));
    before();
    if (!rigChain || rigChain.id !== o.id) {
      const par = selBone && o.bones.find(b => b.id === selBone);
      rigChain = { id: o.id, last: par ? par.tail.slice() : null, parent: par ? par.id : null };
    }
    if (!rigChain.last) {
      rigChain.last = p; rigChain.lastW = m4.point(worldOf(o), p);
      toast('Joint placed. Tap further along the limb to make a bone.');
      changed(); return;
    }
    const nb = { id: uid(), name: 'Bone ' + (o.bones.length + 1), parent: rigChain.parent, head: rigChain.last.slice(), tail: p, rot: [0, 0, 0, 1] };
    o.bones.push(nb);
    // mirrored twin for arms and legs
    if (brush.sym && Math.abs(nb.tail[0]) > 0.03) {
      const par = o.bones.find(b => b.id === nb.parent), mpar = mirrorOf(o, par) || par;
      const mb = { id: uid(), name: nb.name + ' (mirror)', parent: mpar ? mpar.id : null, head: [-nb.head[0], nb.head[1], nb.head[2]], tail: [-nb.tail[0], nb.tail[1], nb.tail[2]], rot: [0, 0, 0, 1], mirror: nb.id };
      if (Math.abs(nb.head[0]) < 0.02) mb.head = nb.head.slice();
      nb.mirror = mb.id; o.bones.push(mb);
    }
    rigChain.last = p; rigChain.parent = nb.id; rigChain.lastW = m4.point(worldOf(o), p);
    selBone = nb.id; o.rigDirty = true;
    changed(); renderTools();
  }
  function jointDragAct(o, j) {
    const W0 = worldOf(o), Wi = m4.inv(W0), n = viewN(j.w);
    const old = (j.end === 'tail' ? j.b.tail : j.b.head).slice();
    let started = false;
    const moveBone = (b, end, p, oldP) => {
      if (end === 'tail') { b.tail = p; o.bones.forEach(c => { if (c.parent === b.id && v3.dist(c.head, oldP) < 1e-3) c.head = p.slice(); }); }
      else b.head = p;
    };
    return {
      type: 'joint', move(x, y) {
        if (!started) { before(); started = true; }
        const w = planeHit(x, y, j.w, n); if (!w) return;
        const p = m4.point(Wi, w).map(v => round(v, 4));
        const prev = (j.end === 'tail' ? j.b.tail : j.b.head).slice();
        moveBone(j.b, j.end, p, prev);
        const mb = brush.sym && mirrorOf(o, j.b);
        if (mb) { const mp = [-p[0], p[1], p[2]], mprev = (j.end === 'tail' ? mb.tail : mb.head).slice(); moveBone(mb, j.end, mp, mprev); }
        o.rigDirty = true; changed({ tl: false });
      },
      up() {
        if (!started) { selBone = j.b.id; rigChain = { id: o.id, last: j.b.tail.slice(), parent: j.b.id, lastW: m4.point(W0, j.b.tail) }; renderTools(); toast(j.b.name + ': tap inside the mesh to grow a bone from here'); }
        else changed();
        dirty = true;
      }
    };
  }
  function bind(o, quiet) {
    const M = MESH.get(o.id); if (!M || !o.bones.length) return;
    if (o.bones.length > S.MAX_BONES) { toast('Up to ' + S.MAX_BONES + ' bones per mesh'); return; }
    M.skin = S.autoWeights(M.m, o.bones);
    o.rigDirty = false;
    if (!quiet) toast('Bound ' + o.bones.length + ' bones to ' + o.name + '. Try it in Pose.');
    saveSoon();
  }

  // ---------- posing: drag a joint (aim, or IK along the chain), or turn on the rings ----------
  function curPose(o) { const rec = lastEval && lastEval.get(o.id); return new Map(rec ? rec.pose : []); }
  function applyPose(o, pose, ids) { for (const id of ids) setChan(o, 'bone:' + id, q.norm(pose.get(id)).map(v => round(v, 5))); }
  function poseDragAct(o, j, px, py) {
    if (j.end === 'head') { selBone = j.b.id; renderTools(); return dragObjAct(o, px, py); }
    const Wm = worldOf(o), Wi = m4.inv(Wm), n = viewN(j.w);
    let started = false;
    return {
      type: 'pose', move(x, y) {
        if (!started) { before(); started = true; selBone = j.b.id; }
        const w = planeHit(x, y, j.w, n); if (!w) return;
        const target = m4.point(Wi, w), pose = curPose(o);
        let ids;
        if (ik.on && j.b.parent) {
          S.solveIK(o.bones, pose, j.b.id, target, Math.max(1, ik.len));
          ids = []; let b = j.b; while (b && ids.length < ik.len) { ids.push(b.id); b = o.bones.find(x2 => x2.id === b.parent); }
        } else {
          const ps = S.poseBones(o.bones, pose), hd = ps.head.get(j.b.id), tl = ps.tail.get(j.b.id);
          const rw = q.between(v3.norm(v3.sub(tl, hd)), v3.norm(v3.sub(target, hd)));
          const pr = j.b.parent ? decompose(ps.P.get(j.b.parent)).r : [0, 0, 0, 1];
          pose.set(j.b.id, q.norm(q.mul(q.mul(q.mul(q.inv(pr), rw), pr), pose.get(j.b.id) || [0, 0, 0, 1])));
          ids = [j.b.id];
        }
        applyPose(o, pose, ids);
        changed({ tl: false });
      },
      up() { if (!started) { selBone = j.b.id; renderTools(); refreshSheet(); } else changed(); dirty = true; }
    };
  }
  function ringAct(o, px, py) {
    const g = boneRings(o, lastEval); if (!g) return null;
    const r = g.rings.find(rr => nearPoly(rr.pts, px, py, 11 * dpr)); if (!r) return null;
    before();
    const b = o.bones.find(x => x.id === selBone), Wm = worldOf(o);
    const eObj = v3.norm(m4.dir(m4.inv(Wm), r.e));
    const pose0 = curPose(o), ps = S.poseBones(o.bones, pose0);
    const pr = b.parent ? decompose(ps.P.get(b.parent)).r : [0, 0, 0, 1], cur = pose0.get(b.id) || [0, 0, 0, 1];
    const facing = v3.dot(r.e, v3.sub(camObj.eye, g.c)) > 0 ? 1 : -1, a0 = Math.atan2(-(py - g.cs[1]), px - g.cs[0]);
    return {
      type: 'bring', move(x, y) {
        const da = (Math.atan2(-(y - g.cs[1]), x - g.cs[0]) - a0) * facing;
        const ql = q.mul(q.mul(q.inv(pr), q.axisAngle(eObj, da)), pr);
        setChan(o, 'bone:' + b.id, q.norm(q.mul(ql, cur)).map(v => round(v, 5)));
        changed({ tl: false });
      }, up() { changed(); }
    };
  }

  // ---------- small UI helpers ----------
  function tool(icon, label, fn, cls, dis) { const b = h('button', { type: 'button', class: 'tool' + (cls ? ' ' + cls : ''), onclick: fn, title: label }, h('span', { class: 'ti', 'aria-hidden': 'true' }, icon), h('span', { class: 'tlab' }, label)); if (dis) b.disabled = true; return b; }
  const sep = () => h('span', { class: 'tool sep', 'aria-hidden': 'true' });
  const group = (title, ...kids) => h('div', { class: 'grp' }, title ? h('h3', {}, title) : null, ...kids);
  const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
  function stepper(v, step, on, opt) {
    opt = opt || {};
    const i = h('input', { type: 'number', step: String(step), value: String(round(v, 3)), inputmode: 'decimal', 'aria-label': opt.label || '' });
    const fire = nv => { if (opt.min != null) nv = Math.max(opt.min, nv); if (opt.max != null) nv = Math.min(opt.max, nv); i.value = String(round(nv, 3)); on(nv); };
    i.addEventListener('change', () => { const n = parseFloat(i.value); if (isFinite(n)) fire(n); });
    return h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'Less', onclick: () => fire((parseFloat(i.value) || 0) - step) }, '−'), i, h('button', { type: 'button', 'aria-label': 'More', onclick: () => fire((parseFloat(i.value) || 0) + step) }, '+'));
  }
  const PALETTE = ['#D9D4CF', '#F2D0A4', '#E8A87C', '#C8553D', '#8E3B46', '#F6E27F', '#8FB996', '#3E8E7E', '#6FA8DC', '#3D5A80', '#9C89B8', '#E6A1C6', '#FFFFFF', '#7A7A85', '#2B2B33'];
  function colorField(v, on) {
    const wrap = h('div', { class: 'swatches' });
    const paint = cur => { wrap.querySelectorAll('.sw').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === String(cur).toLowerCase())); };
    PALETTE.forEach(c => wrap.append(h('button', { type: 'button', class: 'sw', 'data-c': c, style: 'background:' + c, 'aria-label': c, onclick: () => { on(c); paint(c); cust.value = c; } })));
    const cust = h('input', { type: 'color', class: 'sw-custom', value: v || '#ffffff', 'aria-label': 'Any colour' });
    cust.addEventListener('input', () => { on(cust.value); paint(cust.value); });
    wrap.append(cust); paint(v);
    return wrap;
  }
  function selectInput(opts, v, on) { const s = h('select', {}); opts.forEach(([k, l]) => s.append(h('option', { value: k }, l))); s.value = v; s.addEventListener('change', () => on(s.value)); return s; }
  const chk = (label, on, set) => h('label', { class: 'chk' }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = !!on; c.addEventListener('change', () => set(c.checked)); return c; })(), h('span', {}, label));
  function ask(msg, yes) {
    return new Promise(res => {
      const d = $('dlg'); d.innerHTML = '';
      d.append(h('p', {}, msg), h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => { d.close(); res(false); } }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: () => { d.close(); res(true); } }, yes || 'OK')));
      d.showModal();
    });
  }
  function askText(msg, val) {
    return new Promise(res => {
      const d = $('dlg'); d.innerHTML = '';
      const i = h('input', { type: 'text', value: val || '' });
      d.append(h('p', {}, msg), i, h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:10px' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => { d.close(); res(null); } }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: () => { d.close(); res(i.value.trim()); } }, 'OK')));
      d.showModal(); i.focus(); i.select();
    });
  }

  // ---------- modes and tool rows ----------
  const MODE_HINT = { sculpt: 'One finger sculpts the selected object; two fingers move the view.', objects: 'Tap to select, drag it to move, or use the arrows, rings and outer circle.', rig: 'Tap inside a limb to drop joints; each tap after the first adds a bone.', pose: 'Drag a joint to pose. The rings turn the selected bone.', stage: 'Puppet live with a controller or the on-screen sticks.' };
  function setMode(m) {
    if (mode === 'rig' && m !== 'rig') scene.objects.forEach(o => { if (o.rigDirty && o.bones.length) bind(o, true); });
    if (mode === 'stage' && m !== 'stage') exitStage();
    if (shapeEdit && m !== 'sculpt') finishShape();
    mode = m; rigChain = null;
    document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    $('sliders').hidden = m !== 'sculpt';
    $('subBtn').hidden = m !== 'sculpt';
    if (m === 'stage') enterStage();
    renderTools(); closeSheet(); banner(); dirty = true;
    toast(MODE_HINT[m], 2200);
  }
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  function banner() {
    const b = $('banner'), o = selObj();
    b.innerHTML = '';
    if (shapeEdit) { const mo = objById(shapeEdit.id).morphs.find(x => x.id === shapeEdit.mid); b.append(h('span', {}, 'Sculpting the shape “' + (mo ? mo.name : '') + '”'), h('button', { type: 'button', class: 'btn primary', onclick: finishShape }, 'Done')); b.hidden = false; return; }
    if (mode === 'rig' && o && o.rigDirty && o.bones.length) { b.append(h('span', {}, 'Bones changed'), h('button', { type: 'button', class: 'btn primary', onclick: () => { bind(o); banner(); } }, 'Bind')); b.hidden = false; return; }
    b.hidden = true;
  }
  function renderTools() {
    const bar = $('tools'); bar.innerHTML = '';
    const o = selObj();
    if (mode === 'sculpt') {
      for (const [k, B] of Object.entries(SC.BRUSHES)) bar.append(tool(B.icon, B.label, () => { brush.tool = k; store.set('clayframe.brush', brush); renderTools(); toast(B.hint, 1600); if (k === 'paint') openSheet('paint'); }, brush.tool === k ? 'active' : ''));
      bar.append(sep(),
        tool('⊞', 'Subdivide', () => subdivide(o), '', !o),
        tool('≋', 'Smooth all', () => { if (!o) return; pushUndo(snapMesh(o.id)); const m = MESH.get(o.id).m; SC.smoothAll(m, 2); MESHLIB.normals(m); m.ver++; changed({ tl: false }); }, '', !o),
        tool('◑', 'Invert mask', () => maskOp(o, 'invert'), '', !o),
        tool('○', 'Clear mask', () => maskOp(o, 'clear'), '', !o),
        tool('☺', 'Shapes', () => openSheet('shapes'), '', !o),
        tool('◉', 'Look', () => openSheet('look'), '', !o));
    } else if (mode === 'objects') {
      bar.append(tool('＋', 'Add', () => openSheet('add')),
        tool('◉', 'Look', () => openSheet('look'), '', !o),
        tool('⤧', 'Transform', () => openSheet('xform'), '', !o),
        tool('☺', 'Shapes', () => openSheet('shapes'), '', !o),
        tool('⛓', 'Parent', () => openSheet('parent'), '', !o),
        tool('⧉', 'Copy', () => dupObj(o), '', !o),
        tool(o && o.visible === false ? '◌' : '◉', o && o.visible === false ? 'Show' : 'Hide', () => { before(); o.visible = o.visible === false; changed(); renderTools(); }, '', !o),
        tool('🗑', 'Delete', () => delObj(o), '', !o),
        sep(),
        tool('⌂', 'Scene', () => openSheet('scene')));
    } else if (mode === 'rig') {
      bar.append(tool('＋', 'New chain', () => { selBone = null; rigChain = null; toast('Tap inside the mesh where the chain starts'); renderTools(); dirty = true; }, !selBone && !rigChain ? 'active' : '', !o),
        tool('⚭', 'Bind', () => { bind(o); banner(); }, '', !o || !o.bones.length),
        tool('✎', 'Bones', () => openSheet('bones'), '', !o || !o.bones.length),
        tool('✕', 'Delete bone', () => delBone(o), '', !selBone),
        tool('🗑', 'Clear rig', async () => { if (!o || !o.bones.length) return; if (!await ask('Remove every bone from ' + o.name + '?', 'Remove')) return; before(); o.bones = []; for (const k of Object.keys(o.keys)) if (k.startsWith('bone:')) delete o.keys[k]; MESH.get(o.id).skin = null; selBone = null; rigChain = null; changed(); renderTools(); }, '', !o || !o.bones.length));
    } else if (mode === 'pose') {
      bar.append(tool('⤳', ik.on ? 'IK on' : 'IK off', () => { ik.on = !ik.on; store.set('clayframe.ik', ik); renderTools(); toast(ik.on ? 'IK: dragging a joint bends the bones above it' : 'Aim: dragging a joint turns just that bone'); }, ik.on ? 'active' : ''),
        tool('−', 'Chain ' + ik.len, () => { ik.len = Math.max(1, ik.len - 1); store.set('clayframe.ik', ik); renderTools(); }),
        tool('+', 'Longer', () => { ik.len = Math.min(8, ik.len + 1); store.set('clayframe.ik', ik); renderTools(); }),
        tool('↺', 'Reset bone', () => { if (!o || !selBone) return; before(); setChan(o, 'bone:' + selBone, [0, 0, 0, 1]); changed(); }, '', !selBone),
        tool('⟲', 'Reset pose', () => { if (!o) return; before(); o.bones.forEach(b => setChan(o, 'bone:' + b.id, [0, 0, 0, 1])); changed(); }, '', !o || !o.bones.length),
        tool('✎', 'Bones', () => openSheet('bones'), '', !o || !o.bones.length),
        tool('☺', 'Shapes', () => openSheet('shapes'), '', !o));
    }
    updKeyBtn(); banner();
  }
  function subdivide(o) {
    if (!o) return;
    const M = MESH.get(o.id), n = M.m.idx.length / 3;
    if (n * 4 > 600000) { toast('That would be over 600,000 triangles, more than a phone handles smoothly'); return; }
    pushUndo(snapMesh(o.id));
    const ids = Object.keys(M.morphs);
    const r = MESHLIB.subdivide(M.m, ids.map(id => M.morphs[id]));
    const morphs = {}; ids.forEach((id, i) => { morphs[id] = r.extras[i]; });
    delete r.extras;
    M.m = r; M.morphs = morphs;
    if (shapeEdit && shapeEdit.id === o.id) shapeEdit.base = null;
    if (M.skin && o.bones.length) bind(o, true);
    R.drop(o.id);
    changed({ tl: false });
    toast((r.idx.length / 3).toLocaleString() + ' triangles');
  }
  function maskOp(o, k) {
    if (!o) return;
    pushUndo(snapMesh(o.id));
    const m = MESH.get(o.id).m;
    for (let i = 0; i < m.mask.length; i++) m.mask[i] = k === 'clear' ? 0 : 1 - m.mask[i];
    m.cver = (m.cver || 0) + 1; changed({ tl: false });
  }
  function dupObj(o) {
    if (!o) return;
    before();
    const fam = [o, ...descendants(o)], ids = new Map(fam.map(x => [x.id, uid()]));
    for (const x of fam) {
      const c = JSON.parse(JSON.stringify(x)); c.id = ids.get(x.id); if (ids.has(c.parent)) c.parent = ids.get(c.parent);
      const M = MESH.get(x.id);
      if (M) { const mm = MESHLIB.clone(M.m); MESH.set(c.id, { m: mm, morphs: Object.fromEntries(Object.entries(M.morphs).map(([k, v]) => [k, v.slice()])), skin: M.skin ? { bi: M.skin.bi.slice(), bw: M.skin.bw.slice(), bones: M.skin.bones.slice() } : null }); }
      if (x === o) { c.name = x.name + ' copy'; c.pos = v3.add(c.pos, [0.6, 0, 0]); if (c.keys.pos) c.keys.pos.forEach(k => { k.v = v3.add(k.v, [0.6, 0, 0]); }); }
      scene.objects.push(c);
    }
    sel = ids.get(o.id); changed(); renderTools(); renderTimeline();
  }
  async function delObj(o) {
    if (!o) return;
    before();
    const gone = [o, ...descendants(o)];
    scene.objects = scene.objects.filter(x => !gone.includes(x));
    gone.forEach(x => { MESH.delete(x.id); R.drop(x.id); });
    sel = null; changed(); renderTools(); renderTimeline(); closeSheet();
    toast('Deleted. Undo with ↶');
  }
  function delBone(o) {
    if (!o || !selBone) return;
    before();
    const kill = new Set([selBone]);
    let grew = true; while (grew) { grew = false; o.bones.forEach(b => { if (b.parent && kill.has(b.parent) && !kill.has(b.id)) { kill.add(b.id); grew = true; } }); }
    o.bones.forEach(b => { if (kill.has(b.mirror)) delete b.mirror; });
    o.bones = o.bones.filter(b => !kill.has(b.id));
    for (const id of kill) delete o.keys['bone:' + id];
    scene.objects.forEach(c => { if (c.parent === o.id && kill.has(c.parentBone)) c.parentBone = null; });
    selBone = null; rigChain = null; o.rigDirty = true;
    changed(); renderTools();
  }

  // ---------- shape keys ----------
  function startShape(o, mid) {
    const M = MESH.get(o.id);
    if (shapeEdit) finishShape();
    if (mode !== 'sculpt') setMode('sculpt');
    pushUndo(snapMesh(o.id));
    const base = M.m.pos.slice(), d = M.morphs[mid];
    if (d) for (let i = 0; i < base.length; i++) M.m.pos[i] = base[i] + d[i];
    shapeEdit = { id: o.id, mid, base };
    MESHLIB.normals(M.m); M.m.ver++;
    sel = o.id; closeSheet(); banner(); renderTools(); dirty = true;
    toast('Sculpt the change. Tap Done when finished.');
  }
  function finishShape() {
    const se = shapeEdit; if (!se) return;
    shapeEdit = null;
    const M = MESH.get(se.id); if (!M) return;
    if (se.base && se.base.length === M.m.pos.length) {
      const d = new Float32Array(M.m.pos.length);
      for (let i = 0; i < d.length; i++) d[i] = M.m.pos[i] - se.base[i];
      M.morphs[se.mid] = d;
      M.m.pos.set(se.base);
    }
    MESHLIB.normals(M.m); M.m.ver++;
    banner(); changed(); dirty = true;
    toast('Shape saved. Set its amount (and keyframe it) in Shapes.');
  }

  // ---------- panels ----------
  let sheetKind = null;
  function openSheet(k) { sheetKind = k; $('sheet').hidden = false; document.body.classList.add('docked'); renderSheet(); resize(); }
  function closeSheet() { sheetKind = null; $('sheet').hidden = true; document.body.classList.remove('docked'); resize(); }
  $('sheetClose').addEventListener('click', closeSheet);
  function refreshSheet() { if (sheetKind) renderSheet(); }
  function renderSheet() {
    const body = $('sheetBody'), title = $('sheetTitle'), o = selObj(), k = sheetKind;
    body.innerHTML = '';
    const need = () => { body.append(h('p', { class: 'muted' }, 'Select an object first.')); };
    if (k === 'add') { title.textContent = 'Add'; addSheet(body); }
    else if (k === 'scene') { title.textContent = 'Scene'; sceneSheet(body); }
    else if (k === 'paint') { title.textContent = 'Paint colour'; body.append(colorField(brush.color, v => { brush.color = v; store.set('clayframe.brush', brush); }), h('p', { class: 'muted small' }, 'Strength sets how much colour each dab lays down. Mask protects areas.')); }
    else if (k === 'ease') { title.textContent = 'Keyframe easing'; easeSheet(body); }
    else if (k === 'stagemap') { title.textContent = 'Controls'; stageMapSheet(body); }
    else if (!o) { title.textContent = ''; need(); }
    else if (k === 'look') { title.textContent = 'Look'; lookSheet(body, o); }
    else if (k === 'xform') { title.textContent = 'Transform'; xformSheet(body, o); }
    else if (k === 'shapes') { title.textContent = 'Shapes'; shapesSheet(body, o); }
    else if (k === 'parent') { title.textContent = 'Parent'; parentSheet(body, o); }
    else if (k === 'bones') { title.textContent = 'Bones'; bonesSheet(body, o); }
  }
  function addSheet(body) {
    const g = h('div', { class: 'grid4' });
    const ICON = { sphere: '●', cube: '■', cylinder: '▮', capsule: '⬮', cone: '▲', torus: '◎', plane: '▬' };
    for (const [k, p] of Object.entries(MESHLIB.PRIMS)) g.append(h('button', { type: 'button', class: 'tile', onclick: () => addPrim(k) }, h('span', { class: 'ic' }, ICON[k] || '●'), p.label));
    g.append(h('button', { type: 'button', class: 'tile', onclick: importOBJ }, h('span', { class: 'ic' }, '⤒'), 'OBJ file…'));
    body.append(g, h('p', { class: 'muted small' }, 'New shapes start at the middle of the floor. Shapes made of smaller triangles sculpt more finely; Subdivide adds more.'));
  }
  function lookSheet(body, o) {
    const set = (k, v) => { before(); o[k] = v; changed(); };
    body.append(field('Colour', colorField(getChan(o, 'color'), v => { before(); setChan(o, 'color', v); changed(); })));
    const g = h('div', { class: 'grid4' });
    for (const [k, mc] of Object.entries(RND.MATCAPS)) { const c = RND.matcapPreview(k, 48); g.append(h('button', { type: 'button', class: 'tile' + (o.matcap === k ? ' on' : ''), onclick: () => { set('matcap', k); refreshSheet(); } }, c, mc.label)); }
    body.append(field('Material', g));
    body.append(chk('Flat shading (low-poly look)', o.flat, v => set('flat', v)));
    body.append(h('p', { class: 'muted small' }, 'Colour can be keyframed: turn on ● auto-key (or press ◇) and pick a new colour at another time.'));
  }
  function vecRow(label, v, step, on) {
    const ins = v.map((x, i) => { const inp = h('input', { type: 'number', step: String(step), value: String(round(x, 3)), 'aria-label': label + ' ' + 'xyz'[i] }); inp.addEventListener('change', () => { const nv = ins.map(e => parseFloat(e.value) || 0); on(nv); }); return inp; });
    return field(label, h('div', { class: 'vec' }, ...ins.map((e, i) => h('label', {}, e, 'XYZ'[i]))));
  }
  function xformSheet(body, o) {
    const mk = (ch, label, step) => h('div', { class: 'row', style: 'align-items:flex-end;flex-wrap:nowrap' }, h('div', { style: 'flex:1' }, vecRow(label, getChan(o, ch), step, v => { before(); setChan(o, ch, v); changed(); })), keyToggle(o, ch));
    body.append(field('Name', (() => { const i = h('input', { type: 'text', value: o.name }); i.addEventListener('change', () => { before(); o.name = i.value.trim() || o.name; changed(); renderTimeline(); fillProjects(); }); return i; })()));
    body.append(mk('pos', 'Position', 0.1), mk('rot', 'Rotation (°)', 15), mk('scl', 'Size', 0.1));
    body.append(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => { before(); setChan(o, 'rot', [0, 0, 0]); changed(); refreshSheet(); } }, 'Reset turn'),
      h('button', { type: 'button', class: 'btn', onclick: () => { before(); setChan(o, 'scl', [1, 1, 1]); changed(); refreshSheet(); } }, 'Reset size'),
      h('button', { type: 'button', class: 'btn', onclick: () => dropToFloor(o) }, 'Drop to floor')));
  }
  function keyToggle(o, ch) {
    const k = o.keys[ch] || [], here = k.some(x => Math.abs(x.t - time) < 1e-3);
    return h('button', { type: 'button', class: 'keybtn' + (here ? ' on' : k.length ? ' some' : ''), title: 'Keyframe here', onclick: () => {
      before();
      if (here) { o.keys[ch] = k.filter(x => Math.abs(x.t - time) >= 1e-3); if (!o.keys[ch].length) delete o.keys[ch]; }
      else S.setKey(o.keys, ch, round(time, 3), getChan(o, ch));
      changed(); renderTimeline(); refreshSheet();
    } }, here ? '◆' : '◇');
  }
  function dropToFloor(o) {
    const M = MESH.get(o.id); if (!M) return;
    const Wm = worldOf(o), p = M.m.pos;
    let lo = Infinity; for (let i = 0; i < p.length; i += 3) lo = Math.min(lo, m4.point(Wm, [p[i], p[i + 1], p[i + 2]])[1]);
    before(); const P = getChan(o, 'pos'); setChan(o, 'pos', [P[0], round(P[1] - lo, 4), P[2]]); changed(); refreshSheet();
  }
  function shapesSheet(body, o) {
    const M = MESH.get(o.id);
    if (!M) { body.append(h('p', { class: 'muted' }, 'Only sculpted objects have shapes.')); return; }
    body.append(h('p', { class: 'muted small' }, 'A shape is a sculpted change you can dial in and out: a smile, a blink, a squash. Sculpt it once, then set or keyframe how much of it shows.' + (mode === 'sculpt' ? ' (Amounts show outside Sculpt mode.)' : '')));
    const list = h('div', { class: 'list' });
    for (const mo of o.morphs) {
      const name = h('input', { type: 'text', value: mo.name, 'aria-label': 'Shape name' });
      name.addEventListener('change', () => { before(); mo.name = name.value.trim() || mo.name; changed(); });
      list.append(h('div', { class: 'li' + (shapeEdit && shapeEdit.mid === mo.id ? ' on' : '') }, h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:6px;min-width:0' }, name,
        h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(getChan(o, 'morph:' + mo.id)), style: 'flex:1;accent-color:var(--accent)', 'aria-label': mo.name + ' amount', oninput: e => { setChan(o, 'morph:' + mo.id, +e.target.value); changed({ tl: false }); }, onchange: () => { renderTimeline(); refreshSheet(); } }), keyToggle(o, 'morph:' + mo.id))),
        h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, h('button', { type: 'button', class: 'btn', onclick: () => startShape(o, mo.id) }, 'Sculpt'),
          h('button', { type: 'button', class: 'btn quiet danger', onclick: () => { before(); o.morphs = o.morphs.filter(x => x !== mo); delete M.morphs[mo.id]; delete o.keys['morph:' + mo.id]; changed(); refreshSheet(); } }, 'Delete'))));
    }
    body.append(list, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => { before(); const mo = { id: uid(), name: 'Shape ' + (o.morphs.length + 1), w: 0 }; o.morphs.push(mo); M.morphs[mo.id] = new Float32Array(M.m.pos.length); startShape(o, mo.id); } }, '＋ New shape')));
  }
  function parentSheet(body, o) {
    const desc = new Set(descendants(o).map(x => x.id));
    const cands = scene.objects.filter(x => x !== o && !desc.has(x.id));
    body.append(h('p', { class: 'muted small' }, 'A child moves, turns and sizes with its parent. Attach it to one of the parent’s bones and it follows that bone, like a hat on a head.'));
    body.append(field('Parent', selectInput([['', '— none —'], ...cands.map(x => [x.id, x.name])], o.parent || '', v => reparent(o, v || null, null))));
    const par = o.parent && objById(o.parent);
    if (par && par.bones.length) body.append(field('Follow a bone', selectInput([['', '— the whole object —'], ...par.bones.map(b => [b.id, b.name])], o.parentBone || '', v => reparent(o, o.parent, v || null))));
  }
  // keep the object where it is on screen when its parent changes
  function reparent(o, pid, bone) {
    before();
    const Wold = worldOf(o);
    o.parent = pid; o.parentBone = bone;
    const ev = S.evaluate(scene, time, { rest: restMode() }); lastEval = ev;
    const P = parentWorld(o), L = m4.mul(m4.inv(P), Wold), d = decompose(L);
    o.pos = d.t.map(v => round(v, 4)); o.rot = q.toEuler(d.r).map(v => round(v, 2)); o.scl = d.s.map(v => round(v, 4));
    delete o.keys.pos; delete o.keys.rot; delete o.keys.scl;
    changed(); renderTimeline(); refreshSheet();
    if (Object.keys(o.keys).length) toast('Its move, turn and size keyframes were cleared, since they belonged to the old parent');
  }
  function bonesSheet(body, o) {
    const list = h('div', { class: 'list' });
    const depth = b => { let d = 0, p = b; while (p && p.parent && d < 20) { p = o.bones.find(x => x.id === p.parent); d++; } return d; };
    for (const b of S.boneOrder(o.bones)) {
      const name = h('input', { type: 'text', value: b.name, 'aria-label': 'Bone name' });
      name.addEventListener('change', () => { before(); b.name = name.value.trim() || b.name; changed(); renderTimeline(); });
      list.append(h('div', { class: 'li' + (b.id === selBone ? ' on' : ''), style: 'margin-left:' + depth(b) * 12 + 'px' }, h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Select ' + b.name, onclick: () => { selBone = b.id; renderTools(); refreshSheet(); dirty = true; } }, b.id === selBone ? '◉' : '○'), name, mode === 'pose' ? keyToggle(o, 'bone:' + b.id) : null));
    }
    body.append(h('p', { class: 'muted small' }, 'Names help in the timeline and in Stage mode, where a bone called “head” is steered by the right stick.'), list);
  }
  function sceneSheet(body) {
    body.append(field('Name', (() => { const i = h('input', { type: 'text', value: scene.name }); i.addEventListener('change', () => { before(); scene.name = i.value.trim() || scene.name; changed(); saveNow().then(fillProjects); }); return i; })()));
    body.append(h('div', { class: 'two' },
      field('Length (seconds)', stepper(scene.duration, 1, v => { before(); scene.duration = Math.max(1, Math.round(v)); changed(); renderTimeline(); $('dur').textContent = scene.duration; }, { min: 1, max: 600 })),
      field('Video shape', selectInput([['16:9', '16:9 wide'], ['9:16', '9:16 tall'], ['1:1', '1:1 square'], ['4:3', '4:3']], scene.aspect || '16:9', v => { before(); scene.aspect = v; changed(); }))));
    body.append(field('Background', colorField(scene.bg || '#24242A', v => { before(); scene.bg = v; changed(); })));
    body.append(chk('Show the floor grid', scene.grid !== false, v => { scene.grid = v; dirty = true; saveSoon(); }));
    body.append(group('Camera', h('p', { class: 'muted small' }, 'Frame a shot, then tap 🎥◆ to keyframe the camera there. 🎥 on the view plays through those camera keys.'),
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, (scene.camKeys.length || 'No') + ' camera keyframes'), scene.camKeys.length ? h('button', { type: 'button', class: 'btn quiet danger', onclick: () => { before(); scene.camKeys = []; camView = false; changed(); refreshSheet(); renderTimeline(); } }, 'Remove them') : null)));
  }

  // ---------- timeline (fixed playhead in the middle; scroll to scrub) ----------
  let pps = 90, tlScroll = null, ignoreScroll = false, rtT = 0;
  const renderTimelineSoon = () => { clearTimeout(rtT); rtT = setTimeout(renderTimeline, 120); };
  function renderTimeline() {
    const tl = $('timeline');
    tl.classList.toggle('closed', !tlOpen);
    if (!scene) return;
    const prevTop = tlScroll ? tlScroll.scrollTop : 0;
    tl.innerHTML = '';
    const sc = h('div', { class: 'tl-scroll' }), half = Math.max(60, (tl.clientWidth || 360) / 2), D = scene.duration;
    const inner = h('div', { class: 'tl-inner', style: 'width:' + (half * 2 + D * pps) + 'px' });
    const X = t => half + t * pps;
    const ruler = h('div', { class: 'tl-ruler' });
    const step = pps > 140 ? 0.5 : pps > 40 ? 1 : 2;
    for (let t = 0; t <= D + 1e-6; t += step) ruler.append(h('div', { class: 'tl-tick', style: 'left:' + X(t) + 'px' }, Number.isInteger(t) ? t + 's' : ''));
    inner.append(ruler, h('div', { class: 'tl-end', style: 'left:' + X(D) + 'px' }));
    const diamond = (row, ch, t) => h('div', { class: 'tl-key' + (Math.abs(t - time) < 1e-3 ? ' at' : ''), style: 'left:' + X(t) + 'px', 'data-row': row, 'data-ch': ch || '', 'data-t': t });
    const span = (ts) => ts.length > 1 ? h('div', { class: 'tl-span', style: 'left:' + X(ts[0]) + 'px;width:' + (ts[ts.length - 1] - ts[0]) * pps + 'px' }) : null;
    if (scene.camKeys.length) {
      const ts = scene.camKeys.map(k => k.t);
      inner.append(h('div', { class: 'tl-row', 'data-sel': '' }, h('span', { class: 'tl-label' }, '🎥 Camera'), span(ts), ...ts.map(t => diamond('cam', '', t))));
    }
    const depth = o => { let d = 0, p = o; while (p && p.parent && d < 10) { p = objById(p.parent); d++; } return d; };
    for (const o of scene.objects) {
      const ts = S.keyTimes(o);
      inner.append(h('div', { class: 'tl-row' + (o.id === sel ? ' sel' : ''), 'data-sel': o.id }, h('span', { class: 'tl-label', style: 'padding-left:' + (8 + depth(o) * 10) + 'px' }, (o.visible === false ? '◌ ' : '') + o.name), span(ts), ...ts.map(t => diamond(o.id, '', t))));
      if (o.id === sel) for (const [ch, label] of chanList(o)) {
        const k = o.keys[ch]; if (!k || !k.length) continue;
        inner.append(h('div', { class: 'tl-row chan', 'data-sel': o.id }, h('span', { class: 'tl-label' }, label), ...k.map(x => diamond(o.id, ch, x.t))));
      }
    }
    if (!scene.objects.length) inner.append(h('div', { class: 'tl-row' }, h('span', { class: 'tl-label' }, 'Add something in Objects → Add')));
    sc.append(inner);
    tl.append(sc, h('div', { class: 'tl-ph' }));
    tlScroll = sc;
    ignoreScroll = true; sc.scrollLeft = time * pps; sc.scrollTop = prevTop;
    requestAnimationFrame(() => { ignoreScroll = false; });
    sc.addEventListener('scroll', () => { if (ignoreScroll || playing) return; setTime(sc.scrollLeft / pps, true); });
    sc.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); pps = clamp(pps * Math.exp(-e.deltaY * 0.004), 20, 400); renderTimeline(); }, { passive: false });
    sc.addEventListener('click', e => { if (e.target.closest('.tl-key')) return; const r = e.target.closest('.tl-row'); if (r && r.dataset.sel && r.dataset.sel !== sel) selectObj(r.dataset.sel); });
    sc.addEventListener('pointerdown', keyDown);
  }
  // drag a keyframe sideways to retime it; tap one to jump there (tap again for its easing)
  function keyDown(e) {
    const k = e.target.closest('.tl-key'); if (!k) return;
    e.preventDefault();
    const row = k.dataset.row, ch = k.dataset.ch, t0 = +k.dataset.t, x0 = e.clientX;
    let moved = false, snapDone = false;
    const move = ev => {
      const dt = (ev.clientX - x0) / pps;
      if (!moved && Math.abs(ev.clientX - x0) < 6) return;
      if (!snapDone) { before(); snapDone = true; }
      moved = true;
      const nt = round(clamp(Math.round((t0 + dt) * 30) / 30, 0, scene.duration), 3);
      k.dataset.nt = nt;
      k.style.transform = 'translateX(' + (nt - t0) * pps + 'px) rotate(45deg) scale(.78)';
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved) { if (Math.abs(time - t0) < 1e-3) { if (row !== 'cam') selectObj(row); openSheet('ease'); } else setTime(t0); return; }
      const nt = +k.dataset.nt;
      if (row === 'cam') { const c = scene.camKeys.find(x => Math.abs(x.t - t0) < 1e-3); if (c) { scene.camKeys = scene.camKeys.filter(x => x === c || Math.abs(x.t - nt) >= 1e-3); c.t = nt; scene.camKeys.sort((a, b) => a.t - b.t); } }
      else {
        const o = objById(row); if (o) for (const [c2, list] of Object.entries(o.keys)) {
          if (ch && c2 !== ch) continue;
          const kk = list.find(x => Math.abs(x.t - t0) < 1e-3); if (!kk) continue;
          o.keys[c2] = list.filter(x => x === kk || Math.abs(x.t - nt) >= 1e-3); kk.t = nt; o.keys[c2].sort((a, b) => a.t - b.t);
        }
      }
      changed(); renderTimeline();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  const EASES = [['smooth', 'Smooth'], ['linear', 'Linear'], ['easeIn', 'Ease in'], ['easeOut', 'Ease out'], ['backOut', 'Overshoot'], ['spring', 'Spring'], ['bounce', 'Bounce'], ['elastic', 'Elastic'], ['hold', 'Hold']];
  function easeSheet(body) {
    const o = selObj(), t = round(time, 3);
    const targets = [];
    if (o) for (const [, k] of Object.entries(o.keys)) { const x = k.find(y => Math.abs(y.t - t) < 1e-3); if (x) targets.push(x); }
    const ck = scene.camKeys.find(x => Math.abs(x.t - t) < 1e-3); if (ck) targets.push(ck);
    if (!targets.length) { body.append(h('p', { class: 'muted' }, 'No keyframes at the playhead. Move to a ◆ on the timeline, then tap it.')); return; }
    const cur = targets[0].ease || 'smooth';
    body.append(h('p', { class: 'muted small' }, 'How things move into the keyframes at ' + t.toFixed(2) + 's' + (o ? ' (' + o.name + (ck ? ' and the camera' : '') + ')' : '') + '.'));
    body.append(h('div', { class: 'chips' }, EASES.map(([k, l]) => h('button', { type: 'button', class: 'pick' + (cur === k ? ' on' : ''), onclick: () => { before(); targets.forEach(x => { x.ease = k; }); changed(); refreshSheet(); } }, l))));
    body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn danger', onclick: () => {
      before();
      if (o) for (const ch of Object.keys(o.keys)) { o.keys[ch] = o.keys[ch].filter(x => Math.abs(x.t - t) >= 1e-3); if (!o.keys[ch].length) delete o.keys[ch]; }
      if (ck) scene.camKeys = scene.camKeys.filter(x => x !== ck);
      changed(); renderTimeline(); closeSheet();
    } }, 'Delete these keyframes')));
  }

  // ---------- time and playback ----------
  function setTime(t, fromScroll) {
    time = clamp(t, 0, scene.duration);
    $('time').textContent = time.toFixed(2);
    if (!fromScroll && tlScroll) { ignoreScroll = true; tlScroll.scrollLeft = time * pps; requestAnimationFrame(() => { ignoreScroll = false; }); }
    updKeyBtn(); dirty = true;
    if (!playing && (sheetKind === 'xform' || sheetKind === 'shapes' || sheetKind === 'ease') && !(document.activeElement && document.activeElement.closest && document.activeElement.closest('#sheet'))) refreshSheetSoon();
  }
  let rsT = 0; const refreshSheetSoon = () => { clearTimeout(rsT); rsT = setTimeout(refreshSheet, 150); };
  function setPlaying(on) {
    if (on && shapeEdit) finishShape();
    playing = on;
    document.querySelectorAll('.playbtn').forEach(b => { b.textContent = on ? '❚❚' : '▶'; b.setAttribute('aria-label', on ? 'Pause' : 'Play'); });
    if (on) { if (time >= scene.duration - 0.01) time = 0; playT0 = performance.now() - time * 1000; }
    else { renderTimeline(); updKeyBtn(); }
    dirty = true;
  }
  document.querySelectorAll('.playbtn').forEach(b => b.addEventListener('click', () => setPlaying(!playing)));
  let lastFrame = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
    if (stageOn) stageTick(dt);
    if (playing && !exporting) {
      let t = (now - playT0) / 1000;
      if (t >= scene.duration) { if (stageRec) { stopRecord(); t = scene.duration; } else { t = t % scene.duration; playT0 = now - t * 1000; } }
      time = t; $('time').textContent = time.toFixed(2);
      if (tlScroll) { ignoreScroll = true; tlScroll.scrollLeft = time * pps; ignoreScroll = false; }
      dirty = true;
    }
    if (dirty && scene && !exporting) { draw(stageOn ? stageDrawOpt() : {}); dirty = false; }
    requestAnimationFrame(loop);
  }

  // ---------- camera keys ----------
  function camKey() {
    before();
    const t = round(time, 3), v = { target: cam.target.map(x => round(x, 4)), yaw: round(cam.yaw, 4), pitch: round(cam.pitch, 4), dist: round(cam.dist, 4), fov: cam.fov };
    const ex = scene.camKeys.find(x => Math.abs(x.t - t) < 1e-3);
    if (ex) ex.v = v; else { scene.camKeys.push({ t, v }); scene.camKeys.sort((a, b) => a.t - b.t); }
    changed(); renderTimeline();
    toast('Camera keyframed at ' + t.toFixed(2) + 's. 🎥 on the view plays through the camera keys.');
  }
  $('camKey').addEventListener('click', camKey);
  $('camViewBtn').addEventListener('click', () => {
    if (!scene.camKeys.length) { toast('Frame a shot and tap 🎥◆ to keyframe the camera first'); return; }
    camView = !camView; $('camViewBtn').setAttribute('aria-pressed', String(camView)); dirty = true;
  });
  $('frameBtn').addEventListener('click', frameSel);
  $('symBtn').addEventListener('click', () => { brush.sym = !brush.sym; store.set('clayframe.brush', brush); $('symBtn').setAttribute('aria-pressed', String(brush.sym)); toast(brush.sym ? 'Mirroring across X (sculpting and new bones)' : 'Mirroring off'); });
  $('subBtn').addEventListener('click', () => { brush.invert = !brush.invert; $('subBtn').setAttribute('aria-pressed', String(brush.invert)); dirty = true; });
  $('radius').addEventListener('input', e => { brush.radius = +e.target.value; store.set('clayframe.brush', brush); hover = hover || [W / 2, H / 2]; dirty = true; });
  $('strength').addEventListener('input', e => { brush.strength = +e.target.value / 100; store.set('clayframe.brush', brush); dirty = true; });
  $('keyBtn').addEventListener('click', toggleKeyAll);
  $('autoKey').addEventListener('click', () => { autoKey = !autoKey; $('autoKey').setAttribute('aria-pressed', String(autoKey)); toast(autoKey ? 'Auto-key on: every move, turn, pose or shape change makes a keyframe at the playhead' : 'Auto-key off'); });
  $('tlToggle').addEventListener('click', () => { tlOpen = !tlOpen; renderTimeline(); resize(); });
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
  window.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input,select,textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === 'k') toggleKeyAll();
    else if (e.key === 'f') frameSel();
    else if (e.key === 'x') { brush.sym = !brush.sym; $('symBtn').setAttribute('aria-pressed', String(brush.sym)); }
    else if (e.key === '[') { brush.radius = Math.max(8, brush.radius - 6); $('radius').value = brush.radius; dirty = true; }
    else if (e.key === ']') { brush.radius = Math.min(200, brush.radius + 6); $('radius').value = brush.radius; dirty = true; }
  });

  // ---------- posed geometry (for OBJ export) ----------
  function posedPositions(o, rec) {
    const M = MESH.get(o.id), base = S.morphed(M.m, M.morphs, rec.morphW) || M.m.pos, out = new Float32Array(base.length);
    const mats = M.skin && rec.bones ? M.skin.bones.map(id => rec.bones.S.get(id) || m4.id()) : null;
    for (let i = 0; i < base.length / 3; i++) {
      let p = [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]];
      if (mats) { let x = 0, y = 0, z = 0; for (let k = 0; k < 4; k++) { const w = M.skin.bw[i * 4 + k]; if (!w) continue; const q2 = m4.point(mats[M.skin.bi[i * 4 + k]] || m4.id(), p); x += q2[0] * w; y += q2[1] * w; z += q2[2] * w; } p = [x, y, z]; }
      p = m4.point(rec.world, p);
      out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
    }
    return out;
  }
  function download(name, blob) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
  const slug = () => (scene.name || 'clayframe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'clayframe';

  // ---------- video export ----------
  let exporting = null;
  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }
  function openExport() {
    const d = $('dlg'); d.innerHTML = '';
    const mime = pickMime();
    const [aw, ah] = String(scene.aspect || '16:9').split(':').map(Number);
    const res = selectInput([['720', '720p'], ['1080', '1080p']], '720', () => {});
    let useCam = !!scene.camKeys.length;
    const out = h('div', {});
    const status = h('p', { class: 'small muted', 'aria-live': 'polite' }, mime === null ? 'This browser can’t record video.' : scene.duration + ' s at 30 fps, ' + aw + ':' + ah + ', ' + (mime.includes('mp4') ? 'MP4' : 'WebM'));
    const go = h('button', { type: 'button', class: 'btn primary', disabled: mime === null, onclick: () => {
      go.disabled = true;
      recordVideo(+res.value, aw / ah, useCam, mime, (p) => { status.textContent = 'Recording… ' + Math.round(p * 100) + '%'; }, (blob, err) => {
        go.disabled = false;
        if (err) { status.textContent = 'Couldn’t record: ' + err; return; }
        const ext = blob.type.includes('mp4') ? 'mp4' : 'webm', url = URL.createObjectURL(blob);
        status.textContent = 'Done. Play it here, or save it.';
        out.innerHTML = ''; out.append(h('video', { src: url, controls: true, playsinline: true }), h('div', { class: 'row', style: 'margin-top:8px' }, h('a', { class: 'btn primary', href: url, download: slug() + '.' + ext }, '⤓ Save video')));
      });
    } }, '● Record video');
    const sel_ = selObj();
    d.append(h('h2', {}, 'Export'),
      h('div', { class: 'two' }, field('Size', res), field('Shape', h('span', { style: 'padding-top:8px' }, aw + ':' + ah + ' (change in Scene)'))),
      scene.camKeys.length ? chk('Film through the camera keyframes', useCam, v => { useCam = v; }) : h('p', { class: 'muted small' }, 'Films from the current view (keyframe the camera with 🎥◆ for moving shots).'),
      status, h('div', { class: 'row' }, go), out,
      h('hr', { style: 'border:0;border-top:1px solid var(--rule);margin:14px 0' }),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', disabled: !sel_ || !MESH.get(sel_ && sel_.id), onclick: () => {
        const o = selObj(), rec = lastEval.get(o.id), P = posedPositions(o, rec), M = MESH.get(o.id);
        download(slug() + '-' + o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.obj', new Blob([MESHLIB.toOBJ(o.name, P, M.m.idx, RND.normalsFor(P, M.m.idx))], { type: 'text/plain' }));
      } }, '⤓ Selected object as OBJ (as posed now)')),
      h('p', { class: 'muted small' }, 'OBJ files open in Blender, Nomad, Procreate and 3D printing apps.'),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => d.close() }, 'Close')));
    d.showModal();
  }
  $('exportBtn').addEventListener('click', openExport);
  function recordVideo(short, ratio, useCam, mime, onProg, onDone) {
    let w = ratio >= 1 ? Math.round(short * ratio) : short, hh = ratio >= 1 ? short : Math.round(short / ratio);
    w += w % 2; hh += hh % 2;
    const keep = { W, H, time, playing, camView };
    if (playing) setPlaying(false);
    exporting = { cam: useCam };
    W = w; H = hh; view.width = w; view.height = hh;
    let rec, chunks = [];
    try { rec = new MediaRecorder(view.captureStream(30), Object.assign({ videoBitsPerSecond: short >= 1080 ? 12e6 : 6e6 }, mime ? { mimeType: mime } : {})); }
    catch (e) { restoreAfter(); onDone(null, e.message); return; }
    function restoreAfter() { exporting = null; W = keep.W; H = keep.H; view.width = W; view.height = H; time = keep.time; dirty = true; resize(); }
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => { restoreAfter(); onDone(new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] })); };
    rec.start(500);
    const t0 = performance.now(), D = scene.duration;
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      time = Math.min(t, D);
      draw({ final: true });
      onProg(time / D);
      if (t < D + 0.15) requestAnimationFrame(step); else rec.stop();
    };
    requestAnimationFrame(step);
  }

  // ---------- Stage: puppet a character live with a game controller or touch sticks, and record it ----------
  let stageOn = false, stageRec = null, stageChar = null, live = null;
  const inp = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, a: 0, b: 0 };
  const touchInp = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, a: 0, b: 0 };
  const INPUTS = [['lx', 'Left stick ↔'], ['ly', 'Left stick ↕'], ['rx', 'Right stick ↔'], ['ry', 'Right stick ↕'], ['lt', 'Left trigger'], ['rt', 'Right trigger'], ['a', 'A button'], ['b', 'B button']];
  function stageTargets(o) {
    const T = [['move.x', 'Walk across'], ['move.z', 'Walk forward'], ['turn', 'Turn around'], ['jump', 'Jump'], ['lift', 'Rise up']];
    for (const b of o.bones) T.push(['bone:' + b.id + ':y', b.name + ': turn'], ['bone:' + b.id + ':x', b.name + ': nod'], ['bone:' + b.id + ':z', b.name + ': tilt']);
    for (const mo of o.morphs) T.push(['morph:' + mo.id, 'Shape: ' + mo.name]);
    return T;
  }
  function defaultMap(o) {
    const head = o.bones.find(b => /head/i.test(b.name)) || o.bones.filter(b => Math.abs(b.tail[0]) < 0.05).sort((a, b) => b.tail[1] - a.tail[1])[0];
    const arm = o.bones.find(b => /arm|hand/i.test(b.name) && b.tail[0] > 0) || o.bones.find(b => b.tail[0] > 0.2);
    const M = [{ in: 'lx', to: 'move.x', amt: 2.2 }, { in: 'ly', to: 'move.z', amt: 2.2 }];
    if (head) M.push({ in: 'rx', to: 'bone:' + head.id + ':y', amt: 55 }, { in: 'ry', to: 'bone:' + head.id + ':x', amt: 30 });
    else M.push({ in: 'rx', to: 'turn', amt: 140 });
    if (o.morphs[0]) M.push({ in: 'rt', to: 'morph:' + o.morphs[0].id, amt: 1 });
    else if (arm) M.push({ in: 'rt', to: 'bone:' + arm.id + ':z', amt: 70 });
    if (o.morphs[1]) M.push({ in: 'lt', to: 'morph:' + o.morphs[1].id, amt: 1 });
    else if (arm && o.morphs[0]) M.push({ in: 'lt', to: 'bone:' + arm.id + ':z', amt: 70 });
    M.push({ in: 'a', to: 'jump', amt: 1 });
    return M;
  }
  const stageCfg = o => (o.stage = o.stage || { map: defaultMap(o), face: true, bob: true, follow: true });
  function enterStage() {
    stageOn = true; document.body.classList.add('staging');
    if (playing) setPlaying(false);
    const o = selObj() && MESH.get(sel) ? selObj() : scene.objects.find(x => x.type === 'mesh' && x.bones.length) || scene.objects.find(x => x.type === 'mesh');
    setStageChar(o ? o.id : null);
    buildStageUI(); resize();
  }
  function exitStage() {
    if (stageRec) stopRecord();
    stageOn = false; live = null; document.body.classList.remove('staging');
    $('stageUI').hidden = true; $('stageUI').innerHTML = ''; resize(); dirty = true;
  }
  function setStageChar(id) {
    stageChar = id;
    const o = id && objById(id);
    live = null;
    if (!o) return;
    sel = id;
    stageCfg(o);
    resetLive(o);
  }
  function resetLive(o) {
    live = { pos: getChan(o, 'pos').slice(), rot: getChan(o, 'rot').slice(), vy: 0, hop: 0, phase: 0, yaw: getChan(o, 'rot')[1], used: new Set() };
  }
  function readPad() {
    let pad = null;
    try { const ps = navigator.getGamepads ? navigator.getGamepads() : []; for (const p of ps) if (p && p.connected) { pad = p; break; } } catch (e) {}
    const dz = v => Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88;
    const g = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, a: 0, b: 0 };
    if (pad) {
      const ax = pad.axes || [], bt = pad.buttons || [], bv = i => bt[i] ? (typeof bt[i] === 'object' ? bt[i].value : bt[i]) : 0;
      g.lx = dz(ax[0] || 0); g.ly = dz(ax[1] || 0); g.rx = dz(ax[2] || 0); g.ry = dz(ax[3] || 0);
      g.lt = bv(6); g.rt = bv(7); g.a = bv(0); g.b = bv(1);
    }
    for (const k in inp) inp[k] = Math.abs(touchInp[k]) > Math.abs(g[k]) ? touchInp[k] : g[k];
    const pi = $('padInfo'); if (pi) pi.textContent = pad ? '🎮 ' + (pad.id || 'Controller').split('(')[0].trim().slice(0, 32) : 'No controller: use the sticks, or connect one and press a button';
  }
  let liveOver = null, livePose = null;
  function stageTick(dt) {
    readPad();
    const o = stageChar && objById(stageChar);
    if (!o || !live) return;
    const cfg = stageCfg(o);
    // base values come from the timeline; the controls add to them
    const baseRot = getChan(o, 'rot'), basePos = getChan(o, 'pos');
    const off = new Map(), morph = {};
    let mv = [0, 0], turn = 0, lift = 0, jump = 0;
    for (const m of cfg.map) {
      const v = inp[m.in] || 0, a = m.amt;
      if (m.to === 'move.x') { mv[0] += v * a; if (v) live.used.add('pos'); }
      else if (m.to === 'move.z') { mv[1] += v * a; if (v) live.used.add('pos'); }
      else if (m.to === 'turn') { turn += v * a; if (v) live.used.add('rot'); }
      else if (m.to === 'jump') { if (v > 0.5) jump = 1; }
      else if (m.to === 'lift') lift += v * a;
      else if (m.to.startsWith('bone:')) { const [, id, axis] = m.to.split(':'); const e = off.get(id) || [0, 0, 0]; e['xyz'.indexOf(axis)] += v * a; off.set(id, e); if (v) live.used.add('bone:' + id); }
      else if (m.to.startsWith('morph:')) { const id = m.to.slice(6); morph[id] = clamp((morph[id] || 0) + v * a, 0, 1); if (v) live.used.add('morph:' + id); }
    }
    // walk relative to the camera
    const fw = v3.norm([Math.sin(cam.yaw) * -1, 0, Math.cos(cam.yaw) * -1]), rt = [-fw[2], 0, fw[0]];
    const vel = v3.add(v3.scale(rt, mv[0]), v3.scale(fw, -mv[1]));
    const sp = Math.hypot(vel[0], vel[2]);
    if (!live.used.has('pos')) { live.pos = basePos.slice(); }
    live.pos[0] += vel[0] * dt; live.pos[2] += vel[2] * dt;
    if (jump && live.hop <= 0 && live.vy === 0) { live.vy = 4.2; live.used.add('pos'); }
    if (live.vy !== 0 || live.hop > 0) { live.hop += live.vy * dt; live.vy -= 12 * dt; if (live.hop <= 0) { live.hop = 0; live.vy = 0; } }
    live.phase += sp * dt * 3.2;
    const bob = cfg.bob && sp > 0.05 ? Math.abs(Math.sin(live.phase)) * 0.09 : 0;
    let yaw = live.used.has('rot') ? live.yaw : baseRot[1];
    yaw += turn * dt;
    if (cfg.face && sp > 0.15) { const want = Math.atan2(vel[0], vel[2]) * 180 / Math.PI; let d = ((want - yaw + 540) % 360) - 180; yaw += d * Math.min(1, dt * 10); live.used.add('rot'); }
    live.yaw = yaw;
    const pos = [live.pos[0], (live.used.has('pos') ? live.pos[1] : basePos[1]) + live.hop + bob + lift, live.pos[2]];
    const rot = [baseRot[0], yaw, baseRot[2]];
    liveOver = { id: o.id, pos: live.used.has('pos') || live.hop || bob || lift ? pos : null, rot: live.used.has('rot') ? rot : null, morph };
    // bone offsets on top of the keyframed pose
    const pose = new Map();
    const rec = lastEval && lastEval.get(o.id);
    for (const b of o.bones) {
      const base = S.keyVal(o.keys, 'bone:' + b.id, time, b.rot || [0, 0, 0, 1]);
      const e = off.get(b.id);
      pose.set(b.id, e ? q.norm(q.mul(base, q.fromEuler(e))) : base);
    }
    livePose = { id: o.id, map: pose };
    if (cfg.follow) { const tgt = [pos[0], cam.target[1], pos[2]]; cam.target = v3.lerp(cam.target, tgt, Math.min(1, dt * 3)); }
    if (stageRec) sample(o, liveOver, pose, morph);
    dirty = true;
  }
  const stageDrawOpt = () => ({ over: liveOver, pose: livePose });
  // recording: sample every frame, then write keyframes (thinned out) for whatever the controls moved
  function startRecord() {
    const o = stageChar && objById(stageChar); if (!o) return;
    if (time >= scene.duration - 0.05) setTime(0);
    stageRec = { o, t0: time, frames: [] };
    live.used = new Set();
    setPlaying(true); buildStageUI();
  }
  function sample(o, ov, pose, morph) {
    const f = { t: round(time, 3) };
    f.pos = ov.pos ? ov.pos.slice() : getChan(o, 'pos');
    f.rot = ov.rot ? ov.rot.slice() : getChan(o, 'rot');
    f.bones = {}; for (const [id, qq] of pose) f.bones[id] = qq.slice();
    f.morph = {}; for (const mo of o.morphs) f.morph[mo.id] = morph[mo.id] != null ? morph[mo.id] : getChan(o, 'morph:' + mo.id);
    const fr = stageRec.frames; if (!fr.length || f.t > fr[fr.length - 1].t + 1 / 40) fr.push(f);
  }
  function thin(keys, tol) {
    if (keys.length < 3) return keys;
    const dist = (a, b) => typeof a === 'number' ? Math.abs(a - b) : a.reduce((s, x, i) => Math.max(s, Math.abs(x - b[i])), 0);
    const out = [keys[0]];
    for (let i = 1; i < keys.length - 1; i++) {
      const a = out[out.length - 1], c = keys[i + 1], u = (keys[i].t - a.t) / (c.t - a.t || 1);
      const guess = typeof a.v === 'number' ? a.v + (c.v - a.v) * u : a.v.length === 4 ? q.slerp(a.v, c.v, u) : a.v.map((x, j) => x + (c.v[j] - x) * u);
      if (dist(guess, keys[i].v) > tol) out.push(keys[i]);
    }
    out.push(keys[keys.length - 1]);
    return out;
  }
  function stopRecord() {
    const R0 = stageRec; stageRec = null;
    if (playing) setPlaying(false);
    if (!R0 || R0.frames.length < 2) { buildStageUI(); return; }
    pushUndo(snapScene());
    const o = R0.o, fr = R0.frames, t0 = fr[0].t, t1 = fr[fr.length - 1].t;
    const write = (ch, get, tol) => {
      const ks = thin(fr.map(f => ({ t: f.t, v: get(f), ease: 'linear' })), tol);
      const keep = (o.keys[ch] || []).filter(k => k.t < t0 - 1e-3 || k.t > t1 + 1e-3);
      o.keys[ch] = keep.concat(ks).sort((a, b) => a.t - b.t);
    };
    const used = live ? live.used : new Set();
    let n = 0;
    if (used.has('pos')) { write('pos', f => f.pos.map(v => round(v, 4)), 0.01); n++; }
    if (used.has('rot')) { write('rot', f => f.rot.map(v => round(v, 2)), 1); n++; }
    for (const b of o.bones) if (used.has('bone:' + b.id)) { write('bone:' + b.id, f => f.bones[b.id].map(v => round(v, 5)), 0.01); n++; }
    for (const mo of o.morphs) if (used.has('morph:' + mo.id)) { write('morph:' + mo.id, f => round(f.morph[mo.id], 3), 0.02); n++; }
    changed(); renderTimeline(); resetLive(o); buildStageUI();
    toast(n ? 'Recorded ' + (t1 - t0).toFixed(1) + 's into ' + n + ' tracks of ' + o.name + '. Undo with ↶ to try again.' : 'Nothing moved, so nothing was recorded');
  }
  function buildStageUI() {
    const ui = $('stageUI'); ui.hidden = false; ui.innerHTML = '';
    const chars = scene.objects.filter(o => o.type === 'mesh');
    const charSel = selectInput(chars.map(o => [o.id, o.name]), stageChar || '', v => { setStageChar(v); buildStageUI(); });
    const status = h('span', { class: 'st-status' + (stageRec ? ' rec' : '') }, stageRec ? '● REC ' + time.toFixed(1) + 's' : time.toFixed(1) + 's');
    ui.append(h('div', { class: 'st-top' },
      h('button', { type: 'button', class: 'btn', onclick: () => setMode('objects') }, '✕ Exit'),
      charSel,
      stageRec ? h('button', { type: 'button', class: 'btn rec', onclick: stopRecord }, '■ Stop') : h('button', { type: 'button', class: 'btn rec', onclick: startRecord }, '● Record'),
      h('button', { type: 'button', class: 'btn', onclick: () => { if (stageRec) return; setPlaying(!playing); buildStageUI(); } }, playing && !stageRec ? '❚❚ Pause' : '▶ Rehearse'),
      h('button', { type: 'button', class: 'btn', onclick: () => { const o = objById(stageChar); if (o) { resetLive(o); dirty = true; } } }, '⟲ Reset'),
      h('button', { type: 'button', class: 'btn', onclick: () => openSheet('stagemap') }, '⚙ Controls'),
      status));
    const joy = (side, kx, ky, label) => {
      const knob = h('div', { class: 'knob' }), el = h('div', { class: 'joy ' + side, 'aria-label': label }, h('span', { class: 'jl' }, label), knob);
      let id = null;
      const set = e => { const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, R0 = r.width / 2; let dx = (e.clientX - cx) / R0, dy = (e.clientY - cy) / R0; const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; } touchInp[kx] = dx; touchInp[ky] = dy; knob.style.transform = 'translate(' + dx * R0 * 0.6 + 'px,' + dy * R0 * 0.6 + 'px)'; };
      el.addEventListener('pointerdown', e => { id = e.pointerId; el.setPointerCapture(id); set(e); });
      el.addEventListener('pointermove', e => { if (e.pointerId === id) set(e); });
      const end = e => { if (e.pointerId !== id) return; id = null; touchInp[kx] = 0; touchInp[ky] = 0; knob.style.transform = ''; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      return el;
    };
    const trig = (side, k, label) => {
      const fill = h('div', { class: 'fill' }), el = h('div', { class: 'trig ' + side, 'aria-label': label }, h('span', { class: 'jl' }, label), fill);
      let id = null;
      const set = e => { const r = el.getBoundingClientRect(); const v = clamp((r.bottom - e.clientY) / r.height, 0, 1); touchInp[k] = v; fill.style.height = v * 100 + '%'; };
      el.addEventListener('pointerdown', e => { id = e.pointerId; el.setPointerCapture(id); set(e); });
      el.addEventListener('pointermove', e => { if (e.pointerId === id) set(e); });
      const end = e => { if (e.pointerId !== id) return; id = null; touchInp[k] = 0; fill.style.height = '0'; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      return el;
    };
    const btnA = h('button', { type: 'button', class: 'stbtn a', 'aria-label': 'A button' }, 'A');
    btnA.addEventListener('pointerdown', () => { touchInp.a = 1; btnA.classList.add('on'); });
    const offA = () => { touchInp.a = 0; btnA.classList.remove('on'); };
    btnA.addEventListener('pointerup', offA); btnA.addEventListener('pointercancel', offA); btnA.addEventListener('pointerleave', offA);
    ui.append(joy('l', 'lx', 'ly', 'Move'), joy('r', 'rx', 'ry', 'Look'), trig('l', 'lt', 'LT'), trig('r', 'rt', 'RT'), btnA, h('div', { class: 'padinfo', id: 'padInfo' }, ''));
    if (!stageChar) ui.append(h('div', { class: 'banner' }, 'Add a character first'));
  }
  setInterval(() => { if (stageOn) { const s = document.querySelector('.st-status'); if (s) s.textContent = (stageRec ? '● REC ' : '') + time.toFixed(1) + 's'; } }, 200);
  function stageDown() { return false; } function stageMove() { return false; } function stageUp() { return false; }
  function stageMapSheet(body) {
    const o = stageChar && objById(stageChar);
    if (!o) { body.append(h('p', { class: 'muted' }, 'Pick a character first.')); return; }
    const cfg = stageCfg(o), T = stageTargets(o);
    body.append(h('p', { class: 'muted small' }, 'What each stick, trigger and button does to ' + o.name + '. Amount is speed for walking and turning, degrees for bones, and 0–1 for shapes. Works with Xbox, PlayStation and most Bluetooth controllers, and handhelds with built-in sticks.'));
    const list = h('div', { class: 'list' });
    cfg.map.forEach((m, i) => list.append(h('div', { class: 'li', style: 'flex-wrap:wrap' },
      h('div', { style: 'flex:1 1 120px' }, selectInput(INPUTS, m.in, v => { m.in = v; saveSoon(); })),
      h('div', { style: 'flex:1 1 150px' }, selectInput(T, m.to, v => { m.to = v; saveSoon(); })),
      h('div', { style: 'flex:0 0 150px' }, stepper(m.amt, m.to.startsWith('morph') ? 0.1 : m.to.startsWith('move') ? 0.5 : 10, v => { m.amt = v; saveSoon(); })),
      h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Remove', onclick: () => { cfg.map.splice(i, 1); saveSoon(); refreshSheet(); } }, '✕'))));
    body.append(list, h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => { cfg.map.push({ in: 'b', to: T[0][0], amt: 1 }); saveSoon(); refreshSheet(); } }, '＋ Add a control'),
      h('button', { type: 'button', class: 'btn quiet', onclick: () => { cfg.map = defaultMap(o); saveSoon(); refreshSheet(); } }, 'Reset to suggested')));
    body.append(chk('Face the way it walks', cfg.face, v => { cfg.face = v; saveSoon(); }), chk('Bob while walking', cfg.bob, v => { cfg.bob = v; saveSoon(); }), chk('Camera follows', cfg.follow, v => { cfg.follow = v; saveSoon(); }));
    body.append(h('p', { class: 'muted small' }, 'Record plays the timeline from the playhead, so other characters’ animation plays along and you can layer takes. Only the things you moved are recorded.'));
  }

  // ---------- projects, backups, import ----------
  const b64 = a => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s, T) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new T(u.buffer); };
  function backupBlob() {
    const meshes = {};
    for (const [id, M] of MESH) meshes[id] = { pos: b64(M.m.pos), idx: b64(M.m.idx), col: b64(M.m.col), mask: b64(M.m.mask), morphs: Object.fromEntries(Object.entries(M.morphs).map(([k, v]) => [k, b64(v)])), skin: M.skin ? { bi: b64(M.skin.bi), bw: b64(M.skin.bw), bones: M.skin.bones } : null };
    return new Blob([JSON.stringify({ clayframe: 1, scene, meshes })], { type: 'application/json' });
  }
  function fromBackup(j) {
    const meshes = {};
    for (const [id, d] of Object.entries(j.meshes || {})) meshes[id] = { pos: unb64(d.pos, Float32Array), idx: unb64(d.idx, Uint32Array), col: unb64(d.col, Float32Array), mask: unb64(d.mask, Float32Array), morphs: Object.fromEntries(Object.entries(d.morphs || {}).map(([k, v]) => [k, unb64(v, Float32Array)])), skin: d.skin ? { bi: unb64(d.skin.bi, Float32Array), bw: unb64(d.skin.bw, Float32Array), bones: d.skin.bones } : null };
    return meshes;
  }
  function pickFile(accept) { return new Promise(res => { const i = h('input', { type: 'file', accept, style: 'position:fixed;left:-9999px' }); i.addEventListener('change', () => { res(i.files[0] || null); i.remove(); }); document.body.append(i); i.click(); }); }
  async function importOBJ() {
    const f = await pickFile('.obj,text/plain'); if (!f) return;
    try {
      const m = MESHLIB.fromOBJ(await f.text());
      before();
      const b = MESHLIB.bounds(m);
      const o = addMesh(m, { name: f.name.replace(/\.[^.]+$/, '').slice(0, 30) || 'Import', pos: [0, round(-b.min[1] * 1.5, 3), 0], scl: [1.5, 1.5, 1.5] });
      sel = o.id; changed(); renderTools(); renderTimeline(); closeSheet();
      toast('Imported ' + (m.idx.length / 3).toLocaleString() + ' triangles');
    } catch (e) { toast('Couldn’t read that OBJ: ' + e.message); }
  }
  async function newProjectFrom(sc, meshes) {
    if (scene) await saveNow();
    const id = uid();
    openScene(sc, meshes, id);
    saveNow().then(fillProjects);
  }
  function blankScene(name) { return { v: 1, name: name || 'Untitled', duration: 5, fps: 30, aspect: '16:9', bg: '#24242A', objects: [], camKeys: [] }; }
  function openMenu() {
    const d = $('dlg'); d.innerHTML = '';
    const act = (label, fn, cls) => h('button', { type: 'button', class: 'btn ' + (cls || 'quiet'), onclick: () => { d.close(); fn(); } }, label);
    const projs = listMeta();
    d.append(h('h2', {}, 'Projects'), h('div', { class: 'menu' },
      act('＋ New empty project', () => { newProjectFrom(blankScene('Project ' + (projs.length + 1)), {}); setMode('objects'); }),
      act('＋ New copy of the demo character', () => { const dm = demo(); newProjectFrom(dm.scene, dm.meshes); }),
      act('⤓ Save a backup file', () => download(slug() + '.clayframe.json', backupBlob())),
      act('⤒ Open a backup file…', async () => { const f = await pickFile('.json,application/json'); if (!f) return; try { const j = JSON.parse(await f.text()); if (!j.clayframe) throw new Error('that isn’t a Clayframe backup'); newProjectFrom(j.scene, fromBackup(j)); toast('Opened ' + j.scene.name); } catch (e) { toast('Couldn’t open it: ' + e.message); } }),
      act('⌂ Scene settings', () => { if (mode === 'stage') setMode('objects'); openSheet('scene'); }),
      projs.length > 1 ? act('🗑 Delete this project', async () => { if (!await ask('Delete “' + scene.name + '”? This can’t be undone.', 'Delete')) return; const id = projId; try { await db.del(id); } catch (e) {} store.set('clayframe.projects', listMeta().filter(p => p.id !== id)); const next = listMeta()[0]; scene = null; if (!next || !(await loadProject(next.id))) { const dm = demo(); newProjectFrom(dm.scene, dm.meshes); } }, 'quiet danger') : null,
      h('p', { class: 'muted small' }, 'Projects are kept in this browser on this device. Save a backup file to move one to another device.'),
      act('Close', () => {})));
    d.showModal();
  }
  $('menuBtn').addEventListener('click', openMenu);
  $('proj').addEventListener('change', async e => { const id = e.target.value; await saveNow(); if (!(await loadProject(id))) { toast('Couldn’t open that project'); fillProjects(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  // ---------- the demo: a little rigged clay buddy and a ball ----------
  function demo() {
    const sc = blankScene('Clay buddy');
    sc.duration = 6;
    const meshes = {};
    const T = (t, e, s) => m4.trs(t, q.fromEuler(e || [0, 0, 0]), s || [1, 1, 1]);
    const ico = MESHLIB.icosphere(4), cap = MESHLIB.PRIMS.capsule.make();
    const body = MESHLIB.merge([
      { m: ico, mat: T([0, 1.0, 0], [0, 0, 0], [1.05, 1.2, 0.9]) },
      { m: ico, mat: T([0, 1.95, 0.02], [0, 0, 0], [0.86, 0.8, 0.8]) },
      { m: cap, mat: T([0.78, 1.18, 0], [0, 0, 72], [0.62, 1.05, 0.62]) },
      { m: cap, mat: T([-0.78, 1.18, 0], [0, 0, -72], [0.62, 1.05, 0.62]) },
      { m: cap, mat: T([0.26, 0.32, 0], [0, 0, 0], [0.72, 0.9, 0.72]) },
      { m: cap, mat: T([-0.26, 0.32, 0], [0, 0, 0], [0.72, 0.9, 0.72]) }]);
    // a smoothing pass blends the parts a little
    SC.smoothAll(body, 1); MESHLIB.normals(body);
    const o = newObj({ id: 'buddy', name: 'Buddy', color: '#E8A87C', matcap: 'clay' });
    o.bones = [
      { id: 'hips', name: 'Hips', parent: null, head: [0, 0.62, 0], tail: [0, 1.2, 0] },
      { id: 'chest', name: 'Chest', parent: 'hips', head: [0, 1.2, 0], tail: [0, 1.6, 0] },
      { id: 'head', name: 'Head', parent: 'chest', head: [0, 1.6, 0], tail: [0, 2.3, 0] },
      { id: 'armR', name: 'Arm R', parent: 'chest', head: [0.42, 1.36, 0], tail: [0.86, 1.2, 0], mirror: 'armL' },
      { id: 'handR', name: 'Hand R', parent: 'armR', head: [0.86, 1.2, 0], tail: [1.3, 1.04, 0], mirror: 'handL' },
      { id: 'armL', name: 'Arm L', parent: 'chest', head: [-0.42, 1.36, 0], tail: [-0.86, 1.2, 0], mirror: 'armR' },
      { id: 'handL', name: 'Hand L', parent: 'armL', head: [-0.86, 1.2, 0], tail: [-1.3, 1.04, 0], mirror: 'handR' },
      { id: 'legR', name: 'Leg R', parent: 'hips', head: [0.26, 0.62, 0], tail: [0.26, -0.05, 0], mirror: 'legL' },
      { id: 'legL', name: 'Leg L', parent: 'hips', head: [-0.26, 0.62, 0], tail: [-0.26, -0.05, 0], mirror: 'legR' }];
    o.bones.forEach(b => { b.rot = [0, 0, 0, 1]; });
    // shapes: a big surprised head, and a squash
    const n = body.pos.length;
    const big = new Float32Array(n), squash = new Float32Array(n);
    for (let i = 0; i < n; i += 3) {
      const x = body.pos[i], y = body.pos[i + 1], z = body.pos[i + 2];
      if (y > 1.55) { const k = Math.min(1, (y - 1.55) / 0.2); big[i] = x * 0.28 * k; big[i + 1] = (y - 1.95) * 0.28 * k; big[i + 2] = (z - 0.02) * 0.28 * k; }
      squash[i] = x * 0.22; squash[i + 1] = -y * 0.18; squash[i + 2] = z * 0.22;
    }
    o.morphs = [{ id: 'big', name: 'Surprise', w: 0 }, { id: 'squash', name: 'Squash', w: 0 }];
    meshes.buddy = { pos: body.pos, idx: body.idx, col: body.col, mask: body.mask, morphs: { big, squash }, skin: S.autoWeights(body, o.bones) };
    const E = e => q.norm(q.fromEuler(e)).map(v => round(v, 5));
    o.keys = {
      'bone:armR': [{ t: 0, v: E([0, 0, 0]) }, { t: 0.8, v: E([0, 0, 62]) }, { t: 3.6, v: E([0, 0, 62]) }, { t: 4.4, v: E([0, 0, 0]) }],
      'bone:handR': [{ t: 0.8, v: E([0, 0, 20]) }, { t: 1.3, v: E([0, 0, 55]) }, { t: 1.8, v: E([0, 0, 15]) }, { t: 2.3, v: E([0, 0, 55]) }, { t: 2.8, v: E([0, 0, 15]) }, { t: 3.3, v: E([0, 0, 50]) }, { t: 4.4, v: E([0, 0, 0]) }],
      'bone:head': [{ t: 0, v: E([0, 0, 0]) }, { t: 1.2, v: E([0, 0, -12]) }, { t: 2.6, v: E([8, 25, -6]) }, { t: 4.6, v: E([0, 0, 0]) }],
      'bone:chest': [{ t: 0, v: E([0, 0, 0]) }, { t: 1.5, v: E([0, 0, 5]) }, { t: 3, v: E([0, 0, -4]) }, { t: 4.5, v: E([0, 0, 0]) }],
      'morph:big': [{ t: 4.4, v: 0 }, { t: 4.8, v: 1, ease: 'backOut' }, { t: 5.5, v: 1 }, { t: 6, v: 0 }],
      'morph:squash': [{ t: 0, v: 0 }, { t: 0.25, v: 0.6 }, { t: 0.6, v: 0, ease: 'spring' }]
    };
    sc.objects.push(o);
    // eyes ride on the head bone
    const eye = MESHLIB.icosphere(3);
    for (const [id, x] of [['eyeR', 0.17], ['eyeL', -0.17]]) {
      sc.objects.push(newObj({ id, name: id === 'eyeR' ? 'Eye R' : 'Eye L', parent: 'buddy', parentBone: 'head', pos: [x, 2.02, 0.37], scl: [0.12, 0.16, 0.09], color: '#2B2B33', matcap: 'glossy' }));
      meshes[id] = { pos: eye.pos, idx: eye.idx, col: eye.col, mask: eye.mask, morphs: {}, skin: null };
    }
    const ball = MESHLIB.icosphere(4);
    sc.objects.push(newObj({ id: 'ball', name: 'Ball', pos: [1.9, 0.3, 0.6], scl: [0.6, 0.6, 0.6], color: '#6FA8DC', matcap: 'glossy',
      keys: { pos: [{ t: 0, v: [2.6, 2.2, 0.6] }, { t: 1.1, v: [1.9, 0.3, 0.6], ease: 'bounce' }], scl: [{ t: 1, v: [0.6, 0.6, 0.6] }, { t: 1.12, v: [0.72, 0.48, 0.72] }, { t: 1.4, v: [0.6, 0.6, 0.6], ease: 'spring' }] } }));
    meshes.ball = { pos: ball.pos, idx: ball.idx, col: ball.col, mask: ball.mask, morphs: {}, skin: null };
    sc.camKeys = [{ t: 0, v: { target: [0.3, 1.1, 0], yaw: 0.35, pitch: 0.12, dist: 6.2, fov: 40 } }, { t: 4.2, v: { target: [0.1, 1.5, 0], yaw: -0.1, pitch: 0.08, dist: 4.2, fov: 40 }, ease: 'smooth' }, { t: 6, v: { target: [0.3, 1.1, 0], yaw: 0.35, pitch: 0.12, dist: 6.2, fov: 40 } }];
    sc.view = { target: [0.2, 1.1, 0], yaw: 0.45, pitch: 0.15, dist: 6, fov: 40 };
    return { scene: sc, meshes };
  }

  // ---------- start ----------
  window.Clayframe = { get scene() { return scene; }, setTime, setMode, get mode() { return mode; }, select: selectObj, addPrim, get sel() { return sel; }, MESH, cam, draw: () => { dirty = true; }, setPlaying, inp: touchInp, get lastEval() { return lastEval; }, openSheet };
  (async function init() {
    $('radius').value = brush.radius; $('strength').value = Math.round(brush.strength * 100);
    $('symBtn').setAttribute('aria-pressed', String(brush.sym));
    const cur = store.get('clayframe.current', null);
    let ok = false;
    if (cur) ok = await loadProject(cur).catch(() => false);
    if (!ok) { const dm = demo(); newProjectFrom(dm.scene, dm.meshes); setMode('pose'); }
    $('dur').textContent = scene.duration;
    resize(); updUndo(); renderTools(); renderTimeline();
    requestAnimationFrame(loop);
  })();
})();
