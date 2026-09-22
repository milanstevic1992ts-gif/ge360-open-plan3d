import assert from 'node:assert/strict';
import { buildPlanPayload, payloadFingerprint, measuredWallCount, roomTypeFromName, safePlanId } from '../js/plan-payload.js';
import { createBackendClient, BackendError } from '../js/backend-client.js';
import { compactResult, humanizeText, questionAction, isResultStale, statusInfo, decisionWalls, fmtRange, confidenceLabel, drawBackendPlan, isAgentCorrected } from '../js/backend-results.js';

// ---------------------------------------------------------------- payload
const plan = {
  id: 'plan-lz3k2-ab12c',
  name: 'Bagno Rossi',
  walls: [
    { id: 'w-1', a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, lengthCm: 200.5 },
    { id: 'w-2', a: { x: 200, y: 0 }, b: { x: 200, y: 250 }, lengthCm: 250 },
    { id: 'w-3', a: { x: 200, y: 250 }, b: { x: 0, y: 250 }, lengthCm: null },
    { id: 'w-4', a: { x: 0, y: 250 }, b: { x: 0, y: 0 }, lengthCm: 0 }
  ],
  openings: [
    { id: 'd-1', type: 'door', wallId: 'w-1', widthCm: 80, offsetCm: 60, heightCm: 210, sillHeightCm: 5, position: 0.5 },
    { id: 'f-1', type: 'window', wallId: 'w-3', widthCm: 60, offsetCm: null, position: 0.5, heightCm: 120, sillHeightCm: 100 }
  ],
  rooms: [{ id: 'room-1', name: 'Bagno padronale', wallIds: ['w-1', 'w-2', 'w-3', 'w-4'], heightCm: 250 }],
  diagonals: [{ id: 'q-1', a: { wallId: 'w-1', end: 'a', x: 1, y: 1 }, b: { wallId: 'w-2', end: 'b', x: 9, y: 9 }, lengthCm: 320.2 }],
  notes: [],
  wallHeightM: 2.7,
  wallThicknessCm: 10,
  wallReference: 'partitionAxis'
};
const payload = buildPlanPayload(plan);
assert.equal(payload.version, 4);
assert.equal(payload.planId, 'plan-lz3k2-ab12c');
assert.equal(payload.walls[0].lengthCm, 200.5, 'precisione al millimetro');
assert.equal(payload.walls[2].lengthCm, null, 'muro non misurato -> null');
assert.equal(payload.walls[3].lengthCm, null, 'lunghezza 0 non deve arrivare al backend (422)');
assert.equal(payload.walls[0].thicknessMm, 100);
assert.equal(payload.wallReference, 'partitionAxis');
assert.equal(payload.openings[0].sillHeightCm, undefined, 'le porte non hanno davanzale');
assert.equal(payload.openings[1].offsetCm, null);
assert.equal(payload.rooms[0].type, 'bagno');
assert.equal(payload.rooms[0].heightCm, 250);
assert.deepEqual(payload.diagonals[0].a, { x: 0, y: 0 }, 'la quota segue l\'angolo del muro');
assert.deepEqual(payload.diagonals[0].b, { x: 200, y: 250 });
assert.equal(measuredWallCount(payload), 2);
assert.equal(roomTypeFromName('Open space'), 'soggiorno');
assert.equal(roomTypeFromName('Terrazza'), 'esterno');
assert.equal(safePlanId('plan id/../x'), 'plan-id-x');
const fp = payloadFingerprint(payload);
const moved = buildPlanPayload(Object.assign({}, plan, { walls: plan.walls.map((w, i) => i ? w : Object.assign({}, w, { lengthCm: 201 })) }));
assert.notEqual(payloadFingerprint(moved), fp, 'una misura cambiata invalida il risultato');
assert.equal(payloadFingerprint(buildPlanPayload(plan)), fp);

// ---------------------------------------------------------------- client con fetch finto
function fakeServer(routes) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const path = url.replace('http://10.88.0.1:9888/api/v1', '');
    const handler = routes[(opts.method || 'GET') + ' ' + path];
    if (!handler) return { ok: false, status: 404, json: async () => ({ detail: 'Not found' }) };
    const out = typeof handler === 'function' ? handler(opts) : handler;
    return { ok: (out.status || 200) < 400, status: out.status || 200, json: async () => out.body, blob: async () => out.body };
  };
  return { impl, calls };
}

