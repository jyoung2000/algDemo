package com.nowplaying.discovery

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat

/**
 * Best-effort foreground notification for the Activity's WebView audio. This does NOT own the
 * player or a MediaSession and cannot guarantee playback if Android suspends/destroys the WebView.
 * Full background playback needs a Player + MediaSession in MediaSessionService:
 * https://developer.android.com/media/media3/session/background-playback
 */
class PlaybackNotificationService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action != ACTION_PLAYING) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    val channel = NotificationChannel(CHANNEL, "Airwave playback", NotificationManager.IMPORTANCE_LOW)
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val title = intent.getStringExtra(EXTRA_TITLE)?.take(120)?.takeIf { it.isNotBlank() } ?: "Airwave Discovery"
    val notification = Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText("Playback in Airwave Discovery")
      .setContentIntent(open)
      .setCategory(Notification.CATEGORY_TRANSPORT)
      .setOngoing(true)
      .build()
    // https://developer.android.com/develop/background-work/services/fgs/launch
    ServiceCompat.startForeground(this, 1001, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    return START_NOT_STICKY // Never resurrect a notification without the WebView audio process.
  }

  companion object {
    const val ACTION_PLAYING = "com.nowplaying.discovery.PLAYING"
    const val EXTRA_TITLE = "title"
    private const val CHANNEL = "airwave-playback"
  }
}
