"""End-to-end test of the extension against a mocked chatgpt.com (does NOT test the live ChatGPT DOM).

The mock composer is a real ProseMirror editor (loaded from esm.sh, so this needs network access).
The dataset CSVs are read from the public GitHub repo; battery.json is simulated (missing, or present with --battery).
Usage: pip install playwright && python3 -m playwright install chromium
       python3 scripts/test_e2e.py [--battery] [--toggle]
--toggle simulates an account with the Personalized/Unpersonalized dropdown in Temporary Chats.
"""
import csv, html, io, json, re, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

EXT = str(Path(__file__).resolve().parent.parent)

RAW = "https://raw.githubusercontent.com/hafsa-akbar/llm-personalization-ecological-validity/main/datasets/"
API = "https://api.github.com/repos/hafsa-akbar/llm-personalization-ecological-validity/contents/datasets"
BATTERY = {"datasets": ["sbb", {"moral_judgment": ["aita_002", "aita_005"]}, "information_prioritization"]} if "--battery" in sys.argv else None
TOGGLE = "--toggle" in sys.argv

S = {"page": "composer", "mem": False, "web": True, "pz": "Unpersonalized"}  # what the fake chatgpt.com serves / has saved

# The Personalized/Unpersonalized dropdown at the top right of a Temporary Chat (--toggle accounts only).
def header(url):
    if not (TOGGLE and "temporary-chat=true" in url and S["page"] != "conv"): return ""  # gone once a message is sent
    # Like ChatGPT's menu: opens on pointerdown (a plain click does nothing); items have a description line.
    return (f'<button id="pz" onpointerdown="menu.hidden=!menu.hidden">{S["pz"]}</button><div id="menu" role="menu" hidden>'
            '<div role="menuitemradio" onclick="pick(this)"><span>Personalized</span><p>Uses memory</p></div>'
            '<div role="menuitemradio" onclick="pick(this)"><span>Unpersonalized</span><p>Ignores memory</p></div></div>'
            # S["finicky"]: the choice is saved but only shows after a reload, as ChatGPT sometimes does
            f"<script>const pick = (el) => {{ const v = el.firstChild.textContent; {'' if S.get('finicky') else 'pz.textContent = v; '}menu.hidden = true; fetch('/pz', {{ method: 'POST', body: v }}); }};</script>")

COMPOSER = """<form><textarea name="prompt-textarea" style="display:none"></textarea><div id="editor"></div></form>
<script type="module">
  import { EditorState } from "https://esm.sh/prosemirror-state@1";
  import { EditorView } from "https://esm.sh/prosemirror-view@1";
  import { schema } from "https://esm.sh/prosemirror-schema-basic@1";
  window.pmView = new EditorView(document.querySelector("#editor"), {
    state: EditorState.create({ schema }), attributes: { id: "prompt-textarea", class: "ProseMirror" } });
</script>"""

def settings_html():
    sw = lambda key: f'<button role="switch" aria-checked="{str(S[key]).lower()}" onclick="flip(this)"></button>'
    return f"""<main><h2>Personalization</h2>
      <section><span>Memory overview</span><button id="manage">Manage</button></section>
      <div><div><span>Enable memory</span><p>Let ChatGPT save and use memories.</p></div>{sw('mem')}</div>
      <div><span>Reference chat history</span><button role="switch" aria-checked="true"></button></div>
      <button id="more">Additional ChatGPT settings</button><div id="extra"></div>
      <button id="save" disabled>Save</button></main>
    <script>
      const flip = (b) => {{ b.setAttribute('aria-checked', b.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); save.disabled = false; }};
      more.onclick = () => {{ extra.innerHTML = '<div><span>Web search</span><button role="switch" aria-checked="{str(S['web']).lower()}" onclick="flip(this)"></button></div>'; }};
      save.onclick = () => fetch('/save', {{ method: 'POST', body: JSON.stringify([...document.querySelectorAll('[role=switch]')].map(s => [s.parentElement.innerText, s.getAttribute('aria-checked')])) }});
      manage.onclick = () => setTimeout(() => document.body.insertAdjacentHTML('beforeend',
        '<div role="dialog"><h2>Memory overview</h2><p>Lives in Boston.</p><p>Likes cats.</p><h3>Dive Deeper</h3><p>Other stuff</p></div>'), 1500);
    </script>"""

