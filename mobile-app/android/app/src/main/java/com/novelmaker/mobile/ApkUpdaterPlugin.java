package com.novelmaker.mobile;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * APK 自更新：下载新 APK 到 cacheDir 并调起系统安装器。
 * 下载 URL 由 JS 侧拼接（含 token），原生不持有连接配置。
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    // 下载状态（跨 WebView 重载可查询；文件本身是跨进程重启的持久真相）
    private volatile boolean downloading = false;
    private volatile long done = 0;
    private volatile long total = 0;
    private volatile String lastError = null;

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            var info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("version", info.versionName);
            ret.put("versionCode", info.versionCode);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** 下载状态快照：JS 轮询用，不依赖事件回调存活 */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        File apk = apkFile();
        r.put("downloading", downloading);
        r.put("done", done);
        r.put("total", total);
        r.put("size", apk.isFile() ? apk.length() : 0);
        if (lastError != null) r.put("error", lastError);
        call.resolve(r);
    }

    private File apkFile() {
        return new File(getContext().getCacheDir(), "NovelMaker.apk");
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("缺少 url");
            return;
        }
        // 可重入：已在下载中不重复起任务，JS 靠 status() 轮询进度
        if (downloading) {
            call.resolve();
            return;
        }
        String token = call.getString("token", "");
        pool.execute(() -> {
            File dest = apkFile();
            downloading = true;
            done = 0;
            total = 0;
            lastError = null;
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(30000);
                if (!token.isEmpty()) conn.setRequestProperty("x-nm-token", token);
                int code = conn.getResponseCode();
                if (code != 200) {
                    conn.disconnect();
                    throw new IOException("HTTP " + code);
                }
                long t = conn.getContentLength();
                total = t;
                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[16 * 1024];
                    long d = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        d += n;
                        done = d;
                        if (t > 0) {
                            JSObject p = new JSObject();
                            p.put("done", d);
                            p.put("total", t);
                            notifyListeners("progress", p);
                        }
                    }
                } finally {
                    conn.disconnect();
                }
                JSObject r = new JSObject();
                r.put("path", dest.getAbsolutePath());
                r.put("size", dest.length());
                call.resolve(r);
            } catch (Exception e) {
                // noinspection ResultOfMethodCallIgnored
                dest.delete();
                done = 0;
                lastError = e.getMessage() != null ? e.getMessage() : e.toString();
                call.reject(lastError);
            } finally {
                downloading = false;
            }
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        try {
            android.app.Activity activity = getBridge().getActivity();
            android.content.Context ctx = getContext();
            File apk = new File(ctx.getCacheDir(), "NovelMaker.apk");
            if (!apk.isFile()) {
                call.reject("APK 未下载");
                return;
            }
            // Android 8+ 未授予「安装未知应用」时系统安装器不会弹出，先跳授权页
            if (android.os.Build.VERSION.SDK_INT >= 26
                    && !ctx.getPackageManager().canRequestPackageInstalls()) {
                Intent grant = new Intent(
                        android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + ctx.getPackageName()));
                activity.startActivity(grant);
                JSObject r = new JSObject();
                r.put("needsGrant", true);
                call.resolve(r);
                return;
            }
            Uri uri = FileProvider.getUriForFile(
                    ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }
}
