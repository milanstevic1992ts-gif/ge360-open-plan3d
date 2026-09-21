export const DEFAULT_BRIDGE_API = 'http://10.88.0.1:9888/api/v1';

function firstNonEmpty() {
  for (var i = 0; i < arguments.length; i++) {
    if (typeof arguments[i] === 'string' && arguments[i].trim()) return arguments[i].trim();
  }
  return '';
}

export function normalizeBackendApiUrl(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';
  raw = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
  if (/\/api\/v1$/i.test(raw)) return raw;
  return raw + '/api/v1';
}

export function backendRootFromApi(apiUrl) {
  return normalizeBackendApiUrl(apiUrl).replace(/\/api\/v1$/i, '');
}

function parseWireGuardConfig(text) {
  var raw = String(text || '').replace(/\r/g, '').trim();
  if (!/^\s*\[Interface\]/im.test(raw) || !/^\s*\[Peer\]/im.test(raw)) {
    throw new Error('Il QR non contiene una configurazione GE360 WireGuard valida');
  }

  var section = '';
  var iface = {};
  var peer = {};
  raw.split('\n').forEach(function (line) {
    var clean = line.split('#')[0].trim();
    if (!clean) return;
    if (/^\[Interface\]$/i.test(clean)) { section = 'interface'; return; }
    if (/^\[Peer\]$/i.test(clean)) { section = 'peer'; return; }
    var pos = clean.indexOf('=');
    if (pos < 1) return;
    var key = clean.slice(0, pos).trim().toLowerCase();
    var value = clean.slice(pos + 1).trim();
    if (section === 'interface') iface[key] = value;
    if (section === 'peer') peer[key] = value;
  });

  if (!iface.privatekey || !iface.address || !peer.publickey || !peer.endpoint || !peer.allowedips) {
    throw new Error('QR WireGuard incompleto');
  }

  var allowed = peer.allowedips.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (allowed.some(function (x) { return x === '0.0.0.0/0' || x === '::/0'; })) {
    throw new Error('QR rifiutato: GE360 non deve deviare tutto il traffico Internet');
  }
  if (!allowed.some(function (x) { return /^10\.88\.0\.0\/24$/i.test(x); })) {
    throw new Error('QR rifiutato: rete GE360 Direct Bridge non riconosciuta');
  }

  return {
    wireguardConfig: raw + '\n',
    bridgeAddress: iface.address,
    endpoint: peer.endpoint,
    allowedIps: allowed
  };
}

export function parseBridgeQr(rawValue) {
  var raw = String(rawValue || '').trim();
  if (!raw) throw new Error('QR vuoto');

  var envelope = null;
  if (raw.charAt(0) === '{') {
    try { envelope = JSON.parse(raw); } catch (_) { envelope = null; }
  }

  if (envelope && typeof envelope === 'object') {
    var pairing = envelope.pairing && typeof envelope.pairing === 'object' ? envelope.pairing : {};
    var config = firstNonEmpty(
      envelope.wireguard_config,
      envelope.wireguardConfig,
      pairing.wireguard_config,
      pairing.wireguardConfig
    );
    var parsed = parseWireGuardConfig(config);
    parsed.backendUrl = normalizeBackendApiUrl(firstNonEmpty(
      envelope.backend_url,
      envelope.backendUrl,
      pairing.backend_url,
      pairing.backendUrl,
      DEFAULT_BRIDGE_API
    ));
    parsed.apiKey = firstNonEmpty(envelope.api_key, envelope.apiKey, pairing.api_key, pairing.apiKey) || null;
    parsed.deviceId = firstNonEmpty(envelope.device_id, envelope.deviceId, envelope.device && envelope.device.device_id) || null;
    return parsed;
  }

  var current = parseWireGuardConfig(raw);
  current.backendUrl = DEFAULT_BRIDGE_API;
  current.apiKey = null;
  current.deviceId = null;
  return current;
}
