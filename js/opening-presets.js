export const DEFAULT_OPENING_PRESETS = Object.freeze({
  doorHeightCm: 210,
  armoredDoorHeightCm: 210,
  windowSingleWidthCm: 80,
  windowSingleHeightCm: 120,
  windowSingleSillCm: 90,
  windowDoubleWidthCm: 140,
  windowDoubleHeightCm: 120,
  windowDoubleSillCm: 90,
  windowTripleWidthCm: 210,
  windowTripleHeightCm: 120,
  windowTripleSillCm: 90,
  windowSlidingWidthCm: 180,
  windowSlidingHeightCm: 120,
  windowSlidingSillCm: 90,
  balconyWidthCm: 80,
  balconyHeightCm: 210,
  balconyDoubleWidthCm: 140,
  balconyDoubleHeightCm: 210
});

export const DOOR_KINDS = Object.freeze([
  'internal',
  'double',
  'sliding',
  'armored',
  'armored-double'
]);

export const DOOR_KIND_LABELS = Object.freeze({
  internal: 'Porta interna',
  double: 'Porta doppia',
  sliding: 'Porta scorrevole',
  armored: 'Porta blindata',
  'armored-double': 'Blindata doppia'
});

const DOOR_WIDTH_PRESETS = Object.freeze({
  internal: [60, 70, 80, 90],
  double: [120, 140, 160],
  sliding: [70, 80, 90],
  armored: [80, 85, 90],
  'armored-double': [120, 140, 160]
});

export const WINDOW_KINDS = Object.freeze([
  'single',
  'double',
  'triple',
  'sliding',
  'balcony',
  'balcony-double'
]);

export const WINDOW_KIND_LABELS = Object.freeze({
  single: 'Finestra singola',
  double: 'Finestra doppia',
  triple: 'Finestra tripla',
  sliding: 'Finestra scorrevole',
  balcony: 'Portafinestra',
  'balcony-double': 'Portafinestra doppia'
});

function n(value, fallback) {
  const x = Number(value);
  return Number.isFinite(x) && x > 0 ? x : fallback;
}

function nn(value, fallback) {
  const x = Number(value);
  return Number.isFinite(x) && x >= 0 ? x : fallback;
}

export function normalizeDoorKind(value) {
  const kind = String(value || 'internal');
  return DOOR_KINDS.includes(kind) ? kind : 'internal';
}

export function doorPresetKeys(kind) {
  return (DOOR_WIDTH_PRESETS[normalizeDoorKind(kind)] || []).map(String);
}

export function doorKindSpec(kind) {
  const normalized = normalizeDoorKind(kind);
  return {
    kind: normalized,
    label: DOOR_KIND_LABELS[normalized],
    leaves: normalized === 'double' || normalized === 'armored-double' ? 2 : 1,
    sliding: normalized === 'sliding',
    armored: normalized === 'armored' || normalized === 'armored-double'
  };
}

export function normalizeWindowKind(value) {
  const kind = String(value || 'single');
  return WINDOW_KINDS.includes(kind) ? kind : 'single';
}

