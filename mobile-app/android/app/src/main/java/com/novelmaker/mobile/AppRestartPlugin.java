package com.novelmaker.mobile;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 让 WebView 侧主动重启 APP：重建 Activity 后 onCreate/onResume 重跑，
 * 启动更新流程（检查→下载→切换 bundle）随之执行，新版即生效。
 */
@CapacitorPlugin(name = "AppRestart")
public class AppRestartPlugin extends Plugin {
    @PluginMethod
    public void restart(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().recreate());
        call.resolve();
    }
}
