package com.ge360.rilievo;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.VpnService;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.wireguard.android.backend.GoBackend;
import com.wireguard.android.backend.Tunnel;
import com.wireguard.config.Config;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "GE360Tunnel")
public class GE360TunnelPlugin extends Plugin {
    private static final String PREFS = "ge360_direct_bridge";
    private static final String CONFIG_KEY = "wireguard_config";
    private static final String TUNNEL_NAME = "ge360";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile Tunnel.State observedState = Tunnel.State.DOWN;
    private SharedPreferences prefs;
    private GoBackend backend;

    private final Tunnel tunnel = new Tunnel() {
        @Override
        public String getName() {
            return TUNNEL_NAME;
        }

        @Override
        public void onStateChange(State newState) {
            observedState = newState;
        }
    };

    @Override
    public void load() {
        prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        backend = new GoBackend(getContext().getApplicationContext());
    }

    private String requestedOrStoredConfig(PluginCall call) {
        String supplied = call.getString("config");
        if (supplied != null && !supplied.trim().isEmpty()) return supplied.trim() + "\n";
        return prefs.getString(CONFIG_KEY, null);
    }

    private Config parseConfig(String text) throws Exception {
        if (text == null || text.trim().isEmpty()) throw new IllegalArgumentException("Nessun profilo GE360 salvato");
        return Config.parse(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }

    private JSObject result(boolean configured, boolean connected, boolean needsPermission, String state) {
        JSObject ret = new JSObject();
        ret.put("configured", configured);
        ret.put("connected", connected);
        ret.put("needsPermission", needsPermission);
        ret.put("state", state);
        return ret;
    }

    private void connectInternal(PluginCall call, String configText) {
        worker.execute(() -> {
            try {
                Config config = parseConfig(configText);
                Tunnel.State state = backend.setState(tunnel, Tunnel.State.UP, config);
                observedState = state;
                prefs.edit().putString(CONFIG_KEY, configText).apply();
                call.resolve(result(true, state == Tunnel.State.UP, false, state.name()));
            } catch (Exception exc) {
                call.reject("Impossibile attivare GE360 Direct Bridge: " + exc.getMessage(), exc);
            }
        });
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String configText = requestedOrStoredConfig(call);
        if (configText == null || configText.trim().isEmpty()) {
            call.reject("Nessun profilo GE360 salvato");
            return;
        }
        try {
            parseConfig(configText);
        } catch (Exception exc) {
            call.reject("Configurazione WireGuard non valida: " + exc.getMessage(), exc);
            return;
        }

        Intent permissionIntent = VpnService.prepare(getContext());
        if (permissionIntent != null) {
            startActivityForResult(call, permissionIntent, "vpnPermissionResult");
            return;
        }
        connectInternal(call, configText);
    }

    @ActivityCallback
    private void vpnPermissionResult(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK) {
            call.reject("Permesso VPN non concesso");
            return;
        }
        connectInternal(call, requestedOrStoredConfig(call));
    }

    @PluginMethod
    public void restore(PluginCall call) {
        String configText = prefs.getString(CONFIG_KEY, null);
        if (configText == null || configText.trim().isEmpty()) {
            call.resolve(result(false, false, false, Tunnel.State.DOWN.name()));
            return;
        }
        if (VpnService.prepare(getContext()) != null) {
            call.resolve(result(true, false, true, Tunnel.State.DOWN.name()));
            return;
        }
        connectInternal(call, configText);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        worker.execute(() -> {
            try {
                Tunnel.State state = backend.setState(tunnel, Tunnel.State.DOWN, null);
                observedState = state;
                call.resolve(result(prefs.contains(CONFIG_KEY), false, false, state.name()));
            } catch (Exception exc) {
                call.reject("Impossibile disconnettere GE360 Direct Bridge: " + exc.getMessage(), exc);
            }
        });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        worker.execute(() -> {
            try {
                try {
                    backend.setState(tunnel, Tunnel.State.DOWN, null);
                } catch (Exception ignored) {
                }
                observedState = Tunnel.State.DOWN;
                prefs.edit().remove(CONFIG_KEY).apply();
                call.resolve(result(false, false, false, Tunnel.State.DOWN.name()));
            } catch (Exception exc) {
                call.reject("Impossibile eliminare il profilo GE360: " + exc.getMessage(), exc);
            }
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        worker.execute(() -> {
            boolean configured = prefs.contains(CONFIG_KEY);
            try {
                Tunnel.State state = backend.getState(tunnel);
                observedState = state;
                call.resolve(result(configured, state == Tunnel.State.UP, false, state.name()));
            } catch (Exception exc) {
                call.resolve(result(configured, observedState == Tunnel.State.UP, false, observedState.name()));
            }
        });
    }
}
