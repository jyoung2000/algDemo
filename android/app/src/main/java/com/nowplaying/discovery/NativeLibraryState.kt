package com.nowplaying.discovery

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * NATIVE-COLD-STATE-001: the library, native queue and audio settings, kept in the app's own private
 * preferences so a car can cold-start the service (no Activity, no page) with the saved playlists,
 * queue and exactly the sound the listener chose. Restoring never plays: see EnginePlayer.restoreNativeState.
 * The rules (versions, bounds, corruption) live in [NativeStateCodec]. Call [init] before reading;
 * until then reads are null and records are dropped. Synchronized: the engine page's bridge reads
 * the library off the main thread.
 */
object NativeLibraryState {
  private const val PREFS = "airwave_native_state"
  @Volatile private var store: NativeStateCodec.Store? = null

  @Synchronized fun init(context: Context) {
    if (store != null) return
    val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    store = NativeStateCodec.Store(object : NativeStateCodec.Io {
      override fun get(key: String): String? = prefs.getString(key, null)
      override fun put(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
      }
    })
  }

  /** For JVM tests: the same store over injected key/value IO. */
  @Synchronized internal fun initForTest(io: NativeStateCodec.Io?) { store = io?.let { NativeStateCodec.Store(it) } }

  @Synchronized fun library(): JSONObject? = store?.library()
  @Synchronized fun recordLibrary(snapshot: JSONObject): Boolean = store?.recordLibrary(snapshot) == true
  @Synchronized fun nativeState(): JSONObject? = store?.nativeState()
  @Synchronized fun recordNativeState(state: JSONObject) { store?.recordNativeState(state) }
  @Synchronized fun settings(): JSONObject? = store?.settings()
  @Synchronized fun recordSettings(settings: JSONObject) { store?.recordSettings(settings) }
  @Synchronized fun rememberTrack(track: JSONObject): Boolean = store?.rememberTrack(track) == true
  @Synchronized fun rememberTracks(list: JSONArray): Int = store?.rememberTracks(list) ?: 0
  @Synchronized fun rawTrack(key: String): JSONObject? = store?.rawTrack(key)
  @Synchronized fun tracks(): JSONArray? = store?.tracks()
}
