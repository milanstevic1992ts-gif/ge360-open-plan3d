package com.ge360.rilievo;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

@CapacitorPlugin(
    name = "GE360Laser",
    permissions = {
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT
        }),
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION
        })
    }
)
public class GE360LaserPlugin extends Plugin {
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    // Leica DISTO Bluetooth Smart (community implementations tested on D110/D810 family).
    private static final UUID LEICA_SERVICE = UUID.fromString("3ab10100-f831-4395-b29d-570977d5bf94");
    private static final UUID LEICA_DISTANCE = UUID.fromString("3ab10101-f831-4395-b29d-570977d5bf94");
    private static final UUID LEICA_ACK = UUID.fromString("3ab10109-f831-4395-b29d-570977d5bf94");
    private static final byte[] LEICA_ACK_BYTES = new byte[]{0x04, 0x00};

    // Bosch GLM/PLR BLE protocol used by GLM 50C / 50-27 CG compatible implementations.
    private static final UUID BOSCH_SERVICE = UUID.fromString("02a6c0d0-0451-4000-b000-fb3210111989");
    private static final UUID BOSCH_DATA = UUID.fromString("02a6c0d1-0451-4000-b000-fb3210111989");
    private static final byte[] BOSCH_SYNC = new byte[]{
        (byte) 0xC0, 0x55, 0x02, 0x01, 0x00, 0x1A
    };

    private static final String PREFS = "ge360_laser";
    private static final String P_ADDRESS = "address";
    private static final String P_NAME = "name";
    private static final String P_VENDOR = "vendor";

