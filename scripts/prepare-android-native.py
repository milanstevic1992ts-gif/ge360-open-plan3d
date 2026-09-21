#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
APP = ANDROID / "app"

if not ANDROID.exists():
    raise SystemExit("android/ non esiste: esegui prima npx cap add android")

main_activity = APP / "src/main/java/com/ge360/rilievo/MainActivity.java"
plugin_src = ROOT / "android-native/GE360TunnelPlugin.java"
plugin_dst = APP / "src/main/java/com/ge360/rilievo/GE360TunnelPlugin.java"
plugin_dst.parent.mkdir(parents=True, exist_ok=True)
plugin_dst.write_text(plugin_src.read_text(encoding="utf-8"), encoding="utf-8")

main_activity.parent.mkdir(parents=True, exist_ok=True)
main_activity.write_text(
    """package com.ge360.rilievo;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void load() {
        registerPlugin(GE360TunnelPlugin.class);
        super.load();
    }
}
""",
    encoding="utf-8",
)

gradle = APP / "build.gradle"
text = gradle.read_text(encoding="utf-8")
marker = "// GE360_DIRECT_BRIDGE_NATIVE"
if marker not in text:
    text += """
\n// GE360_DIRECT_BRIDGE_NATIVE
android {
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
        coreLibraryDesugaringEnabled = true
    }
}

dependencies {
    implementation "com.wireguard.android:tunnel:1.0.20260102"
    coreLibraryDesugaring "com.android.tools:desugar_jdk_libs:2.0.3"
}
"""
    gradle.write_text(text, encoding="utf-8")

manifest = APP / "src/main/AndroidManifest.xml"
m = manifest.read_text(encoding="utf-8")
if 'android.permission.CAMERA' not in m:
    m = m.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.CAMERA" />',
    )
if 'android:usesCleartextTraffic=' not in m:
    m = m.replace(
        '<application\n',
        '<application\n        android:usesCleartextTraffic="true"\n',
        1,
    )
manifest.write_text(m, encoding="utf-8")

print("GE360 native QR/WireGuard integration prepared")
