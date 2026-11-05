#!/usr/bin/env python3
"""DL-GRADIENT-001: decide pass/fail from the RENDERED meter pixels, not from the stylesheet.

Reads the crops written by scripts/check-download-gradient.mjs and asserts, on real colour
channels, that the filled part of the meter starts blue and ends green with a monotone handover
in between, and that the empty part is untinted track.

Usage: python scripts/analyse-download-gradient.py <dir-with-report.json>
Exit 0 = pass. Any failure prints the measured numbers and exits 1.
"""
import json
import sys
from pathlib import Path

from PIL import Image


def meter_crop(sample) -> Image.Image:
    """Crop the meter out of a full-viewport frame using its viewport rect * devicePixelRatio.

    The frame may be captured at a different scale than devicePixelRatio reports (Electron and the
    Android WebView disagree), so derive the real scale from the image width vs innerWidth.
    """
    img = Image.open(sample['file']).convert('RGB')
    scale = img.width / sample['innerWidth']
    left = round(sample['left'] * scale)
    top = round(sample['top'] * scale)
    right = round((sample['left'] + sample['width']) * scale)
    bottom = round((sample['top'] + sample['height']) * scale)
    crop = img.crop((left, top, right, bottom))
    # 4x so a 10px-tall meter has enough rows to average away the rounded border.
    crop = crop.resize((crop.width * 4, crop.height * 4), Image.NEAREST)
    crop.save(str(Path(sample['file']).with_name(f"meter-{sample['pct']}.png")))
    return crop


def column_rgb(img, x):
    """Mean colour of one pixel column, ignoring the rounded border rows."""
    h = img.height
    rows = range(max(1, h // 3), max(2, h - h // 3))
    px = [img.getpixel((x, y))[:3] for y in rows]
    n = len(px)
    return tuple(sum(c[i] for c in px) / n for i in range(3))


def check(d: Path) -> list[str]:
    report = json.loads((d / 'report.json').read_text())
    problems = []
    crops = {}
    for s in report['samples']:
        img = crops[s['pct']] = meter_crop(s)
        w, pct = img.width, s['pct']
        edge = max(2, w // 50)
        fill_end = int(w * pct / 100)
        start = column_rgb(img, edge)
        label = f"{pct}%"
        # Every fill level starts blue, because the gradient starts at the left end of the track.
        if not (start[2] > start[0] + 25 and start[2] > start[1] + 10):
            problems.append(f"{label}: left edge is not blue, measured RGB {tuple(round(c) for c in start)}")
        s['measured'] = {'left': [round(c) for c in start]}
        if pct == 100:
            # Only a full bar shows the green end: the gradient spans the TRACK, not the fill.
            end = column_rgb(img, w - edge - 1)
            s['measured']['right'] = [round(c) for c in end]
            if not (end[1] > end[0] + 25 and end[1] > end[2] + 15):
                problems.append(f"{label}: right end is not green, measured RGB {tuple(round(c) for c in end)}")
            step = max(1, (w - 2 * edge) // 12)
            cols = [column_rgb(img, x) for x in range(edge, w - edge, step)]
            if cols[-1][1] - cols[0][1] < 20:
                problems.append(f"{label}: green does not rise across the bar ({round(cols[0][1])} -> {round(cols[-1][1])})")
            if cols[0][2] - cols[-1][2] < 20:
                problems.append(f"{label}: blue does not fall across the bar ({round(cols[0][2])} -> {round(cols[-1][2])})")
            s['measured']['sweep'] = [[round(c) for c in cols[0]], [round(c) for c in cols[-1]]]
        else:
            empty = column_rgb(img, min(w - 1, fill_end + edge + 1))
            s['measured']['empty_track'] = [round(c) for c in empty]
            if max(empty) - min(empty) > 18:
                problems.append(f"{label}: unfilled track is tinted, measured RGB {tuple(round(c) for c in empty)}")

    # The decisive check: the gradient must be painted across the whole track, not squeezed into
    # the fill. Sample the same x at different fill levels — a fill-scaled gradient would have a
    # different colour there, so 10% ready and 100% ready would both end green and the colour
    # would carry no information about how much of the list is actually on the device.
    report['scale_invariance'] = []
    for a_pct, b_pct in [(25, 100), (60, 100)]:
        if a_pct not in crops or b_pct not in crops:
            continue
        a, b = crops[a_pct], crops[b_pct]
        x = int(min(a.width, b.width) * (a_pct / 100) * 0.6)
        ca, cb = column_rgb(a, x), column_rgb(b, x)
        drift = max(abs(ca[i] - cb[i]) for i in range(3))
        report['scale_invariance'].append({'compared': f'{a_pct}% vs {b_pct}%', 'at_x': x,
                                           f'rgb_{a_pct}': [round(c) for c in ca],
                                           f'rgb_{b_pct}': [round(c) for c in cb],
                                           'max_channel_drift': round(drift)})
        if drift > 24:
            problems.append(
                f"gradient is scaled to the fill, not the track: at x={x} the colour moved by "
                f"{round(drift)} between {a_pct}% and {b_pct}% ready")
    (d / 'measured.json').write_text(json.dumps(report, indent=2))
    return problems


if __name__ == '__main__':
    target = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    issues = check(target)
    if issues:
        print('FAIL')
        for i in issues:
            print(' -', i)
        sys.exit(1)
    print('PASS: rendered meter runs blue -> green across the full track')
    print((target / 'measured.json').read_text())
