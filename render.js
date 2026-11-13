/* Clayframe renderer: WebGL2, matcap shading (like most sculpting apps), GPU skinning, a ground grid. */
window.CRender = (function () {
  'use strict';
  const { v3, m4 } = window.CM;

  const VS = `#version 300 es
  precision highp float;
  in vec3 aPos; in vec3 aNor; in vec4 aCol; in vec4 aBi; in vec4 aBw;
  uniform mat4 uModel, uView, uProj; uniform mat4 uBones[48]; uniform bool uSkin;
  out vec3 vN; out vec3 vP; out vec4 vC;
  void main() {
    vec4 p = vec4(aPos, 1.0); vec3 n = aNor;
    if (uSkin) {
      mat4 s = uBones[int(aBi.x)] * aBw.x + uBones[int(aBi.y)] * aBw.y + uBones[int(aBi.z)] * aBw.z + uBones[int(aBi.w)] * aBw.w;
      p = s * p; n = mat3(s) * n;
    }
    mat4 mv = uView * uModel;
    vec4 vp = mv * p;
    vP = vp.xyz;
    vN = normalize(transpose(inverse(mat3(mv))) * n);
    vC = aCol;
    gl_Position = uProj * vp;
  }`;
  const FS = `#version 300 es
  precision highp float;
  in vec3 vN; in vec3 vP; in vec4 vC;
  uniform sampler2D uMat; uniform vec3 uColor; uniform bool uFlat; uniform float uSel; uniform vec3 uAccent; uniform float uAlpha;
  out vec4 o;
  void main() {
    vec3 n = uFlat ? normalize(cross(dFdx(vP), dFdy(vP))) : normalize(vN);
    if (!uFlat && !gl_FrontFacing) n = -n;
    vec3 vd = normalize(-vP);
    vec3 x = normalize(vec3(vd.z, 0.0, -vd.x)), y = cross(vd, x);
    vec2 uv = vec2(dot(x, n), dot(y, n)) * 0.495 + 0.5;
    vec3 c = texture(uMat, vec2(uv.x, 1.0 - uv.y)).rgb * uColor * vC.rgb;
    c *= mix(1.0, 0.32, vC.a);
    float rim = pow(1.0 - abs(dot(n, vd)), 3.0);
    c += uAccent * rim * uSel * 0.7;
    o = vec4(c, uAlpha);
  }`;
  const LVS = `#version 300 es
  in vec3 aPos; uniform mat4 uVP; void main() { gl_Position = uVP * vec4(aPos, 1.0); }`;
  const LFS = `#version 300 es
  precision mediump float; uniform vec4 uC; out vec4 o; void main() { o = uC; }`;

  function prog(gl, vs, fs) {
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aNor'); gl.bindAttribLocation(p, 2, 'aCol'); gl.bindAttribLocation(p, 3, 'aBi'); gl.bindAttribLocation(p, 4, 'aBw');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  // ---------- matcaps, drawn procedurally ----------
  const MATCAPS = {
    clay: { label: 'Clay' }, glossy: { label: 'Glossy' }, wax: { label: 'Wax' }, toon: { label: 'Toon' }, metal: { label: 'Metal' }, rim: { label: 'Rim light' }
  };
  function matcapPixels(kind, S) {
    const d = new Uint8Array(S * S * 4), L = v3.norm([-0.55, 0.7, 0.6]), H = v3.norm(v3.add(L, [0, 0, 1]));
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = (i + 0.5) / S * 2 - 1, y = 1 - (j + 0.5) / S * 2, r2 = x * x + y * y;
      const k = Math.min(r2, 0.999), n = [x, y, Math.sqrt(1 - k)];
      const nl = Math.max(0, v3.dot(n, L)), nh = Math.max(0, v3.dot(n, H)), rim = Math.pow(1 - n[2], 2.2), amb = 0.5 + 0.5 * n[1];
      let c;
      switch (kind) {
        case 'glossy': { const s = Math.pow(nh, 70) * 0.9; c = [0.12 + 0.62 * nl + 0.18 * amb + s, 0.12 + 0.62 * nl + 0.18 * amb + s, 0.13 + 0.62 * nl + 0.2 * amb + s]; break; }
        case 'wax': { const sss = 0.25 * Math.pow(1 - Math.abs(v3.dot(n, L)), 2); const s = Math.pow(nh, 30) * 0.25; c = [0.2 + 0.6 * nl + 0.15 * amb + sss + s, 0.16 + 0.56 * nl + 0.12 * amb + sss * 0.6 + s, 0.15 + 0.5 * nl + 0.1 * amb + sss * 0.5 + s]; break; }
        case 'toon': { const b = nl > 0.65 ? 1 : nl > 0.25 ? 0.68 : 0.4; const line = r2 > 0.86 ? 0.25 : 1; const s = nh > 0.97 ? 0.25 : 0; c = [b * line + s, b * line + s, b * line + s]; break; }
        case 'metal': { const ry = n[1] * 0.9 + n[0] * 0.1; const env = ry > 0.1 ? 0.75 + 0.25 * ry : ry > -0.05 ? 0.25 : 0.42 + 0.3 * (ry + 1) * 0.5; const s = Math.pow(nh, 120); c = [env * 0.92 + s, env * 0.94 + s, env + s]; break; }
        case 'rim': { const s = Math.pow(nh, 40) * 0.3; c = [0.08 + 0.5 * nl + 0.1 * amb + rim * 0.35 + s, 0.1 + 0.5 * nl + 0.1 * amb + rim * 0.55 + s, 0.12 + 0.5 * nl + 0.12 * amb + rim * 0.75 + s]; break; }
        default: { const s = Math.pow(nh, 22) * 0.12; c = [0.2 + 0.62 * nl + 0.22 * amb + s, 0.19 + 0.6 * nl + 0.21 * amb + s, 0.18 + 0.57 * nl + 0.21 * amb + s]; }
      }
      const o = (j * S + i) * 4;
      d[o] = Math.min(255, c[0] * 255); d[o + 1] = Math.min(255, c[1] * 255); d[o + 2] = Math.min(255, c[2] * 255); d[o + 3] = 255;
    }
    return d;
  }
  // a small picture of a matcap, for buttons
  function matcapPreview(kind, size) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d'), img = x.createImageData(size, size), d = matcapPixels(kind, size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) { const o = (j * size + i) * 4, xx = (i + 0.5) / size * 2 - 1, yy = (j + 0.5) / size * 2 - 1; const inside = xx * xx + yy * yy <= 1; img.data.set(inside ? [d[o], d[o + 1], d[o + 2], 255] : [0, 0, 0, 0], o); }
    x.putImageData(img, 0, 0);
    return c;
  }

  function normalsFor(pos, idx) {
    const nr = new Float32Array(pos.length);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      nr[a] += nx; nr[a + 1] += ny; nr[a + 2] += nz; nr[b] += nx; nr[b + 1] += ny; nr[b + 2] += nz; nr[c] += nx; nr[c + 1] += ny; nr[c + 2] += nz;
    }
    for (let i = 0; i < nr.length; i += 3) { const l = Math.hypot(nr[i], nr[i + 1], nr[i + 2]) || 1; nr[i] /= l; nr[i + 1] /= l; nr[i + 2] /= l; }
    return nr;
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return null;
    const P = prog(gl, VS, FS), L = prog(gl, LVS, LFS);
    const tex = {};
    function matTex(kind) {
      if (tex[kind]) return tex[kind];
      const t = gl.createTexture(), S = 256;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, matcapPixels(kind, S));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return (tex[kind] = t);
    }
    // GPU copies of meshes
    const gpu = new Map();
    function buf(target, data, usage) { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage || gl.DYNAMIC_DRAW); return b; }
    function sync(id, mesh, display, skin) {
      let g = gpu.get(id);
      const n = mesh.pos.length / 3;
      if (!g || g.topo !== mesh.topoVer || g.mesh !== mesh) {
        if (g) { gl.deleteVertexArray(g.vao); g.bufs.forEach(b => gl.deleteBuffer(b)); }
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const col = new Float32Array(n * 4);
        const bp = buf(gl.ARRAY_BUFFER, mesh.pos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        const bn = buf(gl.ARRAY_BUFFER, mesh.nor); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        const bc = buf(gl.ARRAY_BUFFER, col); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
        const bi = buf(gl.ARRAY_BUFFER, new Float32Array(n * 4)); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
        const bw = buf(gl.ARRAY_BUFFER, new Float32Array(n * 4)); gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 0, 0);
        const bx = buf(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        g = { vao, bufs: [bp, bn, bc, bi, bw, bx], count: mesh.idx.length, topo: mesh.topoVer, mesh, ver: -1, cver: -1, skin: null, disp: null, colArr: col };
        gpu.set(id, g);
      }
      const dispKey = display ? display : null;
      if (g.ver !== mesh.ver || g.disp !== dispKey) {
        const P = display || mesh.pos, N = display ? normalsFor(display, mesh.idx) : mesh.nor;
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[0]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, P);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[1]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, N);
        g.ver = mesh.ver; g.disp = dispKey;
      }
      if (g.cver !== mesh.cver) {
        const c = g.colArr; for (let i = 0; i < n; i++) { c[i * 4] = mesh.col[i * 3]; c[i * 4 + 1] = mesh.col[i * 3 + 1]; c[i * 4 + 2] = mesh.col[i * 3 + 2]; c[i * 4 + 3] = mesh.mask[i]; }
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[2]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, c);
        g.cver = mesh.cver;
      }
      if (skin && g.skin !== skin && skin.bi.length === n * 4) {
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[3]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, skin.bi);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bufs[4]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, skin.bw);
        g.skin = skin;
      }
      return g;
    }
    function drop(id) { const g = gpu.get(id); if (g) { gl.deleteVertexArray(g.vao); g.bufs.forEach(b => gl.deleteBuffer(b)); gpu.delete(id); } }
    // grid
    const gridData = []; const N = 10, step = 0.5;
    for (let i = -N; i <= N; i++) { if (i === 0) continue; gridData.push(i * step, 0, -N * step, i * step, 0, N * step, -N * step, 0, i * step, N * step, 0, i * step); }
    const gridBuf = buf(gl.ARRAY_BUFFER, new Float32Array(gridData), gl.STATIC_DRAW);
    const axisBuf = buf(gl.ARRAY_BUFFER, new Float32Array([-N * step, 0, 0, N * step, 0, 0, 0, 0, -N * step, 0, 0, N * step]), gl.STATIC_DRAW);
    const lineVao = gl.createVertexArray();
    function lines(b, count, vp, c, from) {
      gl.useProgram(L.p); gl.bindVertexArray(lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(L.u.uVP, false, vp); gl.uniform4fv(L.u.uC, c);
      gl.drawArrays(gl.LINES, from || 0, count);
    }
    const ident = new Float32Array(16 * 48);
    for (let i = 0; i < 48; i++) ident.set(m4.id(), i * 16);
    // items: [{ id, mesh, display, skin, bones (Float32Array), model, color [r,g,b], matcap, flat, selected, alpha }]
    function draw(items, cam, opt) {
      const w = canvas.width, h = canvas.height;
      gl.viewport(0, 0, w, h);
      const bg = opt.bg || [0.16, 0.16, 0.18];
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const vp = m4.mul(cam.proj, cam.view);
      if (opt.grid) {
        gl.depthMask(false);
        lines(gridBuf, gridData.length / 3, vp, [1, 1, 1, 0.07]);
        lines(axisBuf, 2, vp, [0.9, 0.3, 0.3, 0.45], 0); lines(axisBuf, 2, vp, [0.3, 0.5, 0.95, 0.45], 2);
        gl.depthMask(true);
      }
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uView, false, cam.view); gl.uniformMatrix4fv(P.u.uProj, false, cam.proj);
      gl.uniform3fv(P.u.uAccent, [0.35, 0.75, 1.0]);
      gl.activeTexture(gl.TEXTURE0); gl.uniform1i(P.u.uMat, 0);
      for (const it of items) {
        const g = sync(it.id, it.mesh, it.display, it.skin);
        gl.bindTexture(gl.TEXTURE_2D, matTex(it.matcap || 'clay'));
        gl.uniformMatrix4fv(P.u.uModel, false, it.model);
        gl.uniform3fv(P.u.uColor, it.color);
        gl.uniform1i(P.u.uFlat, it.flat ? 1 : 0);
        gl.uniform1f(P.u.uSel, it.selected ? 1 : 0);
        gl.uniform1f(P.u.uAlpha, it.alpha == null ? 1 : it.alpha);
        gl.uniform1i(P.u.uSkin, it.bones ? 1 : 0);
        gl.uniformMatrix4fv(P.u.uBones, false, it.bones || ident);
        gl.bindVertexArray(g.vao);
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
    }
    return { gl, draw, drop, matcapPreview };
  }

  // orbit camera → matrices, and screen ↔ world helpers
  function camera(c, w, h) {
    const cp = Math.cos(c.pitch), eye = v3.add(c.target, [c.dist * cp * Math.sin(c.yaw), c.dist * Math.sin(c.pitch), c.dist * cp * Math.cos(c.yaw)]);
    const view = m4.lookAt(eye, c.target, [0, 1, 0]);
    const proj = m4.perspective((c.fov || 40) * Math.PI / 180, w / h, Math.max(0.01, c.dist * 0.01), c.dist * 60 + 100);
    const vp = m4.mul(proj, view), ivp = m4.inv(vp);
    return {
      eye, view, proj, vp, w, h,
      project: p => { const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12], y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13], ww = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]; return [(x / ww * 0.5 + 0.5) * w, (0.5 - y / ww * 0.5) * h, ww]; },
      ray: (sx, sy) => { const nx = sx / w * 2 - 1, ny = 1 - sy / h * 2; const a = m4.point(ivp, [nx, ny, -1]), b = m4.point(ivp, [nx, ny, 1]); return { o: a, d: v3.norm(v3.sub(b, a)) }; },
      // world units per screen pixel at a given depth
      pxSize: p => { const d = v3.dist(eye, p); return 2 * d * Math.tan((c.fov || 40) * Math.PI / 360) / h; }
    };
  }
  return { create, camera, MATCAPS, matcapPreview, normalsFor };
})();
