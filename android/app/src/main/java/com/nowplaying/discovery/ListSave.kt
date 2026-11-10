package com.nowplaying.discovery

import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * LIST-SAVE-FOLDER-001 on Android. Owner: "add an option to quick download entire saved playlist / album
 * and download into seperated folder for just those tracks". Each held song of one saved list or album
 * is copied into a real folder of its own, Music/Airwave Discovery/Albums/<artist - album> or
 * .../Lists/<list name> (inside the folder the owner chose, when one is chosen), numbered in the list's
 * order, so the Files app and other music apps see just those songs. The page calls this again as more
 * songs finish; a song already in the folder is never copied twice or removed. The folder copy becomes
 * the kept copy when the song had none, so it plays offline and the cache limit cannot take it away.
 */
object ListSave {
  private const val FILE = "saved-folders.json"
  private const val MAX_SONGS = 5000
  private val lock = Any()

  /** "Albums" or "Lists"; anything else is refused. */
  fun section(kind: String): String = when (kind) {
    "album" -> "Albums"
    "list" -> "Lists"
    else -> throw IllegalArgumentException("Save an album or a list.")
  }

  /** The folder's own name: nothing a file name cannot hold, and it cannot hide or climb out. */
  fun folderName(kind: String, raw: String): String {
    val fallback = if (kind == "album") "Album" else "List"
    if (raw.trim().trim('.').isBlank()) return fallback
    return Downloads.safeName(raw).take(120).trimStart('.').ifEmpty { fallback }
  }

  /** Where the folder sits under the shared Music folder (MediaStore's RELATIVE_PATH). */
  fun relativePath(kind: String, name: String): String =
    "Music/Airwave Discovery/${section(kind)}/${folderName(kind, name)}"

  /** What the page shows the owner: the place they will find it in the Files app. */
  fun label(kind: String, name: String): String = "Music › Airwave Discovery › ${section(kind)} › ${folderName(kind, name)}"

  /** MediaStore's audio table takes audio types only; a download of unknown type is named by its extension. */
  fun audioType(type: String, ext: String): String = when {
    type.startsWith("audio/") -> type
    ext == "opus" || ext == "ogg" || ext == "oga" -> "audio/ogg"
    ext == "m4a" || ext == "aac" -> "audio/mp4"
    ext == "webm" -> "audio/webm"
    ext == "mp3" -> "audio/mpeg"
    ext == "flac" -> "audio/flac"
    ext == "wav" -> "audio/wav"
    else -> "audio/mpeg"
  }

  fun save(context: Context, req: JSONObject): JSONObject = synchronized(lock) {
    val kind = req.optString("kind")
    val name = folderName(kind, req.optString("name"))
    val key = "${section(kind)}/$name"
    val all = load(context)
    val held = all.optJSONObject(key) ?: JSONObject()
    // A file the owner deleted is fetched into place again on the next call.
    for (u in held.keys().asSequence().toList()) {
      val uri = Uri.parse(held.getJSONObject(u).optString("uri"))
      if (!opens(context.contentResolver, uri)) held.remove(u)
    }
    val songs = req.optJSONArray("songs") ?: JSONArray()
    for (i in 0 until minOf(songs.length(), MAX_SONGS)) {
      val s = songs.optJSONObject(i) ?: continue
      val url = s.optString("url")
      if (held.has(url)) continue
      val (src, _, type) = Downloads.localFile(context, url) ?: continue
      // The download's own extension first ("x.opus" stays .opus); the type's guess turns opus into "oga".
      val ext = extension(nameOf(context, src)) ?: MimeTypeMap.getSingleton().getExtensionFromMimeType(type) ?: ""
      val n = s.optInt("n", i + 1).coerceIn(1, 9999)
      val file = ListFolder.entryName(n, s.optString("title"), s.optString("artist"), ext)
      val dest = runCatching { write(context, kind, name, file, audioType(type, ext), src) }.getOrNull() ?: continue
      held.put(url, JSONObject().put("uri", dest.toString()).put("name", file).put("n", n))
      Downloads.keepAt(context, url, dest)
    }
    all.put(key, held)
    File(context.filesDir, FILE).writeText(all.toString())
    val total = if (req.has("total")) req.optInt("total", songs.length()).coerceAtLeast(0) else songs.length()
    JSONObject().put("ok", true).put("held", held.length()).put("total", total).put("folder", label(kind, name))
  }

