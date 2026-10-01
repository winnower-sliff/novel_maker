package com.novelmaker.mobile;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * APK 内置 bundle 资源的装载 helper（与更新无关）：
 * 首启动把 assets/public 拷到 filesDir/bundle（幂等），APK 覆盖安装后内容变化则重拷。
 */
public final class Updater {

    private Updater() {}

    /**
     * 首启动把 APK 内置资源拷到 filesDir/bundle（幂等）。
     * APK 覆盖安装后本地 bundle 仍是旧版：对比内置 index.html 与本地，
     * 不一致则清掉本地 bundle 重拷。
     */
    public static void ensureLocalBundle(Context ctx) {
        try {
            File bundleDir = new File(ctx.getFilesDir(), "bundle");
            if (new File(bundleDir, "index.html").exists()) {
                String embedded = readAssetText(ctx, "public/index.html");
                String local = readTextFile(new File(bundleDir, "index.html"));
                if (embedded == null || embedded.equals(local)) return;
                deleteRecursively(bundleDir);
            }
            deleteRecursively(bundleDir);
            copyAssetDir(ctx, "public", bundleDir);
        } catch (Exception ignored) {
        }
    }

    public static File bundleDir(Context ctx) {
        return new File(ctx.getFilesDir(), "bundle");
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
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
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

    static void deleteRecursively(File file) {
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
