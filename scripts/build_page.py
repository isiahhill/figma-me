"""Build site/index.html from the page copy and the real run artifacts.

    python3 scripts/build_page.py

Two inputs, and the split between them is the point:

  site/page.json   the words, written for reading
  sample-runs/     the captured runs, verbatim

The deck's own wording used to feed this page and it read badly, because deck
copy is written to be spoken across. On a page the same lines land as shorthand,
and machine identifiers like CTA_COUNT sit on screen with nothing to tell a
reader what they mean. So the prose lives in page.json and gets written for
someone reading alone.

The data does not. Every gate result, rule, question, and rendered email is read
out of sample-runs/, so the page cannot claim an outcome the run did not
produce. Rule codes are translated through page.json's rule_names on the way to
the screen, with the raw code kept as a tooltip for whoever wants it.

The walkthrough is the same rule taken further. Each step names the artifact it
was built from, right on the pane, so a reader can open that file and check.
Steps with no artifact behind them are not in the walkthrough at all, which is
why the model's single rewrite pass appears in the eleven-step list but not in
the player: nothing in sample-runs/ records it.

Self-contained on purpose: no fetches, no CDN, no analytics. It has to render
identically on a locked-down laptop with the wifi off.
"""

from __future__ import annotations

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
RUNS = ROOT / "sample-runs"

# The four captured runs, in the order they tell the best story: a clean pass
# first so the reader sees what good looks like, then the three ways it stops.
SCENARIOS = [
    ("clean", "A well-formed request",
     "Everything the system needs is present, so it goes straight through."),
    ("messy", "A request with holes in it",
     "The kind that actually arrives in Slack. It asks rather than guesses."),
    ("hostile", "A request that breaks brand rules",
     "Overclaiming, a customer named without permission, and an unsafe link."),
    ("break", "A fabricated statistic, injected on purpose",
     "A clean request with an invented number slipped in. The one worth watching."),
]

STEPS = [
    ("AI", "Read the request and work out what was meant"),
    ("code", "Check the required fields are there, and ask if they are not"),
    ("code", "Choose the template and the slots to fill"),
    ("code", "Pull in the brand voice, the approved claims, and past examples"),
    ("AI", "Write the draft, with every fact pointing at its source"),
    ("code", "Check the shape and the brand rules, and stop if either fails"),
    ("AI", "Rewrite only the parts that failed, once"),
    ("AI", "Score the draft, which can send it for a read but never wave it through"),
    ("code", "Decide whether to stop, ask a person to read it, or go ahead"),
    ("human", "The requester previews it and approves or asks for changes"),
    ("system", "Hand a draft to the sending tool, where a person does the final check"),
]

TREE = """email-cortex/
  brand/      the voice, the approved claims, the locked footer
  schemas/    the shape a request and a draft have to fit
  prompts/    what the model is asked, versioned, with a changelog
  skills/     one folder per email type, with its own settings
  cio/        the short list of things the handoff is allowed to call
  evals/      the test requests and the outcomes they have to produce"""

# Fields the intake step pulls off a request, paired with the label a reader
# sees. Anything absent from a given ticket is simply not shown, which is how
# the messy run visibly has less on screen than the clean one.
TICKET_FIELDS = [
    ("type", "type"),
    ("goal", "goal"),
    ("audience", "audience"),
    ("offer", "offer"),
    ("cta_label", "button"),
    ("cta_href", "link"),
    ("deadline", "deadline"),
]


def e(x) -> str:
    return html.escape(str(x), quote=True)


def load_runs() -> dict:
    out = {}
    for name, _, _ in SCENARIOS:
        d = RUNS / name
        if not d.is_dir():
            continue

        def j(f):
            p = d / f
            return json.loads(p.read_text()) if p.exists() else None

        ev = d / "events.jsonl"
        events = [json.loads(x) for x in ev.read_text().splitlines() if x.strip()] \
            if ev.exists() else []
        pv = d / "preview.html"
        out[name] = {"ticket": j("ticket.json"), "lint": j("lint.json"),
                     "decision": j("decision.json"), "payload": j("cio-payload.json"),
                     "draft": j("draft.json"), "events": events,
                     "preview": pv.read_text() if pv.exists() else None}
    return out


