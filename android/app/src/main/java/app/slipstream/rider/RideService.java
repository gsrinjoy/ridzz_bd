package app.slipstream.rider;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the ride alive with the phone in a pocket. Android stops background
 * mic and GPS access unless a visible foreground service owns them, and the
 * partial wake lock keeps the CPU running while the screen is off.
 */
public class RideService extends Service implements LocationListener {

    public interface Listener {
        void onLocation(Location location);
    }

    private static final String CHANNEL = "ride";
    private static final int NOTIFICATION_ID = 1;
    private static final long GPS_INTERVAL_MS = 2000;
    private static final float GPS_DISTANCE_M = 5f;

    static volatile Listener listener;

    private PowerManager.WakeLock wakeLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        boolean hasGps = granted(android.Manifest.permission.ACCESS_FINE_LOCATION);
        if (hasGps) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), types);

        if (wakeLock == null) {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "slipstream:ride");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        if (hasGps) startGps();
        return START_STICKY;
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void startGps() {
        LocationManager manager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, GPS_INTERVAL_MS, GPS_DISTANCE_M, this, Looper.getMainLooper());
        } catch (SecurityException | IllegalArgumentException e) {
            // No GPS hardware or permission: voice still works, the rider just stays off the map.
        }
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Active ride", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while you are on a ride");
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("On a ride")
            .setContentText("Voice and location are active")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(tap)
            .setOngoing(true)
            .build();
    }

    @Override
    public void onLocationChanged(@NonNull Location location) {
        Listener current = listener;
        if (current != null) current.onLocation(location);
    }

    // Required on API 24-29, where these are still abstract.
    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(@NonNull String provider) {}

    @Override
    public void onProviderDisabled(@NonNull String provider) {}

    @Override
    public void onDestroy() {
        ((LocationManager) getSystemService(Context.LOCATION_SERVICE)).removeUpdates(this);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
