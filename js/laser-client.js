function plugin() {
  try {
    return window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins.GE360Laser : null;
  } catch (_) { return null; }
}

export function laserAvailable() { return !!plugin(); }

export async function scanLaserDevices() {
  const p = plugin();
  if (!p) throw new Error('Metro laser disponibile solo nell APK Android GE360');
  const out = await p.scan();
  return Array.isArray(out.devices) ? out.devices : [];
}

export async function connectLaserDevice(device) {
  const p = plugin();
  if (!p) throw new Error('Plugin laser non disponibile');
  return p.connect(device || {});
}

export async function disconnectLaserDevice() {
  const p = plugin();
  return p ? p.disconnect() : null;
}

export async function restoreLaserDevice() {
  const p = plugin();
  return p ? p.restore() : null;
}

export async function laserStatus() {
  const p = plugin();
  return p ? p.status() : { configured:false, connected:false };
}

export async function listenLaser(onMeasurement, onState, onError) {
  const p = plugin();
  if (!p) return [];
  const handles = [];
  handles.push(await p.addListener('measurement', onMeasurement));
  handles.push(await p.addListener('state', onState || function () {}));
  handles.push(await p.addListener('error', onError || function () {}));
  return handles;
}
