package com.nowplaying.discovery

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** SERVICE-API-001: one writer on the original database, and UI requests that never hang. */
class ServiceApiTest {
  private val ui = Any()
  private val ui2 = Any()

  @Test fun reservedForTheServiceTheUiIsItsClientAndCannotClaim() {
    val o = EngineOwner(15_000)
    o.reserveForService(0)
    assertEquals("service", o.modeForUi(1))
    assertFalse(o.claimUi(1, ui))
    assertTrue(o.claimService())
    assertEquals("service", o.modeForUi(20_000)) // a claim never lapses
    assertFalse(o.claimUi(20_000, ui))
  }

  @Test fun aServiceThatFailedAfterOpeningNeverLetsTheUiFallBack() {
    val o = EngineOwner(15_000)
    o.reserveForService(0)
    assertTrue(o.claimService())
    o.serviceFailed(opened = true)
    assertTrue(o.serviceFailed)
    assertEquals("service", o.modeForUi(1))
    assertFalse(o.claimUi(1, ui))
    // Its page gone (WebView destroyed), the UI still waits for a new service page, not local.
    o.releaseService()
    assertEquals("service", o.modeForUi(2))
    assertFalse(o.claimUi(2, ui))
  }

  @Test fun aServiceThatFailedBeforeOpeningLetsTheUiGoLocalAndThenRefusesTheService() {
    val o = EngineOwner(15_000)
    o.reserveForService(0)
    assertTrue(o.claimService())
    o.serviceFailed(opened = false)
    assertEquals("local", o.modeForUi(1))
    assertTrue(o.claimUi(1, ui))
    // A restarted service page must not become a second writer: it runs metadata-only.
    assertFalse(o.claimService())
    // Once the UI page is gone the service may claim again.
    assertFalse(o.releaseUi(ui2))
    assertTrue(o.releaseUi(ui))
    assertTrue(o.claimService())
  }

  @Test fun aReservationTheServiceNeverClaimedLapsesToLocal() {
    val o = EngineOwner(15_000)
    o.reserveForService(0)
    assertEquals("service", o.modeForUi(14_999))
    assertEquals("local", o.modeForUi(15_000))
    assertTrue(o.claimUi(15_000, ui))
    assertFalse(o.claimService())
    // A recreated Activity's page takes over the hold; the old page's release no longer frees it.
    assertTrue(o.claimUi(16_000, ui2))
    assertFalse(o.releaseUi(ui))
    assertFalse(o.claimService())
    assertTrue(o.releaseUi(ui2))
  }

  @Test fun aColdServiceWithNoActivityClaimsDirectly() {
    val o = EngineOwner(15_000)
    assertTrue(o.claimService())
    o.reserveForService(10) // the Activity opens later: its page is the service's client
    assertEquals("service", o.modeForUi(100_000))
  }

  private class Harness(val owner: EngineOwner = EngineOwner(15_000)) {
    var now = 0L
    val timers = ArrayList<Pair<Long, () -> Unit>>()
    val toService = ArrayList<String>()
    val replies = ArrayList<Pair<Int, JSONObject>>()
    var serviceUp = true
    val core = ServiceApiCore(owner, { now }, { ms, run -> timers += (now + ms) to run }, waitMs = 20_000).also {
      it.toService = { env -> if (serviceUp) { toService += env; true } else false }
      it.toUi = { id, json -> replies += id to JSONObject(json) }
    }
    fun advance(ms: Long) {
      now += ms
      val due = timers.filter { it.first <= now }
      timers.removeAll(due)
      due.forEach { it.second() }
    }
  }

  @Test fun requestsBeforeTheServiceIsReadyWaitThenAreDeliveredInOrderWithTheirIds() {
    val h = Harness()
    h.owner.reserveForService(0)
    h.core.fromUi(1, """{"method":"GET","path":"/api/a","body":null}""")
    h.core.fromUi(2, """{"method":"POST","path":"/api/b","body":{"x":1}}""")
    assertEquals(0, h.toService.size)
    assertEquals(2, h.core.waitingCount)
    h.owner.claimService()
    h.core.serviceReady()
    assertEquals(listOf("1", "2"), h.toService.map { JSONObject(it).getString("id") })
    assertEquals("/api/b", JSONObject(h.toService[1]).getString("path"))
    h.core.reply("2", """{"status":200,"body":{"ok":true}}""")
    h.core.reply("2", """{"status":200,"body":{"dup":true}}""") // duplicate dropped
    h.core.reply("99", """{"status":200,"body":{}}""") // unknown dropped
    h.core.reply("x", """{"status":200,"body":{}}""")
    assertEquals(listOf(2), h.replies.map { it.first })
    assertTrue(h.replies[0].second.getJSONObject("body").getBoolean("ok"))
    h.advance(30_000) // the delivered requests' wait timers find nothing to fail
    assertEquals(1, h.replies.size)
  }

