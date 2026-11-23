package com.nowplaying.discovery

import org.json.JSONObject

/**
 * CAR-KEEP-001 (owner: "when I turn off and on my car the app disappears"): who installed jPlay, as
 * Android Auto reads it. The rule is INFERRED from a public decompile of Android Auto 17.9's app
 * validator, not measured on the owner's phone: Android Auto treats an app as a Google Play install
 * when the package that STARTED the install is Google Play, or when Google's package installer
 * started it for Google Play. `adb install -i com.android.vending` only sets the installer NAME; the
 * initiating package stays com.android.shell, so that install is not a Play install to Android Auto.
 *
 * Pure: no Android types, so the decision is unit-tested on the JVM (CarInstallTest).
 */
object CarInstall {
  const val PLAY_STORE = "com.android.vending"
  const val GOOGLE_INSTALLER = "com.google.android.packageinstaller"
  const val ANDROID_AUTO = "com.google.android.projection.gearhead"
  /** Android Auto's own settings screen (resolved on Android Auto 17.9: DefaultSettingsActivity). */
  const val ANDROID_AUTO_SETTINGS = "com.google.android.projection.gearhead.SETTINGS"

  enum class Verdict {
    /** Google Play really installed it. */
    PLAY,
    /** The installer name says Google Play, but something else started the install. */
    PLAY_NAME_ONLY,
    /** Anything else, including an install with no recorded source. */
    SIDELOADED,
  }

  fun verdict(installer: String?, initiating: String?): Verdict = when {
    initiating == PLAY_STORE -> Verdict.PLAY
    initiating == GOOGLE_INSTALLER && installer == PLAY_STORE -> Verdict.PLAY
    installer == PLAY_STORE -> Verdict.PLAY_NAME_ONLY
    else -> Verdict.SIDELOADED
  }

  /** What the Settings card reads (web/src/engine/car-install.ts). Absent names are JSON null. */
  fun describe(
    installer: String?,
    initiating: String?,
    originating: String?,
    androidAutoInstalled: Boolean,
    androidAutoVersion: String?,
    sdk: Int,
  ): JSONObject = JSONObject()
    .put("verdict", verdict(installer, initiating).name)
    .put("installer", installer ?: JSONObject.NULL)
    .put("initiating", initiating ?: JSONObject.NULL)
    .put("originating", originating ?: JSONObject.NULL)
    .put(
      "androidAuto",
      JSONObject()
        .put("installed", androidAutoInstalled)
        .put("version", (if (androidAutoInstalled) androidAutoVersion else null) ?: JSONObject.NULL),
    )
    .put("sdk", sdk)
}
