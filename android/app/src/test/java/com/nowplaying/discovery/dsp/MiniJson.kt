package com.nowplaying.discovery.dsp

/**
 * A minimal JSON reader for the parity manifest (Android JVM unit tests stub `org.json`).
 * Objects become `Map<String, Any?>` (insertion order), arrays `List<Any?>`, numbers `Double`.
 */
internal class MiniJson private constructor(private val s: String) {
  private var i = 0

  companion object {
    fun parse(text: String): Any? {
      val p = MiniJson(text)
      val v = p.value()
      p.ws()
      require(p.i == p.s.length) { "trailing data at ${p.i}" }
      return v
    }
  }

  private fun ws() {
    while (i < s.length && s[i].isWhitespace()) i++
  }

  private fun value(): Any? {
    ws()
    require(i < s.length) { "unexpected end" }
    return when (val c = s[i]) {
      '{' -> obj()
      '[' -> arr()
      '"' -> str()
      't' -> lit("true", true)
      'f' -> lit("false", false)
      'n' -> lit("null", null)
      else -> if (c == '-' || c.isDigit()) num() else error("unexpected '$c' at $i")
    }
  }

  private fun lit(word: String, v: Any?): Any? {
    require(s.startsWith(word, i)) { "bad literal at $i" }
    i += word.length
    return v
  }

  private fun obj(): Map<String, Any?> {
    val m = LinkedHashMap<String, Any?>()
    i++
    ws()
    if (s[i] == '}') { i++; return m }
    while (true) {
      ws()
      val k = str()
      ws()
      require(s[i] == ':') { "expected ':' at $i" }
      i++
      m[k] = value()
      ws()
      when (s[i]) {
        ',' -> i++
        '}' -> { i++; return m }
        else -> error("expected ',' or '}' at $i")
      }
    }
  }

  private fun arr(): List<Any?> {
    val l = ArrayList<Any?>()
    i++
    ws()
    if (s[i] == ']') { i++; return l }
    while (true) {
      l.add(value())
      ws()
      when (s[i]) {
        ',' -> i++
        ']' -> { i++; return l }
        else -> error("expected ',' or ']' at $i")
      }
    }
  }

  private fun str(): String {
    require(s[i] == '"') { "expected string at $i" }
    i++
    val b = StringBuilder()
    while (true) {
      val c = s[i++]
      when (c) {
        '"' -> return b.toString()
        '\\' -> {
          when (val e = s[i++]) {
            'n' -> b.append('\n')
            't' -> b.append('\t')
            'r' -> b.append('\r')
            'b' -> b.append('\b')
            'f' -> b.append('\u000c')
            'u' -> { b.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
            else -> b.append(e)
          }
        }
        else -> b.append(c)
      }
    }
  }

  private fun num(): Double {
    val start = i
    while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
    return s.substring(start, i).toDouble()
  }
}
