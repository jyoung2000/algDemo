package androidx.media3.session

/**
 * CAR-STAR-PICKER-001: a short message Android Auto shows over the player (its toast), kept on the
 * session until [clear].
 *
 * `MediaSession.sendError` reaches Android Auto as two platform playback states pushed back to back
 * (with the message, then without it). The platform session hands controllers whatever state is
 * current when its dispatch runs, so the first state is often never seen: on an emulator one star in
 * three lost its message. Media3's own library-error path keeps the message in every state until it
 * is cleared, so this uses that path. It lives in this package because those calls are internal to
 * Media3 (pinned at 1.9.3 in app/build.gradle.kts); call on the session's application thread.
 */
object CarMessage {
  fun show(session: MediaSession, message: String) {
    val stub = session.impl.mediaSessionLegacyStub
    stub.clearLegacyErrorStatus()
    stub.setLegacyError(LibraryResult.ofError<Any>(SessionError(SessionError.ERROR_UNKNOWN, message)), false)
  }

  fun clear(session: MediaSession) {
    session.impl.mediaSessionLegacyStub.clearLegacyErrorStatus()
  }
}
