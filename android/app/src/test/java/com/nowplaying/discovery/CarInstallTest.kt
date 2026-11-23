package com.nowplaying.discovery

import com.nowplaying.discovery.CarInstall.Verdict
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** CAR-KEEP-001: who installed jPlay, as Android Auto reads it (inferred from Android Auto 17.9). */
class CarInstallTest {
  private val play = "com.android.vending"
  private val googleInstaller = "com.google.android.packageinstaller"

  @Test fun googlePlayStartingTheInstallIsAPlayInstall() {
    assertEquals(Verdict.PLAY, CarInstall.verdict(play, play))
  }

  @Test fun googlesInstallerWorkingForGooglePlayIsAPlayInstall() {
    assertEquals(Verdict.PLAY, CarInstall.verdict(play, googleInstaller))
  }

  @Test fun adbNamingGooglePlayIsPlayInNameOnly() {
    assertEquals(Verdict.PLAY_NAME_ONLY, CarInstall.verdict(play, "com.android.shell"))
  }

  @Test fun googlePlayNamedWithNoKnownStarterIsPlayInNameOnly() {
    // Below Android 11 the phone does not say who started the install.
    assertEquals(Verdict.PLAY_NAME_ONLY, CarInstall.verdict(play, null))
  }

  @Test fun aPlainPackageInstallerInstallIsSideloaded() {
    assertEquals(Verdict.SIDELOADED, CarInstall.verdict(googleInstaller, googleInstaller))
    assertEquals(Verdict.SIDELOADED, CarInstall.verdict("com.android.packageinstaller", "com.android.packageinstaller"))
  }

  @Test fun anInstallWithNoRecordedSourceIsSideloaded() {
    assertEquals(Verdict.SIDELOADED, CarInstall.verdict(null, null))
    assertEquals(Verdict.SIDELOADED, CarInstall.verdict(null, "com.android.shell"))
  }

  @Test fun theCardGetsEveryFieldAndAbsentNamesAreNull() {
    val o = JSONObject(CarInstall.describe(play, "com.android.shell", null, true, "17.9.664044-release", 34).toString())
    assertEquals("PLAY_NAME_ONLY", o.getString("verdict"))
    assertEquals(play, o.getString("installer"))
    assertEquals("com.android.shell", o.getString("initiating"))
    assertTrue(o.has("originating") && o.isNull("originating"))
    assertTrue(o.getJSONObject("androidAuto").getBoolean("installed"))
    assertEquals("17.9.664044-release", o.getJSONObject("androidAuto").getString("version"))
    assertEquals(34, o.getInt("sdk"))
  }

  @Test fun aMissingAndroidAutoHasNoVersion() {
    val o = JSONObject(CarInstall.describe(null, null, null, false, "ignored", 29).toString())
    assertEquals("SIDELOADED", o.getString("verdict"))
    assertTrue(o.isNull("installer") && o.isNull("initiating"))
    assertFalse(o.getJSONObject("androidAuto").getBoolean("installed"))
    assertTrue(o.getJSONObject("androidAuto").isNull("version"))
  }
}
