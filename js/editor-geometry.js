/**
 * Editor geometry helpers.
 * Pure functions used by the mobile editor for live proportions and T-junction discovery.
 * Metric wall lengths remain authoritative; sketch coordinates are only presentation geometry.
 */

export function estimateScaleCmPerUnit(walls, preferredWallId = null) {
  const list = (walls || []).filter(w =>
    w && w.a && w.b && Number.isFinite(w.lengthCm) && w.lengthCm > 0
  );
  if (!list.length) return null;

  if (preferredWallId) {
    const preferred = list.find(w => w.id === preferredWallId);
    if (preferred) {
      const d = distance(preferred.a, preferred.b);
      if (d > 1e-9) return preferred.lengthCm / d;
    }
  }

  const ratios = list
    .map(w => {
      const d = distance(w.a, w.b);
      return d > 1e-9 ? w.lengthCm / d : NaN;
    })
    .filter(Number.isFinite)
    .sort((a,b) => a-b);

  if (!ratios.length) return null;
  const m = ratios.length >> 1;
  return ratios.length % 2 ? ratios[m] : (ratios[m-1] + ratios[m]) / 2;
}

export function applyMeasuredWallProportion(walls, wallId, scaleCmPerUnit, tolerance = 3) {
  const out = (walls || []).map(copyWall);
  const wall = out.find(w => w.id === wallId);
  if (!wall || !wall.a || !wall.b || !Number.isFinite(wall.lengthCm) || wall.lengthCm <= 0) {
    return { walls:out, scaleCmPerUnit, moved:false, movedEndpoint:null };
  }

  const current = distance(wall.a, wall.b);
  if (!(current > 1e-9)) return { walls:out, scaleCmPerUnit, moved:false, movedEndpoint:null };

  let scale = Number(scaleCmPerUnit);
  if (!Number.isFinite(scale) || scale <= 0) {
    scale = wall.lengthCm / current;
    return { walls:out, scaleCmPerUnit:scale, moved:false, movedEndpoint:null };
  }

  const desired = wall.lengthCm / scale;
  if (!Number.isFinite(desired) || desired <= 0 || Math.abs(desired-current) <= Math.max(.25, current*.002)) {
    return { walls:out, scaleCmPerUnit:scale, moved:false, movedEndpoint:null };
  }

  const degreeA = endpointDegree(out, wall.a, tolerance);
  const degreeB = endpointDegree(out, wall.b, tolerance);

  // Keep the more constrained corner fixed. On a tie, preserve A for determinism.
  const anchorEnd = degreeB > degreeA ? 'b' : 'a';
  const movingEnd = anchorEnd === 'a' ? 'b' : 'a';
  const anchor = wall[anchorEnd];
  const moving = wall[movingEnd];
  const dx = moving.x-anchor.x;
  const dy = moving.y-anchor.y;
  const len = Math.hypot(dx,dy);
  if (!(len > 1e-9)) return { walls:out, scaleCmPerUnit:scale, moved:false, movedEndpoint:null };

  const target = {
    x: anchor.x + dx/len*desired,
    y: anchor.y + dy/len*desired
  };
  moveSharedNode(out, moving, target, tolerance);

  return {
    walls:out,
    scaleCmPerUnit:scale,
    moved:true,
    movedEndpoint:movingEnd,
    anchorEndpoint:anchorEnd,
    desiredUnits:desired
  };
}

export function moveSharedNode(walls, origin, target, tolerance = 3) {
  let count = 0;
  for (const wall of walls || []) {
    for (const end of ['a','b']) {
      if (!wall || !wall[end]) continue;
      if (distance(wall[end], origin) <= tolerance) {
        wall[end] = { x:Number(target.x), y:Number(target.y) };
        count++;
      }
    }
  }
  return count;
}

export function findTJunctionCandidates(walls, tolerance = 12, interiorMargin = 0.06) {
  const valid = (walls || []).filter(w => w && w.id != null && validPoint(w.a) && validPoint(w.b));
  const candidates = [];

  for (const branch of valid) {
    for (const branchEnd of ['a','b']) {
      const p = branch[branchEnd];
      let best = null;
      let second = null;

      for (const target of valid) {
        if (target.id === branch.id) continue;
        const hit = pointToSegment(p,target.a,target.b);
        if (hit.t <= interiorMargin || hit.t >= 1-interiorMargin || hit.distance > tolerance) continue;
        const item = {
          branchWallId:branch.id,
          branchEnd,
          targetWallId:target.id,
          t:hit.t,
          point:hit.point,
          distance:hit.distance
        };
        if (!best || item.distance < best.distance) {
          second = best;
          best = item;
        } else if (!second || item.distance < second.distance) {
          second = item;
        }
      }

      if (!best) continue;
      // If two targets are almost equally plausible, do not guess.
      if (second && second.distance <= Math.max(best.distance*1.35, best.distance+2)) continue;
      candidates.push(best);
    }
  }

  candidates.sort((a,b) => a.distance-b.distance || String(a.branchWallId).localeCompare(String(b.branchWallId)));
  return candidates;
}

export function pointToSegment(p,a,b) {
  const vx=b.x-a.x, vy=b.y-a.y;
  const len2=vx*vx+vy*vy;
  if (!(len2 > 1e-12)) return { distance:distance(p,a), t:0, point:{...a} };
  let t=((p.x-a.x)*vx+(p.y-a.y)*vy)/len2;
  t=Math.max(0,Math.min(1,t));
  const point={x:a.x+vx*t,y:a.y+vy*t};
  return {distance:distance(p,point),t,point};
}

function endpointDegree(walls,p,tolerance) {
  let n=0;
  for (const wall of walls || []) {
    if (wall && wall.a && distance(wall.a,p)<=tolerance) n++;
    if (wall && wall.b && distance(wall.b,p)<=tolerance) n++;
  }
  return n;
}

function copyWall(w) {
  return {
    ...w,
    a:w && w.a ? {x:Number(w.a.x),y:Number(w.a.y)} : w.a,
    b:w && w.b ? {x:Number(w.b.x),y:Number(w.b.y)} : w.b
  };
}

function validPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function distance(a,b) {
  return Math.hypot(a.x-b.x,a.y-b.y);
}
