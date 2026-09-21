import assert from 'node:assert/strict';
import { rectRoomGeometry, snapRectRoomCenter } from '../js/room-template.js';

const room = rectRoomGeometry({ x: 100, y: 100 }, 3, 2);
assert.equal(room.segments.length, 4);
assert.deepEqual(room.segments.map(s => s.lengthCm), [300, 200, 300, 200]);
assert.equal(room.corners[1].x - room.corners[0].x, 240);
assert.equal(room.corners[3].y - room.corners[0].y, 160);
assert.deepEqual(room.closed[0], room.closed[4]);

const target = room.corners[0];
const snapped = snapRectRoomCenter(
  { x: 102, y: 103 },
  3,
  2,
  [{ id: 'old', a: { x: target.x, y: target.y }, b: { x: target.x - 50, y: target.y } }],
  10
);
assert.equal(snapped.snapped, true);
const snappedRoom = rectRoomGeometry(snapped.center, 3, 2);
assert.ok(Math.hypot(snappedRoom.corners[0].x - target.x, snappedRoom.corners[0].y - target.y) < 1e-9);

const free = snapRectRoomCenter({ x: 500, y: 500 }, 3, 2, [], 10);
assert.equal(free.snapped, false);
console.log('room-template tests: OK');
