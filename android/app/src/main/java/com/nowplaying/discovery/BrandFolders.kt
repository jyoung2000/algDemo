package com.nowplaying.discovery

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * JPLAY-BRAND-002 (owner, 2026-11-19: "ensure its called jPlay in all places it was called airwave
 * discovery on all platforms"). Downloads and saved lists live in Music/jPlay. Earlier versions used
 * the old name, so their files are moved there once, never copied or deleted:
 *  - Android 10+: each file's MediaStore folder is changed; its content uri stays the same, so the
 *    download index (which stores the uri) still finds it and no song is downloaded again;
 *  - Android 8-9 (app storage): the folder is renamed and the stored file locations rewritten.
 * A file that cannot be moved stays where it is and is still found by its uri.
 */
object BrandFolders {
  const val NAME = "jPlay"
  /** The name earlier versions used: only here, to find their folders. */
  private const val LEGACY = "Airwave Discovery"
  const val MUSIC_PATH = "Music/$NAME"
  private const val TAG = "jPlayFolders"

  /** The jPlay folder for a MediaStore RELATIVE_PATH under the old folder, or null for any other path. */
  fun moved(relativePath: String): String? {
    val old = "Music/$LEGACY"
    return when {
      relativePath == old || relativePath == "$old/" -> "$MUSIC_PATH/"
      relativePath.startsWith("$old/") -> "$MUSIC_PATH/" + relativePath.removePrefix("$old/")
      else -> null
    }
  }

  /** Rewrites file locations under [oldDir] to [newDir] in stored text, as written plainly, uri-encoded and JSON-escaped. */
  fun rewritePaths(text: String, oldDir: String, newDir: String): String {
    var out = text
    for ((o, n) in listOf(oldDir to newDir, oldDir.replace(" ", "%20") to newDir.replace(" ", "%20"))) {
      out = out.replace("$o/", "$n/").replace(o.replace("/", "\\/") + "\\/", n.replace("/", "\\/") + "\\/")
    }
    return out
  }

  private val started = AtomicBoolean(false)

  /** Moves the earlier version's folders once per process, off the main thread. */
  fun moveOnce(context: Context) {
    if (!started.compareAndSet(false, true)) return
    val app = context.applicationContext
    Thread({ runCatching { move(app) }.onFailure { Log.w(TAG, "folder move stopped: ${it.javaClass.simpleName}") } }, "jPlayFolders")
      .apply { isDaemon = true; start() }
  }

  private fun move(context: Context) {
    var moved = 0
    var kept = 0
    if (Build.VERSION.SDK_INT >= 29) {
      val resolver = context.contentResolver
      val table = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
      resolver.query(
        table, arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.RELATIVE_PATH),
        "${MediaStore.Audio.Media.RELATIVE_PATH} LIKE ?", arrayOf("Music/$LEGACY/%"), null,
      )?.use { c ->
        while (c.moveToNext()) {
          val to = moved(c.getString(1) ?: continue) ?: continue
          val ok = runCatching {
            resolver.update(ContentUris.withAppendedId(table, c.getLong(0)), ContentValues().apply { put(MediaStore.Audio.Media.RELATIVE_PATH, to) }, null, null) > 0
          }.getOrDefault(false)
          if (ok) moved++ else kept++
        }
      }
    }
    if (Build.VERSION.SDK_INT >= 29) {
      // The emptied old folders would still show the old name in file managers; only empty ones go.
      @Suppress("DEPRECATION")
      removeEmpty(File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), LEGACY))
    }
    val base = context.getExternalFilesDir(Environment.DIRECTORY_MUSIC)
    if (base != null) {
      val old = File(base, LEGACY)
      val neu = File(base, NAME)
      if (old.isDirectory && !neu.exists() && old.renameTo(neu)) {
        val o = old.absolutePath
        val n = neu.absolutePath
        Downloads.rewriteStoredLocations(context) { rewritePaths(it, o, n) }
        for (name in listOf("saved-folders.json", "list-folder.json")) {
          val f = File(context.filesDir, name)
          if (f.isFile) runCatching { f.writeText(rewritePaths(f.readText(), o, n)) }
        }
        moved++
      }
    }
    if (moved + kept > 0) Log.i(TAG, "moved $moved to $MUSIC_PATH, $kept left where they were (still found)")
  }

  /** Deletes [dir] and its subfolders when they hold no files; anything with a file in it stays. */
  private fun removeEmpty(dir: File): Boolean {
    if (!dir.isDirectory) return false
    val left = dir.listFiles()?.count { !(it.isDirectory && removeEmpty(it)) } ?: return false
    return left == 0 && dir.delete()
  }
}
