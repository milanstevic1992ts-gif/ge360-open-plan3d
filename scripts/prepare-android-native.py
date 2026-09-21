#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
APP = ANDROID / "app"

if not ANDROID.exists():
    raise SystemExit("android/ non esiste: esegui prima npx cap add android")

main_activity = APP / "src/main/java/com/ge360/rilievo/MainActivity.java"
java_dir = APP / "src/main/java/com/ge360/rilievo"
java_dir.mkdir(parents=True, exist_ok=True)
for plugin_name in ("GE360TunnelPlugin.java", "GE360LaserPlugin.java"):
    plugin_src = ROOT / "android-native" / plugin_name
    plugin_dst = java_dir / plugin_name
    plugin_dst.write_text(plugin_src.read_text(encoding="utf-8"), encoding="utf-8")

main_activity.parent.mkdir(parents=True, exist_ok=True)
main_activity.write_text(
    """package com.ge360.rilievo;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void load() {
        registerPlugin(GE360TunnelPlugin.class);
        registerPlugin(GE360LaserPlugin.class);
        super.load();
    }
}
""",
    encoding="utf-8",
)

gradle = APP / "build.gradle"
text = gradle.read_text(encoding="utf-8")
text = text.replace("minSdkVersion rootProject.ext.minSdkVersion", "minSdkVersion 26")
version_code = os.getenv("GE360_VERSION_CODE", "26092101")
version_name = os.getenv("GE360_VERSION_NAME", "1.1.0")
text = text.replace("versionCode 1", f"versionCode {int(version_code)}")
text = text.replace('versionName "1.0"', f'versionName "{version_name}"')
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
        '<uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.CAMERA" />\n'
        '    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />\n'
        '    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />\n'
        '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />\n'
        '    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />\n'
        '    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />\n'
        '    <uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />',
    )
if 'android:usesCleartextTraffic=' not in m:
    m = m.replace(
        '<application\n',
        '<application\n        android:usesCleartextTraffic="true"\n',
        1,
    )
manifest.write_text(m, encoding="utf-8")

print("GE360 native QR/WireGuard + laser BLE integration prepared")
