package com.novelmaker.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
import com.getcapacitor.Bridge;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 静默更新：向电脑端查询 /api/mobile/version，增量差异时全量下载到 staging，
 * 校验 index.html 后原子切换 filesDir/bundle。不自动 reload，重启 APP 生效，
 * 避免打断正在编辑的内容。
 */
public final class Updater {
    public interface Listener {
        void onFinished(@Nullable String newVersion, @Nullable String error);
    }

    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private Updater() {}

    /** WebView 里 localStorage 的 nm_conn JSON（可能为 null），解析后持久化供原生请求用 */
    public static void saveConnFromLocalStorage(Context ctx, @Nullable String localStorageJson) {
        if (localStorageJson == null) return;
        String raw = localStorageJson.trim();
        if (raw.equals("null") || raw.isEmpty()) return;
        try {
            JSONObject conn = new JSONObject(raw);
            String baseUrl = conn.optString("baseUrl", "");
            String token = conn.optString("token", "");
            if (baseUrl.isEmpty() || token.isEmpty()) return;
            prefs(ctx).edit()
                    .putString("baseUrl", baseUrl)
                    .putString("token", token)
                    .apply();
        } catch (Exception ignored) {
        }
    }

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("nm_updater", Context.MODE_PRIVATE);
    }

    public static void checkAndApplyAsync(Context ctx, Bridge bridge, Listener listener) {
        POOL.execute(() -> {
            String result = null;
            String error = null;
            try {
                result = checkAndApply(ctx, bridge);
            } catch (Exception e) {
                error = e.getMessage();
            }
            final String fResult = result;
            final String fError = error;
            MAIN.post(() -> listener.onFinished(fResult, fError));
        });
    }

    /** @return 新版本号（已应用），null 表示无需更新 */
    @Nullable
    private static String checkAndApply(Context ctx, Bridge bridge) throws Exception {
        SharedPreferences prefs = prefs(ctx);
        String baseUrl = prefs.getString("baseUrl", "");
        String token = prefs.getString("token", "");
        if (baseUrl.isEmpty() || token.isEmpty()) return null;

        JSONObject remote = getJson(baseUrl + "/api/mobile/version", token);
        if (!remote.has("version") || remote.isNull("version")) return null;
        String version = remote.getString("version");
        File bundleDir = new File(ctx.getFilesDir(), "bundle");
        if (version.equals(prefs.getString("version", "")) && new File(bundleDir, "index.html").exists()) {
            return null;
        }

        JSONArray files = remote.getJSONArray("files");
        File staging = new File(ctx.getFilesDir(), "bundle-staging");
        deleteRecursively(staging);
        if (!staging.mkdirs()) throw new IOException("无法创建暂存目录");
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.getJSONObject(i);
            String path = f.getString("path");
            if (path.contains("..")) throw new IOException("非法路径: " + path);
            downloadToFile(baseUrl + "/api/mobile/file?path=" + java.net.URLEncoder.encode(path, "UTF-8"),
                    token, new File(staging, path));
        }
        if (!new File(staging, "index.html").isFile()) throw new IOException("下载不完整：缺 index.html");

        // 原子切换：bundle -> bundle-old, staging -> bundle, 删 bundle-old
        File oldDir = new File(ctx.getFilesDir(), "bundle-old");
        deleteRecursively(oldDir);
        if (bundleDir.exists() && !bundleDir.renameTo(oldDir)) {
            deleteRecursively(bundleDir);
        }
        if (!staging.renameTo(bundleDir)) throw new IOException("切换目录失败");
        deleteRecursively(oldDir);
        prefs.edit().putString("version", version).apply();
        return version;
    }

    /** 首启动把 APK 内置资源拷到 filesDir/bundle（幂等） */
    public static void ensureLocalBundle(Context ctx) {
        try {
            File bundleDir = new File(ctx.getFilesDir(), "bundle");
            if (new File(bundleDir, "index.html").exists()) return;
            deleteRecursively(bundleDir);
            copyAssetDir(ctx, "public", bundleDir);
            prefs(ctx).edit().remove("version").apply();
        } catch (Exception ignored) {
        }
    }

    public static File bundleDir(Context ctx) {
        return new File(ctx.getFilesDir(), "bundle");
    }

    private static JSONObject getJson(String url, String token) throws Exception {
        HttpURLConnection conn = open(url, token);
        int code = conn.getResponseCode();
        String body = readAll(conn);
        conn.disconnect();
        if (code != 200) throw new IOException("version HTTP " + code + ": " + body);
        return new JSONObject(body);
    }

    private static void downloadToFile(String url, String token, File dest) throws Exception {
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("无法创建目录: " + parent);
        }
        HttpURLConnection conn = open(url, token);
        int code = conn.getResponseCode();
        if (code != 200) {
            conn.disconnect();
            throw new IOException("下载失败 HTTP " + code + ": " + url);
        }
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            conn.disconnect();
        }
    }

    private static HttpURLConnection open(String url, String token) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("x-nm-token", token);
        return conn;
    }

    private static String readAll(HttpURLConnection conn) throws IOException {
        InputStream in = conn.getErrorStream() != null ? conn.getErrorStream() : conn.getInputStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (InputStream is = in) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        }
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void copyAssetDir(Context ctx, String assetPath, File dest) throws IOException {
        String[] list = ctx.getAssets().list(assetPath);
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("mkdirs 失败: " + dest);
        if (list == null || list.length == 0) {
            copyAssetFile(ctx, assetPath, dest);
            return;
        }
        for (String name : list) {
            String child = assetPath + "/" + name;
            String[] sub = ctx.getAssets().list(child);
            if (sub != null && sub.length > 0) {
                copyAssetDir(ctx, child, new File(dest, name));
            } else {
                copyAssetFile(ctx, child, new File(dest, name));
            }
        }
    }

    private static void copyAssetFile(Context ctx, String assetPath, File dest) throws IOException {
        try (InputStream in = ctx.getAssets().open(assetPath);
             FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static void deleteRecursively(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File c : children) deleteRecursively(c);
        }
        // rename 后 fd 仍打开的文件删不掉属正常，忽略
        // noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
