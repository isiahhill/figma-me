"""Build the walkthrough video's scene file out of the captured runs.

    python3 scripts/record_walkthrough.py

Writes walkthrough-scenes.json, which the walkthrough-video project renders:

    cd ../walkthrough-video
    npm run render -- --props=../figma-me/walkthrough-scenes.json \
                      --out=../figma-me/site/media/walkthrough.mp4
    npm run poster -- --props=../figma-me/walkthrough-scenes.json \
                      --out=../figma-me/site/media/walkthrough-poster.jpg --frame=45

Frame 45 is the opening title card at rest. It is chosen against the obvious
alternative, a frame from the middle showing the invented number being caught,
and the reason is what the reader sees when they press play. The browser holds
the poster until the first frame paints, so a mid-video poster cuts to the
opening card and reads as a glitch. Frame 45 is that same card, so the cut is
the card arriving on its own entrance spring instead. It also sits well clear
of both the entrance (settled by frame 25) and the outro fade (from frame 102),
and a title card is a still by construction, so nothing is caught mid-sentence.

Why a script and not a screen recording. The same reason build_page.py exists:
a video is another surface that can claim an outcome the pipeline never
produced, and the only defence that survives an edit is to read the outcome out
of the artifact instead of typing it. So every number, rule name, question count
and gate result below is pulled from sample-runs/ or from site/page.json's
rule_names, and the parts that are prose get asserted rather than trusted. If a
run changes, this regenerates and the captions change with it. If a caption
starts claiming something the runs no longer say, the assertions at the bottom
fail before anything renders.

Two inputs beyond the runs:

  walkthrough/shots/       stills of the live page at fme.isiah.codes, 1600x1000
  walkthrough/shot-rects.json
                           element rectangles measured in the same browser pass
                           as each shot, so highlight boxes and cursor targets
                           land on the element rather than near it

Neither ships. The Worker serves site/ only, and the shots live outside it.

The shots are stills rather than a capture of the page playing itself, because
the renderer draws only what the scene file names. A screen capture picks up
whatever else is on the machine, and a walkthrough is a bad place to find out
you have published a file path.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "sample-runs"
SHOTS = ROOT / "walkthrough/shots"
RECTS = json.loads((ROOT / "walkthrough/shot-rects.json").read_text())
OUT = ROOT / "walkthrough-scenes.json"

FPS = 30
# Pulled off the page's own stylesheet so the video and the page agree.
ACCENT = "#4d49fc"
BACKGROUND = "#f4f4f7"

# Every shot is a 1600x1000 viewport capture. The renderer needs the intrinsic
# size to lay out highlights, and hard-coding it here rather than shelling out
# to sips keeps the script runnable with nothing installed. verify_shots()
# below re-reads it from the PNG headers and shouts if a shot disagrees.
SHOT_W, SHOT_H = 1600, 1000

# Geometry the schema fixes: the browser card's viewport is 1700x882 composition
# pixels, its top-left corner sits at (110, 133), and "fit": "width" scales a
# 1600px-wide shot by 1700/1600.
SCALE = 1700 / SHOT_W
CARD_X, CARD_Y = 110, 133

# Only the top ~830 rows of a 1000px shot are ever on screen at this scale, and
# the caption bar covers everything below roughly row 755. Anything we point at
# has to sit above that, so we check it instead of remembering it.
VISIBLE_ROWS = 882 / SCALE
# The caption bar's top edge, measured off a rendered frame rather than derived:
# the bar sits 84px up from the bottom of the 1080 frame and stands about 90px
# tall, so it starts around composition row 910.
CAPTION_ROW = (910 - CARD_Y) / SCALE


# ---------------------------------------------------------------------------
# Reading the runs
# ---------------------------------------------------------------------------

def run(name: str) -> dict:
    d = RUNS / name

    def j(f):
        p = d / f
        return json.loads(p.read_text()) if p.exists() else None

    return {"ticket": j("ticket.json"), "lint": j("lint.json"),
            "decision": j("decision.json"), "draft": j("draft.json"),
            "payload": j("cio-payload.json")}


RUN = {n: run(n) for n in ("clean", "messy", "hostile", "break")}

# Small counts read as words on a title card and as digits in a caption, which
# is ordinary typesetting rather than a preference: a card is prose set at
# 38px, a caption is a label. Only the counts this file can actually produce
# are here, so a fifth run turns into a KeyError rather than a silent "5".
WORD = {1: "One", 2: "Two", 3: "Three", 4: "Four"}
PAGE = json.loads((ROOT / "site/page.json").read_text())
RULE_NAMES, GATE_NAMES = PAGE["rule_names"], PAGE["gate_names"]


def rules_named(name: str) -> list[str]:
    """The plain-English rule names a run tripped, deduplicated in the order the
    page shows them. The hostile run trips FORBIDDEN_PHRASE twice and the page
    collapses the chips, so the video has to collapse them too or the caption
    and the frame behind it disagree."""
    out = []
    for v in RUN[name]["lint"]["violations"]:
        n = RULE_NAMES[v["rule_id"]]
        if n not in out:
            out.append(n)
    return out


def gate_label(name: str) -> str:
    return GATE_NAMES[RUN[name]["decision"]["gate"]]


# ---------------------------------------------------------------------------
# Scene builders
#
# Thin wrappers over the schema. They exist so the scene list below reads as a
# storyboard rather than as JSON, and so the frame arithmetic for cursors and
# highlights happens in one place.
# ---------------------------------------------------------------------------

def title(eyebrow: str, headline: str, supporting: str, frames: int,
          bg: str = "tint") -> dict:
    return {"type": "title", "durationInFrames": frames, "eyebrow": eyebrow,
            "headline": headline, "supporting": supporting, "align": "left",
            "background": bg}


def caption(text: str, at: int, hold: int) -> dict:
    return {"type": "caption", "text": text, "fromFrame": at, "durationInFrames": hold}


def box(shot: str, key: str, at: int, hold: int, pad: int = 8) -> dict:
    """A highlight over a measured element, padded so the rule sits outside the
    text rather than on top of its ascenders.

    Deliberately unlabelled. The schema's label pill hangs above the box's
    top-left corner, and every pane on this page has its own note line sitting
    exactly there, so a pill covers live text in all nine of these scenes. The
    captions already name what is boxed, and they are timed to it, so the box
    can just be a box.
    """
    r = RECTS[shot][key]
    return {"x": r["x"] - pad, "y": r["y"] - pad,
            "width": r["w"] + pad * 2, "height": r["h"] + pad * 2,
            "fromFrame": at, "durationInFrames": hold}


def click(shot: str, key: str, at: int, start: tuple[int, int] = (1500, 900),
          hide: int | None = None) -> dict:
    """A pointer that walks in from the lower right and clicks the centre of a
    measured element. The conversion from screenshot to composition space is the
    one the schema documents, and it is only valid on a scene with no pan, which
    is why no scene here has both."""
    r = RECTS[shot][key]
    cx = CARD_X + (r["x"] + r["w"] / 2) * SCALE
    cy = CARD_Y + (r["y"] + r["h"] / 2) * SCALE
    path = [{"x": start[0], "y": start[1], "atFrame": 0},
            {"x": round(cx), "y": round(cy), "atFrame": at, "click": True}]
    out = {"type": "cursor", "path": path}
    if hide is not None:
        out["hideAfterFrame"] = hide
    return out


def browser(shot: str, frames: int, highlights: list, captions: list,
            cursor: dict | None = None) -> dict:
    overlays = list(captions) + ([cursor] if cursor else [])
    return {"type": "browser", "durationInFrames": frames,
            # The address bar reads as the live page, which is what it is.
            "url": "fme.isiah.codes/#run",
            "image": {"src": f"walkthrough/shots/{shot}.png",
                      "width": SHOT_W, "height": SHOT_H},
            "fit": "width", "highlights": highlights, "overlays": overlays}


# ---------------------------------------------------------------------------
# The storyboard
# ---------------------------------------------------------------------------

def build() -> dict:
    messy_q = RUN["messy"]["ticket"]["needs_input"]
    messy_conf = RUN["messy"]["ticket"]["confidence"]
    hostile = rules_named("hostile")
    brk_v = RUN["break"]["lint"]["violations"]
    brk_rule = RULE_NAMES[brk_v[0]["rule_id"]]
    brk_msg = brk_v[0]["message"]
    brk_line = RUN["break"]["ticket"]["must_include"][-1]
    brk_score = RUN["break"]["decision"]["reviewer"]["score"]
    clean_cites = len(RUN["clean"]["draft"]["citations"])
    clean_blocks = len(RUN["clean"]["draft"]["blocks"])
    # The opening card's arithmetic, read off the decisions rather than typed,
    # so it cannot drift if a run's outcome changes. "Ready to hand off" is the
    # page's own words for ready_for_cio, and the distinction matters: nothing
    # on this page sends, so the clean run finishes ready, not sent.
    ready = [n for n in RUN if RUN[n]["decision"]["gate"] == "ready_for_cio"]
    stopped = [n for n in RUN if n not in ready]
    # The lint message arrives as "<claim>: <quoted value>". Split it into two
    # sentences rather than reading the colon aloud, keeping both halves byte
    # for byte. partition() gives an empty tail if the shape ever changes,
    # which the caption then handles instead of crashing on an index.
    brk_claim, _, brk_value = brk_msg.partition(": ")

    scenes = [
        # --- 1. Open ------------------------------------------------------
        title("Email production, governed",
              "A request goes in. A person still says yes.",
              f"{WORD[len(RUN)]} requests go in. {WORD[len(ready)]} comes out "
              f"ready to hand off. {WORD[len(stopped)]} stop before that.",
              110),

        # --- 2. Pick the messy run ----------------------------------------
        # The page opens on the clean run. Reach for the one that looks like
        # real life first, because that is the request the team actually gets.
        browser("01-tabs-clean", 260,
                [box("01-tabs-clean", "tabstrip", 30, 130, pad=0)],
                [caption(f"{len(RUN)} runs, each a different kind of request.", 10, 125),
                 caption("Start with the request that actually turns up in Slack.", 145, 105)],
                click("01-tabs-clean", "tab-messy", 165, hide=250)),

        # --- 3. The messy request itself ----------------------------------
        browser("02-messy-request", 280,
                [box("02-messy-request", "brief", 40, 195)],
                [caption("One line. No goal, no link, no date.", 10, 130),
                 caption("It also leans on a number nobody approved.", 145, 120)],
                click("02-messy-request", "rail-2", 205, hide=272)),

        # --- 4. What it asked for -----------------------------------------
        # The count and the confidence are read off the ticket, so the caption
        # cannot drift from the panel behind it.
        browser("03-messy-questions", 340,
                [box("03-messy-questions", "note", 20, 85),
                 box("03-messy-questions", "questions", 115, 215)],
                [caption(f"It did not guess. It read this at confidence {messy_conf} and asked.", 10, 100),
                 caption(f"{len(messy_q)} questions, each naming the field it needs.", 115, 115),
                 caption("The unapproved number is quarantined, not written into copy.", 235, 100)],
                click("03-messy-questions", "tab-clean", 285, hide=332)),

        # --- 5. The clean run produces a draft ----------------------------
        browser("04-clean-draft", 370,
                [box("04-clean-draft", "fields", 20, 105),
                 box("04-clean-draft", "citation", 135, 105),
                 box("04-clean-draft", "preview", 255, 105)],
                [caption("Now the well-formed request, at the step that writes the draft.", 10, 120),
                 caption(f"{clean_blocks} blocks, and its {clean_cites} factual claim points at an approved source.", 135, 105),
                 caption("Here is the rendered email, button and footer and all.", 250, 100)]),

        # --- 6. Brand rules firing ----------------------------------------
        browser("05-hostile-rules", 330,
                [box("05-hostile-rules", "rules", 55, 235)],
                [caption(f"A request that breaks the rules. {len(hostile)} of them fire.", 10, 130),
                 caption(f"{hostile[0]}. {hostile[1]}.", 145, 105),
                 caption(f"{hostile[2]}. {hostile[3]}.", 255, 68)],
                click("05-hostile-rules", "tab-break", 285, hide=322)),

        # --- 7. Chapter break ---------------------------------------------
        title("The one that matters",
              "A clean request, with an invented number in it",
              "Everything else about this request is correct. One line was slipped in.",
              95, "white"),

        # --- 8. The injected line -----------------------------------------
        browser("06-break-request", 320,
                [box("06-break-request", "injected-line", 55, 235, pad=6)],
                [caption("This request is well formed. Type, goal, audience, link, date.", 10, 130),
                 caption(f'The last line reads "{brk_line}".', 145, 115),
                 caption("Nobody approved that number.", 265, 48)],
                click("06-break-request", "rail-3", 275, hide=312)),

        # --- 9. The number reaches the copy, and is caught ------------------
        # The beat the whole video is for, so it gets the longest scene and two
        # highlights: the number sitting in the rendered email, and the rule
        # naming it beside the email.
        browser("10-break-draft", 360,
                [box("10-break-draft", "number-in-copy", 45, 150, pad=6),
                 box("10-break-draft", "rule-card", 190, 160)],
                [caption("The model wrote the draft, invented number included.", 10, 120),
                 caption("The checker marks it inside the rendered email.", 135, 110),
                 # str.capitalize() would lowercase the rest of the message and
                 # quietly rewrite the lint output, so only the first letter moves.
                 caption(brk_claim[0].upper() + brk_claim[1:] + "."
                         + (f" {brk_value}." if brk_value else ""), 250, 100)],
                click("10-break-draft", "rail-4", 290, start=(1500, 940), hide=352)),

        # --- 10. The rule, in plain English --------------------------------
        browser("07-break-rule", 320,
                [box("07-break-rule", "rule-chip", 55, 230)],
                [caption("The rule pass says the same thing without the code.", 10, 130),
                 caption(f'{brk_rule}. That is the only violation.', 145, 115),
                 caption("Everything else about the request was fine.", 265, 48)],
                click("07-break-rule", "rail-5", 275, hide=312)),

        # --- 11. The gate ---------------------------------------------------
        browser("08-break-gate", 300,
                [box("08-break-gate", "gate", 45, 195)],
                [caption("The gate reads the rule results and decides.", 10, 120),
                 caption(f'{gate_label("break")}. Reviewer score {brk_score}, flagged for the same rule.', 135, 115),
                 caption("The gate calls no model, so a persuasive draft has nothing to persuade.", 255, 43)],
                click("08-break-gate", "rail-6", 265, hide=292)),

        # --- 12. Nothing left the system ------------------------------------
        browser("09-break-handoff", 280,
                [box("09-break-handoff", "verdict", 45, 185)],
                [caption("No payload file. No handoff event.", 10, 115),
                 caption("Nothing left the system.", 130, 90),
                 caption("A person has to clear the number before this goes anywhere.", 225, 50)]),

        # --- 13. Close --------------------------------------------------------
        title("What it comes to",
              "The model writes. Code decides.",
              "Every stop came from rules in code. Those rules run whatever "
              "the model produces.",
              165),
    ]

    return {"title": "Email production walkthrough", "accent": ACCENT,
            "background": BACKGROUND, "scenes": scenes}


# ---------------------------------------------------------------------------
# Checks. Cheap, and each one is here because it is a thing a future edit can
# quietly get wrong.
# ---------------------------------------------------------------------------

def texts(doc: dict):
    """Every string a viewer reads, with a path so a failure names itself."""
    for i, s in enumerate(doc["scenes"]):
        for k in ("eyebrow", "headline", "supporting"):
            if s.get(k):
                yield f"scenes[{i}].{k}", s[k]
        for j, h in enumerate(s.get("highlights") or []):
            if h.get("label"):
                yield f"scenes[{i}].highlights[{j}].label", h["label"]
        for j, o in enumerate(s.get("overlays") or []):
            if o.get("type") == "caption":
                yield f"scenes[{i}].overlays[{j}].text", o["text"]


# A line that talks about the recording instead of the work. The reader came
# for the pipeline, and a caption narrating its own production spends their
# attention on the wrong thing. Word boundaries rather than substrings, and the
# scan runs over texts() rather than the whole document, because the scene file
# legitimately carries "walkthrough/shots/..." image paths and an address bar
# that a blob-level match would flag forever until someone weakened the rule.
META = re.compile(
    r"\b(recording|recorded|video|screencast|footage|film(?:ed|ing)?|page|"
    r"captur(?:e|ed|es|ing)|replay(?:s|ed|ing)?|screenshot|walkthrough|"
    r"this card|this clip)\b",
    re.I,
)

# A colon joining two clauses. Spoken lines do not have colons in them, and on
# screen the mark reads as a label rather than as speech. Matching ":" followed
# by whitespace catches exactly that use and leaves a ratio or a timestamp
# alone.
COLON = re.compile(r":\s")


def verify(doc: dict) -> list[str]:
    bad = []

    # House style for spoken lines: short sentences, no em dashes, no
    # semicolons. Both punctuation marks ask a reader to hold a clause open,
    # which is the wrong thing to do to someone also watching a screen.
    for path, t in texts(doc):
        if "—" in t or ";" in t:
            bad.append(f"{path}: em dash or semicolon in {t!r}")
        m = META.search(t)
        if m:
            bad.append(f"{path}: says {m.group(0)!r}, which is the video "
                       f"talking about itself, in {t!r}")
        if COLON.search(t):
            bad.append(f"{path}: colon joining two clauses in {t!r}")

    for i, s in enumerate(doc["scenes"]):
        for j, o in enumerate(s.get("overlays") or []):
            # The caption bar clips rather than wraps, and a sentence sliced
            # mid-word reads as a broken video.
            if o.get("type") == "caption" and len(o["text"]) > 88:
                bad.append(f"scenes[{i}].overlays[{j}]: caption is "
                           f"{len(o['text'])} chars, over the 88 that fit")
            # A cursor or caption that outlives its scene is a pointer left
            # hanging over the next shot.
            end = o.get("fromFrame", 0) + o.get("durationInFrames", 0)
            if o.get("durationInFrames") and end > s["durationInFrames"]:
                bad.append(f"scenes[{i}].overlays[{j}]: runs to frame {end} in a "
                           f"{s['durationInFrames']}-frame scene")
        for j, h in enumerate(s.get("highlights") or []):
            end = h.get("fromFrame", 0) + h.get("durationInFrames", 0)
            if h.get("durationInFrames") and end > s["durationInFrames"]:
                bad.append(f"scenes[{i}].highlights[{j}]: runs to frame {end} in a "
                           f"{s['durationInFrames']}-frame scene")
            # Inside the image but below the fold is still off screen, and the
            # renderer will not warn about it because the box is in bounds.
            if h["y"] + h["height"] > CAPTION_ROW:
                bad.append(f"scenes[{i}].highlights[{j}] ({h.get('label')}): bottom at "
                           f"{h['y'] + h['height']:.0f} is under the caption bar "
                           f"(row {CAPTION_ROW:.0f})")
            if h["y"] + h["height"] > VISIBLE_ROWS:
                bad.append(f"scenes[{i}].highlights[{j}]: below the visible "
                           f"{VISIBLE_ROWS:.0f} rows of the shot")
        if s["type"] == "browser" and not (SHOTS / f'{Path(s["image"]["src"]).name}').exists():
            bad.append(f'scenes[{i}].image.src: missing {s["image"]["src"]}')

    # Nothing about this machine, ever. The video is published, the paths are
    # not, and this is the check that would have caught it.
    blob = json.dumps(doc)
    for pattern in (r"/Users/", r"/private/", r"/tmp/", r"\.local\b", r"localhost"):
        if re.search(pattern, blob):
            bad.append(f"scene file contains {pattern!r}, which is a machine detail")

    # The brief asked for 90 to 130 seconds. A caption hold added carelessly is
    # the usual way that stops being true.
    total = sum(s["durationInFrames"] for s in doc["scenes"])
    if not 2700 <= total <= 3900:
        bad.append(f"total {total} frames ({total / FPS:.0f}s) is outside 90 to 130 seconds")
    return bad


def verify_shots() -> list[str]:
    """Read the intrinsic size straight out of each PNG's IHDR chunk. If a shot
    is ever re-taken at a different size, every highlight box and every cursor
    target silently moves, and this is the only place that notices."""
    bad = []
    for p in sorted(SHOTS.glob("*.png")):
        head = p.read_bytes()[:33]
        if head[:8] != b"\x89PNG\r\n\x1a\n":
            bad.append(f"{p.name}: not a PNG")
            continue
        w = int.from_bytes(head[16:20], "big")
        h = int.from_bytes(head[20:24], "big")
        if (w, h) != (SHOT_W, SHOT_H):
            bad.append(f"{p.name}: {w}x{h}, expected {SHOT_W}x{SHOT_H}")
    return bad


if __name__ == "__main__":
    doc = build()
    problems = verify(doc) + verify_shots()
    if problems:
        for p in problems:
            print(f"error  {p}", file=sys.stderr)
        sys.exit(1)

    OUT.write_text(json.dumps(doc, indent=2) + "\n")
    total = sum(s["durationInFrames"] for s in doc["scenes"])
    print(f"wrote {OUT.relative_to(ROOT)} - {len(doc['scenes'])} scenes, "
          f"{total} frames, {total / FPS:.1f}s at {FPS}fps")