let polls = 0;
const processedDecisions = [{ id: 'd1', kind: 'typo', text: 'Parete w-2: misurata 350,0 cm, trattata come 305,0 cm (cifre invertite)', probability: 0.96, wallId: 'w-2', declaredMm: 3500, usedMm: 3050 }];
const processed = {
  walls: [{ id: 'w-1', start: { x: 0, y: 0 }, end: { x: 2005, y: 0 }, thicknessMm: 100, declaredLengthMm: 2005, calculatedLengthMm: 2005, lengthSource: 'MEASURED', measured: true, withinTolerance: true },
          { id: 'w-3', start: { x: 2005, y: 2500 }, end: { x: 0, y: 2500 }, thicknessMm: 100, declaredLengthMm: 2005, calculatedLengthMm: 2005, lengthSource: 'CALCULATED', measured: false, withinTolerance: true }],
  openings: [{ id: 'd-1', type: 'door', wallId: 'w-1', center: { x: 1000, y: 0 }, widthMm: 800, heightMm: 2100, sillHeightMm: 0 }],
  rooms: [{ roomId: 'room-1', name: 'Bagno padronale', type: 'bagno', polygon: [{ x: 0, y: 0 }, { x: 2005, y: 0 }, { x: 2005, y: 2500 }, { x: 0, y: 2500 }],
            quality: 'OK', confidence: 1, floorAreaM2: 5.0125, ceilingAreaM2: 5.0125, perimeterM: 9.01, heightMm: 2500, volumeM3: 12.53,
            widthM: 2.005, depthM: 2.5, skirtingM: 8.21, grossWallAreaM2: 22.5, netWallAreaM2: 20.8, openingsAreaM2: 1.7, revealsAreaM2: 0.5,
            tilingHeightMm: 2200, tilingAreaM2: 18, paintAreaM2: 12, openings: [], questions: [] }],
  metadata: { ai: null, decisions: processedDecisions }
};
processed.rooms[0].floorAreaRangeM2 = [4.98, 5.05];
processed.rooms[0].decisions = ['Parete w-2: misurata 350,0 cm, trattata come 305,0 cm (cifre invertite) — probabilità 96%'];
const server = fakeServer({
  'POST /plans/refine': () => ({ body: { ok: true, planId: payload.planId, jobId: 'job-1', status: 'QUEUED' } }),
  'GET /jobs/job-1': () => ({ body: { jobId: 'job-1', status: ++polls < 2 ? 'PROCESSING' : 'DONE' } }),
  ['GET /plans/' + payload.planId]: { body: { status: 'PROCESSED', currentVersion: 3, quality: { status: 'OK' }, files: { json: '/x' },
    totals: { floorAreaM2: 5.0125, questions: ['Bagno: Parete w-4: non misurata e non ricavabile dalle altre misure. Serve la misura.'], aiSummary: 'Bagno 2 x 2,5 m' } } },
  ['GET /plans/' + payload.planId + '/processed']: { body: processed },
  ['GET /plans/' + payload.planId + '/versions']: { body: [
    { version: 3, status: 'PROCESSED', completedAt: '2026-09-21T10:00:00Z', totals: { works: 2 } },
    { version: 2, status: 'PROCESSED', completedAt: '2026-09-20T10:00:00Z', totals: { works: 1 } }
  ] },
  ['GET /plans/' + payload.planId + '/versions/2']: { body: { version: 2, status: 'PROCESSED', completedAt: '2026-09-20T10:00:00Z', totals: { floorAreaM2: 5.0125 } } },
  ['GET /plans/' + payload.planId + '/versions/2/processed']: { body: processed },
  ['GET /plans/' + payload.planId + '/versions/2/pdf']: { body: new Blob(['old-pdf'], { type: 'application/pdf' }) }
});
const client = createBackendClient({ baseUrl: '10.88.0.1:9888', apiKey: 'k', fetchImpl: server.impl });
const steps = [];
const out = await client.processPlan(payload, { onProgress: s => steps.push(s) });
assert.equal(out.status.status, 'PROCESSED');
assert.equal(out.processed.rooms.length, 1);
assert.deepEqual(steps.filter((s, i) => steps.indexOf(s) === i), ['SENDING', 'PROCESSING', 'DONE', 'DOWNLOADING']);
assert.equal(server.calls[0].opts.headers['X-GE360-API-Key'], 'k');
assert.equal(JSON.parse(server.calls[0].opts.body).walls[2].lengthCm, null);
const versions = await client.listVersions(payload.planId);
assert.deepEqual(versions.map(v => v.version), [3, 2]);
const version2 = await client.fetchVersion(payload.planId, 2);
assert.equal(version2.metadata.version, 2);
assert.equal(version2.processed.rooms.length, 1);
const oldPdf = await client.downloadArtifact(payload.planId, 'pdf', 2);
assert.equal(oldPdf.type, 'application/pdf');

let flakyPdfAttempts = 0;
const flakyPdfServer = fakeServer({
  ['GET /plans/' + payload.planId + '/pdf']: () => {
    flakyPdfAttempts += 1;
    if (flakyPdfAttempts === 1) throw new TypeError('temporary bridge interruption');
    return { body: new Blob(['current-pdf'], { type: 'application/pdf' }) };
  },
  'GET /health': { body: { ok: true } }
});
const flakyPdfClient = createBackendClient({
  baseUrl: '10.88.0.1:9888',
  apiKey: 'k',
  fetchImpl: flakyPdfServer.impl
});
const retriedPdf = await flakyPdfClient.downloadArtifact(payload.planId, 'pdf');
assert.equal(retriedPdf.type, 'application/pdf');
assert.equal(flakyPdfAttempts, 2, 'il PDF viene ritentato se il backend risponde al probe health');
assert.equal(flakyPdfServer.calls.some(call => call.url.endsWith('/health')), true);

