package com.ractrotech.deligro.pushstyle

import android.content.Context
import android.graphics.Color
import android.view.View
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import com.onesignal.notifications.INotificationReceivedEvent
import org.json.JSONObject

/**
 * Draws a push as a card when it carries `data.card` (built on the server by
 * src/lib/notifications/push-card.ts). Anything without a card is left alone and
 * shows as a normal notification.
 *
 * Card keys, all optional:
 *   tone   orange | green | red | blue | amber | dark   accent colour of the small icon
 *   tile   {v, u?, tone?}                               big value on the right ("12" "min")
 *   steps  {at, of}                                     progress bar, `at` is the current step (1-based)
 *   code   "4821"                                       delivery / pickup code as tiles
 *   route  {from, fromNote?, to}                        pickup and drop lines (expanded only)
 *   lines  ["3 x Paneer", ...]                          up to 4 text lines (expanded only)
 *   stats  [{v, l, tone?}, ...]                         up to 3 stat tiles (expanded only)
 *
 * The collapsed view is what a heads-up shows, so it keeps to title, body, tile,
 * steps and code; route, lines and stats only appear when the card is expanded.
 */
object PushStyle {
    /** Attaches the card to the notification OneSignal is about to show. True when a card was found. */
    fun extend(event: INotificationReceivedEvent): Boolean {
        val n = event.notification
        val card = n.additionalData?.optJSONObject("card") ?: return false
        val title = n.title ?: ""
        val body = n.body ?: ""
        val ctx = event.context
        n.setExtender { builder -> decorate(ctx, builder, title, body, card) }
        return true
    }

    fun decorate(
        ctx: Context,
        builder: NotificationCompat.Builder,
        title: String,
        body: String,
        card: JSONObject,
    ): NotificationCompat.Builder {
        try {
            val small = render(ctx, title, body, card, expanded = false)
            val big = render(ctx, title, body, card, expanded = true)
            builder.setStyle(NotificationCompat.DecoratedCustomViewStyle())
            builder.setCustomContentView(small)
            builder.setCustomBigContentView(big)
            accent(card.optString("tone"))?.let { builder.setColor(it) }
        } catch (_: Exception) {
            // A bad card must never cost the person the notification itself.
        }
        return builder
    }