  @Test fun aServiceThatNeverStartsFailsWaitingRequestsWithARealErrorNotAHang() {
    val h = Harness()
    h.owner.reserveForService(0)
    h.owner.claimService()
    h.core.fromUi(1, """{"method":"GET","path":"/api/a"}""")
    h.advance(19_999)
    assertTrue(h.replies.isEmpty())
    h.advance(1)
    assertEquals(503, h.replies.single().second.getInt("status"))
    assertFalse(h.replies.single().second.optBoolean("local"))
    assertEquals(0, h.core.waitingCount)
  }

  @Test fun aLapsedReservationAnswersLocalSoTheUiMayOpenTheDatabase() {
    val h = Harness()
    h.owner.reserveForService(0)
    h.core.fromUi(1, """{"method":"GET","path":"/api/a"}""")
    h.advance(20_000)
    assertTrue(h.replies.single().second.getBoolean("local"))
    h.core.fromUi(2, """{"method":"GET","path":"/api/a"}""")
    assertTrue(h.replies[1].second.getBoolean("local"))
  }

  @Test fun failureBeforeOpeningAnswersLocalAfterOpeningAnswersError() {
    val before = Harness()
    before.owner.reserveForService(0)
    before.owner.claimService()
    before.core.fromUi(1, """{"method":"GET","path":"/a"}""")
    before.core.serviceFailed(opened = false)
    assertTrue(before.replies.single().second.getBoolean("local"))

    val after = Harness()
    after.owner.reserveForService(0)
    after.owner.claimService()
    after.core.fromUi(1, """{"method":"GET","path":"/a"}""")
    after.core.serviceFailed(opened = true)
    assertFalse(after.replies.single().second.optBoolean("local"))
    after.core.fromUi(2, """{"method":"GET","path":"/a"}""")
    assertEquals(503, after.replies[1].second.getInt("status"))
    assertFalse(after.replies[1].second.optBoolean("local"))
  }

  @Test fun losingTheServiceFailsWhatItWasAnsweringAndANewPageServesTheRest() {
    val h = Harness()
    h.owner.claimService()
    h.core.serviceReady()
    h.core.fromUi(1, """{"method":"GET","path":"/a"}""")
    h.core.serviceLost()
    assertEquals(503, h.replies.single().second.getInt("status"))
    h.core.reply("1", """{"status":200,"body":{}}""") // a late answer from the dead page is dropped
    assertEquals(1, h.replies.size)
    h.core.fromUi(2, """{"method":"GET","path":"/b"}""")
    assertEquals(1, h.core.waitingCount)
    h.core.serviceReady()
    assertEquals("2", JSONObject(h.toService.last()).getString("id"))
  }

  @Test fun undeliverableMalformedOversizeAndOverflowingRequestsAreAnsweredAtOnce() {
    val h = Harness()
    h.owner.claimService()
    h.core.serviceReady()
    h.serviceUp = false
    h.core.fromUi(1, """{"method":"GET","path":"/a"}""")
    assertEquals(503, h.replies.last().second.getInt("status"))
    h.core.fromUi(2, "{nope")
    assertEquals(400, h.replies.last().second.getInt("status"))
    h.core.fromUi(3, "{\"p\":\"" + "x".repeat(ServiceApiCore.MAX_REQUEST_CHARS) + "\"}")
    assertEquals(413, h.replies.last().second.getInt("status"))
    h.core.serviceLost()
    repeat(ServiceApiCore.MAX_WAITING) { h.core.fromUi(100 + it, """{"method":"GET","path":"/a"}""") }
    val before = h.replies.size
    h.core.fromUi(999, """{"method":"GET","path":"/a"}""")
    assertEquals(before + 1, h.replies.size)
    assertEquals(999, h.replies.last().first)
    assertEquals(503, h.replies.last().second.getInt("status"))
  }

  @Test fun anOversizeReplyBecomesAnErrorAndTheUiGoingAwayForgetsEverything() {
    val h = Harness()
    h.owner.claimService()
    h.core.serviceReady()
    h.core.fromUi(1, """{"method":"GET","path":"/a"}""")
    h.core.reply("1", "x".repeat(ServiceApiCore.MAX_REPLY_CHARS + 1))
    assertEquals(500, h.replies.single().second.getInt("status"))
    h.core.fromUi(2, """{"method":"GET","path":"/a"}""")
    h.core.uiGone()
    h.core.reply("2", """{"status":200,"body":{}}""")
    assertEquals(1, h.replies.size)
    assertEquals(0, h.core.inFlightCount)
  }
}
