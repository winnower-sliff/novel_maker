package com.novelmaker.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
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
 * 更新引擎：向电脑端查询 /api/mobile/version，有新版则下载到 staging，
 * 校验 index.html 后原子切换 filesDir/bundle。同步执行，调用方放后台线程；
 * 过程经 ProgressListener 汇报状态与字节进度（回调已切主线程）。
 */
public final class Updater {
    public interface ProgressListener {
        /** check / download / apply 阶段切换（主线程回调） */
        void onState(String state, @Nullable String version, int fileCount, long totalBytes);

        /** 下载进度（主线程回调） */
        void onProgress(long doneBytes, long totalBytes);
    }

    /** 一次更新的终态结果 */
    public static final class Result {
        public final boolean updated;
        @Nullable public final String version;
        public final int fileCount;
        public final long bytes;
        public final long durationMs;
        @Nullable public final String error;

        Result(boolean updated, @Nullable String version, int fileCount, long bytes, long durationMs, @Nullable String error) {
            this.updated = updated;
            this.version = version;
            this.fileCount = fileCount;
            this.bytes = bytes;
            this.durationMs = durationMs;
            this.error = error;
        }
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

    public static boolean hasConn(Context ctx) {
        SharedPreferences prefs = prefs(ctx);
        return !prefs.getString("baseUrl", "").isEmpty() && !prefs.getString("token", "").isEmpty();
    }

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("nm_updater", Context.MODE_PRIVATE);
    }

    /** 在后台线程执行一轮检查+更新；结果经主线程回调 */
    public static void updateAsync(Context ctx, ProgressListener listener, Callback callback) {
        POOL.execute(() -> {
            long start = System.currentTimeMillis();
            Result r;
            try {
                r = checkAndUpdate(ctx, listener);
                r = new Result(r.updated, r.version, r.fileCount, r.bytes,
                        System.currentTimeMillis() - start, r.error);
            } catch (Exception e) {
                r = new Result(false, null, 0, 0, System.currentTimeMillis() - start,
                        e.getMessage() != null ? e.getMessage() : e.toString());
            }
            final Result fr = r;
            MAIN.post(() -> callback.onDone(fr));
        });
    }

    public interface Callback {
        void onDone(Result result);
    }

    /** 同步执行一轮检查+更新（阻塞，须在后台线程调用） */
    public static Result checkAndUpdate(Context ctx, @Nullable ProgressListener listener) throws Exception {
        SharedPreferences prefs = prefs(ctx);
        String baseUrl = prefs.getString("baseUrl", "");
        String token = prefs.getString("token", "");
        if (baseUrl.isEmpty() || token.isEmpty()) {
            return new Result(false, null, 0, 0, 0, null);
        }

        // check
        notifyState(listener, "check", null, 0, 0);
        HttpURLConnection conn = open(baseUrl + "/api/mobile/version", token);
        int code = conn.getResponseCode();
        String body = readAll(conn);
        conn.disconnect();
        if (code != 200) throw new IOException("检查更新失败 HTTP " + code);
        JSONObject remote = new JSONObject(body);
        if (!remote.has("version") || remote.isNull("version")) {
            return new Result(false, null, 0, 0, 0, null);
        }
        String version = remote.getString("version");
        File bundleDir = new File(ctx.getFilesDir(), "bundle");
        if (version.equals(prefs.getString("version", "")) && new File(bundleDir, "index.html").exists()) {
            return new Result(false, version, 0, 0, 0, null);
        }

        JSONArray files = remote.getJSONArray("files");
        long totalBytes = 0;
        for (int i = 0; i < files.length(); i++) totalBytes += files.getJSONObject(i).optLong("size", 0);
        notifyState(listener, "download", version, files.length(), totalBytes);

        // download
        File staging = new File(ctx.getFilesDir(), "bundle-staging");
        deleteRecursively(staging);
        if (!staging.mkdirs()) throw new IOException("无法创建暂存目录");
        long[] done = {0};
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.getJSONObject(i);
            String path = f.getString("path");
            if (path.contains("..")) throw new IOException("非法路径: " + path);
            downloadToFile(baseUrl + "/api/mobile/file?path=" + java.net.URLEncoder.encode(path, "UTF-8"),
                    token, new File(staging, path), done, totalBytes, listener);
        }
        if (!new File(staging, "index.html").isFile()) throw new IOException("下载不完整：缺 index.html");

        // apply
        notifyState(listener, "apply", version, files.length(), totalBytes);
        File oldDir = new File(ctx.getFilesDir(), "bundle-old");
        deleteRecursively(oldDir);
        if (bundleDir.exists() && !bundleDir.renameTo(oldDir)) {
            deleteRecursively(bundleDir);
        }
        if (!staging.renameTo(bundleDir)) throw new IOException("切换目录失败");
        deleteRecursively(oldDir);
        prefs.edit().putString("version", version).apply();
        return new Result(true, version, files.length(), totalBytes, 0, null);
    }

    private static void notifyState(@Nullable ProgressListener l, String state, @Nullable String version,
                                    int fileCount, long totalBytes) {
        if (l == null) return;
        MAIN.post(() -> l.onState(state, version, fileCount, totalBytes));
    }

    /**
     * 首启动把 APK 内置资源拷到 filesDir/bundle（幂等）。
     * APK 覆盖安装后本地 bundle 仍是旧版：对比内置 index.html 与本地，
     * 不一致则清掉本地 bundle 重拷，并清 version 记录让更新检查重新对齐服务器。
     */
    public static void ensureLocalBundle(Context ctx) {
        try {
            File bundleDir = new File(ctx.getFilesDir(), "bundle");
            if (new File(bundleDir, "index.html").exists()) {
                String embedded = readAssetText(ctx, "public/index.html");
                String local = readTextFile(new File(bundleDir, "index.html"));
                if (embedded == null || embedded.equals(local)) return;
                deleteRecursively(bundleDir);
                prefs(ctx).edit().remove("version").apply();
            }
            deleteRecursively(bundleDir);
            copyAssetDir(ctx, "public", bundleDir);
            prefs(ctx).edit().remove("version").apply();
        } catch (Exception ignored) {
        }
    }

    public static File bundleDir(Context ctx) {
        return new File(ctx.getFilesDir(), "bundle");
    }

    private static void downloadToFile(String url, String token, File dest,
                                       long[] done, long totalBytes, @Nullable ProgressListener listener) throws Exception {
        File parent = dest.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("无法创建目录: " + parent);
        }
        HttpURLConnection conn = open(url, token);
        int code = conn.getResponseCode();
        if (code != 200) {
            conn.disconnect();
            throw new IOException("下载失败 HTTP " + code);
        }
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done[0] += n;
                if (listener != null) {
                    final long d = done[0];
                    MAIN.post(() -> listener.onProgress(d, totalBytes));
                }
            }
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

    private static String readTextFile(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            return drainStream(in);
        }
    }

    private static String readAssetText(Context ctx, String path) throws IOException {
        try (InputStream in = ctx.getAssets().open(path)) {
            return drainStream(in);
        }
    }

    private static String drainStream(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String readAll(HttpURLConnection conn) throws IOException {
        InputStream in = conn.getErrorStream() != null ? conn.getErrorStream() : conn.getInputStream();
        try (InputStream is = in) {
            return drainStream(is);
        }
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