def paras(items) -> str:
    return "".join(f"<p>{e(t)}</p>" for t in items)


def cards(items) -> str:
    return '<div class="cards">' + "".join(
        f'<div class="card"><div class="in"><h3>{e(c["h"])}</h3><p>{e(c["p"])}</p>'
        f'</div></div>' for c in items) + "</div>"


def video(v) -> str:
    """The walkthrough player.

    Deliberately a bare <video> with a local source and a local poster. A CDN
    player or a YouTube embed would break the one rule this page keeps, which is
    that it renders the same on a locked-down laptop with the network off. The
    poster carries the first useful frame so the block does not read as a hole
    in the page before anyone presses play, and preload="none" means the MP4 is
    only fetched when they do.
    """
    return (f'<div class="vidwrap pane"><div class="in">'
            f'<video class="vid" controls playsinline preload="none" '
            f'poster="{e(v["poster"])}" width="1920" height="1080">'
            f'<source src="{e(v["src"])}" type="video/mp4">'
            f'<p>This browser cannot play the recording. '
            f'<a href="{e(v["src"])}">Download the file</a> instead.</p>'
            f'</video></div>'
            # The note is optional and usually should not exist. A line under
            # the player explaining how the recording was made is the page
            # talking about itself while the reader is trying to watch.
            + (f'<p class="vidnote">{e(v["note"])}</p>' if v.get("note") else "")
            + '</div>')


def table(t) -> str:
    ei = t.get("emphasis", -1)
    head = "".join(
        f'<th{" class=em" if k == ei else ""}>{e(c)}</th>' for k, c in enumerate(t["cols"]))
    rows = ""
    for r in t["rows"]:
        rows += "<tr>" + "".join(
            f'<td{" class=em" if k == ei else ""}>{e(c)}</td>' for k, c in enumerate(r)) + "</tr>"
    return ('<div class="tw pane"><div class="in"><div class="tscroll"><table>'
            f'<thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div></div></div>')


def chain(items) -> str:
    return '<ol class="chain">' + "".join(
        f'<li><span class="n">{k:02d}</span><p>{e(s)}</p></li>'
        for k, s in enumerate(items, 1)) + "</ol>"


def steps_block() -> str:
    """The pipeline. Who does each step is the whole message, so the label says
    it in words rather than in a legend the reader has to hold in their head."""
    li = ""
    for k, (who, text) in enumerate(STEPS, 1):
        li += (f'<li class="w-{who}"><span class="n">{k:02d}</span>'
               f'<p>{e(text)}</p><span class="who">{e(who)}</span></li>')
    return (f'<div class="stepwrap pane"><div class="in"><ol class="steps">{li}</ol></div></div>'
            '<p class="legend"><span class="k w-AI"></span>the model decides'
            '<span class="k w-code"></span>ordinary code'
            '<span class="k w-human"></span>a person'
            '<span class="k w-system"></span>another system</p>')


# ---------------------------------------------------------------------------
# The walkthrough
#
# Six steps, each one built from a named file. The mapping is deliberately
# boring: a step exists only where an artifact does, so nothing on screen is a
# dramatisation of something the pipeline did not write down.
# ---------------------------------------------------------------------------

def rule_tags(violations, rule_names) -> str:
    """Plain English first, the machine code second and only as a tooltip.
    Duplicates collapse: the hostile run trips FORBIDDEN_PHRASE twice and two
    identical chips read as a rendering bug rather than as two findings."""
    seen, out = [], ""
    for v in violations or []:
        rid = v.get("rule_id")
        if rid in seen:
            continue
        seen.append(rid)
        out += (f'<li class="sev-{e(v.get("severity", ""))}" '
                f'title="{e(rid)}: {e(v.get("message", ""))}">{e(rule_names.get(rid, rid))}</li>')
    return f'<ul class="tags">{out}</ul>' if out else ""


