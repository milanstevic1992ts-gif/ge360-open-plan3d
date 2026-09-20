let threePromise = null;

async function loadThree() {
  if (!threePromise) {
    threePromise = Promise.all([
      import('https://esm.sh/three@0.180.0'),
      import('https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js'),
      import('https://esm.sh/three@0.180.0/examples/jsm/loaders/GLTFLoader.js')
    ]).then(([THREE, controls, loaders]) => ({
      THREE,
      OrbitControls: controls.OrbitControls,
      GLTFLoader: loaders.GLTFLoader
    }));
  }
  return threePromise;
}

function unitScale(units) {
  if (String(units || '').toLowerCase() === 'mm') return 0.001;
  if (String(units || '').toLowerCase() === 'cm') return 0.01;
  return 1;
}

function wallBox(THREE, wall, scale, material) {
  const start = wall.start || (wall.a ? [wall.a.x, wall.a.y] : null);
  const end = wall.end || (wall.b ? [wall.b.x, wall.b.y] : null);
  if (!start || !end) return null;
  const x1 = Number(start[0]) * scale, z1 = Number(start[1]) * scale;
  const x2 = Number(end[0]) * scale, z2 = Number(end[1]) * scale;
  const dx = x2 - x1, dz = z2 - z1;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length <= 0) return null;
  const height = Number(wall.height || wall.heightMm || 2700) * scale;
  const thickness = Number(wall.thickness || wall.thicknessMm || 120) * scale;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, thickness), material);
  mesh.position.set((x1 + x2) / 2, height / 2, (z1 + z2) / 2);
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.userData.wallId = wall.id || null;
  return mesh;
}

function openingMarker(THREE, opening, wallMap, scale, material, kind) {
  const wall = wallMap.get(String(opening.wallId || opening.wall_id || ''));
  if (!wall) return null;
  const start = wall.start || (wall.a ? [wall.a.x, wall.a.y] : null);
  const end = wall.end || (wall.b ? [wall.b.x, wall.b.y] : null);
  if (!start || !end) return null;
  const t = Number.isFinite(Number(opening.position)) ? Number(opening.position) : 0.5;
  const x1 = Number(start[0]) * scale, z1 = Number(start[1]) * scale;
  const x2 = Number(end[0]) * scale, z2 = Number(end[1]) * scale;
  const width = Number(opening.width || opening.widthMm || opening.widthCm * 10 || 900) * scale;
  const height = Number(opening.height || opening.heightMm || (kind === 'door' ? 2100 : 1200)) * scale;
  const sill = Number(opening.sillHeight || opening.sill_height || (kind === 'door' ? 0 : 900)) * scale;
  const thickness = Math.max(0.035, Number(wall.thickness || 120) * scale * 1.15);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, thickness), material);
  mesh.position.set(x1 + (x2 - x1) * t, sill + height / 2, z1 + (z2 - z1) * t);
  mesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
  return mesh;
}

function boundsFromWalls(plan, scale) {
  const points = [];
  (plan.walls || []).forEach(w => {
    const a = w.start || (w.a ? [w.a.x, w.a.y] : null);
    const b = w.end || (w.b ? [w.b.x, w.b.y] : null);
    if (a) points.push([Number(a[0]) * scale, Number(a[1]) * scale]);
    if (b) points.push([Number(b[0]) * scale, Number(b[1]) * scale]);
  });
  if (!points.length) return { minX: -2, maxX: 2, minZ: -2, maxZ: 2 };
  return {
    minX: Math.min(...points.map(p => p[0])),
    maxX: Math.max(...points.map(p => p[0])),
    minZ: Math.min(...points.map(p => p[1])),
    maxZ: Math.max(...points.map(p => p[1]))
  };
}

export async function renderPlan3D({ container, plan3d = null, glbBlob = null }) {
  const { THREE, OrbitControls, GLTFLoader } = await loadThree();
  container.innerHTML = '';

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf8fafc);
  const camera = new THREE.PerspectiveCamera(48, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(5, 10, 6);
  scene.add(sun);

  const root = new THREE.Group();
  scene.add(root);

  let target = new THREE.Vector3(0, 0.8, 0);
  let span = 6;

  if (glbBlob) {
    const url = URL.createObjectURL(glbBlob);
    const gltf = await new Promise((resolve, reject) => new GLTFLoader().load(url, resolve, undefined, reject));
    URL.revokeObjectURL(url);
    root.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    target.copy(center);
    span = Math.max(size.x, size.y, size.z, 1);
  } else if (plan3d) {
    const scale = unitScale(plan3d.units);
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xd7dde7, roughness: 0.85 });
    const doorMaterial = new THREE.MeshStandardMaterial({ color: 0x22c55e, transparent: true, opacity: 0.72 });
    const windowMaterial = new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.65 });
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 1 });
    const wallMap = new Map();

    (plan3d.walls || []).forEach(w => {
      wallMap.set(String(w.id || ''), w);
      const mesh = wallBox(THREE, w, scale, wallMaterial);
      if (mesh) root.add(mesh);
    });

    (plan3d.doors || []).forEach(o => {
      const mesh = openingMarker(THREE, o, wallMap, scale, doorMaterial, 'door');
      if (mesh) root.add(mesh);
    });
    (plan3d.windows || []).forEach(o => {
      const mesh = openingMarker(THREE, o, wallMap, scale, windowMaterial, 'window');
      if (mesh) root.add(mesh);
    });

    const b = boundsFromWalls(plan3d, scale);
    const width = Math.max(0.5, b.maxX - b.minX);
    const depth = Math.max(0.5, b.maxZ - b.minZ);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(width + 0.35, 0.04, depth + 0.35), floorMaterial);
    floor.position.set((b.minX + b.maxX) / 2, -0.03, (b.minZ + b.maxZ) / 2);
    root.add(floor);

    target.set((b.minX + b.maxX) / 2, 0.9, (b.minZ + b.maxZ) / 2);
    span = Math.max(width, depth, 2);
  }

  function view3d() {
    camera.position.set(target.x + span * 0.9, target.y + span * 0.7, target.z + span * 0.9);
    controls.target.copy(target);
    controls.update();
  }
  function topView() {
    camera.position.set(target.x, target.y + span * 1.8, target.z + 0.001);
    controls.target.copy(target);
    controls.update();
  }
  view3d();

  let frame = 0;
  function tick() {
    frame = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  const onResize = () => {
    if (!container.isConnected) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  globalThis.addEventListener('resize', onResize);

  return {
    topView,
    view3d,
    reset: view3d,
    dispose() {
      cancelAnimationFrame(frame);
      globalThis.removeEventListener('resize', onResize);
      controls.dispose();
      renderer.dispose();
      container.innerHTML = '';
    }
  };
}
