package com.nowplaying.discovery

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.MimeTypeMap
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * LIST-FOLDER-001 on Android. Owner: "add a button where the user can open the local folder with the
 * current song list / queue". The queue's songs live in the app's private cache, which no file manager
 * can see, and kept songs in Music/Airwave Discovery. So the app does not copy anything: it records the
 * list (names in play order, and where each song's file is) and [ListFolderProvider] shows it as an
 * "Airwave Discovery" place in the Files app, opened at once. Songs not downloaded yet are left out.
 */
object ListFolder {
  const val AUTHORITY = "com.nowplaying.discovery.listfolder"
  const val ROOT = "airwave"
  const val DIR = "list"
  private const val FILE = "list-folder.json"
  private const val MAX_SONGS = 5000

  data class Entry(val name: String, val uri: Uri, val mime: String, val size: Long)
  data class Listing(val name: String, val entries: List<Entry>)

  /** "01 Yale - Ken Carson.opus": numbered in play order, with nothing a file name cannot hold. */
  fun entryName(n: Int, title: String, artist: String, ext: String): String {
    val label = if (artist.isBlank()) title.ifBlank { "Song" } else "${title.ifBlank { "Song" }} - $artist"
    val base = Downloads.safeName("${n.toString().padStart(2, '0')} ${label.take(200)}").take(150)
    return if (ext.isEmpty()) base else "$base.$ext"
  }

  /** The list's name as a folder name. */
  fun listName(raw: String): String = Downloads.safeName(raw.ifBlank { "Now playing queue" }).take(80).trimStart('.').ifEmpty { "Now playing queue" }

  fun open(context: Context, req: JSONObject): JSONObject {
    val name = listName(req.optString("name"))
    val songs = req.optJSONArray("songs") ?: JSONArray()
    val entries = ArrayList<JSONObject>()
    for (i in 0 until minOf(songs.length(), MAX_SONGS)) {
      val s = songs.optJSONObject(i) ?: continue
      val (uri, size, type) = Downloads.localFile(context, s.optString("url")) ?: continue
      val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type)
        ?: uri.lastPathSegment?.substringAfterLast('.', "")?.takeIf { it.length in 1..5 } ?: ""
      entries += JSONObject()
        .put("name", entryName(entries.size + 1, s.optString("title"), s.optString("artist"), ext))
        .put("uri", uri.toString()).put("mime", type).put("size", size)
    }
    record(context, name, entries)
    return JSONObject().put("ok", show(context)).put("held", entries.size).put("total", songs.length()).put("folder", "Files › Airwave Discovery › $name")
  }

  /**
   * LIST-SAVE-FOLDER-001: shows a saved list's own folder (songs already copied there, as `uri` + `name`)
   * in the same Files-app place, for phones whose Files app cannot open the Music folder directly.
   */
  fun showSaved(context: Context, name: String, songs: JSONArray): Boolean {
    val entries = ArrayList<JSONObject>()
    for (i in 0 until minOf(songs.length(), MAX_SONGS)) {
      val s = songs.optJSONObject(i) ?: continue
      val uri = Uri.parse(s.optString("uri"))
      val size = runCatching { context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: continue
      entries += JSONObject().put("name", s.optString("name")).put("uri", uri.toString())
        .put("mime", context.contentResolver.getType(uri) ?: "audio/*").put("size", size)
    }
    if (entries.isEmpty()) return false
    record(context, listName(name), entries)
    return show(context)
  }

  private fun record(context: Context, name: String, entries: List<JSONObject>) {
    File(context.filesDir, FILE).writeText(JSONObject().put("name", name).put("songs", JSONArray(entries)).toString())
    context.contentResolver.notifyChange(DocumentsContract.buildRootsUri(AUTHORITY), null)
    context.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(AUTHORITY, DIR), null)
  }

  /** What [open] last recorded, or null before any list was opened. */
  fun read(context: Context): Listing? = runCatching {
    val o = JSONObject(File(context.filesDir, FILE).readText())
    val a = o.getJSONArray("songs")
    Listing(o.getString("name"), (0 until a.length()).map { i ->
      val e = a.getJSONObject(i)
      Entry(e.getString("name"), Uri.parse(e.getString("uri")), e.optString("mime", "audio/*"), e.optLong("size", -1))
    })
  }.getOrNull()

  /** Opens the Files app at the list. */
  private fun show(context: Context): Boolean {
    val tries = listOf(
      DocumentsContract.buildRootUri(AUTHORITY, ROOT) to DocumentsContract.Root.MIME_TYPE_ITEM,
      DocumentsContract.buildDocumentUri(AUTHORITY, DIR) to DocumentsContract.Document.MIME_TYPE_DIR,
    )
    for ((uri, type) in tries) {
      val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      try { context.startActivity(intent); return true } catch (_: ActivityNotFoundException) { /* next */ } catch (_: SecurityException) { /* next */ }
    }
    return false
  }
}