def stage_event(events, stage) -> dict:
    for ev in events:
        if ev.get("stage") == stage:
            return ev
    return {}


def walk_steps(name, r, rule_names, gate_names) -> list:
    """Returns (title, source file, note, body html) per step."""
    tk = r["ticket"] or {}
    dr = r["draft"] or {}
    lint = r["lint"] or {}
    dec = r["decision"] or {}
    ev = r["events"]
    intake, drafted, gated = (stage_event(ev, s) for s in ("intake", "draft", "gate"))
    steps = []

    # 1. The request, exactly as it landed.
    brief = tk.get("raw") or tk.get("goal") or ""
    steps.append((
        "The request arrives", "ticket.json",
        f'Ticket {tk.get("ticket_id", "")}, submitted through '
        f'{intake.get("requester", "the request form")}.',
        f'<pre class="brief">{e(brief)}</pre>'))

    # 2. Required fields, read off the same ticket. Confidence and the count of
    #    questions come from the intake event, so the two agree by construction.
    kv = "".join(f"<dt>{e(lbl)}</dt><dd>{e(tk[key])}</dd>"
                 for key, lbl in TICKET_FIELDS if tk.get(key))
    conf = tk.get("confidence")
    body = f'<dl class="kv">{kv}</dl>'
    qs = tk.get("needs_input") or []
    if qs:
        body += ('<h4 style="margin-top:20px">What it asked for</h4><ul class="qs">'
                 + "".join(f"<li>{e(q)}</li>" for q in qs) + "</ul>")
    else:
        body += '<p class="snote" style="margin-top:16px">Nothing was missing. No questions.</p>'
    note = f'Read with confidence {conf}. ' if conf is not None else ""
    note += (f'{len(qs)} question{"s" if len(qs) != 1 else ""} raised.'
             if qs else "Every required field was present.")
    steps.append(("Required fields checked", "ticket.json", note, body))

    # 3. The draft. Block kinds come off the draft itself, the counts off the
    #    draft event, and the rendered email is the captured preview.
    kinds = ", ".join(b.get("kind", "") for b in dr.get("blocks") or [])
    rows = [("subject", dr.get("subject")), ("preheader", dr.get("preheader")),
            ("from", dr.get("from_name")), ("blocks", kinds),
            ("button", (dr.get("cta") or {}).get("label"))]
    body = '<dl class="kv">' + "".join(
        f"<dt>{e(k)}</dt><dd>{e(v)}</dd>" for k, v in rows if v) + "</dl>"
    cites = dr.get("citations") or []
    if cites:
        body += ('<h4 style="margin-top:20px">What it pointed at</h4><ul class="tags">'
                 + "".join(f'<li class="sev-warn" title="{e(c.get("span", ""))}">'
                           f'{e(c.get("claim_id", ""))}</li>' for c in cites) + "</ul>")
    if r["preview"]:
        body += (f'<div class="prev"><div class="prev-bar">The email it produced</div>'
                 f'<div class="prev-scale"><iframe title="The email produced by the '
                 f'{e(name)} run" sandbox srcdoc="{e(r["preview"])}"></iframe>'
                 f'</div></div>')
    note = (f'{drafted.get("block_count", len(dr.get("blocks") or []))} blocks, '
            f'{drafted.get("citation_count", len(cites))} cited claim'
            f'{"s" if drafted.get("citation_count", len(cites)) != 1 else ""}.')
    steps.append(("The model writes the draft", "draft.json", note, body))

    # 4. The rule pass. A clean run is not a missing step, it is the checker
    #    running and finding nothing, so it gets a pane of its own.
    vio = lint.get("violations") or []
    if vio:
        # The chips are deduplicated, so say both numbers. The hostile run trips
        # FORBIDDEN_PHRASE twice and "5 violations" over four chips otherwise
        # reads as a rendering bug.
        uniq = len({v.get("rule_id") for v in vio})
        note = f'{len(vio)} violation{"s" if len(vio) != 1 else ""} recorded'
        note += (f' across {uniq} rules. ' if uniq != len(vio) else ". ")
        note += "Hover a rule for the raw code."
        body = rule_tags(vio, rule_names)
    else:
        note = "Every rule ran. None fired."
        body = ('<p class="verdict ok">The draft passed the shape check and every brand '
                'rule, so nothing was raised.</p>')
    steps.append(("Brand rules run in code", "lint.json",
                  f'Status {lint.get("status", "")}. ' + note, body))

    # 5. The gate. No model involved, which is the point of the section above it.
    gate = dec.get("gate", "")
    cls = {"ready_for_cio": "g-ok", "review": "g-review"}.get(gate, "g-stop")
    rev = dec.get("reviewer") or {}
    body = f'<span class="gate {cls}">{e(gate_names.get(gate, gate))}</span>'
    if rev.get("score") is not None:
        body += (f'<p class="score">reviewer score {e(rev["score"])}'
                 + (f' &middot; {e(rev.get("notes"))}' if rev.get("notes") else "") + "</p>")
    body += ('<p class="snote">The gate reads the rule results and decides. It calls no '
             'model, so a persuasive draft has nothing to persuade.</p>')
    steps.append(("The gate decides", "decision.json",
                  f'Gate {gate}, on lint status {dec.get("lint_status", "")}.', body))

    # 6. Handoff. Present only as a payload file, absent as a missing event, and
    #    the pane says which of the two it is looking at.
    if r["payload"]:
        pay = r["payload"]
        rows = [("method", pay.get("method")), ("call", pay.get("sdk")),
                ("name", (pay.get("body") or {}).get("name")),
                ("recipient", ((pay.get("body") or {}).get("envelope") or {}).get("recipient"))]
        body = '<dl class="kv">' + "".join(
            f"<dt>{e(k)}</dt><dd>{e(v)}</dd>" for k, v in rows if v) + "</dl>"
        body += ('<p class="verdict ok" style="margin-top:16px">A draft was created. The '
                 'recipient is an unresolved template variable, so no audience is attached '
                 'and there is no send call.</p>')
        src, note = "cio-payload.json", f'Handoff event written by {stage_event(r["events"], "handoff").get("sdk", "the handoff")}.'
    else:
        body = ('<p class="verdict stop">No payload file exists for this run and no handoff '
                'event was written. Nothing left the system.</p>')
        src, note = "events.jsonl", "The run ends at the gate."
    steps.append(("Handoff, or not", src, note, body))
    return steps


