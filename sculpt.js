/* Clayframe sculpting brushes. Every dab works in the mesh's own space on the vertices inside the brush sphere. */
window.CSculpt = (function () {
  'use strict';
  const BRUSHES = {
    clay: { label: 'Clay', icon: '◒', hint: 'Builds up flat layers, like adding clay' },
    draw: { label: 'Draw', icon: '✎', hint: 'Raises a ridge along the stroke' },
    inflate: { label: 'Inflate', icon: '◍', hint: 'Puffs the surface outwards' },
    smooth: { label: 'Smooth', icon: '≈', hint: 'Evens out bumps' },
    flatten: { label: 'Flatten', icon: '▭', hint: 'Presses towards a flat plane' },
    pinch: { label: 'Pinch', icon: '⋈', hint: 'Pulls the surface together into sharp edges' },
    crease: { label: 'Crease', icon: '⌄', hint: 'Cuts a sharp groove' },
    move: { label: 'Move', icon: '✥', hint: 'Grabs and drags a whole region' },
    mask: { label: 'Mask', icon: '▒', hint: 'Protects areas from other brushes (shown darker)' },
    paint: { label: 'Paint', icon: '🖌', hint: 'Paints colour onto the surface' }
  };
  const fall = x => { const k = 1 - x * x; return k > 0 ? k * k : 0; };
  // vertices within radius r of point P: [index, falloff] pairs
  function gather(mesh, P, r) {
    const p = mesh.pos, out = [], r2 = r * r;
    for (let i = 0, n = p.length / 3; i < n; i++) {
      const dx = p[i * 3] - P[0], dy = p[i * 3 + 1] - P[1], dz = p[i * 3 + 2] - P[2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) out.push(i, fall(Math.sqrt(d2) / r));
    }
    return out;
  }
  // one dab. opt: { tool, P, N, r, s (0..1), invert, color [r,g,b] }. Returns changed vertex indices.
  function dab(mesh, opt) {
    const { tool, P, r } = opt, s = opt.s, sgn = opt.invert ? -1 : 1;
    const p = mesh.pos, nr = mesh.nor, mk = mesh.mask, g = gather(mesh, P, r), changed = [];
    if (!g.length) return changed;
    if (tool === 'mask') {
      for (let k = 0; k < g.length; k += 2) { const i = g[k]; mk[i] = Math.max(0, Math.min(1, mk[i] + sgn * g[k + 1] * s)); changed.push(i); }
      mesh.cver = (mesh.cver || 0) + 1;
      return changed;
    }
    if (tool === 'paint') {
      const c = opt.color || [1, 1, 1];
      for (let k = 0; k < g.length; k += 2) { const i = g[k], a = g[k + 1] * s * (1 - mk[i]); for (let j = 0; j < 3; j++) mesh.col[i * 3 + j] += (c[j] - mesh.col[i * 3 + j]) * a; changed.push(i); }
      mesh.cver = (mesh.cver || 0) + 1;
      return changed;
    }
    // area-weighted centre and normal of the brush region
    let cx = 0, cy = 0, cz = 0, wsum = 0;
    for (let k = 0; k < g.length; k += 2) { const i = g[k], w = g[k + 1]; cx += p[i * 3] * w; cy += p[i * 3 + 1] * w; cz += p[i * 3 + 2] * w; wsum += w; }
    cx /= wsum; cy /= wsum; cz /= wsum;
    // the brush's own normal: the region's average, which is steadier than the single hit normal
    let ax = 0, ay = 0, az = 0;
    for (let k = 0; k < g.length; k += 2) { const i = g[k] * 3, w = g[k + 1]; ax += nr[i] * w; ay += nr[i + 1] * w; az += nr[i + 2] * w; }
    const al = Math.hypot(ax, ay, az);
    const N = al > 1e-6 && (ax * opt.N[0] + ay * opt.N[1] + az * opt.N[2]) > 0 ? [ax / al, ay / al, az / al] : opt.N;
    const old = tool === 'smooth' ? p.slice() : null;
    for (let k = 0; k < g.length; k += 2) {
      const i = g[k], f = g[k + 1] * (1 - mk[i]);
      if (f <= 0) continue;
      const o = i * 3;
      let dx = 0, dy = 0, dz = 0;
      switch (tool) {
        case 'draw': { const a = sgn * s * r * 0.11 * f; dx = N[0] * a; dy = N[1] * a; dz = N[2] * a; break; }
        case 'inflate': { const a = sgn * s * r * 0.09 * f; dx = nr[o] * a; dy = nr[o + 1] * a; dz = nr[o + 2] * a; break; }
        case 'clay': {
          // push up to a plane just above the surface, so strokes build flat layers
          const off = sgn * r * 0.14 * s;
          const d = (cx + N[0] * off - p[o]) * N[0] + (cy + N[1] * off - p[o + 1]) * N[1] + (cz + N[2] * off - p[o + 2]) * N[2];
          if (sgn * d > 0) { const a = d * f * 0.5; dx = N[0] * a; dy = N[1] * a; dz = N[2] * a; }
          break;
        }
        case 'flatten': { const d = (p[o] - cx) * N[0] + (p[o + 1] - cy) * N[1] + (p[o + 2] - cz) * N[2], a = -d * f * s * 0.5; dx = N[0] * a; dy = N[1] * a; dz = N[2] * a; break; }
        case 'pinch': case 'crease': {
          let tx = P[0] - p[o], ty = P[1] - p[o + 1], tz = P[2] - p[o + 2];
          const dn = tx * N[0] + ty * N[1] + tz * N[2]; tx -= N[0] * dn; ty -= N[1] * dn; tz -= N[2] * dn;
          const a = sgn * f * s * (tool === 'pinch' ? 0.22 : 0.16);
          dx = tx * a; dy = ty * a; dz = tz * a;
          if (tool === 'crease') { const b = -sgn * s * r * 0.07 * f; dx += N[0] * b; dy += N[1] * b; dz += N[2] * b; }
          break;
        }
        case 'smooth': {
          let ax = 0, ay = 0, az = 0, c = 0;
          for (let j = mesh.nbStart[i]; j < mesh.nbStart[i + 1]; j++) { const u = mesh.nb[j] * 3; ax += old[u]; ay += old[u + 1]; az += old[u + 2]; c++; }
          if (c) { const a = f * Math.min(1, s * 1.2); dx = (ax / c - old[o]) * a; dy = (ay / c - old[o + 1]) * a; dz = (az / c - old[o + 2]) * a; }
          break;
        }
      }
      p[o] += dx; p[o + 1] += dy; p[o + 2] += dz;
      changed.push(i);
    }
    return changed;
  }
  // Move brush: remember the region at the start, then follow the finger
  function grabStart(mesh, P, r) {
    const g = gather(mesh, P, r), idx = [], w = [], orig = [];
    for (let k = 0; k < g.length; k += 2) { const i = g[k]; idx.push(i); w.push(g[k + 1] * (1 - mesh.mask[i])); orig.push(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]); }
    return { idx, w, orig };
  }
  function grabMove(mesh, grab, delta) {
    const p = mesh.pos;
    grab.idx.forEach((i, k) => { const f = grab.w[k]; p[i * 3] = grab.orig[k * 3] + delta[0] * f; p[i * 3 + 1] = grab.orig[k * 3 + 1] + delta[1] * f; p[i * 3 + 2] = grab.orig[k * 3 + 2] + delta[2] * f; });
    return grab.idx;
  }
  // whole-mesh helpers
  function smoothAll(mesh, passes) {
    for (let it = 0; it < (passes || 1); it++) {
      const old = mesh.pos.slice(), p = mesh.pos;
      for (let i = 0, n = p.length / 3; i < n; i++) {
        const f = 0.5 * (1 - mesh.mask[i]); if (!f) continue;
        let ax = 0, ay = 0, az = 0, c = 0;
        for (let j = mesh.nbStart[i]; j < mesh.nbStart[i + 1]; j++) { const u = mesh.nb[j] * 3; ax += old[u]; ay += old[u + 1]; az += old[u + 2]; c++; }
        if (c) { p[i * 3] += (ax / c - old[i * 3]) * f; p[i * 3 + 1] += (ay / c - old[i * 3 + 1]) * f; p[i * 3 + 2] += (az / c - old[i * 3 + 2]) * f; }
      }
    }
  }
  return { BRUSHES, dab, grabStart, grabMove, smoothAll, gather };
})();
