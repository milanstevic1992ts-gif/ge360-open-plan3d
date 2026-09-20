export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

export const toDeg = (r) => r / DEG;
export const toRad = (d) => d * DEG;

export function dist(p, q) {
  return Math.hypot(q.x - p.x, q.y - p.y);
}

export function angleOf(p, q) {
  return Math.atan2(q.y - p.y, q.x - p.x);
}

export function isFinitePoint(p) {
  return !!p && typeof p === "object" && Number.isFinite(p.x) && Number.isFinite(p.y);
}

export function circularMean(angles, weights) {
  let s = 0;
  let c = 0;
  for (let i = 0; i < angles.length; i++) {
    const w = weights ? weights[i] : 1;
    s += w * Math.sin(angles[i]);
    c += w * Math.cos(angles[i]);
  }
  if (Math.abs(s) < 1e-15 && Math.abs(c) < 1e-15) return angles.length ? angles[0] : 0;
  return Math.atan2(s, c);
}

export function pointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return { distance: dist(p, a), t: 0 };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  const tc = Math.max(0, Math.min(1, t));
  return { distance: Math.hypot(a.x + tc * dx - p.x, a.y + tc * dy - p.y), t };
}

export function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function round(v, digits) {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function fmt(v, digits = 1) {
  return String(round(v, digits)).replace(".", ",");
}

export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => {
    const r = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) r[j] = row[j];
    r[n] = b[i];
    return r;
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    let best = Math.abs(M[c][c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(M[r][c]);
      if (v > best) {
        best = v;
        p = r;
      }
    }
    if (best < 1e-300) return null;
    if (p !== c) [M[p], M[c]] = [M[c], M[p]];
    const pr = M[c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / pr[c];
      if (f === 0) continue;
      const rr = M[r];
      for (let j = c; j <= n; j++) rr[j] -= f * pr[j];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null;
  return x;
}

function sumSq(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i] * r[i];
  return s;
}

export function levenbergMarquardt(fn, x0, opts = {}) {
  const maxIt = opts.maxIterations ?? 200;
  const n = x0.length;
  let x = Float64Array.from(x0);
  let r = fn(x);
  let cost = sumSq(r);
  if (n === 0) return { x, r, cost, iterations: 0, converged: true };
  const m = r.length;
  let lambda = opts.initialLambda ?? 1e-3;
  const h = 1e-7;
  const J = new Float64Array(m * n);
  let it = 0;
  let converged = false;
  for (; it < maxIt; it++) {
    for (let k = 0; k < n; k++) {
      const old = x[k];
      x[k] = old + h;
      const rk = fn(x);
      x[k] = old;
      for (let i = 0; i < m; i++) J[i * n + k] = (rk[i] - r[i]) / h;
    }
    const A = Array.from({ length: n }, () => new Float64Array(n));
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const ri = r[i];
      const row = i * n;
      for (let a = 0; a < n; a++) {
        const ja = J[row + a];
        if (ja === 0) continue;
        g[a] += ja * ri;
        const Aa = A[a];
        for (let b = a; b < n; b++) Aa[b] += ja * J[row + b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    let gmax = 0;
    for (let a = 0; a < n; a++) gmax = Math.max(gmax, Math.abs(g[a]));
    if (gmax < 1e-14) {
      converged = true;
      break;
    }
    let improved = false;
    while (lambda < 1e14) {
      const M = A.map((row, a) => {
        const c = Float64Array.from(row);
        c[a] += lambda * Math.max(row[a], 1e-9);
        return c;
      });
      const rhs = new Float64Array(n);
      for (let a = 0; a < n; a++) rhs[a] = -g[a];
      const d = solveLinear(M, rhs);
      if (!d) {
        lambda *= 10;
        continue;
      }
      const xn = new Float64Array(n);
      let dmax = 0;
      for (let k = 0; k < n; k++) {
        xn[k] = x[k] + d[k];
        dmax = Math.max(dmax, Math.abs(d[k]));
      }
      const rn = fn(xn);
      const cn = sumSq(rn);
      if (cn < cost) {
        const dec = cost - cn;
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 3, 1e-15);
        improved = true;
        if (dec <= 1e-20 + 1e-13 * cost || dmax < 1e-13) converged = true;
        break;
      }
      lambda *= 4;
    }
    if (!improved) {
      converged = true;
      break;
    }
    if (converged) {
      it++;
      break;
    }
  }
  return { x, r, cost, iterations: it, converged };
}