    private fun render(ctx: Context, title: String, body: String, card: JSONObject, expanded: Boolean): RemoteViews {
        val rv = RemoteViews(ctx.packageName, R.layout.dl_card)
        rv.setTextViewText(R.id.dl_title, title)
        // The heads-up has room for one title line and two of body; the expanded card gets more.
        rv.setInt(R.id.dl_title, "setMaxLines", if (expanded) 2 else 1)
        rv.setInt(R.id.dl_body, "setMaxLines", if (expanded) 4 else 2)

        val code = card.optString("code", "")
        // With a code row the heads-up is already full; the body moves to the expanded view.
        val showBody = body.isNotEmpty() && (expanded || code.isEmpty())
        rv.setTextViewText(R.id.dl_body, body)
        rv.setViewVisibility(R.id.dl_body, vis(showBody))

        card.optJSONObject("tile")?.let { tile ->
            val tone = tile.optString("tone", "dark")
            rv.setViewVisibility(R.id.dl_tile, View.VISIBLE)
            rv.setInt(R.id.dl_tile, "setBackgroundResource", tileDrawable(tone))
            rv.setTextViewText(R.id.dl_tile_value, tile.optString("v"))
            rv.setTextColor(R.id.dl_tile_value, tileText(tone))
            val unit = tile.optString("u", "")
            rv.setTextViewText(R.id.dl_tile_unit, unit)
            rv.setTextColor(R.id.dl_tile_unit, tileText(tone))
            rv.setViewVisibility(R.id.dl_tile_unit, vis(unit.isNotEmpty()))
        }

        card.optJSONObject("steps")?.let { steps ->
            val of = steps.optInt("of", 0).coerceIn(0, SEGMENTS.size)
            val at = steps.optInt("at", 0)
            if (of > 0) {
                rv.setViewVisibility(R.id.dl_steps, View.VISIBLE)
                for (i in SEGMENTS.indices) {
                    rv.setViewVisibility(SEGMENTS[i], vis(i < of))
                    rv.setInt(
                        SEGMENTS[i], "setBackgroundResource",
                        when {
                            i + 1 < at -> R.drawable.dl_seg_done
                            i + 1 == at -> R.drawable.dl_seg_now
                            else -> R.drawable.dl_seg_todo
                        },
                    )
                }
            }
        }

        if (code.isNotEmpty()) {
            rv.setViewVisibility(R.id.dl_code, View.VISIBLE)
            for (i in CODE.indices) {
                val ch = code.getOrNull(i)
                rv.setViewVisibility(CODE[i], vis(ch != null))
                if (ch != null) rv.setTextViewText(CODE[i], ch.toString())
            }
        }

        if (expanded) {
            card.optJSONObject("route")?.let { route ->
                rv.setViewVisibility(R.id.dl_route, View.VISIBLE)
                val note = route.optString("fromNote", "")
                rv.setTextViewText(R.id.dl_route_from_label, if (note.isEmpty()) "PICK UP" else "PICK UP  ·  $note")
                rv.setTextViewText(R.id.dl_route_from, route.optString("from"))
                rv.setTextViewText(R.id.dl_route_to_label, "DROP")
                rv.setTextViewText(R.id.dl_route_to, route.optString("to"))
            }
            card.optJSONArray("lines")?.let { lines ->
                rv.setViewVisibility(R.id.dl_lines, View.VISIBLE)
                for (i in LINES.indices) {
                    val text = lines.optString(i, "")
                    rv.setViewVisibility(LINES[i], vis(text.isNotEmpty()))
                    rv.setTextViewText(LINES[i], text)
                }
            }
            card.optJSONArray("stats")?.let { stats ->
                rv.setViewVisibility(R.id.dl_stats, View.VISIBLE)
                for (i in STATS.indices) {
                    val s = stats.optJSONObject(i)
                    rv.setViewVisibility(STATS[i].box, vis(s != null))
                    if (s != null) {
                        val tone = s.optString("tone", "neutral")
                        rv.setInt(STATS[i].box, "setBackgroundResource", tileDrawable(tone))
                        rv.setTextViewText(STATS[i].value, s.optString("v"))
                        rv.setTextViewText(STATS[i].label, s.optString("l"))
                        rv.setTextColor(STATS[i].value, tileText(tone))
                        rv.setTextColor(STATS[i].label, tileText(tone))
                    }
                }
            }
        }
        return rv
    }

    private fun vis(show: Boolean) = if (show) View.VISIBLE else View.GONE

    private fun tileDrawable(tone: String) = when (tone) {
        "orange" -> R.drawable.dl_tile_orange
        "green" -> R.drawable.dl_tile_green
        "red" -> R.drawable.dl_tile_red
        "blue" -> R.drawable.dl_tile_blue
        "amber" -> R.drawable.dl_tile_amber
        "neutral" -> R.drawable.dl_tile_neutral
        else -> R.drawable.dl_tile_dark
    }

    private fun tileText(tone: String): Int = Color.parseColor(
        when (tone) {
            "orange" -> "#1A0A00"
            "green" -> "#0E6B3C"
            "red" -> "#A31F1F"
            "blue" -> "#134DAA"
            "amber" -> "#7A5400"
            "neutral" -> "#14161A"
            else -> "#FFFFFF"
        },
    )

    private fun accent(tone: String): Int? = when (tone) {
        "orange" -> "#F2680C"
        "green" -> "#14804A"
        "red" -> "#C62828"
        "blue" -> "#1D5FD1"
        "amber" -> "#B07A00"
        "dark" -> "#14161A"
        else -> null
    }?.let { Color.parseColor(it) }

    private val SEGMENTS = intArrayOf(R.id.dl_seg0, R.id.dl_seg1, R.id.dl_seg2, R.id.dl_seg3, R.id.dl_seg4, R.id.dl_seg5)
    private val CODE = intArrayOf(R.id.dl_code0, R.id.dl_code1, R.id.dl_code2, R.id.dl_code3)
    private val LINES = intArrayOf(R.id.dl_line0, R.id.dl_line1, R.id.dl_line2, R.id.dl_line3)

    private class Stat(val box: Int, val value: Int, val label: Int)

    private val STATS = arrayOf(
        Stat(R.id.dl_stat0, R.id.dl_stat0_v, R.id.dl_stat0_l),
        Stat(R.id.dl_stat1, R.id.dl_stat1_v, R.id.dl_stat1_l),
        Stat(R.id.dl_stat2, R.id.dl_stat2_v, R.id.dl_stat2_l),
    )
}
