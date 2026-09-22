/**
 * Convenzioni grafiche GE360 per gli stati costruttivi.
 * Modulo DOM-free per mantenere testabile il rendering.
 */
export const CONSTRUCTION_VISUALS = Object.freeze({
  existing: Object.freeze({
    stroke: '#0f172a',
    lineWidth: 8,
    dash: [],
    label: 'ESISTENTE',
    legendClass: null
  }),
  demolish: Object.freeze({
    stroke: '#dc2626',
    lineWidth: 7,
    dash: [12, 8],
    label: 'DEMOLIRE',
    legendClass: 'demo'
  }),
  new: Object.freeze({
    stroke: '#16a34a',
    lineWidth: 9,
    dash: [],
    label: 'NUOVO',
    legendClass: 'new'
  }),
  'close-opening': Object.freeze({
    stroke: '#d97706',
    lineWidth: 9,
    dash: [4, 4],
    label: 'CHIUSURA',
    legendClass: 'close'
  }),
  'new-opening': Object.freeze({
    stroke: '#7c3aed',
    lineWidth: 7,
    dash: [2, 7],
    label: 'APERTURA',
    legendClass: 'opening'
  })
});

export function normalizeConstructionState(value) {
  const state = String(value || 'existing');
  return Object.prototype.hasOwnProperty.call(CONSTRUCTION_VISUALS, state)
    ? state
    : 'existing';
}

export function constructionVisual(value, selected = false) {
  const state = normalizeConstructionState(value);
  const base = CONSTRUCTION_VISUALS[state];
  if (!selected) return { ...base, state };
  return {
    ...base,
    state,
    stroke: '#2563eb',
    lineWidth: Math.max(base.lineWidth + 2, 10)
  };
}

export function activeConstructionStates(walls) {
  const seen = new Set();
  (walls || []).forEach(wall => {
    const state = normalizeConstructionState(wall && wall.constructionState);
    if (state !== 'existing') seen.add(state);
  });
  return [...seen];
}