  /** Opens the Files app at the folder; false when nothing was saved there yet. */
  fun open(context: Context, req: JSONObject): JSONObject = synchronized(lock) {
    val kind = req.optString("kind")
    val name = folderName(kind, req.optString("name"))
    val held = load(context).optJSONObject("${section(kind)}/$name")
    val result = JSONObject().put("folder", label(kind, name))
    if (held == null || held.length() == 0) return result.put("ok", false)
    // The real folder first (Files by Google opens it), then the app's own Files-app place listing the same songs.
    if (Downloads.chosenTreeDir(context) == null) {
      val doc = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:${relativePath(kind, name)}")
      val intent = Intent(Intent.ACTION_VIEW).setDataAndType(doc, DocumentsContract.Document.MIME_TYPE_DIR)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      try { context.startActivity(intent); return result.put("ok", true) } catch (_: ActivityNotFoundException) { /* next */ } catch (_: SecurityException) { /* next */ }
    }
    val entries = held.keys().asSequence().map { held.getJSONObject(it) }.sortedBy { it.optInt("n") }.toList()
    val songs = JSONArray()
    entries.forEach { e -> songs.put(JSONObject().put("uri", e.optString("uri")).put("name", e.optString("name"))) }
    return result.put("ok", ListFolder.showSaved(context, name, songs))
  }

  /** "song.opus" → "opus": a short audio-file extension, or null. */
  fun extension(name: String?): String? =
    name?.substringAfterLast('.', "")?.lowercase()?.takeIf { it.length in 2..5 && it.all { c -> c.isLetterOrDigit() } && it != name.lowercase() }

  /** A file's own name: the path's last part for a file, the provider's display name for a content uri. */
  private fun nameOf(context: Context, uri: Uri): String? =
    if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
      runCatching {
        context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
      }.getOrNull()
    } else uri.lastPathSegment

  private fun load(context: Context): JSONObject =
    runCatching { JSONObject(File(context.filesDir, FILE).readText()) }.getOrDefault(JSONObject())

  private fun opens(resolver: ContentResolver, uri: Uri): Boolean =
    runCatching { resolver.openFileDescriptor(uri, "r")?.use { true } ?: false }.getOrDefault(false)

  /** Copies one song into the list's folder: the chosen folder, MediaStore on Android 10+, app storage before. */
  private fun write(context: Context, kind: String, name: String, file: String, type: String, src: Uri): Uri {
    val resolver = context.contentResolver
    Downloads.chosenTreeDir(context)?.let { (tree, root) ->
      val section = childDir(resolver, tree, root, section(kind))
      val folder = childDir(resolver, tree, section, name)
      val uri = DocumentsContract.createDocument(resolver, folder, type, file) ?: throw IOException("Selected folder is unavailable; choose it again.")
      copy(resolver, src, uri) { runCatching { DocumentsContract.deleteDocument(resolver, uri) } }
      return uri
    }
    if (Build.VERSION.SDK_INT >= 29) {
      val values = ContentValues().apply {
        put(MediaStore.Audio.Media.DISPLAY_NAME, file)
        put(MediaStore.Audio.Media.MIME_TYPE, type)
        put(MediaStore.Audio.Media.RELATIVE_PATH, relativePath(kind, name))
        put(MediaStore.Audio.Media.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values) ?: throw IOException("Could not create a file in the Music folder.")
      copy(resolver, src, uri) { resolver.delete(uri, null, null) }
      if (resolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null) < 1) {
        resolver.delete(uri, null, null)
        throw IOException("Could not publish the Music file.")
      }
      return uri
    }
    val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "Airwave Discovery/${section(kind)}/$name").also { it.mkdirs() }
    val dest = File(dir, file)
    if (!dest.exists()) (resolver.openInputStream(src) ?: throw IOException("Song is gone.")).use { input -> dest.outputStream().use { input.copyTo(it) } }
    return Uri.fromFile(dest)
  }

  private fun copy(resolver: ContentResolver, src: Uri, dest: Uri, undo: () -> Unit) {
    try {
      (resolver.openInputStream(src) ?: throw IOException("Song is gone.")).use { input ->
        (resolver.openOutputStream(dest) ?: throw IOException("Could not write the song.")).use { input.copyTo(it) }
      }
    } catch (e: Exception) {
      undo()
      throw e
    }
  }

  /** A sub-folder of a chosen folder, made when it is not there yet. */
  private fun childDir(resolver: ContentResolver, tree: Uri, parent: Uri, name: String): Uri {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent))
    resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
      while (c.moveToNext()) {
        if (c.getString(1) == name && c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))
      }
    }
    return DocumentsContract.createDocument(resolver, parent, DocumentsContract.Document.MIME_TYPE_DIR, name) ?: throw IOException("Could not make the folder $name.")
  }
}
