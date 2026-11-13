/* Clayframe meshes: indexed triangle meshes with per-vertex colour and mask, primitives,
   neighbours, normals, subdivision, ray casting and OBJ in/out. */
window.CMesh = (function () {
  'use strict';
  const { v3 } = window.CM;

  // A mesh: pos (Float32Array xyz), idx (Uint32Array), col (Float32Array rgb, vertex paint), mask (Float32Array)
  function make(pos, idx) {
    const n = pos.length / 3;
    const m = { pos: Float32Array.from(pos), idx: Uint32Array.from(idx), col: new Float32Array(n * 3).fill(1), mask: new Float32Array(n), nor: new Float32Array(n * 3), ver: 0 };
    topology(m); normals(m);
    return m;
  }
  function clone(m) {
    const c = { pos: m.pos.slice(), idx: m.idx.slice(), col: m.col.slice(), mask: m.mask.slice(), nor: m.nor.slice(), ver: 0 };
    topology(c);
    return c;
  }
  // neighbour lists (CSR) and per-vertex triangle lists
  function topology(m) {
    const n = m.pos.length / 3, idx = m.idx, cnt = new Uint32Array(n + 1);
    const pairs = new Set();
    const edges = [];
    for (let i = 0; i < idx.length; i += 3) for (let k = 0; k < 3; k++) {
      const a = idx[i + k], b = idx[i + (k + 1) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      if (!pairs.has(key)) { pairs.add(key); edges.push(a, b); cnt[a + 1]++; cnt[b + 1]++; }
    }
    for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
    const nb = new Uint32Array(cnt[n]), fill = cnt.slice(0, n);
    for (let i = 0; i < edges.length; i += 2) { const a = edges[i], b = edges[i + 1]; nb[fill[a]++] = b; nb[fill[b]++] = a; }
    m.nbStart = cnt; m.nb = nb;
    // triangles per vertex
    const tc = new Uint32Array(n + 1);
    for (let i = 0; i < idx.length; i++) tc[idx[i] + 1]++;
    for (let i = 0; i < n; i++) tc[i + 1] += tc[i];
    const vt = new Uint32Array(idx.length), f2 = tc.slice(0, n);
    for (let i = 0; i < idx.length; i++) vt[f2[idx[i]]++] = (i / 3) | 0;
    m.vtStart = tc; m.vt = vt;
    m.topoVer = (m.topoVer || 0) + 1;
  }
  function normals(m, verts) {
    const p = m.pos, idx = m.idx, nr = m.nor;
    if (!verts) {
      nr.fill(0);
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        nr[a] += nx; nr[a + 1] += ny; nr[a + 2] += nz; nr[b] += nx; nr[b + 1] += ny; nr[b + 2] += nz; nr[c] += nx; nr[c + 1] += ny; nr[c + 2] += nz;
      }
      for (let i = 0; i < nr.length; i += 3) { const l = Math.hypot(nr[i], nr[i + 1], nr[i + 2]) || 1; nr[i] /= l; nr[i + 1] /= l; nr[i + 2] /= l; }
      return;
    }
    // only around the given vertices
    for (const v of verts) {
      let nx = 0, ny = 0, nz = 0;
      for (let k = m.vtStart[v]; k < m.vtStart[v + 1]; k++) {
        const t = m.vt[k] * 3, a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nr[v * 3] = nx / l; nr[v * 3 + 1] = ny / l; nr[v * 3 + 2] = nz / l;
    }
  }
  function bounds(m) {
    const p = m.pos; let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]); }
    const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    return { min: [x0, y0, z0], max: [x1, y1, z1], c, r: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 };
  }

  // ---------- primitives (all about 1 unit across, centred) ----------
  function icosphere(level) {
    const t = (1 + Math.sqrt(5)) / 2;
    let pos = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v3.norm);
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let l = 0; l < level; l++) {
      const cache = new Map(), nf = [];
      const mid = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; let i = cache.get(k); if (i == null) { i = pos.length; pos.push(v3.norm(v3.lerp(pos[a], pos[b], 0.5))); cache.set(k, i); } return i; };
      for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
      faces = nf;
    }
    return make(pos.flatMap(p => v3.scale(p, 0.5)), faces.flat());
  }
  // grid-based shapes share one builder: a (u, v) grid wrapped by f(u, v) → [x, y, z]
  function grid(nu, nv, f, wrapU, capTop, capBottom) {
    const pos = [], idx = [], cols = wrapU ? nu : nu + 1;
    for (let j = 0; j <= nv; j++) for (let i = 0; i < cols; i++) pos.push(...f(i / nu, j / nv));
    const at = (i, j) => j * cols + (wrapU ? i % nu : i);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1); idx.push(a, b, c, a, c, d); }
    const cap = (j, top) => {
      const c = pos.length / 3; let x = 0, y = 0, z = 0;
      for (let i = 0; i < nu; i++) { x += pos[at(i, j) * 3]; y += pos[at(i, j) * 3 + 1]; z += pos[at(i, j) * 3 + 2]; }
      pos.push(x / nu, y / nu, z / nu);
      for (let i = 0; i < nu; i++) top ? idx.push(c, at(i, j), at(i + 1, j)) : idx.push(c, at(i + 1, j), at(i, j));
    };
    if (capBottom) cap(0, false);
    if (capTop) cap(nv, true);
    return { pos, idx };
  }
  function weld(pos, idx, eps) {
    const map = new Map(), out = [], remap = [];
    const k = 1 / (eps || 1e-5);
    for (let i = 0; i < pos.length / 3; i++) {
      const key = Math.round(pos[i * 3] * k) + ',' + Math.round(pos[i * 3 + 1] * k) + ',' + Math.round(pos[i * 3 + 2] * k);
      let j = map.get(key);
      if (j == null) { j = out.length / 3; out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); map.set(key, j); }
      remap.push(j);
    }
    const ni = [];
    for (let i = 0; i < idx.length; i += 3) { const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]]; if (a !== b && b !== c && a !== c) ni.push(a, b, c); }
    return { pos: out, idx: ni };
  }
  function box(n) {
    // a cube made of six n×n grids, welded, so it sculpts evenly
    const pos = [], idx = [];
    const faces = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
    for (const [nn, u, v] of faces) {
      const base = pos.length / 3;
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const a = i / n - 0.5, b = j / n - 0.5; pos.push(nn[0] * 0.5 + u[0] * a + v[0] * b, nn[1] * 0.5 + u[1] * a + v[1] * b, nn[2] * 0.5 + u[2] * a + v[2] * b); }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = base + j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1; idx.push(a, b, c, a, c, d); }
    }
    const w = weld(pos, idx);
    return make(w.pos, w.idx);
  }
  function cylinder(seg, rings) {
    const g = grid(seg, rings, (u, v) => [0.5 * Math.cos(u * 2 * Math.PI), v - 0.5, -0.5 * Math.sin(u * 2 * Math.PI)], true, true, true);
    return make(g.pos, g.idx);
  }
  function cone(seg, rings) {
    const g = grid(seg, rings, (u, v) => [0.5 * (1 - v) * Math.cos(u * 2 * Math.PI) + 1e-4, v - 0.5, -0.5 * (1 - v) * Math.sin(u * 2 * Math.PI)], true, false, true);
    const w = weld(g.pos, g.idx, 1e-3);
    return make(w.pos, w.idx);
  }
  function torus(seg, rings) {
    const g = grid(seg, rings, (u, v) => { const a = u * 2 * Math.PI, b = v * 2 * Math.PI, R = 0.35, r = 0.15; return [(R + r * Math.cos(b)) * Math.cos(a), r * Math.sin(b), -(R + r * Math.cos(b)) * Math.sin(a)]; }, true);
    const w = weld(g.pos, g.idx, 1e-4);
    return make(w.pos, w.idx);
  }
  function capsule(seg, rings) {
    const g = grid(seg, rings, (u, v) => {
      const a = u * 2 * Math.PI, ph = v * Math.PI, y = -Math.cos(ph), r = Math.sin(ph);
      return [0.25 * r * Math.cos(a), y * 0.25 + (y > 0 ? 0.25 : y < 0 ? -0.25 : 0), -0.25 * r * Math.sin(a)];
    }, true);
    const w = weld(g.pos, g.idx, 1e-4);
    return make(w.pos, w.idx);
  }
  function plane(n) {
    const pos = [], idx = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i / n - 0.5, 0, j / n - 0.5);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1; idx.push(a, c, b, a, d, c); }
    return make(pos, idx);
  }
  const PRIMS = {
    sphere: { label: 'Sphere', make: () => icosphere(5) },
    cube: { label: 'Cube', make: () => box(24) },
    cylinder: { label: 'Cylinder', make: () => cylinder(48, 24) },
    capsule: { label: 'Capsule', make: () => capsule(48, 40) },
    cone: { label: 'Cone', make: () => cone(48, 24) },
    torus: { label: 'Torus', make: () => torus(72, 28) },
    plane: { label: 'Plane', make: () => plane(48) }
  };

  // ---------- subdivision: split every edge, then relax towards the old shape (keeps it smooth) ----------
  // extras: other per-vertex xyz arrays (shape-key deltas) to split the same way
  function subdivide(m, extras) {
    const p = m.pos, idx = m.idx, n = p.length / 3;
    const pos = Array.from(p), col = Array.from(m.col), mask = Array.from(m.mask);
    const ex = (extras || []).map(a => Array.from(a));
    const cache = new Map(), out = [];
    const mid = (a, b) => {
      const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      let i = cache.get(k);
      if (i == null) {
        i = pos.length / 3;
        for (let c = 0; c < 3; c++) { pos.push((p[a * 3 + c] + p[b * 3 + c]) / 2); col.push((m.col[a * 3 + c] + m.col[b * 3 + c]) / 2); }
        mask.push((m.mask[a] + m.mask[b]) / 2);
        (extras || []).forEach((E, j) => { for (let c = 0; c < 3; c++) ex[j].push((E[a * 3 + c] + E[b * 3 + c]) / 2); });
        cache.set(k, i);
      }
      return i;
    };
    for (let i = 0; i < idx.length; i += 3) { const a = idx[i], b = idx[i + 1], c = idx[i + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); out.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca); }
    const r = { pos: new Float32Array(pos), idx: new Uint32Array(out), col: new Float32Array(col), mask: new Float32Array(mask), nor: new Float32Array(pos.length), ver: 0 };
    topology(r);
    // one gentle smoothing pass on the new edge points only, so the surface rounds out
    const q = r.pos.slice();
    for (let v = n; v < r.pos.length / 3; v++) {
      let x = 0, y = 0, z = 0, c = 0;
      for (let k = r.nbStart[v]; k < r.nbStart[v + 1]; k++) { const u = r.nb[k]; x += q[u * 3]; y += q[u * 3 + 1]; z += q[u * 3 + 2]; c++; }
      if (c) { r.pos[v * 3] = q[v * 3] * 0.5 + x / c * 0.5; r.pos[v * 3 + 1] = q[v * 3 + 1] * 0.5 + y / c * 0.5; r.pos[v * 3 + 2] = q[v * 3 + 2] * 0.5 + z / c * 0.5; }
    }
    normals(r);
    r.extras = ex.map(a => new Float32Array(a));
    return r;
  }

  // ---------- ray casting (Möller–Trumbore), in the mesh's own space ----------
  function raycast(m, o, d, backface) {
    const p = m.pos, idx = m.idx;
    let best = Infinity, bi = -1, bu = 0, bv = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2], e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (backface ? Math.abs(det) < 1e-12 : det < 1e-12) continue;
      const inv = 1 / det, tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-6 && t < best) { best = t; bi = i / 3; bu = u; bv = v; }
    }
    if (bi < 0) return null;
    const a = idx[bi * 3] * 3, b = idx[bi * 3 + 1] * 3, c = idx[bi * 3 + 2] * 3;
    const nx = m.nor[a] * (1 - bu - bv) + m.nor[b] * bu + m.nor[c] * bv, ny = m.nor[a + 1] * (1 - bu - bv) + m.nor[b + 1] * bu + m.nor[c + 1] * bv, nz = m.nor[a + 2] * (1 - bu - bv) + m.nor[b + 2] * bu + m.nor[c + 2] * bv;
    return { t: best, tri: bi, p: v3.add(o, v3.scale(d, best)), n: v3.norm([nx, ny, nz]), v: idx[bi * 3 + (bu > bv ? (bu > 1 - bu - bv ? 1 : 0) : (bv > 1 - bu - bv ? 2 : 0))] };
  }
  // every crossing along the ray (for finding the inside of a limb)
  function raycastAll(m, o, d) {
    const p = m.pos, idx = m.idx, hits = [];
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2], e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det, tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-6) hits.push(t);
    }
    return hits.sort((a, b) => a - b);
  }

  // ---------- merge (for building characters out of parts) ----------
  function merge(parts) {
    const pos = [], idx = [], col = [];
    for (const { m, mat } of parts) {
      const base = pos.length / 3, P = m.pos;
      for (let i = 0; i < P.length; i += 3) pos.push(...(mat ? window.CM.m4.point(mat, [P[i], P[i + 1], P[i + 2]]) : [P[i], P[i + 1], P[i + 2]]));
      for (let i = 0; i < m.idx.length; i++) idx.push(m.idx[i] + base);
      for (let i = 0; i < m.col.length; i++) col.push(m.col[i]);
    }
    const r = make(pos, idx);
    r.col.set(col);
    return r;
  }

  // ---------- OBJ ----------
  function toOBJ(name, P, idx, nor) {
    const L = ['# Clayframe', 'o ' + (name || 'mesh').replace(/\s+/g, '_')];
    for (let i = 0; i < P.length; i += 3) L.push('v ' + P[i].toFixed(5) + ' ' + P[i + 1].toFixed(5) + ' ' + P[i + 2].toFixed(5));
    if (nor) for (let i = 0; i < nor.length; i += 3) L.push('vn ' + nor[i].toFixed(4) + ' ' + nor[i + 1].toFixed(4) + ' ' + nor[i + 2].toFixed(4));
    for (let i = 0; i < idx.length; i += 3) { const a = idx[i] + 1, b = idx[i + 1] + 1, c = idx[i + 2] + 1; L.push(nor ? 'f ' + a + '//' + a + ' ' + b + '//' + b + ' ' + c + '//' + c : 'f ' + a + ' ' + b + ' ' + c); }
    return L.join('\n') + '\n';
  }
  function fromOBJ(text) {
    const pos = [], idx = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim().split(/\s+/);
      if (t[0] === 'v') pos.push(+t[1], +t[2], +t[3]);
      else if (t[0] === 'f') {
        const f = t.slice(1).map(s => { const i = parseInt(s.split('/')[0], 10); return i < 0 ? pos.length / 3 + i : i - 1; });
        for (let k = 1; k + 1 < f.length; k++) idx.push(f[0], f[k], f[k + 1]);
      }
    }
    if (!idx.length) throw new Error('no faces found');
    const w = weld(pos, idx, 1e-6);
    const m = make(w.pos, w.idx), b = bounds(m), s = 1 / ((b.r * 2) || 1);
    for (let i = 0; i < m.pos.length; i += 3) { m.pos[i] = (m.pos[i] - b.c[0]) * s; m.pos[i + 1] = (m.pos[i + 1] - b.c[1]) * s; m.pos[i + 2] = (m.pos[i + 2] - b.c[2]) * s; }
    normals(m);
    return m;
  }
  return { make, clone, topology, normals, bounds, PRIMS, icosphere, box, subdivide, raycast, raycastAll, merge, toOBJ, fromOBJ, weld };
})();
