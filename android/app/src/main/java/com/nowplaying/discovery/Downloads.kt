package com.nowplaying.discovery

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * yt-dlp on Android, the same engine the Windows app ships, via the youtubedl-android library
 * (a Python runtime, yt-dlp and ffmpeg that unpack from the APK on first run; nothing to install).
 *
 * The page names a URL, a tool and a format; every flag is written here, `--ignore-config` first so a
 * config file can never add `--exec`. The URL goes last, after `--`, so it cannot be read as an option.
 * Finished files are copied to the phone's Music folder (Music/Airwave Discovery) through MediaStore.
 *
 * spotDL is not run here: it is a Python app that depends on packages with no Android build
 * (rapidfuzz, pydantic-core, uvloop). The page does what spotDL does instead (Spotify track ->
 * YouTube Music match -> yt-dlp) and `health` says so in `method`.
 */
object Downloads {
  /** Mirrored by web/src/engine/downloads.ts and windows/downloads.cjs; download-hosts.test.ts checks all three. */
  val YTDLP_HOSTS = setOf(
    "youtu.be", "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com",
  )
  val FORMATS = setOf("mp3", "m4a", "opus", "flac", "wav", "original")

  private val audioExtensions = setOf("mp3", "m4a", "aac", "flac", "opus", "ogg", "oga", "wav", "webm", "mka")
  private val mime = mapOf("mp3" to "audio/mpeg", "m4a" to "audio/mp4", "aac" to "audio/aac", "flac" to "audio/flac", "opus" to "audio/ogg", "ogg" to "audio/ogg", "oga" to "audio/ogg", "wav" to "audio/wav", "webm" to "audio/webm", "mka" to "audio/x-matroska")

  class Job(val id: String, val url: String, val format: String, val label: String, val dir: File) {
    @Volatile var state = "queued"
    @Volatile var stage = "queued"
    @Volatile var percent: Double? = null
    @Volatile var message: String? = null
    @Volatile var error: String? = null
    @Volatile var savedTo: String? = null
    @Volatile var cancelled = false
    val files = CopyOnWriteArrayList<Triple<String, Long, Uri?>>() // name, bytes, uri
  }

  private val jobs = ConcurrentHashMap<String, Job>()
  /**
   * Finished downloads indexed by the link they were fetched from, so the player can ask "do you
   * hold this song?" and play it on a deck through the equaliser and mixer (LOCAL-AUDIO-001). The
   * value is the saved file's URI (MediaStore on Android 10+, a file on older phones), kept in
   * SharedPreferences; an entry whose file has gone is dropped when read.
   */
  private const val LIBRARY = "airwave-library"
  private val libraryLock = Any()

  private fun libraryGet(context: Context, url: String): Uri? = synchronized(libraryLock) {
    val prefs = context.getSharedPreferences(LIBRARY, Context.MODE_PRIVATE)
    val raw = prefs.getString(url, null) ?: return null
    val uri = Uri.parse(raw)
    val present = runCatching { context.contentResolver.openFileDescriptor(uri, "r")?.use { true } ?: false }.getOrDefault(false)
    if (!present) { prefs.edit().remove(url).apply(); return null }
    uri
  }

  private fun librarySet(context: Context, url: String, uri: Uri) = synchronized(libraryLock) {
    context.getSharedPreferences(LIBRARY, Context.MODE_PRIVATE).edit().putString(url, uri.toString()).apply()
  }

