package com.novelmaker.mobile;

import android.graphics.Color;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean basePathApplied = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 插件必须在 super.onCreate 之前注册，否则 Bridge 初始化时插件表里没有它，
        // JS 侧会报 "plugin is not implemented on android"
        registerPlugin(ApkUpdaterPlugin.class);
        Updater.ensureLocalBundle(this);
        super.onCreate(savedInstanceState);
        // edge-to-edge margin 避让处露出的 WebView 底色默认为白，统一为应用底色
        bridge.getWebView().setBackgroundColor(Color.parseColor("#09090b"));
    }

    @Override
    public void onResume() {
        super.onResume();
        if (!basePathApplied) {
            // 首帧从 assets/public 加载，切到 filesDir/bundle（内容相同，无感）
            bridge.setServerBasePath(Updater.bundleDir(this).getAbsolutePath());
            basePathApplied = true;
        }
    }
}
