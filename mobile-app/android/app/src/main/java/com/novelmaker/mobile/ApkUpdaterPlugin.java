package com.novelmaker.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
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
    /** 修复前的所有版本都下载到这个固定名；里面可能是一个更旧的安装包 */
    private static final String LEGACY_APK = "NovelMaker.apk";

    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    // 下载状态（跨 WebView 重载可查询；文件本身是跨进程重启的持久真相）
    private volatile boolean downloading = false;
    private volatile long done = 0;
    private volatile long total = 0;
    private volatile String lastError = null;

    @Override
    public void load() {
        File legacy = new File(getContext().getCacheDir(), LEGACY_APK);
        if (legacy.isFile()) {
            // noinspection ResultOfMethodCallIgnored
            legacy.delete();
        }
    }

    /**
     * 不能用 call.getLong()：JS 传来的整数经 JSON 到这里是 Integer，而 getLong 只认 Long，
     * 否则一律返回默认值——修复前 versionCode 永远被读成 0，所有版本都落到固定文件名、反复安装旧包。
     */
    private static long longArg(PluginCall call, String name, long fallback) {
        Object v = call.getData().opt(name);
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) {
            try {
                return Long.parseLong((String) v);
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    private static long versionCodeArg(PluginCall call) throws IOException {
        long vc = longArg(call, "versionCode", 0L);
        if (vc <= 0) throw new IOException("缺少 versionCode");
        return vc;
    }

    /** 只用 int 形式：versionCode 是分钟级时间戳（约三千万），远在 int 范围内；longVersionCode 在当前编译环境解析不到 */
    @SuppressWarnings("deprecation")
    private static long versionCodeOf(PackageInfo info) {
        return Integer.toUnsignedLong(info.versionCode);
    }

    /** 下载文件按 versionCode 隔离（nm-<vc>.apk）：不同版本的文件天然不同名 */
    private File apkFile(long versionCode) {
        return new File(getContext().getCacheDir(), "nm-" + versionCode + ".apk");
    }

    /** 下载中写到这里，校验通过才改成正式文件名——正式文件存在即代表完整且版本正确 */
    private File partFile(long versionCode) {
        return new File(getContext().getCacheDir(), "nm-" + versionCode + ".apk.part");
    }

    /** APK 文件自己声明的 versionCode；不是合法安装包时返回 -1 */
    private long packageVersionCode(File apk) {
        PackageInfo info = getContext().getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        return info != null ? versionCodeOf(info) : -1;
    }

    private long installedVersionCode() throws PackageManager.NameNotFoundException {
        Context ctx = getContext();
        return versionCodeOf(ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0));
    }

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            Context ctx = getContext();
            PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            JSObject ret = new JSObject();
            ret.put("version", info.versionName);
            ret.put("versionCode", versionCodeOf(info));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** 下载状态快照：JS 轮询用，不依赖事件回调存活；versionCode 指定查哪个版本的文件 */
    @PluginMethod
    public void status(PluginCall call) {
        try {
            File apk = apkFile(versionCodeArg(call));
            JSObject r = new JSObject();
            r.put("downloading", downloading);
            r.put("done", done);
            r.put("total", total);
            r.put("size", apk.isFile() ? apk.length() : 0);
            r.put("complete", apk.isFile());
            if (lastError != null) r.put("error", lastError);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("缺少 url");
            return;
        }
        long vc;
        long expected;
        try {
            vc = versionCodeArg(call);
            expected = longArg(call, "expectedSize", 0L);
        } catch (IOException e) {
            call.reject(e.getMessage());
            return;
        }
        // 可重入：已在下载中不重复起任务，JS 靠 status() 轮询进度
        if (downloading) {
            call.resolve();
            return;
        }
        String token = call.getString("token", "");
        pool.execute(() -> {
            File dest = apkFile(vc);
            File part = partFile(vc);
            // noinspection ResultOfMethodCallIgnored
            part.delete();
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
                     FileOutputStream out = new FileOutputStream(part)) {
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
                long size = part.length();
                if (expected > 0 && size != expected) {
                    throw new IOException("下载不完整（" + size + " / " + expected + " 字节）");
                }
                if (packageVersionCode(part) != vc) {
                    throw new IOException("下载到的安装包版本不对");
                }
                // noinspection ResultOfMethodCallIgnored
                dest.delete();
                if (!part.renameTo(dest)) {
                    throw new IOException("安装包保存失败");
                }
                JSObject r = new JSObject();
                r.put("path", dest.getAbsolutePath());
                r.put("size", dest.length());
                call.resolve(r);
            } catch (Exception e) {
                // noinspection ResultOfMethodCallIgnored
                part.delete();
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
            long vc = versionCodeArg(call);
            File apk = apkFile(vc);
            if (!apk.isFile()) {
                call.reject("安装包还没下载好");
                return;
            }
            // 正式文件只会在校验后生成，这里再核一次，绝不把版本不对的包交给系统安装器
            long fileVc = packageVersionCode(apk);
            if (fileVc != vc || fileVc <= installedVersionCode()) {
                // noinspection ResultOfMethodCallIgnored
                apk.delete();
                call.reject("安装包版本不对，已删除");
                return;
            }
            android.app.Activity activity = getBridge().getActivity();
            Context ctx = getContext();
            // Android 8+ 未授予「安装未知应用」时系统安装器不会弹出，先跳授权页
            if (Build.VERSION.SDK_INT >= 26
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
