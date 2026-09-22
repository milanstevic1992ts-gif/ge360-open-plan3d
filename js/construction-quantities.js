/**
 * GE360 — quantità costruttive deterministiche.
 * Nessun coefficiente di sfrido o di rigonfiamento macerie viene inventato qui.
 * Le quantità derivano solo da lunghezza, altezza e spessore realmente presenti.
 */

const ACTIONABLE_STATES = new Set(['demolish', 'new']);

function n(value) {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function round(value, digits = 3) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function wallConstructionMetrics(wall, wallHeightM = 2.7) {
  if (!wall) return null;
  const state = String(wall.constructionState || 'existing');
  if (!ACTIONABLE_STATES.has(state)) return null;

  const lengthCm = n(wall.lengthCm);
  const thicknessCm = n(wall.constructionThicknessCm);
  const height = n(wall.heightCm) ? n(wall.heightCm) / 100 : n(wallHeightM);

  if (!(lengthCm > 0) || !(thicknessCm > 0) || !(height > 0)) {
    return {
      wallId: wall.id,
      state,
      complete: false,
      lengthM: lengthCm > 0 ? round(lengthCm / 100, 3) : null,
      heightM: height > 0 ? round(height, 3) : null,
      thicknessCm: thicknessCm > 0 ? round(thicknessCm, 1) : null,
      grossAreaM2: null,
      twoFacesM2: null,
      volumeM3: null
    };
  }

  const lengthM = lengthCm / 100;
  const thicknessM = thicknessCm / 100;
  const grossAreaM2 = lengthM * height;
  const volumeM3 = grossAreaM2 * thicknessM;

  return {
    wallId: wall.id,
    state,
    complete: true,
    lengthM: round(lengthM, 3),
    heightM: round(height, 3),
    thicknessCm: round(thicknessCm, 1),
    grossAreaM2: round(grossAreaM2, 3),
    twoFacesM2: round(grossAreaM2 * 2, 3),
    volumeM3: round(volumeM3, 4)
  };
}

export function summarizeConstruction(walls, wallHeightM = 2.7) {
  const rows = (walls || [])
    .map(w => wallConstructionMetrics(w, wallHeightM))
    .filter(Boolean);

  const totals = {
    demolitionAreaM2: 0,
    demolitionVolumeM3: 0,
    newWallAreaM2: 0,
    newWallVolumeM3: 0,
    newWallFinishFacesM2: 0
  };

  rows.forEach(row => {
    if (!row.complete) return;
    if (row.state === 'demolish') {
      totals.demolitionAreaM2 += row.grossAreaM2;
      totals.demolitionVolumeM3 += row.volumeM3;
    } else if (row.state === 'new') {
      totals.newWallAreaM2 += row.grossAreaM2;
      totals.newWallVolumeM3 += row.volumeM3;
      totals.newWallFinishFacesM2 += row.twoFacesM2;
    }
  });

  Object.keys(totals).forEach(k => { totals[k] = round(totals[k], k.endsWith('M3') ? 4 : 3); });

  return {
    rows,
    totals,
    complete: rows.every(row => row.complete),
    hasConstruction: rows.length > 0
  };
}

export function constructionWorkLines(metrics) {
  if (!metrics || !metrics.complete) return [];
  if (metrics.state === 'demolish') {
    return [
      { key:'demolition-area', label:'Demolizione muratura', quantity:metrics.grossAreaM2, unit:'m²' },
      { key:'demolition-volume', label:'Volume geometrico da demolire', quantity:metrics.volumeM3, unit:'m³' }
    ];
  }
  if (metrics.state === 'new') {
    return [
      { key:'new-wall-area', label:'Nuova muratura', quantity:metrics.grossAreaM2, unit:'m²' },
      { key:'new-wall-volume', label:'Volume geometrico muratura', quantity:metrics.volumeM3, unit:'m³' },
      { key:'new-wall-faces', label:'Superficie due facce da finire', quantity:metrics.twoFacesM2, unit:'m²' }
    ];
  }
  return [];
}
