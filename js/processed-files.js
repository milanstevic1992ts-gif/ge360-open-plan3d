const MIME = {
  pdf: 'application/pdf',
  dxf: 'application/dxf',
  png: 'image/png',
  svg: 'image/svg+xml',
  json: 'application/json',
  glb: 'model/gltf-binary',
  zip: 'application/zip'
};

const EXT = { pdf: 'pdf', dxf: 'dxf', png: 'png', svg: 'svg', json: 'json', glb: 'glb', zip: 'zip' };

export function sanitizeName(value) {
  return String(value || 'rilievo')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'rilievo';
}

export function availableFileEntries(files = {}) {
  return ['pdf', 'dxf', 'png', 'svg', 'json', 'glb']
    .filter(type => Boolean(files[type]))
    .map(type => ({ type, url: files[type] }));
}

export function fileNameFor(planName, version, type) {
  const base = 'GE360-' + sanitizeName(planName);
  const suffix = version != null ? '-v' + sanitizeName(version) : '';
  return base + suffix + '.' + (EXT[type] || type);
}

function browserDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function saveRemoteFile(client, { url, type, fileName }) {
  const blob = await client.fetchBlob(url);
  if (typeof globalThis.showSaveFilePicker === 'function') {
    const handle = await globalThis.showSaveFilePicker({
      suggestedName: fileName,
      types: [{ description: type.toUpperCase(), accept: { [MIME[type] || blob.type || 'application/octet-stream']: ['.' + (EXT[type] || type)] } }]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { method: 'picker', fileName };
  }
  browserDownload(blob, fileName);
  return { method: 'download', fileName };
}

export async function openRemoteFile(client, { url, type, fileName }) {
  const blob = await client.fetchBlob(url);
  const objectUrl = URL.createObjectURL(blob);
  const opened = globalThis.open ? globalThis.open(objectUrl, '_blank', 'noopener') : null;
  if (!opened && typeof document !== 'undefined') browserDownload(blob, fileName);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  return { objectUrl, opened: Boolean(opened), type };
}

export async function shareRemoteFiles(client, descriptors, { title = 'GE360 Rilievo', text = 'Elaborati GE360' } = {}) {
  const files = [];
  for (const item of descriptors) {
    const blob = await client.fetchBlob(item.url);
    files.push(new File([blob], item.fileName, { type: MIME[item.type] || blob.type || 'application/octet-stream' }));
  }
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files }))) {
    await navigator.share({ title, text, files });
    return { shared: true, fallback: false };
  }
  for (let i = 0; i < descriptors.length; i += 1) {
    const blob = files[i];
    browserDownload(blob, descriptors[i].fileName);
  }
  return { shared: false, fallback: true };
}

export async function saveAllAvailable(client, files, planName, version) {
  if (files.zip) {
    return [await saveRemoteFile(client, {
      url: files.zip,
      type: 'zip',
      fileName: 'GE360-' + sanitizeName(planName) + (version != null ? '-v' + sanitizeName(version) : '') + '.zip'
    })];
  }
  const results = [];
  for (const item of availableFileEntries(files)) {
    results.push(await saveRemoteFile(client, {
      ...item,
      fileName: fileNameFor(planName, version, item.type)
    }));
  }
  return results;
}
