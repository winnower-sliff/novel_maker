package com.novelmaker.mobile;

import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final long UPDATE_HARD_LIMIT_MS = 60_000;

    private boolean basePathApplied = false;
    private FrameLayout overlay;
    private TextView stateText;
    private TextView detailText;
    private ProgressBar progressBar;
    private Button retryButton;
    private Button skipButton;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private final Runnable hardLimit = this::onUpdateHardLimit;
    private boolean updateFinished = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppRestartPlugin.class);
        Updater.ensureLocalBundle(this);
        super.onCreate(savedInstanceState);
        buildOverlay();
    }

    private void buildOverlay() {
        overlay = new FrameLayout(this);
        overlay.setBackgroundColor(Color.parseColor("#09090b"));
        overlay.setVisibility(View.GONE);
        overlay.setClickable(true);
        overlay.setFocusable(true);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout.LayoutParams boxLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        boxLp.gravity = Gravity.CENTER;
        int pad = (int) (32 * getResources().getDisplayMetrics().density);
        box.setPadding(pad * 2, 0, pad * 2, 0);

        stateText = new TextView(this);
        stateText.setTextColor(Color.parseColor("#e4e4e7"));
        stateText.setTextSize(17);
        stateText.setGravity(Gravity.CENTER);
        box.addView(stateText);

        detailText = new TextView(this);
        detailText.setTextColor(Color.parseColor("#a1a1aa"));
        detailText.setTextSize(13);
        detailText.setGravity(Gravity.CENTER);
        detailText.setPadding(0, (int) (6 * getResources().getDisplayMetrics().density), 0, 0);
        box.addView(detailText);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        LinearLayout.LayoutParams pbLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                (int) (8 * getResources().getDisplayMetrics().density));
        pbLp.topMargin = (int) (18 * getResources().getDisplayMetrics().density);
        progressBar.setLayoutParams(pbLp);
        progressBar.setMax(100);
        progressBar.getProgressDrawable().setColorFilter(Color.parseColor("#d97706"),
                android.graphics.PorterDuff.Mode.SRC_IN);
        progressBar.setIndeterminateTintList(
                android.content.res.ColorStateList.valueOf(Color.parseColor("#d97706")));
        box.addView(progressBar);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams btnsLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnsLp.topMargin = (int) (22 * getResources().getDisplayMetrics().density);
        buttons.setLayoutParams(btnsLp);

        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnLp.setMargins((int) (6 * getResources().getDisplayMetrics().density), 0,
                (int) (6 * getResources().getDisplayMetrics().density), 0);

        retryButton = new Button(this);
        retryButton.setText("重试");
        retryButton.setVisibility(View.GONE);
        retryButton.setOnClickListener(v -> startUpdate());
        buttons.addView(retryButton, btnLp);

        skipButton = new Button(this);
        skipButton.setText("跳过进入");
        skipButton.setVisibility(View.GONE);
        skipButton.setOnClickListener(v -> finishUpdate(false));
        buttons.addView(skipButton, btnLp);

        box.addView(buttons);
        overlay.addView(box);
        addContentView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void setOverlayState(String state, String version, int fileCount, long totalBytes) {
        progressBar.setIndeterminate(!"download".equals(state));
        retryButton.setVisibility(View.GONE);
        skipButton.setVisibility(View.GONE);
        switch (state) {
            case "check":
                stateText.setText("正在检查更新…");
                detailText.setText("");
                break;
            case "download":
                stateText.setText("正在下载 v" + version);
                detailText.setText(fileCount + " 个文件 · 共 " + fmtBytes(totalBytes));
                break;
            case "apply":
                stateText.setText("正在应用更新…");
                detailText.setText("v" + version);
                break;
            default:
                break;
        }
    }

    private static String fmtBytes(long b) {
        if (b >= 1024 * 1024) return String.format(java.util.Locale.US, "%.1f MB", b / 1048576.0);
        if (b >= 1024) return String.format(java.util.Locale.US, "%.0f KB", b / 1024.0);
        return b + " B";
    }

    @Override
    public void onResume() {
        super.onResume();
        if (!basePathApplied) {
            // 首帧从 assets/public 加载，切到 filesDir/bundle（内容相同，无感）
            bridge.setServerBasePath(Updater.bundleDir(this).getAbsolutePath());
            basePathApplied = true;
        }
        // 等 WebView 就绪后读 localStorage 的连接信息；有连接才做启动更新
        WebView webView = bridge.getWebView();
        if (webView == null) return;
        webView.evaluateJavascript("localStorage.getItem('nm_conn')", (ValueCallback<String>) value -> {
            Updater.saveConnFromLocalStorage(this, value);
            if (!Updater.hasConn(this)) return; // 未配置连接，直接进
            startUpdate();
        });
    }

    private void startUpdate() {
        updateFinished = false;
        overlay.setVisibility(View.VISIBLE);
        setOverlayState("check", null, 0, 0);
        uiHandler.postDelayed(hardLimit, UPDATE_HARD_LIMIT_MS);
        Updater.updateAsync(this, new Updater.ProgressListener() {
            @Override
            public void onState(String state, String version, int fileCount, long totalBytes) {
                setOverlayState(state, version, fileCount, totalBytes);
            }

            @Override
            public void onProgress(long doneBytes, long totalBytes) {
                if (totalBytes > 0) {
                    progressBar.setIndeterminate(false);
                    progressBar.setProgress((int) (doneBytes * 100 / totalBytes));
                    detailText.setText(fmtBytes(doneBytes) + " / " + fmtBytes(totalBytes));
                }
            }
        }, this::onUpdateDone);
    }

    private void onUpdateDone(Updater.Result r) {
        if (updateFinished) return;
        uiHandler.removeCallbacks(hardLimit);
        if (r.error != null) {
            // 失败：显示原因，人工重试或跳过
            stateText.setText("更新失败");
            detailText.setText(r.error == null ? "未知错误" : r.error);
            progressBar.setIndeterminate(false);
            progressBar.setProgress(0);
            retryButton.setVisibility(View.VISIBLE);
            skipButton.setVisibility(View.VISIBLE);
            writeLastUpdate(r, true);
            return;
        }
        if (r.updated) {
            writeLastUpdate(r, false);
            // 本次启动即加载新版：切路径 + reload
            bridge.setServerBasePath(Updater.bundleDir(this).getAbsolutePath());
            // reload 后等 __NM_READY__ 再揭覆盖层
            waitReadyThenFinish();
        } else {
            finishUpdate(false);
        }
    }

    private void onUpdateHardLimit() {
        // 60s 兜底：不再阻塞进入
        updateFinished = true;
        finishUpdate(false);
    }

    private void waitReadyThenFinish() {
        final int[] tries = {0};
        Runnable poll = new Runnable() {
            @Override
            public void run() {
                if (updateFinished) return;
                tries[0]++;
                WebView webView = bridge.getWebView();
                if (webView == null) {
                    finishUpdate(false);
                    return;
                }
                webView.evaluateJavascript("window.__NM_READY__ === true", (ValueCallback<String>) v -> {
                    if (updateFinished) return;
                    if ("true".equals(v)) {
                        finishUpdate(false);
                    } else if (tries[0] > 60) {
                        finishUpdate(false);
                    } else {
                        uiHandler.postDelayed(this, 250);
                    }
                });
            }
        };
        uiHandler.postDelayed(poll, 500);
    }

    private void writeLastUpdate(Updater.Result r, boolean failed) {
        String json = "{\"ok\":" + !failed
                + ",\"version\":" + (r.version == null ? "null" : "\"" + r.version + "\"")
                + ",\"files\":" + r.fileCount
                + ",\"bytes\":" + r.bytes
                + ",\"durationMs\":" + r.durationMs
                + ",\"error\":" + (r.error == null ? "null" : "\"" + r.error.replace("\"", "'") + "\"")
                + ",\"at\":" + System.currentTimeMillis() + "}";
        String js = "try{localStorage.setItem('nm_last_update','" + jsQuote(json) + "')}catch(e){}void 0";
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView != null) webView.evaluateJavascript(js, null);
    }

    /** JSON 字符串 → JS 单引号字符串字面量安全转义 */
    private static String jsQuote(String s) {
        return s.replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
    }

    private void finishUpdate(boolean ignored) {
        updateFinished = true;
        uiHandler.removeCallbacks(hardLimit);
        overlay.setVisibility(View.GONE);
    }
}
