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
  }
  from(layout.projectDirectory.dir("../../docs")) {
    into("web/licenses")
    include("LICENSES.md")
  }
  into(stagedAssets)
  doFirst {
    check(webDist.file("index.html").asFile.exists()) { "Build the web app first: pnpm --dir discovery-demo/web build" }
    check(modelDir.file("model_epoch_36.onnx.data").asFile.exists()) { "The audio model is missing from discovery-demo/.data/models" }
  }
}

android {
  namespace = "com.nowplaying.discovery"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.nowplaying.discovery"
    minSdk = 26
    targetSdk = 35
    versionCode = 3
    versionName = "0.3.0"
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

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions { jvmTarget = "17" }

  lint { abortOnError = false }
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(syncWebAssets) }
tasks.matching { it.name.contains("lintVitalAnalyze") || it.name.contains("generate") && it.name.endsWith("LintVitalReportModel") }.configureEach { dependsOn(syncWebAssets) }

dependencies {
  // yt-dlp, a Python runtime and ffmpeg, unpacked from the APK on first run (see Downloads.kt).
  implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
  implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
  // The library asks for older androidx; pin the versions the rest of the Airwave apps build with.
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
}