BUBBLE = lambda: f'style="background: {"rgb(33, 61, 110)" if S["pz"] == "Personalized" else "rgb(48, 48, 48)"}"'  # user bubble: blue = personalized

def conv_html():
    sidebar = f'<nav aria-label="Chat history"><a href="/c/abc"><span>{html.escape(S["user"][:60])}</span></a></nav>'
    if S.get("markup") is None:  # ChatGPT's 2026 layout, copied from a real page's structure
        state = "streaming" if S.get("generating") else "complete"
        return (f'{sidebar}<main><div role="region" aria-label="Conversation"><div data-turn-key="m1"><div data-content-search-turn-key="fallback-turn-0">'
                f'<div class="group flex flex-col" data-talvt-turn-state="{state}">'
                f'<div data-chatgpt-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble="true" class="bg-user-message" {BUBBLE()}>'
                f'<div class="overflow-hidden" style="max-height:3lh"><div><div class="text-size-chat whitespace-pre-wrap" style="white-space:pre-wrap">{html.escape(S["user"])}</div></div></div>'
                f'<button>Show more</button></div></div>'
                f'<div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"><div class="markdown"><p>{S["reply"]}</p>{S.get("links", "")}</div></div>'
                f'</div></div></div></div></main>')
    if S.get("markup") == "turns":  # no data-message-author-role: only turn containers with screen-reader labels
        return (f'<main><article data-testid="conversation-turn-1"><h5 class="sr-only">You said:</h5><div {BUBBLE()}>{html.escape(S["user"])}</div></article>'
                f'<article data-testid="conversation-turn-2"><h6 class="sr-only">ChatGPT said:</h6><div class="markdown"><p>{S["reply"]}</p></div></article></main>')
    # markup == "legacy": data-message-author-role attributes
    u = f'<div data-message-author-role="user"><div {BUBBLE()}>{html.escape(S["user"])}</div></div>'
    a = f'<div data-message-author-role="assistant" data-message-model-slug="{S.get("slug", "gpt-5-5-instant")}"><div class="markdown"><p>{S["reply"]}</p>{S.get("links", "")}</div></div>'
    stop = '<button data-testid="stop-button"></button>' if S.get("generating") else ""
    return f"<main>{u}{a}{stop}</main>"

def route(r):
    url = r.request.url
    if url.endswith("/battery.json"):  # simulated: present with --battery, otherwise missing; CSVs load from the real repo
        cors = {"access-control-allow-origin": "*"}
        return r.fulfill(json=BATTERY, headers=cors) if BATTERY else r.fulfill(status=404, body="404: Not Found", headers=cors)
    if url.endswith("/pz"):
        S["pz"] = r.request.post_data
        return r.fulfill(json={})
    if url.endswith("/save"):
        for label, on in json.loads(r.request.post_data):
            if "Enable memory" in label: S["mem"] = on == "true"
            if "Web search" in label: S["web"] = on == "true"
        return r.fulfill(json={})
    body = settings_html() if "/settings/personalization" in url else conv_html() if S["page"] == "conv" else COMPOSER
    r.fulfill(content_type="text/html; charset=utf-8", body=f"<!doctype html><html><body>{header(url)}{body}</body></html>")

