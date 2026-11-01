/*
 * Airwave Discovery for Android — a separate build from ../../android (the player).
 * It has no library dependencies: a WebView shell that opens the demo server.
 */
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "airwave-discovery-android"
include(":app")