export function windowKindSpec(kind, settings = {}) {
  const normalized = normalizeWindowKind(kind);
  if (normalized === 'single') {
    return {
      kind: normalized,
      label: WINDOW_KIND_LABELS[normalized],
      widthCm: n(settings.windowSingleWidthCm, DEFAULT_OPENING_PRESETS.windowSingleWidthCm),
      heightCm: n(settings.windowSingleHeightCm, DEFAULT_OPENING_PRESETS.windowSingleHeightCm),
      sillHeightCm: nn(settings.windowSingleSillCm, DEFAULT_OPENING_PRESETS.windowSingleSillCm),
      leaves: 1, sliding: false, balconyDoor: false
    };
  }
  if (normalized === 'double') {
    return {
      kind: normalized,
      label: WINDOW_KIND_LABELS[normalized],
      widthCm: n(settings.windowDoubleWidthCm, DEFAULT_OPENING_PRESETS.windowDoubleWidthCm),
      heightCm: n(settings.windowDoubleHeightCm, DEFAULT_OPENING_PRESETS.windowDoubleHeightCm),
      sillHeightCm: nn(settings.windowDoubleSillCm, DEFAULT_OPENING_PRESETS.windowDoubleSillCm),
      leaves: 2, sliding: false, balconyDoor: false
    };
  }
  if (normalized === 'triple') {
    return {
      kind: normalized,
      label: WINDOW_KIND_LABELS[normalized],
      widthCm: n(settings.windowTripleWidthCm, DEFAULT_OPENING_PRESETS.windowTripleWidthCm),
      heightCm: n(settings.windowTripleHeightCm, DEFAULT_OPENING_PRESETS.windowTripleHeightCm),
      sillHeightCm: nn(settings.windowTripleSillCm, DEFAULT_OPENING_PRESETS.windowTripleSillCm),
      leaves: 3, sliding: false, balconyDoor: false
    };
  }
  if (normalized === 'sliding') {
    return {
      kind: normalized,
      label: WINDOW_KIND_LABELS[normalized],
      widthCm: n(settings.windowSlidingWidthCm, DEFAULT_OPENING_PRESETS.windowSlidingWidthCm),
      heightCm: n(settings.windowSlidingHeightCm, DEFAULT_OPENING_PRESETS.windowSlidingHeightCm),
      sillHeightCm: nn(settings.windowSlidingSillCm, DEFAULT_OPENING_PRESETS.windowSlidingSillCm),
      leaves: 2, sliding: true, balconyDoor: false
    };
  }
  if (normalized === 'balcony') {
    return {
      kind: normalized,
      label: WINDOW_KIND_LABELS[normalized],
      widthCm: n(settings.balconyWidthCm, DEFAULT_OPENING_PRESETS.balconyWidthCm),
      heightCm: n(settings.balconyHeightCm, DEFAULT_OPENING_PRESETS.balconyHeightCm),
      sillHeightCm: 0,
      leaves: 1, sliding: false, balconyDoor: true
    };
  }
  return {
    kind: 'balcony-double',
    label: WINDOW_KIND_LABELS['balcony-double'],
    widthCm: n(settings.balconyDoubleWidthCm, DEFAULT_OPENING_PRESETS.balconyDoubleWidthCm),
    heightCm: n(settings.balconyDoubleHeightCm, DEFAULT_OPENING_PRESETS.balconyDoubleHeightCm),
    sillHeightCm: 0,
    leaves: 2, sliding: false, balconyDoor: true
  };
}

export function applyWindowKind(opening, kind, settings = {}) {
  const meta = windowKindSpec(kind, settings);
  return Object.assign({}, opening, {
    windowKind: meta.kind,
    widthCm: meta.widthCm,
    heightCm: meta.heightCm,
    sillHeightCm: meta.sillHeightCm,
    leaves: meta.leaves,
    sliding: meta.sliding,
    balconyDoor: meta.balconyDoor,
    presetKey: meta.kind
  });
}

export function openingPresetSpec(type, key, settings = {}, context = {}) {
  if (type === 'door') {
    const kind = normalizeDoorKind(context.doorKind || settings.lastDoorKind || 'internal');
    const widths = doorPresetKeys(kind);
    if (!widths.includes(String(key))) return null;
    const meta = doorKindSpec(kind);
    return {
      key: String(key),
      label: String(key) + ' cm',
      widthCm: Number(key),
      heightCm: meta.armored
        ? n(settings.armoredDoorHeightCm, DEFAULT_OPENING_PRESETS.armoredDoorHeightCm)
        : n(settings.doorHeightCm, DEFAULT_OPENING_PRESETS.doorHeightCm),
      sillHeightCm: null,
      doorKind: meta.kind,
      category: meta.armored ? 'armored' : 'interior',
      leaves: meta.leaves,
      sliding: meta.sliding,
      armored: meta.armored
    };
  }

  if (type !== 'window') return null;
  const kind = normalizeWindowKind(context.windowKind || key || settings.lastWindowKind || 'single');
  if (String(key) !== kind && String(key) !== 'standard') return null;
  const meta = windowKindSpec(kind, settings);
  return {
    key: meta.kind,
    label: meta.label,
    widthCm: meta.widthCm,
    heightCm: meta.heightCm,
    sillHeightCm: meta.sillHeightCm,
    windowKind: meta.kind,
    leaves: meta.leaves,
    sliding: meta.sliding,
    balconyDoor: meta.balconyDoor
  };
}

