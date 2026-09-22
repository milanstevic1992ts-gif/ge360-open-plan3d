export const DEFAULT_OPENING_PRESETS = Object.freeze({
  doorHeightCm: 210,
  armoredDoorHeightCm: 210,
  windowSingleWidthCm: 80,
  windowSingleHeightCm: 120,
  windowSingleSillCm: 90,
  windowDoubleWidthCm: 140,
  windowDoubleHeightCm: 120,
  windowDoubleSillCm: 90
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

  if (key === 'single') {
    return {
      key,
      label: 'Singola',
      widthCm: n(settings.windowSingleWidthCm, DEFAULT_OPENING_PRESETS.windowSingleWidthCm),
      heightCm: n(settings.windowSingleHeightCm, DEFAULT_OPENING_PRESETS.windowSingleHeightCm),
      sillHeightCm: nn(settings.windowSingleSillCm, DEFAULT_OPENING_PRESETS.windowSingleSillCm)
    };
  }

  if (key === 'double') {
    return {
      key,
      label: 'Doppia',
      widthCm: n(settings.windowDoubleWidthCm, DEFAULT_OPENING_PRESETS.windowDoubleWidthCm),
      heightCm: n(settings.windowDoubleHeightCm, DEFAULT_OPENING_PRESETS.windowDoubleHeightCm),
      sillHeightCm: nn(settings.windowDoubleSillCm, DEFAULT_OPENING_PRESETS.windowDoubleSillCm)
    };
  }

  return null;
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
    const single = openingPresetSpec('window', 'single', settings);
    const double = openingPresetSpec('window', 'double', settings);
    if (single && Math.abs(width - single.widthCm) < 0.05) return 'single';
    if (double && Math.abs(width - double.widthCm) < 0.05) return 'double';
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
