/**
 * Diagnostica geometrica GE360.
 * Trasforma i risultati del motore esistente in problemi azionabili senza bloccare il rilievo.
 */

function arr(v) { return Array.isArray(v) ? v : []; }

function issueKey(issue) {
  return [
    issue.type || 'issue',
    ...arr(issue.walls).map(String).sort(),
    ...arr(issue.openings).map(String).sort(),
    issue.diagonalId || '',
    issue.workId || ''
  ].join('|');
}

function withKey(issue) {
  return { ...issue, key: issue.key || issueKey(issue) };
}

function dedupe(issues) {
  const seen = new Set();
  const out = [];
  for (const raw of issues) {
    const issue = withKey(raw);
    if (seen.has(issue.key)) continue;
    seen.add(issue.key);
    out.push(issue);
  }
  return out;
}

function solvedAnchor(anchor, wallMap) {
  if (!anchor || !anchor.wallId) return null;
  const wall = wallMap.get(String(anchor.wallId));
  if (!wall || !wall.a || !wall.b) return null;
  return anchor.end === 'b' ? wall.b : wall.a;
}

function dist(a,b) {
  return Math.hypot(a.x-b.x,a.y-b.y);
}

function severityRank(value) {
  return value === 'error' ? 3 : value === 'warning' ? 2 : 1;
}

export function diagnosticAction(issue) {
  const type = String(issue && issue.type || '');
  if (issue && issue.diagonalId) return 'diagonal';
  if (arr(issue && issue.openings).length) return 'opening';
  if (issue && issue.workId) return 'works';
  if (
    type === 'closure_error' ||
    type === 'closure_inconsistent' ||
    type === 'impossible_closure' ||
    type === 'near_perpendicular' ||
    type === 'near_miss_endpoints' ||
    type === 'overlapping_walls' ||
    type === 'sketch_proportion'
  ) return 'solver';
  if (arr(issue && issue.walls).length) return 'wall';
  return 'none';
}

export function buildGeometryDiagnostics({
  validation = {},
  solution = null,
  walls = [],
  openings = [],
  diagonals = [],
  works = []
} = {}) {
  const issues = [];

  for (const source of [...arr(validation.errors), ...arr(validation.warnings)]) {
    issues.push({
      ...source,
      severity: source.severity || 'warning',
      action: diagnosticAction(source)
    });
  }

  if (solution) {
    for (const source of [...arr(solution.errors), ...arr(solution.warnings)]) {
      issues.push({
        ...source,
        severity: source.severity || 'warning',
        action: diagnosticAction(source)
      });
    }

    for (const change of arr(solution.changes)) {
      if (change.reason !== 'perpendicular_snap') continue;
      const delta = Math.abs(Number(change.deltaDeg));
      if (!Number.isFinite(delta) || delta < 1 || delta > 8) continue;
      const source = {
        type: 'near_perpendicular',
        severity: 'info',
        message: `Il muro ${change.wallId} è quasi perpendicolare: correzione proposta ${delta.toFixed(1)}°.`,
        walls: [change.wallId]
      };
      issues.push({ ...source, action: 'solver' });
    }

    const solvedWalls = new Map(arr(solution.walls).map(w => [String(w.id), w]));
    for (const diagonal of diagonals) {
      const a = solvedAnchor(diagonal.a, solvedWalls);
      const b = solvedAnchor(diagonal.b, solvedWalls);
      const declared = Number(diagonal.lengthCm);
      if (!a || !b || !(declared > 0)) continue;
      const calculated = dist(a,b);
      const delta = Math.abs(calculated - declared);
      const tolerance = Math.max(5, declared * 0.02);
      if (delta <= tolerance) continue;
      issues.push({
        type: 'diagonal_mismatch',
        severity: delta > tolerance * 2 ? 'warning' : 'info',
        message: `La diagonale misurata è ${(declared/100).toFixed(2)} m, mentre la geometria ricostruita indica ${(calculated/100).toFixed(2)} m: scarto ${delta.toFixed(1)} cm.`,
        diagonalId: diagonal.id,
        walls: [diagonal.a && diagonal.a.wallId, diagonal.b && diagonal.b.wallId].filter(Boolean),
        deltaCm: Math.round(delta * 10) / 10,
        action: 'diagonal'
      });
    }
  }

  const wallIds = new Set(walls.map(w => String(w.id)));
  const openingIds = new Set(openings.map(o => String(o.id)));
  const roomIds = new Set();
  for (const work of works) {
    if (work && work.targetType === 'room' && work.targetId != null) roomIds.add(String(work.targetId));
  }

  for (const wall of walls) {
    const state = String(wall && wall.constructionState || 'existing');
    if ((state === 'demolish' || state === 'new') &&
        !(Number(wall.constructionThicknessCm) > 0)) {
      issues.push({
        type: 'construction_missing_thickness',
        severity: 'warning',
        message: `Il muro ${wall.id} è ${state === 'demolish' ? 'da demolire' : 'nuovo'}, ma manca lo spessore necessario al calcolo.`,
        walls: [wall.id],
        action: 'wall'
      });
    }
  }

  for (const work of works) {
    if (!work || !work.targetType || work.targetId == null) continue;
    let missing = false;
    if (work.targetType === 'wall') missing = !wallIds.has(String(work.targetId));
    else if (work.targetType === 'opening') missing = !openingIds.has(String(work.targetId));
    if (!missing) continue;
    issues.push({
      type: 'orphan_work_target',
      severity: 'warning',
      message: `La lavorazione "${work.label || work.workId || 'Lavorazione'}" è collegata a un elemento che non esiste più.`,
      workId: work.id || work.workId || String(work.targetId),
      action: 'works'
    });
  }

  const normalized = dedupe(issues).map(issue => ({
    ...issue,
    action: issue.action || diagnosticAction(issue)
  }));

  normalized.sort((a,b) => severityRank(b.severity) - severityRank(a.severity));

  return {
    issues: normalized,
    errors: normalized.filter(i => i.severity === 'error'),
    warnings: normalized.filter(i => i.severity === 'warning'),
    info: normalized.filter(i => i.severity !== 'error' && i.severity !== 'warning'),
    ok: normalized.every(i => i.severity !== 'error' && i.severity !== 'warning')
  };
}

export function visibleDiagnostics(report, ignoredKeys = []) {
  const ignored = new Set(ignoredKeys || []);
  const issues = arr(report && report.issues).filter(i => !ignored.has(i.key));
  return {
    ...report,
    issues,
    errors: issues.filter(i => i.severity === 'error'),
    warnings: issues.filter(i => i.severity === 'warning'),
    info: issues.filter(i => i.severity !== 'error' && i.severity !== 'warning'),
    ok: issues.every(i => i.severity !== 'error' && i.severity !== 'warning')
  };
}