  /** The held file for a link (its URI, size and MIME type), for the activity to serve at the app origin. */
  fun localFile(context: Context, url: String): Triple<Uri, Long, String>? {
    if (!urlAllowed(url)) return null
    val uri = libraryGet(context, url) ?: return null
    val size = runCatching { context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: return null
    val type = context.contentResolver.getType(uri) ?: mime[uri.lastPathSegment?.substringAfterLast('.', "")?.lowercase() ?: ""] ?: "application/octet-stream"
    return Triple(uri, size, type)
  }
  private val order = CopyOnWriteArrayList<String>()
  private val queue = Executors.newSingleThreadExecutor()
  private val setup = Executors.newSingleThreadExecutor()
  private val starting = AtomicBoolean(false)

  @Volatile private var ready = false
  @Volatile private var failure: String? = null
  @Volatile private var version: String? = null

  /** First-run setup: unpacks Python, yt-dlp and ffmpeg on a background thread. Safe to call repeatedly. */
  fun warmUp(context: Context) {
    if (ready || !starting.compareAndSet(false, true)) return
    val app = context.applicationContext
    setup.execute {
      try {
        YoutubeDL.getInstance().init(app)
        FFmpeg.getInstance().init(app)
        version = YoutubeDL.getInstance().version(app)
        failure = null
        ready = true
        // YouTube changes often and old yt-dlp builds stop working, so fetch the newest release in the
        // background. If the phone is offline or the update fails, the bundled build keeps working.
        try {
          YoutubeDL.getInstance().updateYoutubeDL(app, YoutubeDL.UpdateChannel.STABLE)
          version = YoutubeDL.getInstance().version(app)
        } catch (_: Throwable) {
        }
      } catch (e: Throwable) {
        failure = e.message ?: e.javaClass.simpleName
        starting.set(false)
      }
    }
  }

  fun urlAllowed(raw: String): Boolean {
    if (raw.length > 500 || raw.any { it.isWhitespace() || it.code < 32 }) return false
    val u = runCatching { URI(raw) }.getOrNull() ?: return false
    if (u.scheme != "https" || u.userInfo != null) return false
    return (u.host ?: return false).lowercase() in YTDLP_HOSTS
  }

  fun health(context: Context): JSONObject {
    val tools = JSONArray()
    val state = when {
      ready -> null
      failure != null -> "This app could not set up yt-dlp: $failure"
      else -> "Setting up on first run; it unpacks itself the first time the app opens, which takes a few seconds."
    }
    tools.put(JSONObject().put("id", "yt-dlp").put("present", ready).put("version", version ?: JSONObject.NULL).put("method", "the real yt-dlp, run inside this app").put("detail", state ?: JSONObject.NULL))
    tools.put(
      JSONObject().put("id", "spotdl").put("present", ready).put("version", JSONObject.NULL)
        .put("method", "spotDL's own method: Spotify track, matched on YouTube Music, downloaded with yt-dlp. The spotdl program itself needs packages with no Android build.")
        .put("detail", state ?: JSONObject.NULL),
    )
    tools.put(JSONObject().put("id", "ffmpeg").put("present", ready).put("version", if (ready) "bundled with this app" else JSONObject.NULL).put("method", "the real ffmpeg, run inside this app").put("detail", state ?: JSONObject.NULL))
    return JSONObject().put("ready", ready).put("runs_spotdl", false).put("tools", tools).put("saves_to", "Music/Airwave Discovery")
  }

  fun handle(context: Context, req: JSONObject): JSONObject = when (val op = req.optString("op")) {
    "health" -> health(context)
    "start" -> JSONObject().put("job", view(start(context, req.optString("url"), req.optString("tool"), req.optString("format"), req.optString("label"))))
    "jobs" -> JSONObject().put("jobs", JSONArray().also { a -> order.mapNotNull { jobs[it] }.forEach { a.put(view(it)) } })
    "cancel" -> JSONObject().put("ok", cancel(req.optString("id")))
    "forget" -> { val id = req.optString("id"); cancel(id); order.remove(id); JSONObject().put("ok", jobs.remove(id) != null) }
    "reveal" -> JSONObject().put("ok", reveal(context, req.optString("id")))
    "local" -> {
      val url = req.optString("url")
      require(urlAllowed(url)) { "Not a link this app downloads from." }
      val held = localFile(context, url)
      val running = jobs.values.any { it.url == url && (it.state == "queued" || it.state == "running") }
      JSONObject()
        .put("file", held?.let { (uri, size, _) -> JSONObject().put("name", uri.lastPathSegment ?: "song").put("bytes", size) } ?: JSONObject.NULL)
        .put("running", running)
    }
    else -> throw IllegalArgumentException("Unknown request: $op")
  }

  private fun start(context: Context, url: String, tool: String, format: String, label: String): Job {
    // The page maps a Spotify link to a YouTube Music link first, so only yt-dlp is ever run here.
    require(tool == "yt-dlp") { "Only yt-dlp runs on this device." }
    require(format in FORMATS) { "Unsupported format." }
    require(urlAllowed(url)) { "yt-dlp downloads from YouTube, YouTube Music and SoundCloud links." }
    require(jobs.values.count { it.state == "queued" || it.state == "running" } < 20) { "Too many downloads are waiting. Let some finish first." }
    val id = UUID.randomUUID().toString()
    val dir = File(File(context.cacheDir, "dl-jobs"), id).also { it.mkdirs() }
    val job = Job(id, url, format, label.take(200), dir)
    jobs[id] = job
    order.add(id)
    val app = context.applicationContext
    queue.execute {
      try {
        run(app, job)
      } catch (e: Throwable) {
        if (!job.cancelled) fail(job, e.message ?: e.javaClass.simpleName)
      } finally {
        if (job.cancelled && job.state != "failed") job.state = "cancelled"
        runCatching { job.dir.deleteRecursively() }
      }
    }
    return job
  }

  private fun run(context: Context, job: Job) {
    if (job.cancelled) { job.state = "cancelled"; job.stage = "done"; return }
    if (!ready) return fail(job, failure?.let { "yt-dlp could not be set up: $it" } ?: "yt-dlp is still unpacking itself. Try again in a moment.")
    job.state = "running"
    job.stage = "fetching"
    val r = YoutubeDLRequest(job.url)
    r.addOption("--ignore-config")
    r.addOption("--no-colors")
    r.addOption("--newline")
    r.addOption("--no-mtime")
    r.addOption("--no-cache-dir")
    r.addOption("--no-playlist")
    r.addOption("--paths", job.dir.absolutePath)
    r.addOption("--output", "%(title).180B.%(ext)s")
    r.addOption("--extract-audio")
    r.addOption("--embed-metadata")
    if (job.format != "original") r.addOption("--audio-format", job.format)
    val resp = YoutubeDL.getInstance().execute(r, job.id) { progress, _, line ->
      if (progress >= 0f) job.percent = progress.toDouble().coerceIn(0.0, 100.0)
      val t = line.trim()
      if (t.isNotEmpty()) {
        job.message = t.take(300)
        if (t.startsWith("[ExtractAudio]") || t.startsWith("[Merger]") || t.startsWith("[Metadata]")) job.stage = "converting"
      }
    }
    if (job.cancelled) return
    if (resp.exitCode != 0) return fail(job, lastLine(resp.err) ?: "yt-dlp exited with code ${resp.exitCode}.")
    job.stage = "finalizing"
    val found = job.dir.walkTopDown().maxDepth(4).filter { it.isFile && it.extension.lowercase() in audioExtensions }.sortedBy { it.name }.toList()
    if (found.isEmpty()) return fail(job, "yt-dlp finished without producing an audio file.")
    for (f in found) {
      val (name, uri, where) = saveToMusic(context, f)
      job.files.add(Triple(name, f.length(), uri))
      job.savedTo = where
    }
    if (found.size == 1) job.files.firstOrNull()?.third?.let { librarySet(context, job.url, it) }
    job.state = "done"
    job.stage = "done"
    job.percent = 100.0
  }

  /** Copies into Music/Airwave Discovery. Android 10+ uses MediaStore (no permission needed); older versions use the app's own Music folder. */
  private fun saveToMusic(context: Context, f: File): Triple<String, Uri?, String> {
    val name = safeName(f.name)
    val type = mime[f.extension.lowercase()] ?: "application/octet-stream"
    if (Build.VERSION.SDK_INT >= 29) {
      val values = ContentValues().apply {
        put(MediaStore.Audio.Media.DISPLAY_NAME, name)
        put(MediaStore.Audio.Media.MIME_TYPE, type)
        put(MediaStore.Audio.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MUSIC}/Airwave Discovery")
        put(MediaStore.Audio.Media.IS_PENDING, 1)
      }
      val resolver = context.contentResolver
      val uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values) ?: throw java.io.IOException("Could not create a file in the Music folder.")
      resolver.openOutputStream(uri)!!.use { out -> f.inputStream().use { it.copyTo(out) } }
      resolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null)
      return Triple(name, uri, "Music/Airwave Discovery")
    }
    val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "Airwave Discovery").also { it.mkdirs() }
    val dest = File(dir, name)
    f.copyTo(dest, overwrite = false)
    return Triple(name, Uri.fromFile(dest), dir.absolutePath)
  }

  private fun cancel(id: String): Boolean {
    val j = jobs[id] ?: return false
    if (j.state == "queued" || j.state == "running") {
      j.cancelled = true
      runCatching { YoutubeDL.getInstance().destroyProcessById(id) }
      if (j.state == "queued") { j.state = "cancelled"; j.stage = "done" }
    }
    return true
  }

  private fun reveal(context: Context, id: String): Boolean {
    val uri = jobs[id]?.files?.firstOrNull()?.third ?: return false
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "audio/*").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return runCatching { context.startActivity(intent) }.isSuccess
  }

  private fun fail(job: Job, reason: String) {
    job.state = "failed"
    job.stage = "done"
    job.error = reason.take(600)
  }

  private fun view(j: Job): JSONObject {
    val files = JSONArray()
    j.files.forEach { (n, b, _) -> files.put(JSONObject().put("name", n).put("bytes", b)) }
    return JSONObject().put("id", j.id).put("url", j.url).put("tool", "yt-dlp").put("format", j.format).put("label", j.label)
      .put("state", j.state).put("stage", j.stage).put("percent", j.percent ?: JSONObject.NULL).put("message", j.message ?: JSONObject.NULL)
      .put("error", j.error ?: JSONObject.NULL).put("files", files).put("saved_to", j.savedTo ?: JSONObject.NULL)
  }

  fun safeName(name: String): String {
    val cleaned = name.replace(Regex("[\\u0000-\\u001f<>:\"/\\\\|?*]"), "_").trim().trim('.')
    return if (cleaned.isEmpty()) "song" else cleaned.take(160)
  }

  /** yt-dlp's last ERROR line; warnings (an old version, skipped formats) are not the reason it failed. */
  private fun lastLine(stderr: String): String? {
    val at = stderr.lastIndexOf("ERROR:")
    if (at < 0) return stderr.split("\n").map { it.trim() }.lastOrNull { it.isNotEmpty() && !it.startsWith("WARNING:", ignoreCase = true) }?.take(600)
    return stderr.substring(at + 6).trim().lineSequence().first().trim().take(600)
  }
}
