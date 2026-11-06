package app.slipstream.rider;

import android.Manifest;
import android.os.Build;
import android.util.Base64;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;

/**
 * Phone-to-phone link over Bluetooth and Wi-Fi through Google Nearby Connections.
 * The JavaScript side owns the protocol; this only moves bytes between riders.
 *
 * Scanning is costly, so it runs only while the JavaScript side asks for it.
 */
@CapacitorPlugin(
    name = "NearbyLink",
    permissions = {
        @Permission(alias = "legacy", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "radios", strings = { Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN }),
        @Permission(alias = "wifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES })
    }
)
public class NearbyLinkPlugin extends Plugin {

    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;

    private final Set<String> peers = new HashSet<>();
    private ConnectionsClient client;
    private String serviceId;
    private String localName;

    private String[] neededAliases() {
        ArrayList<String> aliases = new ArrayList<>();
        aliases.add("legacy");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) aliases.add("radios");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) aliases.add("wifi");
        return aliases.toArray(new String[0]);
    }

    private boolean permitted() {
        for (String alias : neededAliases()) {
            if (getPermissionState(alias) != PermissionState.GRANTED) return false;
        }
        return true;
    }

    /**
     * Asks while the rider has the phone in hand. Waiting until the internet drops
     * would mean a prompt nobody can answer, with the phone in a pocket.
     */
    @PluginMethod
    public void prepare(PluginCall call) {
        if (permitted()) {
            reportPermission(call);
            return;
        }
        requestPermissionForAliases(neededAliases(), call, "onPrepared");
    }

    @PermissionCallback
    private void onPrepared(PluginCall call) {
        reportPermission(call);
    }

    private void reportPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", permitted());
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        int services = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext());
        if (services != ConnectionResult.SUCCESS) {
            call.reject("Google Play services is needed for the nearby link");
            return;
        }
        if (!permitted()) {
            requestPermissionForAliases(neededAliases(), call, "onPermissions");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void onPermissions(PluginCall call) {
        if (permitted()) begin(call);
        else call.reject("Nearby devices permission is needed for the local link");
    }

    private void begin(PluginCall call) {
        // Only riders on the same ride share a service id, so strangers never connect.
        serviceId = "app.slipstream.ride." + call.getString("code", "");
        localName = call.getString("name", "Rider");
        client = Nearby.getConnectionsClient(getContext());
        client
            .startAdvertising(localName, serviceId, lifecycle, new AdvertisingOptions.Builder().setStrategy(STRATEGY).build())
            .addOnFailureListener(e -> {
                if (!isAlready(e)) call.reject("Could not start advertising: " + e.getMessage());
            })
            .addOnSuccessListener(unused ->
                client
                    .startDiscovery(serviceId, discovery, new DiscoveryOptions.Builder().setStrategy(STRATEGY).build())
                    .addOnSuccessListener(done -> call.resolve())
                    .addOnFailureListener(e -> {
                        if (isAlready(e)) call.resolve();
                        else call.reject("Could not start discovery: " + e.getMessage());
                    })
            );
    }

    private static boolean isAlready(Exception e) {
        String text = String.valueOf(e.getMessage());
        return text.contains(String.valueOf(ConnectionsStatusCodes.STATUS_ALREADY_ADVERTISING))
            || text.contains(String.valueOf(ConnectionsStatusCodes.STATUS_ALREADY_DISCOVERING));
    }

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            if (peers.contains(endpointId) || client == null) return;
            client.requestConnection(localName, endpointId, lifecycle);
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {}
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            if (client != null) client.acceptConnection(endpointId, payloads);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            if (result.getStatus().isSuccess()) {
                peers.add(endpointId);
                announcePeers();
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            peers.remove(endpointId);
            announcePeers();
        }
    };

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            byte[] bytes = payload.asBytes();
            if (bytes == null) return;
            JSObject event = new JSObject();
            event.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            notifyListeners("data", event);
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {}
    };

    private void announcePeers() {
        JSObject event = new JSObject();
        event.put("count", peers.size());
        notifyListeners("peers", event);
    }

    @PluginMethod
    public void send(PluginCall call) {
        if (client != null && !peers.isEmpty()) {
            byte[] bytes = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
            client.sendPayload(new ArrayList<>(peers), Payload.fromBytes(bytes));
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (client != null) {
            client.stopAdvertising();
            client.stopDiscovery();
            client.stopAllEndpoints();
        }
        peers.clear();
        announcePeers();
        client = null;
        call.resolve();
    }
}
