package com.nowplaying.discovery

import android.speech.SpeechRecognizer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** CAR-QUICK-SEARCH-001: what a recognizer error tells the driver. */
class CarVoiceTest {
  @Test fun silenceAndNoMatchAreNothingHeard() {
    assertTrue(CarVoice.outcomeOf(SpeechRecognizer.ERROR_NO_MATCH) is CarVoice.Outcome.NothingHeard)
    assertTrue(CarVoice.outcomeOf(SpeechRecognizer.ERROR_SPEECH_TIMEOUT) is CarVoice.Outcome.NothingHeard)
  }
  @Test fun permissionAndNetworkSayWhatIsWrong() {
    assertTrue(CarVoice.outcomeOf(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) is CarVoice.Outcome.NoPermission)
    assertEquals("No connection for voice search", (CarVoice.outcomeOf(SpeechRecognizer.ERROR_NETWORK) as CarVoice.Outcome.Failed).why)
    assertEquals("Voice search stopped (code 99)", (CarVoice.outcomeOf(99) as CarVoice.Outcome.Failed).why)
  }
}
