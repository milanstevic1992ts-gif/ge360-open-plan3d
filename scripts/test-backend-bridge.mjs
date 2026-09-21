import assert from 'node:assert/strict';
import { DEFAULT_BRIDGE_API, normalizeBackendApiUrl, parseBridgeQr } from '../js/backend-bridge.js';

const wg = `[Interface]
PrivateKey = abcdef
Address = 10.88.0.2/32

[Peer]
PublicKey = serverkey
Endpoint = vpn.example.it:51820
AllowedIPs = 10.88.0.0/24
PersistentKeepalive = 25
`;

const parsed = parseBridgeQr(wg);
assert.equal(parsed.backendUrl, DEFAULT_BRIDGE_API);
assert.equal(parsed.bridgeAddress, '10.88.0.2/32');
assert.equal(parsed.endpoint, 'vpn.example.it:51820');
assert.ok(parsed.wireguardConfig.includes('PrivateKey = abcdef'));

const envelope = parseBridgeQr(JSON.stringify({
  pairing: {
    wireguard_config: wg,
    backend_url: 'http://10.88.0.1:9888'
  },
  api_key: 'secret-test'
}));
assert.equal(envelope.backendUrl, 'http://10.88.0.1:9888/api/v1');
assert.equal(envelope.apiKey, 'secret-test');
assert.equal(normalizeBackendApiUrl('10.88.0.1:9888'), 'http://10.88.0.1:9888/api/v1');

assert.throws(() => parseBridgeQr('hello'), /WireGuard valida/);
assert.throws(() => parseBridgeQr(wg.replace('10.88.0.0/24', '0.0.0.0/0')), /tutto il traffico/);
assert.throws(() => parseBridgeQr(wg.replace('10.88.0.0/24', '10.0.0.0/8')), /rete GE360/);

console.log('GE360 backend bridge parser OK');
