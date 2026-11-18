package com.nowplaying.discovery

import java.text.Normalizer
import java.util.Locale

/** Same station call-sign/frequency rules as web engine/radio.ts; never synthesize a dial mapping. */
internal object RadioNames {
  data class Parts(val call: String?, val frequency: String?)
  private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFKD).replace(Regex("""\p{M}"""), "").uppercase(Locale.ROOT)
  private fun calls(name: String) = Regex("""(?:^|[^A-Z])([WK][A-Z]{2,3})(?=$|[^A-Z])""").findAll(fold(name)).map { it.groupValues[1] }.toList()
  fun numbers(name: String): List<String> {
    val clean = fold(name).replace(Regex("""\b(?:MP3|AAC\d*|HD\d+)\b"""), " ")
      .replace(Regex("""\b\d+\s*(?:KBPS|KBIT(?:/S)?|KB/S)\b"""), " ")
    return Regex("""\d+(?:[.,]\d+)?""").findAll(clean).map { it.value.replace(',', '.') }.distinct().toList()
  }
  fun parts(query: String): Parts? {
    val compact = fold(query.trim()).replace(Regex("""(?:\s+|-)(?:FM|AM)$"""), "").replace(Regex("""[\s-]+"""), "")
    Regex("""^([WK][A-Z]{2,3})(\d+(?:[.,]\d*)?)?$""").matchEntire(compact)?.let {
      return Parts(it.groupValues[1], it.groupValues[2].replace(',', '.').ifBlank { null })
    }
    Regex("""^(\d+(?:[.,]\d*)?)([WK][A-Z]{2,3})$""").matchEntire(compact)?.let { return Parts(it.groupValues[2], it.groupValues[1].replace(',', '.')) }
    if (compact.matches(Regex("""\d{1,4}(?:[.,]\d*)?"""))) return Parts(null, compact.replace(',', '.'))
    return null
  }
  fun source(query: String): String { val p = parts(query); return p?.call ?: p?.frequency?.substringBefore('.') ?: query.trim() }
  fun matchesQuery(name: String, query: String): Boolean {
    if (query.isBlank()) return true
    val p = parts(query) ?: return fold(name).contains(fold(query.trim()))
    return (p.call == null || p.call in calls(name)) && (p.frequency == null || numbers(name).any { it.startsWith(p.frequency) })
  }
  fun initial(name: String): String {
    calls(name).firstOrNull()?.let { return it.take(1) }
    val brand = fold(name.trimStart()).replace(Regex("""^[^\p{L}]+"""), "").replace(Regex("""^(?:FM|AM|HD)\b[\s:-]*"""), "")
    return brand.take(1).takeIf { it.matches(Regex("[A-Z]")) } ?: "#"
  }
  fun matchesInitial(name: String, initial: String): Boolean = initial.isBlank() ||
    if (initial.matches(Regex("[0-9]"))) numbers(name).any { it.startsWith(initial) } else RadioNames.initial(name) == initial
}
