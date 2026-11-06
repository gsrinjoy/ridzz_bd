package app.slipstream.rider;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** The web app's handle on what only native code can do: staying alive and reaching the helmet. */
@CapacitorPlugin(
    name = "RideShell",
    permissions = {
        @Permission(alias = "ride", strings = { Manifest.permission.RECORD_AUDIO, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class RideShellPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("ride") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[] { "ride", "notifications", "bluetooth" }, call, "onPermissions");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void onPermissions(PluginCall call) {
        if (getPermissionState("ride") == PermissionState.GRANTED) begin(call);
        else call.reject("Microphone and location are needed for a ride");
    }

    private void begin(PluginCall call) {
        Context context = getContext();
        RideService.listener = this::sendLocation;
        // The renderer must keep its priority once the screen is off, or audio stutters and stops.
        WebView webView = getBridge().getWebView();
        webView.post(() -> webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false));
        ContextCompat.startForegroundService(context, new Intent(context, RideService.class));
        routeToHeadset();
        JSObject result = new JSObject();
        result.put("headset", headsetName());
        call.resolve(result);
    }

    /**
     * Doze and vendor battery managers kill long-running audio apps, which is the
     * usual cause of a call dying mid-ride on Android. Asks once to be left alone.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        boolean exempt = power.isIgnoringBatteryOptimizations(context.getPackageName());
        if (!exempt) {
            Intent ask = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + context.getPackageName()));
            ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(ask);
        }
        JSObject result = new JSObject();
        result.put("exempt", exempt);
        call.resolve(result);
    }

    private void sendLocation(Location location) {
        JSObject fix = new JSObject();
        fix.put("la", location.getLatitude());
        fix.put("lo", location.getLongitude());
        fix.put("sp", location.hasSpeed() ? location.getSpeed() * 3.6 : 0);
        fix.put("hd", location.hasBearing() ? location.getBearing() : -1);
        fix.put("ts", location.getTime());
        notifyListeners("location", fix);
    }

    private AudioManager audio() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private AudioDeviceInfo findHeadset() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
        for (AudioDeviceInfo device : audio().getAvailableCommunicationDevices()) {
            int type = device.getType();
            if (type == AudioDeviceInfo.TYPE_BLE_HEADSET || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return device;
        }
        return null;
    }

    /** Sends voice through the helmet set rather than the phone's own mic and speaker. */
    @SuppressWarnings("deprecation")
    private void routeToHeadset() {
        AudioManager manager = audio();
        manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo headset = findHeadset();
            if (headset != null) manager.setCommunicationDevice(headset);
        } else {
            manager.startBluetoothSco();
            manager.setBluetoothScoOn(true);
        }
    }

    private static String kindOf(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
                return "bluetooth";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return "speaker";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "earpiece";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return "wired";
            default:
                return "other";
        }
    }

    private static String labelOf(AudioDeviceInfo device) {
        switch (device.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return "Phone speaker";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "Phone earpiece";
            default:
                return device.getProductName().toString();
        }
    }

    /** Every place a call can go right now, for the Speaker button on the call deck. */
    @PluginMethod
    public void listRoutes(PluginCall call) {
        JSArray routes = new JSArray();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioManager manager = audio();
            AudioDeviceInfo current = manager.getCommunicationDevice();
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                JSObject route = new JSObject();
                route.put("id", String.valueOf(device.getId()));
                route.put("label", labelOf(device));
                route.put("kind", kindOf(device.getType()));
                route.put("active", current != null && current.getId() == device.getId());
                routes.put(route);
            }
        } else {
            routes.put(legacyRoute("speaker", "Phone speaker", "speaker", audio().isSpeakerphoneOn()));
            routes.put(legacyRoute("bluetooth", "Bluetooth headset", "bluetooth", audio().isBluetoothScoOn()));
        }
        JSObject result = new JSObject();
        result.put("routes", routes);
        call.resolve(result);
    }

    private static JSObject legacyRoute(String id, String label, String kind, boolean active) {
        JSObject route = new JSObject();
        route.put("id", id);
        route.put("label", label);
        route.put("kind", kind);
        route.put("active", active);
        return route;
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void setRoute(PluginCall call) {
        String id = call.getString("id", "");
        AudioManager manager = audio();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                if (String.valueOf(device.getId()).equals(id)) {
                    if (manager.setCommunicationDevice(device)) call.resolve();
                    else call.reject("That audio route is not available");
                    return;
                }
            }
            call.reject("That audio route has gone");
        } else {
            boolean speaker = "speaker".equals(id);
            manager.setSpeakerphoneOn(speaker);
            if (speaker) manager.stopBluetoothSco();
            else manager.startBluetoothSco();
            manager.setBluetoothScoOn(!speaker);
            call.resolve();
        }
    }

    private String headsetName() {
        AudioDeviceInfo headset = findHeadset();
        return headset == null ? "" : headset.getProductName().toString();
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void stop(PluginCall call) {
        Context context = getContext();
        RideService.listener = null;
        context.stopService(new Intent(context, RideService.class));
        AudioManager manager = audio();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            manager.clearCommunicationDevice();
        } else {
            manager.setBluetoothScoOn(false);
            manager.stopBluetoothSco();
        }
        manager.setMode(AudioManager.MODE_NORMAL);
        call.resolve();
    }
}
