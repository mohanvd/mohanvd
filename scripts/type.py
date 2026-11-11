#!/usr/bin/env python3
"""Sets the README's name and section labels in the site's own type.

GitHub renders a README in its own fonts and colours, and nothing in Markdown
can change that. So the few pieces of display type, the name and the section
labels, are traced here into SVG outlines from the same font files
mohanadtarek.com serves, at the size, weight, tracking and optical size its
type scale gives them, and filled with its `fg` and `muted` tokens. Everything
that is read rather than looked at stays real text.

Nothing about the design is written down in this file. Sizes and colours are
read out of the site's src/design/tokens.ts, so the README follows the site
when a token changes: run this again and commit what it draws.

Run by hand, not on a schedule:

    python scripts/type.py [path to a mohanadtarek.com checkout]

It also writes type/atlas.json for scripts/window.mjs, which redraws a picture
every hour and has to set type that changes: the glyph outlines, advances and
kerning of the three styles it uses, with the palette and the measure.

The path defaults to a checkout sitting beside this one. Needs fontTools,
brotli (the fonts are woff2) and uharfbuzz (kerning, and the variable axes).
"""

import json
import re
import sys
from io import BytesIO
from math import ceil
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SITE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "mohanadtarek.com"
DESIGN = SITE / "src" / "design"
OUT = ROOT / "type"

# What gets set, and as what. `step` is a step of the site's type scale, `color`
# a name from its palette, and the pairings are the homepage's own: the name is
# its <h1> (text-h1 font-semibold), a label is one of its section headings
# (font-mono text-label font-semibold uppercase text-muted).
SERIF = "newsreader-latin-var.woff2"
MONO = "jetbrains-mono-latin-var.woff2"
NAME = dict(font=SERIF, step="h1", weight=600, color="fg", upper=False)
LABEL = dict(font=MONO, step="label", weight=600, color="muted", upper=True)

PIECES = {
    "name": ("Mohanad Tarek", NAME),
    "label-elsewhere": ("Elsewhere", LABEL),
}

# The styles the window sets its changing text in: a sentence as the site sets
# a lead paragraph, and its figures and labels as the site sets metadata and
# section labels. window.mjs has no dependencies and cannot shape text, so it
# is handed every glyph it could need, already drawn.
ATLAS = {
    "prose": dict(font=SERIF, step="lead", weight=400),
    "meta": dict(font=MONO, step="meta", weight=400),
    "label": dict(font=MONO, step="label", weight=600),
}
CHARSET = [chr(code) for code in range(32, 127)] + list("°·’–−")
LIGATURES = ["ff", "fi", "fl", "ffi", "ffl"]

ROOT_FONT_SIZE = 16  # px in a rem, at the browser's default text size


def read_tokens():
    """The two palettes and the type scale, out of tokens.ts."""
    source = (DESIGN / "tokens.ts").read_text(encoding="utf-8")

    palette_block = source[source.index("export const palette") : source.index("export type ColorName")]
    light, dark = palette_block.split("dark: {")
    hexes = lambda block: dict(re.findall(r"^\s+(\w+): '(#[0-9a-fA-F]{6})'", block, re.M))
    palette = {"light": hexes(light), "dark": hexes(dark)}

    steps = {}
    scale_block = source[source.index("export const text") : source.index("export const font")]
    for name, body in re.findall(r"^\s+(\w+): \{ (size: .+?) \}", scale_block, re.M):
        fields = dict(re.findall(r"(\w+): '?(-?[\d.]+)(?:r?em)?'?", body))
        steps[name] = {key: float(value) for key, value in fields.items()}
        # Only the fixed steps are in rem; `code` is in em and is not used here.
        steps[name]["px"] = steps[name]["size"] * ROOT_FONT_SIZE

    measure = float(re.search(r"copy: '([\d.]+)rem'", source)[1]) * ROOT_FONT_SIZE

    return palette, steps, measure


def load(font_file, variations):
    """A HarfBuzz font at one point of the variable font's design space."""
    sfnt = TTFont(DESIGN / "fonts" / font_file)
    sfnt.flavor = None  # unwrap the woff2: HarfBuzz reads plain sfnt
    data = BytesIO()
    sfnt.save(data)

    font = hb.Font(hb.Face(data.getvalue()))
    font.set_variations(variations)
    os2 = sfnt["OS/2"]
    return font, sfnt["head"].unitsPerEm, os2.sTypoAscender, os2.sTypoDescender