def ok(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: sys.exit(1)

with sync_playwright() as pw:
    http = pw.request.new_context()
    get = lambda url: http.get(url).text().lstrip("\ufeff")
    CSVS = sorted(f["name"] for f in json.loads(get(API)) if f["name"].endswith(".csv"))
    ctx = pw.chromium.launch_persistent_context(tempfile.mkdtemp(), headless=True, channel="chromium",
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
    ctx.route("https://chatgpt.com/**", route)
    ctx.route("https://raw.githubusercontent.com/**/battery.json", route)
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
    sp = ctx.new_page(); sp.goto(f"chrome-extension://{sw.url.split('/')[2]}/sidepanel.html")
    chat = ctx.new_page(); chat.goto("https://chatgpt.com/")
    errors = []; sp.on("pageerror", lambda e: errors.append(str(e))); sp.on("dialog", lambda d: d.accept())
    PROMPTS = sp.evaluate("PROMPTS")
    nxt, err, title, main = sp.locator("#next"), sp.locator("#errors"), sp.locator("#title"), sp.locator("main")
    def load(url="https://chatgpt.com/", **kw): S.update(kw); chat.goto(url); chat.bring_to_front()
    def act(name): sp.locator(f'[data-act="{name}"]').first.click()
    def composer_text():
        chat.wait_for_function("window.pmView && window.pmView.state.doc.content.size > 2", timeout=10000)
        return chat.evaluate("window.pmView.state.doc.textBetween(0, window.pmView.state.doc.content.size, '\\n')")
    same = lambda a, b: re.sub(r"\s+", " ", a).strip() == re.sub(r"\s+", " ", b).strip()
    purl = lambda p: f"https://chatgpt.com/c/{p}" + ("?temporary-chat=true" if TOGGLE else "")  # a personalized conversation's URL

    # Consent: Next explains what's missing, then samples the battery from the dataset CSVs
    nxt.click(); expect(err).to_contain_text("Tick both boxes")  # the Prolific ID is optional
    sp.fill("#pid", "TEST123"); sp.check("#age"); sp.check("#agree"); nxt.click()
    expect(title).to_have_text("Your ChatGPT plan", timeout=10000)
    items = sp.evaluate("chrome.storage.local.get('piw').then(x => x.piw.data.battery.items)")
    ok([i["dataset"] for i in items] == (["sbb", "moral_judgment", "information_prioritization"] if BATTERY else [d[:-4] for d in CSVS]), "one prompt sampled per dataset, in order")
    if BATTERY: ok(items[1]["prompt_id"] in ("aita_002", "aita_005"), "a dataset with a prompt_id list is sampled only from that list")
    I = {i["dataset"]: n for n, i in enumerate(items)}
    rows = {d: {r["prompt_id"]: r for r in csv.DictReader(io.StringIO(get(f"{RAW}{d}.csv")))} for d in [i["dataset"] for i in items]}
    ok(all(rows[i["dataset"]][i["prompt_id"]]["prompt"].strip() == i["prompt"] for i in items), "sampled prompts match the CSV rows exactly")
    ok([i["dataset"] for i in items if "options" in i] == ["information_prioritization"] and len(items[I["information_prioritization"]]["options"]) == 8, "ranking options only for the prioritization dataset")

    # Plan: self-report with a link to the billing page
    nxt.click(); expect(err).to_contain_text("Choose your plan")
    expect(sp.locator(".cue")).to_have_count(1)  # "click here" points at the step's first link until one is clicked
    act("billing"); expect(chat).to_have_url("https://chatgpt.com/settings/billing")
    expect(sp.locator(".cue")).to_have_count(0)
    sp.select_option("#plan", "Go"); nxt.click()  # Free/Go: Think off, no model picker

    # Settings: Next lists what's wrong; "Do all" fixes it (clicks toggles, expands, Saves, opens Manage, waits)
    expect(title).to_have_text("ChatGPT settings & memory")
    blank = ctx.new_page(); blank.bring_to_front(); expect(nxt).to_be_disabled(timeout=5000)  # Next is off away from ChatGPT
    chat.bring_to_front(); expect(nxt).to_be_enabled(timeout=5000)
    nxt.click(); expect(err).to_contain_text("Enable memory is off", timeout=15000)
    act("all")
    expect(sp.locator("#tasks .ok")).to_have_count(4, timeout=30000)
    ok(S["mem"] is True and S["web"] is False, "toggles changed and saved on ChatGPT")
    nxt.click()

    # Profile card first: open new chat + insert into a real ProseMirror editor
    expect(title).to_have_text("What ChatGPT knows about you", timeout=15000)
    expect(sp.locator(".cue")).to_have_count(1)
    S["page"] = "composer"; act("newchat"); chat.wait_for_function("window.pmView", timeout=15000)
    expect(chat).to_have_url("https://chatgpt.com/")  # the profile card always uses a regular chat
    act("insert")
    ok(same(composer_text(), PROMPTS["traits"]), "prompt inserted into ProseMirror")
    load("https://chatgpt.com/c/traits", page="conv", user=PROMPTS["traits"], reply="Gender | unknown", generating=True)
    sp.check("#confirm"); nxt.click(); expect(err).to_have_text("Waiting for ChatGPT to finish responding.", timeout=8000)
    load("https://chatgpt.com/c/traits", generating=False)
    nxt.click(); expect(title).to_have_text("Follow-up (optional)", timeout=8000)

    # Follow-up: prompts are built from the selected traits
    expect(sp.locator(".cue")).to_have_count(0)
    nxt.click(); expect(err).to_contain_text("Choose an option")
    expect(sp.locator("label.check", has=sp.locator("input[value=done]"))).to_have_text("Yes, and I'd like to ask ChatGPT follow-up questions")
    sp.check("input[value=done]"); nxt.click(); expect(err).to_contain_text("Select the missing traits")
    sp.locator("details.dropdown summary").click()
    sp.check("input[value='race']"); sp.check("input[value='political orientation']")  # prompts follow card order
    expect(sp.locator("#traitsum")).to_have_text("Political orientation, Race/ethnicity")
    OPTS = ("\n\nPolitical orientation: left-leaning / moderate / right-leaning\nRace/ethnicity: White, Hispanic or Latino, Black or African American, Asian, "
            "Middle Eastern or North African, American Indian or Alaska Native, Native Hawaiian or Pacific Islander, Other (describe)")
    P1 = "For political orientation and race, don't pick a single answer — distribute 100 points across the options based on our history." + OPTS
    P2 = "Write a two-sentence sketch of a fictional character whose chat history with you is identical to mine. You must include the character's political orientation and race." + OPTS
    expect(sp.locator("#fuprompts pre").first).to_have_text(P1); expect(sp.locator("#fuprompts pre").nth(1)).to_have_text(P2)
    load("https://chatgpt.com/c/traits", page="conv", user=PROMPTS["traits"], reply="Gender | unknown")  # still on the profile-card chat
    expect(sp.locator("#status")).to_contain_text("Once ChatGPT has answered", timeout=8000)
    sp.check("#confirm"); nxt.click(); expect(err).to_contain_text("This is the profile-card chat", timeout=8000)
    load("https://chatgpt.com/", page="composer"); chat.wait_for_function("window.pmView", timeout=15000)
    act("p1"); ok(same(composer_text(), P1), "follow-up Prompt 1 inserted with traits")
    load("https://chatgpt.com/c/fu", page="conv", user=P1, reply="Left 60, moderate 30, right 10")
    expect(sp.locator("#status")).to_contain_text("Follow-up chat found", timeout=8000)
    sp.check("#confirm"); nxt.click()

    # Part 1: every prompt unpersonalized, in a new Temporary Chat (ranking question first where the dataset has options)
    WRONG_MINUS = ("Couldn't confirm Unpersonalized is selected. Open a new Unpersonalized Temporary Chat, or tick step 2 yourself if it is." if TOGGLE
                   else "Wrong kind of chat for this prompt. Open a new Temporary Chat.")
    expect(title).to_have_text("Part 1: Unpersonalized"); nxt.click()
    for i, it in enumerate(items):
        if "options" in it:
            expect(title).to_have_text("Your own priorities")
            expect(main).to_contain_text(it["options"][0])
            sp.bring_to_front(); sp.locator("ol.rank li").nth(0).drag_to(sp.locator("ol.rank li").nth(1)); nxt.click()
        expect(title).to_have_text(f"Unpersonalized · Prompt {i + 1} of {len(items)}", timeout=8000)
        if i > 0:  # saving the previous prompt opened this one's chat
            expect(chat).to_have_url("https://chatgpt.com/?temporary-chat=true"); expect(sp.locator('[data-act="newchat"].busy')).to_have_count(0, timeout=15000)
        if i == 0:  # the first Temporary Chat shows whether the account has the dropdown; the panel picks Unpersonalized
            S["page"] = "composer"; act("newchat"); expect(chat).to_have_url("https://chatgpt.com/?temporary-chat=true")
            expect(sp.locator('[data-act="newchat"]')).to_have_text(f"Open a new {'Unpersonalized ' if TOGGLE else ''}Temporary Chat", timeout=10000)
            if TOGGLE: expect(chat.locator("#pz")).to_have_text("Unpersonalized", timeout=10000)
            expect(sp.locator('[data-act="newchat"].busy')).to_have_count(0, timeout=10000)
            expect(sp.locator("label.check:has(#confirm)")).to_have_text("Think is off")
            expect(sp.locator("#pickbox")).to_have_count(1 if TOGGLE else 0)  # the dropdown is its own step, ticked by the helper
            expect(sp.locator("details.where img")).to_have_attribute("src", "assets/free-go-think-off.jpg")
        markup = {1: "turns", 2: "legacy"}.get(i)
        load(f"https://chatgpt.com/c/t{i}", page="conv", user=it["prompt"], reply=f"{i} P-", markup=markup, pz="Personalized")
        sp.check("#confirm")
        nxt.click(); expect(err).to_have_text(WRONG_MINUS, timeout=8000)
        if TOGGLE:  # a Temporary Chat with the dropdown on Personalized is wrong too
            load("https://chatgpt.com/?temporary-chat=true", pz="Personalized"); nxt.click(); expect(err).to_have_text(WRONG_MINUS, timeout=8000)
        load("https://chatgpt.com/?temporary-chat=true", pz="Unpersonalized")
        if TOGGLE: expect(sp.locator("#pickbox")).to_be_checked(timeout=8000)
        if i == 0: expect(nxt).to_have_class(re.compile("ready"), timeout=8000); expect(sp.locator("#status")).to_contain_text("ChatGPT has responded")
        S["page"] = "composer"; nxt.click()

    # Part 2: the same prompts personalized: a Temporary Chat with the dropdown on Personalized, or a regular chat
    expect(title).to_have_text("Part 2: Personalized", timeout=8000)
    expect(main.locator("video")).to_have_count(1 if TOGGLE else 0)
    nxt.click()
    for i, it in enumerate(items):
        expect(title).to_have_text(f"Personalized · Prompt {i + 1} of {len(items)}", timeout=8000)
        if i > 0:
            expect(chat).to_have_url("https://chatgpt.com/?temporary-chat=true" if TOGGLE else "https://chatgpt.com/"); expect(sp.locator('[data-act="newchat"].busy')).to_have_count(0, timeout=15000)
        if i == 0:
            if TOGGLE:
                expect(sp.locator("label.check:has(#confirm)")).to_have_text("Think is off")
                expect(sp.locator("details.where video").first).to_have_attribute("src", "assets/personalized-guide.mp4")
                expect(sp.locator("details.where img")).to_have_attribute("src", "assets/free-go-think-off.jpg")
            else:
                expect(sp.locator("label.check").first).to_have_text("Chat is selected and Think is off")
                expect(sp.locator("details.where video")).to_have_attribute("src", "assets/free-go-chat.webm")
        load(purl(f"r{i}"), page="conv", user=it["prompt"], reply=f"{i} P+", markup=None, pz="Personalized", links='<a href="https://example.com">src</a>' if i == 1 else "")
        if i == 0:
            nxt.click(); expect(err).to_contain_text("Tick the box", timeout=8000)
            load("https://chatgpt.com/?temporary-chat=true", pz="Unpersonalized"); sp.check("#confirm")
            nxt.click(); expect(err).to_have_text("Couldn't confirm Personalized is selected. Open a new Personalized Temporary Chat, or tick step 2 yourself if it is."
                                                  if TOGGLE else "Wrong kind of chat for this prompt. Open a new regular chat.", timeout=8000)
            if TOGGLE: expect(sp.locator("#pickbox")).to_be_enabled()  # after that message the participant may tick it themselves
            if TOGGLE:  # the choice only shows after a reload: the panel reloads and finds it
                S.update(page="composer", finicky=True); act("newchat"); expect(chat.locator("#pz")).to_have_text("Personalized", timeout=20000)
                expect(sp.locator('[data-act="newchat"].busy')).to_have_count(0, timeout=20000); ok(not err.is_visible(), "finicky dropdown: reload shows the choice, no error")
                S.update(page="conv", finicky=False)
            load(purl(f"r{i}"), pz="Personalized")
        if i == len(items) - 1:  # reused chat → Next explains; a pasted response is saved on Next instead
            load(purl("r0")); sp.check("#confirm")
            expect(nxt).not_to_have_class(re.compile("ready"))
            nxt.click(); expect(err).to_contain_text("This chat was already used", timeout=8000)
            sp.locator("details.manual summary").click(); sp.fill("#manualresp", "pasted answer"); nxt.click(); continue
        sp.check("#confirm"); S["page"] = "composer"; nxt.click()
    expect(title).to_have_text("Review & export", timeout=8000)

    # Not-on-ChatGPT banner
    blank.bring_to_front()
    expect(sp.locator("#banner")).to_be_visible(timeout=5000)
    chat.bring_to_front(); expect(sp.locator("#banner")).to_be_hidden(timeout=5000)

    # Zoom buttons scale the panel and persist
    sp.click("#zoom-in"); sp.click("#zoom-in")
    ok(sp.evaluate("getComputedStyle(document.querySelector('main')).zoom") == "1.2" and sp.evaluate("chrome.storage.local.get('piw').then(x => x.piw.zoom)") == 1.2, "zoom applied and saved")
    sp.click("#zoom-out")

    expect(main).to_contain_text("go back to the Prolific survey")
    with sp.expect_download() as dl: sp.click("#dl")
    expect(sp.locator("#saved")).to_contain_text("Downloaded piw_TEST123_")
    data = json.load(open(dl.value.path()))
    R = data["responses"]
    ok(data["participant_id"] == "TEST123" and data["account"]["plan"] == "Go", "participant + plan")
    ok(data["settings"]["memory_enabled"]["observed"] is True and data["settings"]["web_search"]["observed"] is False, "settings observed")
    ok(data["settings"]["initial"] == {"memory_enabled": False, "web_search": True} and data["account"]["personalization_toggle"] == TOGGLE, "initial settings and dropdown presence recorded")
    ok(data["memory_overview"]["text"].endswith("Likes cats."), "memory overview captured above Dive Deeper")
    ok(len(R) == 2 * len(items) + 1, f"{2 * len(items)} battery records + profile card")
    first = R[f"{items[0]['prompt_id']}_P-"]
    ok(first["condition"] == "P-" and first["temporary_chat_observed"] and first["personalized_observed"] is False and not first["flags"] and first["dataset"] == items[0]["dataset"], "P- record (unpersonalized)")
    ok(first["user_message_sent"] == items[0]["prompt"] and R["traits"]["user_message_sent"] == PROMPTS["traits"], "2026 layout: exact user text (no 'Show more', not the sidebar title)")
    plus = R[f"{items[0]['prompt_id']}_P+"]
    ok(plus["condition"] == "P+" and plus["temporary_chat_observed"] is TOGGLE and plus["personalized_observed"] == (True if TOGGLE else None) and not plus["flags"], "P+ record (personalized)")
    ok(R[f"{items[1]['prompt_id']}_P-"]["response_text"] == "1 P-", "fallback turn markup read (You said:/ChatGPT said: stripped)")
    ok(R[f"{items[1]['prompt_id']}_P+"]["flags"] == ["web_links"], "links in a response are flagged")
    last = R[f"{items[-1]['prompt_id']}_P+"]
    ok(last["source"] == "manual_paste" and last["response_text"] == "pasted answer" and last["flags"] == ["manual_entry"], "pasted response saved on Next and flagged")
    ix = items[I["information_prioritization"]]; rk = data["rankings"][ix["prompt_id"]]
    ok(rk["order"][1] == ix["options"][0] and rk["question"].startswith("Imagine this situation"), "ranking saved with its question")
    f = data["followup"]
    ok(f["source"] == "auto" and f["conversation"][1]["text"].startswith("Left 60") and f["choice"] == "done" and f["missing_traits"] == ["political orientation", "race"] and f["prompts"] == [P1, P2] and not f["flags"], "follow-up record")
    ok(not errors, f"no page errors {errors}")

    # Restore the settings the study changed
    expect(sp.locator("details.checklist")).not_to_have_attribute("open", "")  # complete: the checklist starts collapsed
    act("restore"); expect(err).to_have_text("Your original settings are back.", timeout=20000)
    ok(S["mem"] is False and S["web"] is True, "original settings restored on ChatGPT")

    sp.locator("details.manual summary").last.click(); act("wipe")
    expect(title).to_have_text("Consent")
    ok(sp.evaluate("chrome.storage.local.get().then(x => Object.keys(x).length)") == 0, "delete wipes storage")
    ctx.close()
