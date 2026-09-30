package com.novelmaker.mobile;

import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean basePathApplied = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        Updater.ensureLocalBundle(this);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (!basePathApplied) {
            // 首帧从 assets/public 加载，切到 filesDir/bundle（内容相同，无感）
            bridge.setServerBasePath(Updater.bundleDir(this).getAbsolutePath());
            basePathApplied = true;
        }
        // 等 WebView 就绪后读 localStorage 的连接信息，再查更新
        WebView webView = bridge.getWebView();
        if (webView != null) {
            webView.evaluateJavascript("localStorage.getItem('nm_conn')", (ValueCallback<String>) value -> {
                Updater.saveConnFromLocalStorage(this, value);
                Updater.checkAndApplyAsync(this, bridge, (newVersion, error) -> {
                    // 不自动 reload：重启 APP 生效，避免打断编辑中的内容
                });
            });
        }
    }
}
