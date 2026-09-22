import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../js/app.js',import.meta.url),'utf8');

assert.ok(html.includes('PIANTA PULITA'));
assert.ok(html.includes('Vista tecnica senza comandi'));

const openStart=app.indexOf('function openPresentation()');
const openEnd=app.indexOf('function closePresentation()',openStart);
assert.ok(openStart>=0 && openEnd>openStart);
const openBlock=app.slice(openStart,openEnd);
assert.equal(openBlock.includes('return openResult(activePlanId)'),false,'pianta pulita non deve deviare alla schermata risultato');
assert.ok(openBlock.includes('constructionState'));

const renderStart=app.indexOf('function renderPresentation()');
const renderEnd=app.indexOf('function nativePlugin(name)',renderStart);
assert.ok(renderStart>=0 && renderEnd>renderStart);
const renderBlock=app.slice(renderStart,renderEnd);
assert.ok(renderBlock.includes('constructionVisual'));
assert.ok(renderBlock.includes('openingSegmentOnWall'));
assert.ok(renderBlock.includes('doorKindSpec'));
assert.ok(renderBlock.includes('windowKindSpec'));
assert.equal(renderBlock.includes("var label = (wall.lengthCm / 100)"),false,'nessuna quota muro nella pianta pulita');
assert.equal(renderBlock.includes("fillText(opening.type === 'door' ? 'P' : 'F'"),false,'niente pallini P/F');

console.log('clean technical plan tests OK');