def player(name, r, rule_names, gate_names) -> str:
    steps = walk_steps(name, r, rule_names, gate_names)
    rail, panes = "", ""
    for k, (title, src, note, body) in enumerate(steps):
        pid = f"w-{name}-{k + 1}"
        rail += (f'<li{" class=on" if k == 0 else ""}><button type="button" '
                 f'aria-current="{"step" if k == 0 else "false"}" aria-controls="{pid}">'
                 f'<span class="sn">{k + 1:02d}</span><span class="st">{e(title)}</span>'
                 f'<span class="fill"></span></button></li>')
        panes += (f'<article class="spane{" cur" if k == 0 else ""}" id="{pid}">'
                  f'<h5>{e(title)}</h5>'
                  f'<p class="from">read from <b>sample-runs/{e(name)}/{e(src)}</b></p>'
                  f'<p class="snote">{e(note)}</p>{body}</article>')
    return f"""<div class="player pane" data-run="{e(name)}"><div class="in">
  <div class="pbar">
    <button type="button" class="pbtn" aria-label="Play the walkthrough">
      <span class="lb">Play</span><span class="gl" aria-hidden="true">&#9654;</span></button>
    <span class="pcount" aria-live="polite">1 / {len(steps)}</span>
    <span class="psrc">sample-runs/{e(name)}/</span>
  </div>
  <div class="pbody">
    <ol class="prail">{rail}</ol>
    <div class="stage">{panes}</div>
  </div>
</div></div>"""


