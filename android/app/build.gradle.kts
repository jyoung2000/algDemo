import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

// The web app, its engine and the audio model are copied into the APK's assets by `syncWebAssets`.
val webDist = layout.projectDirectory.dir("../../web/dist")
val modelDir = layout.projectDirectory.dir("../../.data/models")
val stagedAssets = layout.buildDirectory.dir("generated/webAssets")

val syncWebAssets by tasks.registering(Sync::class) {
  from(webDist) { into("web") }
  from(modelDir) {
    into("web/models")
    include("model_epoch_36.onnx", "model_epoch_36.onnx.data")
    // VOICE-SEARCH-001: speech to text for the search bar's mic (Whisper tiny.en, Apache-2.0).
    include("whisper-tiny.en/encoder_model_quantized.onnx", "whisper-tiny.en/decoder_model_quantized.onnx", "whisper-tiny.en/vocab.json", "whisper-tiny.en/generation_config.json")
  }
  from(layout.projectDirectory.dir("../../docs")) {
    into("web/licenses")
    include("LICENSES.md")
  }
  into(stagedAssets)
  doFirst {
    check(webDist.file("index.html").asFile.exists()) { "Build the web app first: pnpm --dir discovery-demo/web build" }
    check(modelDir.file("model_epoch_36.onnx.data").asFile.exists()) { "The audio model is missing from discovery-demo/.data/models" }
    check(modelDir.file("whisper-tiny.en/decoder_model_quantized.onnx").asFile.exists()) { "The speech model is missing from discovery-demo/.data/models/whisper-tiny.en (see docs/LICENSES.md)" }
  }
}

// Release signing reads a keystore.properties file kept OUTSIDE the repo: AIRWAVE_SIGNING_DIR, or ~/airwave-signing.
// It holds storeFile, storePassword, keyAlias and keyPassword. Without it the release build is left unsigned.
val signingProps = Properties().apply {
  val dir = System.getenv("AIRWAVE_SIGNING_DIR") ?: "${System.getProperty("user.home")}/airwave-signing"
  val f = File(dir, "keystore.properties")
  if (f.isFile) f.inputStream().use { load(it) }
}

android {
  namespace = "com.nowplaying.discovery"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.nowplaying.discovery"
    minSdk = 26
    targetSdk = 35
    versionCode = 53
    versionName = "0.18.10"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    // The embedded Python, yt-dlp and ffmpeg ship per CPU. Phones are arm64; the emulator is x86_64.
    ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
  }

  buildFeatures { buildConfig = true }

  // youtubedl-android unpacks its Python runtime out of the APK at first run, which only works if the
  // libraries are stored rather than deflated and extracted to disk.
  packaging { jniLibs { useLegacyPackaging = true } }

  sourceSets.getByName("main").assets.srcDir(stagedAssets)

  // The model and wasm are already compact; compressing them only slows start-up.
  androidResources { noCompress += listOf("onnx", "data", "wasm") }

  signingConfigs {
    if (signingProps.getProperty("storeFile") != null) {
      create("release") {
        storeFile = file(signingProps.getProperty("storeFile"))
        storePassword = signingProps.getProperty("storePassword")
        keyAlias = signingProps.getProperty("keyAlias")
        keyPassword = signingProps.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfigs.findByName("release")?.let { signingConfig = it }
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions { jvmTarget = "17" }

  lint { abortOnError = false }
}

// Lint and its model-writer tasks read the merged assets, so every one of them has to wait for the
// sync that produces them — otherwise Gradle fails the build for an undeclared dependency (seen on
// `lintRelease`, which uses a different task name from the vital-lint path).
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(syncWebAssets) }
tasks.matching { it.name.contains("Lint") || it.name.contains("lint") }.configureEach { dependsOn(syncWebAssets) }

dependencies {
  // yt-dlp, a Python runtime and ffmpeg, unpacked from the APK on first run (see Downloads.kt).
  implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
  implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
  // The library asks for older androidx; pin the versions the rest of the Airwave apps build with.
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  // Media3 session and ExoPlayer native playback. NativePlayback is the first verified local-file
  // slice; the service still uses the old WebPlayer proxy until the controller/UI migration is done.
  // Never advertise a native playback path as complete before DSP and background parity tests pass.
  implementation("androidx.media3:media3-session:1.9.3")
  implementation("androidx.media3:media3-common:1.9.3")
  implementation("androidx.media3:media3-exoplayer:1.9.3")
  testImplementation("junit:junit:4.13.2")
  // android.jar's org.json is a stub on the JVM; the engine's JSON (EqJsonTest) needs the real one.
  testImplementation("org.json:json:20240303")
  // Instrumented browse-tree test (Android Auto): connects a real MediaBrowser to PlaybackService.
  androidTestImplementation("androidx.test.ext:junit:1.1.5")
  androidTestImplementation("androidx.test:runner:1.5.2")
  androidTestImplementation("androidx.test:core-ktx:1.5.0")
}