export function detectOpeningPreset(opening, settings = {}) {
  if (!opening) return null;
  if (opening.presetKey && opening.presetKey !== 'custom') return opening.presetKey;
  const width = Number(opening.widthCm);

  if (opening.type === 'door') {
    const kind = normalizeDoorKind(opening.doorKind || (opening.armored ? 'armored' : 'internal'));
    for (const key of doorPresetKeys(kind)) {
      if (Math.abs(width - Number(key)) < 0.05) return key;
    }
    return 'custom';
  }

  if (opening.type === 'window') {
    const kind = normalizeWindowKind(opening.windowKind || 'single');
    const spec = windowKindSpec(kind, settings);
    if (
      Math.abs(width - spec.widthCm) < 0.05 &&
      Math.abs(Number(opening.heightCm) - spec.heightCm) < 0.05 &&
      Math.abs(Number(opening.sillHeightCm || 0) - spec.sillHeightCm) < 0.05
    ) return kind;

    // Backward compatibility for older plans without windowKind.
    for (const legacy of ['single', 'double']) {
      const candidate = windowKindSpec(legacy, settings);
      if (Math.abs(width - candidate.widthCm) < 0.05) return legacy;
    }
    return 'custom';
  }

  return null;
}

export function applyDoorKind(opening, kind) {
  const meta = doorKindSpec(kind);
  return Object.assign({}, opening, {
    doorKind: meta.kind,
    category: meta.armored ? 'armored' : 'interior',
    leaves: meta.leaves,
    sliding: meta.sliding,
    armored: meta.armored
  });
}

export function fitOpeningToWall(opening, wallLengthCm) {
  const out = { ...opening };
  const length = Number(wallLengthCm);
  const width = Number(out.widthCm);
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(width) || width <= 0) {
    return { opening: out, fits: true, inferredOffset: false };
  }
  if (width > length) return { opening: out, fits: false, inferredOffset: false };

  let center = Number.isFinite(Number(out.position)) ? Number(out.position) * length : length / 2;
  center = Math.max(width / 2, Math.min(length - width / 2, center));
  const reference = out.referenceEnd === 'b' ? 'b' : 'a';
  const offset = reference === 'b'
    ? length - center - width / 2
    : center - width / 2;

  out.position = center / length;
  out.offsetCm = Math.round(Math.max(0, offset) * 10) / 10;
  return { opening: out, fits: true, inferredOffset: true };
}

export function offsetForReference(opening, wallLengthCm, referenceEnd) {
  const out = { ...opening, referenceEnd: referenceEnd === 'b' ? 'b' : 'a' };
  const length = Number(wallLengthCm);
  const width = Number(out.widthCm);
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(width) || width <= 0) return out;

  let center;
  if (Number.isFinite(Number(opening.position))) center = Number(opening.position) * length;
  else if (Number.isFinite(Number(opening.offsetCm))) {
    center = opening.referenceEnd === 'b'
      ? length - Number(opening.offsetCm) - width / 2
      : Number(opening.offsetCm) + width / 2;
  } else center = length / 2;

  center = Math.max(width / 2, Math.min(length - width / 2, center));
  out.position = center / length;
  out.offsetCm = Math.round((out.referenceEnd === 'b'
    ? length - center - width / 2
    : center - width / 2) * 10) / 10;
  return out;
}