const bad = createBackendClient({ baseUrl: 'http://10.88.0.1:9888/api/v1', apiKey: 'x', fetchImpl: fakeServer({
  'POST /plans/refine': { status: 422, body: { detail: [{ loc: ['body', 'planId'], msg: 'String should match pattern' }] } }
}).impl });
await assert.rejects(() => bad.submitPlan(payload), e => e instanceof BackendError && e.status === 422 && /planId/.test(e.message));
const unauthorized = createBackendClient({ baseUrl: 'http://10.88.0.1:9888', apiKey: 'x', fetchImpl: fakeServer({
  'POST /plans/refine': { status: 401, body: { detail: 'Invalid API key' } }
}).impl });
await assert.rejects(() => unauthorized.submitPlan(payload), e => e.status === 401 && /API key/.test(e.message));
const offline = createBackendClient({ baseUrl: 'http://10.88.0.1:9888', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
await assert.rejects(() => offline.submitPlan(payload), e => e.code === 'NETWORK');
const failing = createBackendClient({ baseUrl: 'http://10.88.0.1:9888', fetchImpl: fakeServer({
  'GET /jobs/j': { body: { status: 'ERROR', error: 'at least one measured wall is required' } }
}).impl });
await assert.rejects(() => failing.waitForJob('j', { intervalMs: 1 }), e => e.code === 'JOB_ERROR');

// ---------------------------------------------------------------- risultato
const compact = compactResult(out.status, out.processed, { fingerprint: fp });
assert.equal(compact.status, 'PROCESSED');
assert.equal(compact.walls[1].lengthSource, 'CALCULATED');
assert.equal(compact.rooms[0].tilingAreaM2, 18);
assert.equal(compact.totals.aiSummary, 'Bagno 2 x 2,5 m');
assert.ok(JSON.stringify(compact).length < 8000, 'il risultato salvato sul telefono resta compatto');
assert.equal(isResultStale(compact, fp), false);
assert.equal(isResultStale(compact, payloadFingerprint(moved)), true);
const q = compact.totals.questions[0];
assert.deepEqual(questionAction(q, plan.walls), { type: 'wall', wallId: 'w-4' });
assert.equal(humanizeText(q, plan.walls), 'Bagno: Parete muro 4: non misurata e non ricavabile dalle altre misure. Serve la misura.');
assert.deepEqual(questionAction('Camera: Posizione del tramezzo w-2 lungo la parete w-1 presa dallo schizzo: misura la distanza da un angolo.', plan.walls), { type: 'quote' });
assert.deepEqual(questionAction('La finestra è sopra la vasca?', plan.walls), { type: 'info' });
assert.equal(statusInfo('NEEDS_REVIEW').label, 'DA VERIFICARE');

// agente autonomo: decisioni, intervalli, affidabilità
assert.equal(compact.decisions.length, 1);
assert.equal(compact.decisions[0].probability, 0.96);
assert.deepEqual(decisionWalls(compact.decisions[0], plan.walls), ['w-2']);
assert.deepEqual(compact.rooms[0].floorAreaRangeM2, [4.98, 5.05]);
assert.equal(fmtRange(compact.rooms[0].floorAreaRangeM2), '4,98–5,05');
assert.equal(humanizeText(compact.rooms[0].decisions[0], plan.walls).startsWith('Parete muro 2'), true);
assert.equal(confidenceLabel(0.9), 'alta');
assert.equal(confidenceLabel(0.4), 'bassa');

console.log('backend client / payload / result tests OK');

// Regressioni: id simili, vecchi risultati e selezione singola/multipla.
assert.deepEqual(decisionWalls({text: 'Parete w-20: corretta'}, [{id:'w-2'}, {id:'w-20'}]), ['w-20']);
assert.equal(fmtRange([5, 4]), '');
assert.equal(fmtRange([null, 5]), '');
assert.equal(isAgentCorrected({id:'w-2', calculatedLengthMm:3050}, processedDecisions), true);
assert.equal(isAgentCorrected({id:'w-2', calculatedLengthMm:3500}, processedDecisions), false);
assert.equal(isAgentCorrected({id:'w-2', calculatedLengthMm:3050}), false);
const strokes = [];
const ctx = new Proxy({stroke() { strokes.push(this.strokeStyle); }}, {
  get(target, key) { return key in target ? target[key] : () => {}; }
});
const canvas = {getContext: () => ctx, getBoundingClientRect: () => ({width:400, height:300})};
const renderWalls = {walls: compact.walls, rooms:[], openings:[]};
drawBackendPlan(canvas, renderWalls, {highlightWallId:'w-1', highlightWallIds:[]});
assert.equal(strokes[0], '#2563eb');
strokes.length = 0;
drawBackendPlan(canvas, renderWalls, {highlightWallIds:['w-1','w-3']});
assert.deepEqual(strokes, ['#2563eb', '#2563eb']);
console.log('agent rendering regressions OK');
