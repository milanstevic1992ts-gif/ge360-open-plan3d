import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');

test('DOM non contiene id duplicati',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  const duplicates=ids.filter((id,i)=>ids.indexOf(id)!==i);
  assert.deepEqual([...new Set(duplicates)],[]);
});

test('DOM contiene hook Elaborati obbligatori',()=>{
  for(const id of ['rawTabBtn','processedTabBtn','processedWorkspace','elaborateBtn','processNowBtn','processedCard','open2dBtn','open3dBtn','shareProcessedBtn','saveProcessedBtn','downloadAllBtn','versionsList','missingMeasuresBackdrop','viewer2dBackdrop','viewer3dBackdrop']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
});

test('app conserva storage legacy e funzioni editor principali',()=>{
  assert.match(app,/ge360-rilievo-library-v3/);
  assert.match(app,/ge360-rilievo-settings-v1/);
  for(const fn of ['commitStroke','editWallMeasurement','placeOpening','deleteCurrentOpening','openSolver','openRoomPicker','openSurfaces','openPresentation','undo']){
    assert.match(app,new RegExp('function '+fn+'\\b'));
  }
});

test('app usa backend client e non fetch sparsi per elaborazione',()=>{
  assert.match(app,/BackendClient/);
  assert.match(app,/startProcessing/);
  assert.match(app,/pollProcessing/);
  assert.match(app,/PROCESS_POLL_MS = 2000/);
});

test('chiave API non è hardcoded come valore',()=>{
  assert.doesNotMatch(app,/apiKey\s*:\s*['"][A-Za-z0-9_-]{16,}['"]/);
});

test('menu mantiene SISTEMA PIANTA e aggiunge ELABORA RILIEVO',()=>{
  assert.match(html,/SISTEMA PIANTA/);
  assert.match(html,/ELABORA RILIEVO/);
});


test('AMBIENTE non apre PRESENTA e chiude eventuali overlay di presentazione',()=>{
  assert.match(app,/function openRoomPicker\(\)[\s\S]*closePresentation\(\);[\s\S]*roomPickMode = true/);
  assert.match(app,/roomBtn'\)\.addEventListener\('click',[\s\S]*runTool\(openRoomPicker\)/);
  assert.doesNotMatch(app,/roomBtn'\)\.addEventListener\('click',[^\n]*openPresentation/);
});

test('PRESENTA usa la geometria proporzionata solo quando il solver ha chiuso davvero',()=>{
  assert.match(app,/var solvedClosed = !!\([\s\S]*solved\.result\.closure\.closed/);
  assert.match(app,/var displayWalls = solvedClosed \? clone\(solved\.walls\) : clone\(walls\)/);
  assert.match(app,/walls: displayWalls/);
  assert.match(app,/var displayFaces = buildFaces\(pwalls\)/);
});

test('PRESENTA non può aprirsi durante selezione AMBIENTE',()=>{
  assert.match(app,/function openPresentation\(\) \{[\s\S]*if \(roomPickMode\) return toast\('Prima termina la selezione AMBIENTE'\)/);
});


test('porte e finestre sono renderizzate come vere aperture con controllo porta',()=>{
  assert.match(html,/id="swingToggleBtn"/);
  assert.match(app,/function drawOpeningSymbol\(/);
  assert.match(app,/openingInterval\(opening, wall\)/);
  assert.match(app,/Cancella davvero il tratto di muro/);
  assert.match(app,/swingToggleBtn'\)\.addEventListener\('click', toggleDoorSwing\)/);
});

test('interventi hanno preset, stile grafico e quantità strutturata',()=>{
  assert.match(html,/id="noteWorkPresets"/);
  assert.match(html,/data-note-style="callout"/);
  assert.match(html,/data-note-style="text"/);
  assert.match(app,/function interventionQuantityHint\(/);
  assert.match(app,/quantityHint: interventionQuantityHint\(pendingNoteTarget\)/);
  assert.match(app,/kind: 'intervention'/);
  assert.match(app,/workItems: workItems/);
});


test('modifica muri espone spostamento estremi ed eliminazione sicura',()=>{
  assert.match(html,/id="moveWallStartBtn"/);
  assert.match(html,/id="moveWallEndBtn"/);
  assert.match(html,/id="deleteWallBtn"/);
  assert.match(app,/function deleteSelectedWall\(/);
  assert.match(app,/function startWallEndpointMove\(/);
  assert.match(app,/function commitWallEndpointMove\(/);
  assert.match(app,/openings = openings\.filter\(function \(o\) \{ return o\.wallId !== wall\.id; \}\)/);
  assert.match(app,/rawStrokes = rawStrokes\.filter/);
  assert.match(app,/candidate\[end\] = \{ x: p\.x, y: p\.y \}/);
});


test('editor avanzato espone redo e selezione diretta elementi',()=>{
  assert.match(html,/id="redoBtn"/);
  assert.match(html,/id="objectActionBar"/);
  assert.match(html,/id="objectMeasureBtn"/);
  assert.match(html,/id="objectMoveBtn"/);
  assert.match(html,/id="objectWorkBtn"/);
  assert.match(html,/id="objectDeleteBtn"/);
  assert.match(app,/function redo\(/);
  assert.match(app,/function armLongPress\(/);
  assert.match(app,/function showObjectActionBar\(/);
  assert.match(app,/function commitOpeningMove\(/);
});

test('vista interventi è separata dal rilievo e supporta annotazioni trascinabili',()=>{
  assert.match(html,/id="stageModeToggle"/);
  assert.match(html,/id="surveyViewBtn"/);
  assert.match(html,/id="worksViewBtn"/);
  assert.match(app,/function setEditorLayer\(/);
  assert.match(app,/function drawInterventionSurfaces\(/);
  assert.match(app,/function chooseAnnotationPosition\(/);
  assert.match(app,/function startAnnotationDrag\(/);
  assert.match(app,/labelOffset/);
});

test('misura muro attiva proporzione live e riparazione T',()=>{
  assert.match(app,/function applyLiveProportion\(/);
  assert.match(app,/applyMeasuredWallProportion\(/);
  assert.match(app,/function autoRepairTJunctions\(/);
  assert.match(app,/splitWallAtTJunction\(/);
  assert.match(app,/applyLiveProportion\(wall\.id\)/);
});

test('FATTO esegue un controllo completo prima di esportare',()=>{
  assert.match(html,/id="finishCheckBackdrop"/);
  assert.match(html,/id="finishCheckList"/);
  assert.match(app,/function buildSurveyChecks\(/);
  assert.match(app,/function openFinishCheck\(/);
  assert.match(app,/doneBtn'\)\.addEventListener\('click', openFinishCheck\)/);
});
