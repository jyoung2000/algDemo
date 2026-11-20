package com.nowplaying.discovery

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.zip.GZIPOutputStream

/**
 * ALLOWANCE-ARCH-001 (owner, 2026-11-20): "the allowance shouldn't apply on wifi". The page is charged what the
 * network carried, not the unpacked answer (a YouTube Music songs search is 683,896 bytes unpacked and 39,350 on
 * the wire), and every answer says whether the connection is metered.
 */
class NativeHttpTest {
  private fun gzip(b: ByteArray): ByteArray = ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(b) } }.toByteArray()

  @After fun reset() { NativeHttp.metered = null }

  @Test fun aGzipAnswerIsUnpackedAndCountedAsWhatTheNetworkCarried() {
    val plain = ("{\"title\":\"Song\",\"artist\":\"Someone\"},".repeat(500)).toByteArray()
    val packed = gzip(plain)
    val (body, wire) = NativeHttp.readBody(ByteArrayInputStream(packed), "gzip", 8_000_000)
    assertArrayEquals(plain, body)
    assertEquals(packed.size, wire)
    assertTrue(wire < plain.size / 5)
  }

  @Test fun anUnpackedAnswerCountsItsOwnSize() {
    val (body, wire) = NativeHttp.readBody(ByteArrayInputStream("hello".toByteArray()), null, 8_000_000)
    assertEquals("hello", String(body))
    assertEquals(5, wire)
  }

  @Test fun theSizeLimitBoundsTheUnpackedAnswer() {
    val packed = gzip(ByteArray(200_000) { 97 })
    try {
      NativeHttp.readBody(ByteArrayInputStream(packed), "gzip", 50_000)
      fail("an answer over the limit must be refused")
    } catch (e: IOException) {
      assertTrue(e.message!!.contains("response larger than 50000 bytes"))
    }
  }

  @Test fun anEmptyAnswerMarkedGzipIsEmptyNotAnError() {
    val (body, wire) = NativeHttp.readBody(ByteArrayInputStream(ByteArray(0)), "gzip", 8_000_000)
    assertEquals(0, body.size)
    assertEquals(0, wire)
  }

  @Test fun asksForGzipUnlessThePageChoseAnEncoding() {
    assertEquals("gzip", NativeHttp.outgoingHeaders(JSONObject("{\"user-agent\":\"x\"}"))["Accept-Encoding"])
    val chosen = NativeHttp.outgoingHeaders(JSONObject("{\"accept-encoding\":\"identity\"}"))
    assertEquals("identity", chosen["accept-encoding"])
    assertFalse(chosen.containsKey("Accept-Encoding"))
    assertEquals("gzip", NativeHttp.outgoingHeaders(null)["Accept-Encoding"])
  }

  @Test fun theUnpackedAnswerDropsTheHeadersThatDescribedThePackedOne() {
    val all = mapOf<String?, List<String>>(null to listOf("HTTP/1.1 200 OK"), "Content-Encoding" to listOf("gzip"), "Content-Length" to listOf("123"), "Content-Type" to listOf("application/json"), "Location" to listOf("a", "b"))
    val packed = NativeHttp.pageHeaders(all, packed = true)
    assertFalse(packed.has("content-encoding"))
    assertFalse(packed.has("content-length"))
    assertEquals("application/json", packed.getString("content-type"))
    assertEquals("b", packed.getString("location"))
    assertEquals("123", NativeHttp.pageHeaders(all, packed = false).getString("content-length"))
  }

  @Test fun theNetworkQuestionIsAnsweredWithoutUsingTheNetwork() {
    NativeHttp.metered = { true }
    val mobile = NativeHttp.perform("{\"probe\":\"network\"}")
    assertEquals(204, mobile.getInt("status"))
    assertTrue(mobile.getBoolean("metered"))
    assertFalse(mobile.has("error"))
    NativeHttp.metered = { false }
    assertFalse(NativeHttp.perform("{\"probe\":\"network\"}").getBoolean("metered"))
  }

  @Test fun whenThePhoneCannotTellItSaysNothingAboutTheNetwork() {
    NativeHttp.metered = { null }
    assertFalse(NativeHttp.perform("{\"probe\":\"network\"}").has("metered"))
    NativeHttp.metered = null
    assertFalse(NativeHttp.perform("{\"probe\":\"network\"}").has("metered"))
  }

  @Test fun hostsOffTheListAreStillRefused() {
    assertTrue(NativeHttp.perform("{\"url\":\"https://example.com/\"}").getString("error").contains("host not allowed"))
  }
}
