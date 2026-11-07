from airwave_discovery.identity import match_recordings, parse_title, recording_key, split_artists


def t(title, artists, duration=None, isrc=None, version=""):
    return {"title": title, "artists": artists, "duration": duration, "isrc": isrc, "version": version}


def test_versions_stay_distinct():
    base = recording_key("Blinding Lights", ["The Weeknd"])
    for v in ("Blinding Lights (Live)", "Blinding Lights - Acoustic", "Blinding Lights (Remix)", "Blinding Lights (Sped Up)"):
        assert recording_key(v, ["The Weeknd"]) != base, v


def test_editions_and_features_fold_together():
    a = recording_key("Levitating (feat. DaBaby)", ["Dua Lipa"])
    b = recording_key("Levitating", ["Dua Lipa", "DaBaby"])
    assert a == b
    assert parse_title("Levitating (feat. DaBaby)").featured == ("dababy",)


def test_collaborations_split():
    assert split_artists("Kendrick Lamar & SZA") == ["kendrick lamar", "sza"]
    assert split_artists(["Calvin Harris, Dua Lipa"]) == ["calvin harris", "dua lipa"]


def test_match_same_by_isrc():
    assert match_recordings(t("X", ["A"], isrc="USUM71900001"), t("Totally different", ["B"], isrc="usum71900001")).verdict == "same"


def test_shared_isrc_does_not_override_conflicting_duration_or_version():
    # Providers do misfile an ISRC onto a re-release or a live cut; hard contradictions must win.
    studio = t("Song", ["A"], 180, "USUM71900001")
    assert match_recordings(studio, t("Song", ["A"], 300, "USUM71900001")).verdict != "same"
    assert match_recordings(studio, t("Song (Live)", ["A"], 180, "USUM71900001")).verdict == "different"
    assert match_recordings(studio, t("Song", ["A"], 182, "USUM71900001")).verdict == "same"


def test_match_same_title_artist_duration():
    r = match_recordings(t("Weird Fishes/Arpeggi", ["Radiohead"], 318), t("Weird Fishes/Arpeggi", ["Radiohead"], 319))
    assert r.verdict == "same"


def test_duration_gap_is_uncertain_not_merged():
    r = match_recordings(t("Song", ["A"], 200), t("Song", ["A"], 206))
    assert r.verdict == "uncertain"


def test_same_title_different_artist_is_different():
    assert match_recordings(t("Hurt", ["Nine Inch Nails"], 373), t("Hurt", ["Johnny Cash"], 218)).verdict == "different"


def test_cover_and_live_not_merged():
    assert match_recordings(t("Song", ["A"], 200), t("Song (Live)", ["A"], 200)).verdict == "different"
    assert match_recordings(t("Song", ["A"], 200), t("Song (Acoustic Version)", ["A"], 200)).verdict == "different"


def test_no_duration_is_uncertain():
    assert match_recordings(t("Song", ["A"]), t("Song", ["A"])).verdict == "uncertain"
