package com.ractrotech.deligro.pushstyle

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject

/** Only for checking a card on a device: posts a local notification through [PushStyle]. */
class PushStylePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var context: Context? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "deligro/push_style").also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        context = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = context
        if (call.method != "showSample" || ctx == null) {
            result.notImplemented()
            return
        }
        val id = call.argument<Int>("id") ?: 1
        val title = call.argument<String>("title") ?: ""
        val body = call.argument<String>("body") ?: ""
        val card = JSONObject(call.argument<Map<String, Any?>>("card") ?: emptyMap<String, Any?>())

        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(SAMPLE_CHANNEL, "Notification samples", NotificationManager.IMPORTANCE_HIGH))
        }
        val builder = NotificationCompat.Builder(ctx, SAMPLE_CHANNEL)
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
        PushStyle.decorate(ctx, builder, title, body, card)
        nm.notify(id, builder.build())
        result.success(null)
    }

    private companion object {
        const val SAMPLE_CHANNEL = "deligro_push_style_samples"
    }
}
