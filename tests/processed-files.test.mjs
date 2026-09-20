import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, availableFileEntries, fileNameFor } from '../js/processed-files.js';

test('nomi file GE360 sono sicuri',()=>{
  assert.equal(sanitizeName('Bagno Rossi / 1'),'Bagno-Rossi-1');
});

test('fileName include versione e formato',()=>{
  assert.equal(fileNameFor('Bagno Rossi',4,'pdf'),'GE360-Bagno-Rossi-v4.pdf');
});

test('mostra solo formati realmente disponibili',()=>{
  const items=availableFileEntries({pdf:'/a.pdf',png:null,svg:'/a.svg',plan3d:'/3d.json'});
  assert.deepEqual(items.map(x=>x.type),['pdf','svg']);
});
