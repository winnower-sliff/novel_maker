package com.novelmaker.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean basePathApplied = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        Updater.ensureLocalBundle(this);
        super.onCreate(savedInstanceState);
        registerPlugin(ApkUpdaterPlugin.class);
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
