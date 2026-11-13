package com.novelmaker.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

/**
 * 导出文件到用户选择的位置：SAF ACTION_CREATE_DOCUMENT 调起系统文件保存器，
 * 用户选目录（可改文件名）→ 返回 content uri → JS 再调 writeFileToUri 写入内容。
 */
@CapacitorPlugin(name = "ExportPlugin")
public class ExportPlugin extends Plugin {

    /** 调起系统保存器：确认后 resolve { uri }；用户取消 reject("cancelled") */
    @PluginMethod
    public void presentCreateDocument(PluginCall call) {
        String fileName = call.getString("fileName", "export.zip");
        String mime = call.getString("mimeType", "application/zip");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        bridge.saveCall(call);
        startActivityForResult(call, intent, "createDocumentResult");
    }

    @ActivityCallback
    private void createDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        JSObject ret = new JSObject();
        ret.put("uri", uri == null ? "" : uri.toString());
        call.resolve(ret);
    }

    /** 向 SAF uri 覆盖写入 base64 内容 */
    @PluginMethod
    public void writeFileToUri(PluginCall call) {
        String uriStr = call.getString("uri", "");
        String base64 = call.getString("base64", "");
        if (uriStr.isEmpty() || base64.isEmpty()) {
            call.reject("uri/base64 不能为空");
            return;
        }
        try {
            byte[] bytes = Base64.decode(base64, Base64.NO_WRAP);
            try (OutputStream os = getContext().getContentResolver().openOutputStream(Uri.parse(uriStr))) {
                if (os == null) throw new IllegalStateException("无法打开目标文件");
                os.write(bytes);
                os.flush();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