def run_panel(name, heading, blurb, r, rule_names, gate_names) -> str:
    return (f'<div class="panel" id="run-{e(name)}" data-run="{e(name)}" role="tabpanel" '
            f'aria-labelledby="tab-{e(name)}" hidden>'
            f'<p class="panel-lead">{e(blurb)}</p>'
            f'{player(name, r, rule_names, gate_names)}</div>')


def build() -> str:
    page = json.loads((SITE / "page.json").read_text())
    runs = load_runs()
    rn, gn = page["rule_names"], page["gate_names"]

    nav, body = "", ""
    for i, s in enumerate(page["sections"], 1):
        sid = s["id"]
        nav += f'<li><a href="#{e(sid)}">{e(s["nav"])}</a></li>'
        inner = f'<p class="lead">{e(s["lead"])}</p>'
        if s.get("stats"):
            inner += '<div class="statwrap pane"><div class="in"><div class="stats">' + "".join(
                f'<div class="stat"><b>{e(x["value"])}</b><span>{e(x["label"])}</span></div>'
                for x in s["stats"]) + "</div></div></div>"
        if s.get("video"):
            inner += video(s["video"])
        if s.get("table"):
            inner += table(s["table"])
        if s.get("chain"):
            inner += chain(s["chain"])
        if s.get("steps"):
            inner += steps_block()
        if s.get("tree"):
            inner += f'<div class="treewrap pane"><div class="in"><pre class="tree">{e(TREE)}</pre></div></div>'
        if s.get("body"):
            inner += f'<div class="prose">{paras(s["body"])}</div>'
        if s.get("reasons"):
            inner += cards(s["reasons"])
        if s.get("exits"):
            inner += '<h4 class="sub-h">The three ways a person gets involved</h4>' + cards(s["exits"])
        if s.get("cards"):
            inner += cards(s["cards"])
        if s.get("plain"):
            inner += ('<aside class="callout pane"><div class="in"><h3>Put plainly</h3>'
                      f'<p>{e(s["plain"])}</p></div></aside>')
        if s.get("callout"):
            c = s["callout"]
            inner += ('<aside class="callout pane"><div class="in">'
                      f'<h3>{e(c["h"])}</h3><p>{e(c["p"])}</p></div></aside>')
        if s.get("runs") and runs:
            tabs = "".join(
                f'<button type="button" role="tab" id="tab-{e(n)}" aria-controls="run-{e(n)}" '
                f'aria-selected="false">{e(h)}</button>'
                for n, h, _ in SCENARIOS if n in runs)
            panels = "".join(run_panel(n, h, b, runs[n], rn, gn)
                             for n, h, b in SCENARIOS if n in runs)
            inner += (f'<div class="runs" id="runs"><div class="tabsrow pane flush">'
                      f'<div class="tabs" role="tablist" aria-label="Captured runs">{tabs}</div>'
                      f'</div>{panels}</div>')
        if s.get("next"):
            inner += (f'<p class="next"><a href="#{e(page["sections"][i]["id"])}">'
                      f'{e(s["next"])}<span class="arw" aria-hidden="true">&#8595;</span></a></p>')
        h = "h1" if i == 1 else "h2"
        body += (f'<section id="{e(sid)}"><div class="wrap rv">'
                 f'<p class="kicker"><span class="num">{i:02d}</span>{e(s["nav"])}</p>'
                 f'<{h}>{e(s["title"])}</{h}>{inner}</div></section>')

    # The mark is inlined rather than linked, and its source lives outside
    # site/ on purpose. The Worker serves that whole directory, so an SVG left
    # in there is a live URL, and this one is somebody else's trademark. Inline
    # it renders; as a file it would be hosted.
    mark = (ROOT / "brand/figma-mark.svg").read_text().strip()
    tpl = (SITE / "_template.html").read_text()
    return (tpl.replace("<!--NAV-->", nav)
               .replace("<!--BODY-->", body)
               .replace("<!--MARK-->", mark)
               .replace("<!--TAGLINE-->", e(page["tagline"]))
               .replace("<!--TITLE-->", e(page["title"])))


if __name__ == "__main__":
    out = SITE / "index.html"
    out.write_text(build())
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