def number(value):
    return f"{value:.1f}".rstrip("0").rstrip(".")


def trace(text, font, step, weight, color, upper):
    """One line of type as SVG paths, in the line box CSS would give it."""
    variations = {"wght": weight}
    if "opsz" in step:
        variations["opsz"] = step["opsz"]
    hb_font, upem, ascender, descender = load(font, variations)

    buffer = hb.Buffer()
    buffer.add_str(text.upper() if upper else text)
    buffer.guess_segment_properties()
    hb.shape(hb_font, buffer)  # kerning, as the page's font-kerning: normal

    # letter-spacing follows every glyph but is trimmed after the last, so the
    # picture ends where the ink does.
    tracking = step["letterSpacing"] * upem
    paths, x = [], 0.0
    for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
        pen = SVGPathPen(None, ntos=number)
        hb_font.draw_glyph_with_pen(info.codepoint, pen)
        if d := pen.getCommands():
            paths.append(f'<path transform="translate({number(x + position.x_offset)},0)" d="{d}"/>')
        x += position.x_advance + tracking
    advance = x - tracking

    # The line box: the font's own ascent and descent, centred in the step's
    # line-height, which is where a browser puts the baseline.
    scale = step["px"] / upem
    height = round(step["px"] * step["lineHeight"])
    baseline = (height - (ascender - descender) * scale) / 2 + ascender * scale
    width = ceil(advance * scale)

    def svg(fill):
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
            f'width="{width}" height="{height}" role="img" aria-labelledby="t">\n'
            f"<!-- Drawn by scripts/type.py from mohanadtarek.com's {font} and design tokens. -->\n"
            f'<title id="t">{text}</title>\n'
            f'<g fill="{fill}" transform="translate(0,{baseline:.2f}) scale({scale:.5f},-{scale:.5f})">'
            f'{"".join(paths)}</g>\n'
            "</svg>\n"
        )

    return svg, width, height


def atlas(font, step, weight):
    """Every glyph of one style, for a program that lays out its own lines."""
    variations = {"wght": weight}
    if "opsz" in step:
        variations["opsz"] = step["opsz"]
    hb_font, upem, ascender, descender = load(font, variations)

    def shape(text):
        buffer = hb.Buffer()
        buffer.add_str(text)
        buffer.guess_segment_properties()
        hb.shape(hb_font, buffer)
        return buffer.glyph_infos, buffer.glyph_positions

    # A ligature is kept only if the font has it: the text then asks for "fi"
    # by name and gets one glyph, as a browser would give it.
    glyphs = {}
    for text in CHARSET + LIGATURES:
        infos, positions = shape(text)
        if len(infos) != 1 or infos[0].codepoint == 0:
            continue
        pen = SVGPathPen(None, ntos=lambda value: str(round(value)))
        hb_font.draw_glyph_with_pen(infos[0].codepoint, pen)
        glyphs[text] = [positions[0].x_advance, pen.getCommands()]

    # Kerning, read back off the shaper: how far a pair moves the first
    # glyph's advance from what it is alone.
    kerning = {}
    for a in CHARSET:
        for b in CHARSET:
            if a not in glyphs or b not in glyphs:
                continue
            infos, positions = shape(a + b)
            if len(infos) == 2 and (shift := positions[0].x_advance - glyphs[a][0]):
                kerning[a + b] = shift

    return {
        "px": step["px"],
        "lineHeight": step["lineHeight"],
        "letterSpacing": step["letterSpacing"],
        "upem": upem,
        "ascender": ascender,
        "descender": descender,
        "glyphs": glyphs,
        "kerning": kerning,
    }


def main():
    palette, steps, measure = read_tokens()
    OUT.mkdir(exist_ok=True)

    styles = {name: atlas(s["font"], steps[s["step"]], s["weight"]) for name, s in ATLAS.items()}
    (OUT / "atlas.json").write_text(
        json.dumps({"palette": palette, "measure": measure, "styles": styles}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
        newline="\n",
    )

    for name, (text, style) in PIECES.items():
        svg, width, height = trace(
            text, style["font"], steps[style["step"]], style["weight"], style["color"], style["upper"]
        )
        for scheme, colors in palette.items():
            (OUT / f"{name}-{scheme}.svg").write_text(svg(colors[style["color"]]), encoding="utf-8", newline="\n")
        # The README's <img> tags repeat these so the page does not shift as
        # the pictures load.
        print(f'{name}: width="{width}" height="{height}"')


if __name__ == "__main__":
    main()
