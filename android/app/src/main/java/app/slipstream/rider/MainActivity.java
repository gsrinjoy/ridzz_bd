package app.slipstream.rider;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RideShellPlugin.class);
        registerPlugin(NearbyLinkPlugin.class);
        super.onCreate(savedInstanceState);
        handleShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleShare(intent);
    }

    /** A place shared from Google Maps becomes a stop, through the same /share route the web app uses. */
    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || getBridge() == null) return;
        String url = getBridge().getServerUrl() + "/share?text=" + Uri.encode(text);
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
    }
}