    private BluetoothAdapter adapter;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic dataCharacteristic;
    private String connectedAddress;
    private String connectedName;
    private String connectedVendor;
    private boolean connected = false;
    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = manager != null ? manager.getAdapter() : null;
        prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean permissionsReady() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return getPermissionState("bluetooth") == PermissionState.GRANTED;
        }
        return getPermissionState("location") == PermissionState.GRANTED;
    }

    private void requestNeededPermission(PluginCall call, String callback) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissionForAlias("bluetooth", call, callback);
        } else {
            requestPermissionForAlias("location", call, callback);
        }
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (permissionsReady()) {
            call.resolve(permissionResult(true));
            return;
        }
        requestNeededPermission(call, "accessPermissionCallback");
    }

    @PermissionCallback
    private void accessPermissionCallback(PluginCall call) {
        call.resolve(permissionResult(permissionsReady()));
    }

    private JSObject permissionResult(boolean granted) {
        JSObject out = new JSObject();
        out.put("granted", granted);
        out.put("bluetoothAvailable", adapter != null);
        out.put("bluetoothEnabled", adapter != null && adapter.isEnabled());
        return out;
    }

    @PluginMethod
    public void scan(PluginCall call) {
        if (!permissionsReady()) {
            requestNeededPermission(call, "scanPermissionCallback");
            return;
        }
        scanInternal(call);
    }

    @PermissionCallback
    private void scanPermissionCallback(PluginCall call) {
        if (!permissionsReady()) {
            call.reject("Permesso Bluetooth non concesso");
            return;
        }
        scanInternal(call);
    }

    private void scanInternal(PluginCall call) {
        if (adapter == null) {
            call.reject("Bluetooth non disponibile");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("Attiva il Bluetooth");
            return;
        }
        BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            call.reject("Scanner Bluetooth LE non disponibile");
            return;
        }

        Map<String, JSObject> found = new LinkedHashMap<>();
        ScanCallback callback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice device = result.getDevice();
                if (device == null) return;
                String name = null;
                try { name = device.getName(); } catch (SecurityException ignored) {}
                String vendor = classify(name, result.getScanRecord());
                if (vendor == null) return;
                JSObject item = new JSObject();
                item.put("address", device.getAddress());
                item.put("name", name == null || name.isBlank() ? "Metro laser" : name);
                item.put("vendor", vendor);
                item.put("rssi", result.getRssi());
                found.put(device.getAddress(), item);
            }

            @Override
            public void onScanFailed(int errorCode) {
                if (!call.isReleased()) call.reject("Ricerca Bluetooth fallita: " + errorCode);
            }
        };

        scanner.startScan(callback);
        handler.postDelayed(() -> {
            try { scanner.stopScan(callback); } catch (Exception ignored) {}
            if (call.isReleased()) return;
            JSArray devices = new JSArray();
            for (JSObject item : found.values()) devices.put(item);
            JSObject out = new JSObject();
            out.put("devices", devices);
            out.put("count", found.size());
            call.resolve(out);
        }, 5500);
    }

    private String classify(String name, ScanRecord record) {
        if (hasService(record, LEICA_SERVICE)) return "leica";
        if (hasService(record, BOSCH_SERVICE)) return "bosch";
        String n = name == null ? "" : name.toUpperCase(Locale.ROOT);
        if (n.contains("DISTO") || n.contains("LEICA")) return "leica";
        if (n.contains("GLM") || n.contains("PLR") || n.contains("BOSCH")) return "bosch";
        return null;
    }

    private boolean hasService(ScanRecord record, UUID uuid) {
        if (record == null || record.getServiceUuids() == null) return false;
        for (ParcelUuid service : record.getServiceUuids()) {
            if (uuid.equals(service.getUuid())) return true;
        }
        return false;
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (!permissionsReady()) {
            requestNeededPermission(call, "connectPermissionCallback");
            return;
        }
        connectInternal(call);
    }

    @PermissionCallback
    private void connectPermissionCallback(PluginCall call) {
        if (!permissionsReady()) {
            call.reject("Permesso Bluetooth non concesso");
            return;
        }
        connectInternal(call);
    }

    private void connectInternal(PluginCall call) {
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth non disponibile o spento");
            return;
        }
        String address = call.getString("address");
        if (address == null || address.isBlank()) address = prefs.getString(P_ADDRESS, null);
        if (address == null || address.isBlank()) {
            call.reject("Nessun metro laser selezionato");
            return;
        }
        disconnectGatt();
        try {
            BluetoothDevice device = adapter.getRemoteDevice(address);
            connectedAddress = address;
            connectedName = call.getString("name", prefs.getString(P_NAME, "Metro laser"));
            connectedVendor = call.getString("vendor", prefs.getString(P_VENDOR, ""));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                gatt = device.connectGatt(getContext(), false, gattCallback, BluetoothDevice.TRANSPORT_LE);
            } else {
                gatt = device.connectGatt(getContext(), false, gattCallback);
            }
            prefs.edit().putString(P_ADDRESS, address)
                .putString(P_NAME, connectedName)
                .putString(P_VENDOR, connectedVendor).apply();
            JSObject out = stateObject();
            out.put("connecting", true);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Connessione laser fallita: " + e.getMessage(), e);
        }
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt current, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                connected = true;
                try { current.discoverServices(); } catch (SecurityException ignored) {}
                emitState();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connected = false;
                dataCharacteristic = null;
                emitState();
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt current, int status) {
            BluetoothGattService leica = current.getService(LEICA_SERVICE);
            BluetoothGattService bosch = current.getService(BOSCH_SERVICE);
            if (leica != null) {
                connectedVendor = "leica";
                dataCharacteristic = leica.getCharacteristic(LEICA_DISTANCE);
                subscribe(current, dataCharacteristic);
            } else if (bosch != null) {
                connectedVendor = "bosch";
                dataCharacteristic = bosch.getCharacteristic(BOSCH_DATA);
                subscribe(current, dataCharacteristic);
            } else {
                emitError("Metro collegato ma protocollo GE360 non riconosciuto");
                return;
            }
            prefs.edit().putString(P_VENDOR, connectedVendor).apply();
            emitState();
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt current, BluetoothGattDescriptor descriptor, int status) {
            if ("bosch".equals(connectedVendor) && dataCharacteristic != null) {
                writeCharacteristic(current, dataCharacteristic, BOSCH_SYNC);
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt current, BluetoothGattCharacteristic characteristic) {
            handleData(current, characteristic.getUuid(), characteristic.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt current, BluetoothGattCharacteristic characteristic, byte[] value) {
            handleData(current, characteristic.getUuid(), value);
        }
    };

    @SuppressWarnings("deprecation")
    private void subscribe(BluetoothGatt current, BluetoothGattCharacteristic characteristic) {
        if (characteristic == null) {
            emitError("Caratteristica misura non disponibile");
            return;
        }
        try {
            current.setCharacteristicNotification(characteristic, true);
            BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CCCD);
            if (descriptor != null) {
                descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                current.writeDescriptor(descriptor);
            } else if ("bosch".equals(connectedVendor)) {
                writeCharacteristic(current, characteristic, BOSCH_SYNC);
            }
        } catch (SecurityException e) {
            emitError("Permesso Bluetooth perso");
        }
    }

    private void handleData(BluetoothGatt current, UUID uuid, byte[] value) {
        if (value == null) return;
        Double meters = null;
        if (LEICA_DISTANCE.equals(uuid) && value.length >= 4) {
            meters = (double) ByteBuffer.wrap(value, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getFloat();
            BluetoothGattService service = current.getService(LEICA_SERVICE);
            if (service != null) {
                BluetoothGattCharacteristic ack = service.getCharacteristic(LEICA_ACK);
                if (ack != null) writeCharacteristic(current, ack, LEICA_ACK_BYTES);
            }
        } else if (BOSCH_DATA.equals(uuid) && value.length >= 11
                && (value[0] & 0xff) == 0xC0 && (value[1] & 0xff) == 0x55
                && (value[2] & 0xff) == 0x10 && (value[3] & 0xff) == 0x06) {
            meters = (double) ByteBuffer.wrap(value, 7, 4).order(ByteOrder.LITTLE_ENDIAN).getFloat();
        }
        if (meters == null || !Double.isFinite(meters) || meters <= 0 || meters > 200) return;
        long mm = Math.round(meters * 1000.0);
        JSObject event = new JSObject();
        event.put("distanceM", mm / 1000.0);
        event.put("distanceMm", mm);
        event.put("vendor", connectedVendor);
        event.put("name", connectedName);
        event.put("address", connectedAddress);
        event.put("receivedAt", Instant.now().toString());
        notifyListeners("measurement", event, true);
    }

    @SuppressWarnings("deprecation")
    private void writeCharacteristic(BluetoothGatt current, BluetoothGattCharacteristic characteristic, byte[] value) {
        try {
            characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            characteristic.setValue(value);
            current.writeCharacteristic(characteristic);
        } catch (SecurityException ignored) {}
    }

    private void emitState() {
        notifyListeners("state", stateObject(), true);
    }

    private void emitError(String message) {
        JSObject event = new JSObject();
        event.put("message", message);
        notifyListeners("error", event, true);
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(stateObject());
    }

    @PluginMethod
    public void restore(PluginCall call) {
        String address = prefs.getString(P_ADDRESS, null);
        if (connected || address == null || address.isBlank()) {
            call.resolve(stateObject());
            return;
        }
        if (!permissionsReady()) {
            call.resolve(stateObject());
            return;
        }
        connectInternal(call);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        disconnectGatt();
        call.resolve(stateObject());
    }

    @PluginMethod
    public void forget(PluginCall call) {
        disconnectGatt();
        prefs.edit().clear().apply();
        connectedAddress = null;
        connectedName = null;
        connectedVendor = null;
        call.resolve(stateObject());
    }

    private JSObject stateObject() {
        JSObject out = new JSObject();
        String address = connectedAddress != null ? connectedAddress : prefs.getString(P_ADDRESS, null);
        String name = connectedName != null ? connectedName : prefs.getString(P_NAME, null);
        String vendor = connectedVendor != null ? connectedVendor : prefs.getString(P_VENDOR, null);
        out.put("configured", address != null && !address.isBlank());
        out.put("connected", connected);
        out.put("address", address);
        out.put("name", name);
        out.put("vendor", vendor);
        return out;
    }

    private void disconnectGatt() {
        BluetoothGatt current = gatt;
        gatt = null;
        connected = false;
        dataCharacteristic = null;
        if (current != null) {
            try { current.disconnect(); } catch (Exception ignored) {}
            try { current.close(); } catch (Exception ignored) {}
        }
        emitState();
    }
}
