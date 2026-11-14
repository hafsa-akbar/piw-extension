"""End-to-end test of the extension against a mocked chatgpt.com (does NOT test the live ChatGPT DOM).

The mock composer is a real ProseMirror editor (loaded from esm.sh, so this needs network access).
The dataset CSVs are read from the public GitHub repo; battery.json is simulated (missing, or present with --battery).
Usage: pip install playwright && python3 -m playwright install chromium
       python3 scripts/test_e2e.py [--battery] [--toggle]
--toggle simulates an account with the Personalized/Unpersonalized dropdown in Temporary Chats.
"""
import csv, html, io, json, re, subprocess, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

EXT = str(Path(__file__).resolve().parent.parent)

RAW = "https://raw.githubusercontent.com/hafsa-akbar/llm-personalization-ecological-validity/main/datasets/"
API = "https://api.github.com/repos/hafsa-akbar/llm-personalization-ecological-validity/contents/datasets"
BATTERY = "--battery" in sys.argv  # becomes a battery.json pinning one dataset to two of its prompt_ids
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
      let webOn = {str(S['web']).lower()};
      const flip = (b) => {{ b.setAttribute('aria-checked', b.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); if (b.closest('#extra')) webOn = b.getAttribute('aria-checked') === 'true'; save.disabled = false; }};
      // Like ChatGPT: the expander opens on a pointer press (a plain click does nothing), and Save re-renders the page, collapsing it again.
      more.onpointerdown = () => {{ extra.innerHTML = '<div><span>Web search</span><button role="switch" aria-checked="' + webOn + '" onclick="flip(this)"></button></div>'; }};
      save.onclick = () => {{ const body = JSON.stringify([...document.querySelectorAll('[role=switch]')].map(s => [s.parentElement.innerText, s.getAttribute('aria-checked')])); fetch('/save', {{ method: 'POST', body }}); extra.innerHTML = ''; }};
      manage.onclick = () => setTimeout(() => document.body.insertAdjacentHTML('beforeend',
        '<div role="dialog"><h2>Memory overview</h2><p>Lives in Boston.</p><p>Likes cats.</p><h3>Dive Deeper</h3><p>Other stuff</p></div>'), 1500);
    </script>"""

BUBBLE = lambda: f'style="background: {"rgb(33, 61, 110)" if S["pz"] == "Personalized" else "rgb(48, 48, 48)"}"'  # user bubble: blue = personalized

def conv_html():
    sidebar = f'<nav aria-label="Chat history"><a href="/c/abc"><span>{html.escape(S["user"][:60])}</span></a></nav>'
    if S.get("markup") is None:  # ChatGPT's 2026 layout, copied from a real page's structure; a second turn when user2 is set
        def turn(n, user, reply, state, links=""):
            return (f'<div data-turn-key="m{n + 1}"><div data-content-search-turn-key="fallback-turn-{n}">'
                    f'<div class="group flex flex-col" data-talvt-turn-state="{state}">'
                    f'<div data-chatgpt-search-unit-key="fallback-turn-{n}:0:user"><div data-user-message-bubble="true" class="bg-user-message" {BUBBLE()}>'
                    f'<div class="overflow-hidden" style="max-height:3lh"><div><div class="text-size-chat whitespace-pre-wrap" style="white-space:pre-wrap">{html.escape(user)}</div></div></div>'
                    f'<button>Show more</button></div></div>'
                    f'<div data-chatgpt-search-unit-key="fallback-turn-{n}:1:assistant"><div class="markdown"><p>{reply}</p>{links}</div></div>'
                    f'</div></div></div>')
        state = "streaming" if S.get("generating") else "complete"
        turns = turn(0, S["user"], S["reply"], "complete" if S.get("user2") else state, S.get("links", ""))
        if S.get("user2"): turns += turn(1, S["user2"], S["reply2"], state)
        return f'{sidebar}<main><div role="region" aria-label="Conversation">{turns}</div></main>{COMPOSER}'  # real conversation pages keep a composer
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

ALLOC = {}  # the mocked allocator's category → prompt_id mapping (filled once the CSVs are read)
def supa(r):
    if r.request.url.endswith("/allocate"):
        if S.get("alloc_fail"): return r.fulfill(status=500, json={"error": "boom"})
        S["alloc_pid"] = json.loads(r.request.post_data)["participant_key"]
        return r.fulfill(json={"stage_id": "pilot_60", "assignments": ALLOC, "exhausted": [], "existing": False})
    S["submitted"] = json.loads(r.request.post_data); S["submits"] = S.get("submits", 0) + 1
    r.fulfill(json={"updated": len(ALLOC), "total": len(ALLOC)})

with sync_playwright() as pw:
    http = pw.request.new_context()
    get = lambda url: http.get(url).text().lstrip("\ufeff")
    CSVS = sorted(f["name"] for f in json.loads(get(API)) if f["name"].endswith(".csv"))
    PINNED = CSVS[0][:-4]  # a dataset that exists right now, read from the repo listing
    if BATTERY:  # limit that dataset to two of its current prompt_ids
        IDS = [r["prompt_id"] for r in csv.DictReader(io.StringIO(get(f"{RAW}{PINNED}.csv")))][:2]
        BATTERY = {"datasets": ["sbb", {PINNED: IDS}, "value_alignment"]}
    ctx = pw.chromium.launch_persistent_context(tempfile.mkdtemp(), headless=True, channel="chromium",
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
    ctx.route("https://chatgpt.com/**", route)
    ctx.route("https://raw.githubusercontent.com/**/battery.json", route)
    ctx.route("https://frgzptcagazvqrfaxeuz.supabase.co/**", supa)
    for name in (["sbb.csv", f"{PINNED}.csv", "value_alignment.csv"] if BATTERY else CSVS):  # allocate the last eligible prompt of each dataset
        ids_ = IDS if BATTERY and name == f"{PINNED}.csv" else [r_["prompt_id"] for r_ in csv.DictReader(io.StringIO(get(RAW + name))) if r_.get("prompt", "").strip()]
        ALLOC[name[:-4]] = ids_[-1]
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

    # Consent: Next explains what's missing; prompts come from the allocator, never a local fallback
    nxt.click(); expect(err).to_contain_text("Tick both boxes")  # the Prolific ID stays optional
    sp.check("#age"); sp.check("#agree"); S["alloc_fail"] = True; nxt.click()  # an empty PID is fine; the allocator is what fails here
    expect(err).to_contain_text("assignment", timeout=10000)
    ok(sp.evaluate("chrome.storage.local.get('piw').then(x => x.piw?.data.battery ?? null)") is None, "failed allocation leaves no untracked local battery")
    sp.fill("#pid", "TEST123"); S["alloc_fail"] = False; nxt.click()
    expect(title).to_have_text("Your ChatGPT plan", timeout=10000)
    KEY = sp.evaluate("chrome.storage.local.get('piw').then(x => x.piw.data.participant_key)")
    ok(S.get("alloc_pid") == KEY and re.fullmatch(r"[0-9a-f-]{36}", KEY or "") and KEY != "TEST123", "allocator receives a generated key, never the Prolific ID")
    items = sp.evaluate("chrome.storage.local.get('piw').then(x => x.piw.data.battery.items)")
    ok([i["dataset"] for i in items] == (["sbb", PINNED, "value_alignment"] if BATTERY else [d[:-4] for d in CSVS]), "one prompt sampled per dataset, in order")
    if BATTERY: ok(items[1]["prompt_id"] in IDS, "a dataset with a prompt_id list is sampled only from that list")
    I = {i["dataset"]: n for n, i in enumerate(items)}
    rows = {d: {r["prompt_id"]: r for r in csv.DictReader(io.StringIO(get(f"{RAW}{d}.csv")))} for d in [i["dataset"] for i in items]}
    row = lambda i: rows[i["dataset"]][i["prompt_id"]]
    ok(all((row(i).get("prompt_short") or row(i)["prompt"]).strip() == i["prompt"] for i in items), "sampled prompts match the CSV rows exactly (prompt_short when present)")
    ok([i["dataset"] for i in items if "choice" in i] == ["value_alignment"], "pick-one question only for the value_alignment dataset")
    ok(all(i.get("follow_up") == ((row(i).get("follow_up") or "").strip() or None) for i in items), "follow_up carried from the CSV onto the sampled item")
    ok(all(i["prompt_id"] == ALLOC[i["dataset"]] for i in items), "allocator drives prompt selection")
    ca = items[I["value_alignment"]]["choice"]
    ok([o["label"] for o in ca["options"]] == [chr(65 + j) for j in range(len(ca["options"]))] and len(ca["options"]) >= 2
       and ca["question"] == "Which response do you prefer?" and ca["options"][0]["text"] in ca["text"] and all(o["code"] for o in ca["options"]), "participant_prompt parsed into lettered options with codes")

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
    sp.locator("details.manual summary").click()
    expect(sp.locator("#manualmem")).to_have_count(0)  # no paste box for the Memory Overview: only the full auto-capture
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
    sp.check("input[value='race/ethnicity']"); sp.check("input[value='political orientation']")  # prompts follow card order
    expect(sp.locator("#traitsum")).to_have_text("Political orientation, Race/ethnicity")
    OPTS = ("\n\nPolitical orientation: very liberal / liberal / moderate / conservative / very conservative\nRace and/or ethnicity (one or more): American Indian or Alaska Native / Asian / "
            "Black or African American / Hispanic or Latino / Middle Eastern or North African / Native Hawaiian or Pacific Islander / White")
    P1 = "For political orientation and race/ethnicity, don't pick a single answer — distribute 100 points across the options based on our history." + OPTS
    P2 = "Write a two-sentence sketch of a fictional character whose chat history with you is identical to mine. You must include the character's political orientation and race/ethnicity." + OPTS
    expect(sp.locator("#fuprompts pre").first).to_have_text(P1); expect(sp.locator("#fuprompts pre").nth(1)).to_have_text(P2)
    load("https://chatgpt.com/c/traits", page="conv", user=PROMPTS["traits"], reply="Gender | unknown")  # still on the profile-card chat
    expect(sp.locator("#status")).to_contain_text("Once ChatGPT has answered", timeout=8000)
    sp.check("#confirm"); nxt.click(); expect(err).to_contain_text("This is the profile-card chat", timeout=8000)
    load("https://chatgpt.com/", page="composer"); chat.wait_for_function("window.pmView", timeout=15000)
    act("p1"); ok(same(composer_text(), P1), "follow-up Prompt 1 inserted with traits")
    load("https://chatgpt.com/c/fu", page="conv", user=P1, reply="Liberal 60, moderate 30, conservative 10")
    expect(sp.locator("#status")).to_contain_text("Follow-up chat found", timeout=8000)
    sp.check("#confirm"); nxt.click()

    # Part 1: every prompt unpersonalized, in a new Temporary Chat (pick-one question first where the dataset has one)
    WRONG_MINUS = ("Couldn't confirm Unpersonalized is selected. Open a new Unpersonalized Temporary Chat, or tick step 2 yourself if it is." if TOGGLE
                   else "Wrong kind of chat for this prompt. Open a new Temporary Chat.")
    expect(title).to_have_text("Part 1: Unpersonalized"); nxt.click()
    for i, it in enumerate(items):
        if "choice" in it:
            expect(title).to_have_text("Your preference")
            expect(main).to_contain_text("Please read the options carefully")
            expect(main).to_contain_text(it["choice"]["options"][-1]["text"])
            sp.bring_to_front(); nxt.click(); expect(err).to_contain_text("at least 1 minute")  # dwell gate before anything else
            sp.evaluate("ui.choiceAt -= 60000")  # a minute passes
            nxt.click(); expect(err).to_have_text("Pick one response.")
            sp.locator("label.option").nth(1).click(); nxt.click()
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
        fu = (it.get("follow_up") or "").strip()
        if fu:  # the follow-up continues in the same chat: no new-chat link or confirm box, wrong chat rejected, sent verbatim
            expect(title).to_have_text(f"Unpersonalized · Prompt {i + 1} of {len(items)} — follow-up", timeout=8000)
            expect(sp.locator('[data-act="newchat"]')).to_have_count(0); expect(sp.locator("#confirm")).to_have_count(0)
            load("https://chatgpt.com/?temporary-chat=true", page="conv", user=fu, reply="wrong chat")
            nxt.click(); expect(err).to_contain_text("isn't the chat where you sent the prompt", timeout=8000)
            load("https://chatgpt.com/?temporary-chat=true", user=it["prompt"], reply=f"{i} P-")
            act("insert"); ok(same(composer_text(), fu), "follow-up inserted verbatim into the same chat")
            load("https://chatgpt.com/?temporary-chat=true", user2=fu, reply2=f"{i} fu P-", generating=True)
            nxt.click(); expect(err).to_have_text("Waiting for ChatGPT to finish responding.", timeout=8000)
            load("https://chatgpt.com/?temporary-chat=true", generating=False)
            expect(nxt).to_have_class(re.compile("ready"), timeout=8000)
            S.update(page="composer", user2=None); nxt.click()
            # Discarding the main response also discards its follow-up record, then both are re-captured
            expect(sp.locator('[data-act="newchat"].busy')).to_have_count(0, timeout=15000)
            sp.click("#back"); sp.click("#back")
            expect(title).to_have_text(f"Unpersonalized · Prompt {i + 1} of {len(items)}", timeout=8000)
            act("redo"); expect(sp.locator('[data-act="redo"]')).to_have_count(0, timeout=8000)
            ok(sp.evaluate(f"chrome.storage.local.get('piw').then(x => Object.keys(x.piw.data.responses).filter(k => k.startsWith('{it['prompt_id']}_')).length)") == 0,
               "redo on the main response discards its follow-up record too")
            load("https://chatgpt.com/?temporary-chat=true", page="conv", user=it["prompt"], reply=f"{i} P- redo")
            sp.check("#confirm"); nxt.click()
            expect(title).to_have_text(f"Unpersonalized · Prompt {i + 1} of {len(items)} — follow-up", timeout=8000)
            load("https://chatgpt.com/?temporary-chat=true", user2=fu, reply2=f"{i} fu P-")
            expect(nxt).to_have_class(re.compile("ready"), timeout=8000)
            S.update(page="composer", user2=None); nxt.click()

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
        fu = (it.get("follow_up") or "").strip()
        if fu:
            expect(title).to_have_text(f"Personalized · Prompt {i + 1} of {len(items)} — follow-up", timeout=8000)
            load(purl(f"r{i}"), page="conv", user2=fu, reply2=f"{i} fu P+")
            expect(nxt).to_have_class(re.compile("ready"), timeout=8000)
            S.update(page="composer", user2=None); nxt.click()
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
    v = subprocess.run(["node", EXT + "/scripts/verify.js", str(dl.value.path())], capture_output=True, text=True)
    ok(v.returncode == 0 and ": VALID" in v.stdout, "integrity signature verifies")
    R = data["responses"]
    ok(data["participant_id"] == "TEST123" and data["account"]["plan"] == "Go", "participant + plan")
    ok(data["settings"]["memory_enabled"]["observed"] is True and data["settings"]["web_search"]["observed"] is False, "settings observed")
    ok(data["settings"]["initial"] == {"memory_enabled": False, "web_search": True} and data["account"]["personalization_toggle"] == TOGGLE, "initial settings and dropdown presence recorded")
    ok(data["memory_overview"]["text"].endswith("Likes cats."), "memory overview captured above Dive Deeper")
    n_fu = sum(1 for i_ in items if i_.get("follow_up"))
    ok(n_fu == (0 if BATTERY else 1), "exactly the recommendation_steering item has a follow_up")
    ok(len(R) == 2 * len(items) + 1 + 2 * n_fu, f"{2 * len(items)} battery records + profile card + {2 * n_fu} follow-up records")
    first = R[f"{items[0]['prompt_id']}_P-"]
    ok(first["condition"] == "P-" and first["temporary_chat_observed"] and first["personalized_observed"] is False and not first["flags"] and first["dataset"] == items[0]["dataset"], "P- record (unpersonalized)")
    ok(first["user_message_sent"] == items[0]["prompt"] and R["traits"]["user_message_sent"] == PROMPTS["traits"], "2026 layout: exact user text (no 'Show more', not the sidebar title)")
    plus = R[f"{items[0]['prompt_id']}_P+"]
    ok(plus["condition"] == "P+" and plus["temporary_chat_observed"] is TOGGLE and plus["personalized_observed"] == (True if TOGGLE else None) and not plus["flags"], "P+ record (personalized)")
    ok(R[f"{items[1]['prompt_id']}_P-"]["response_text"] == "1 P-", "fallback turn markup read (You said:/ChatGPT said: stripped)")
    ok(R[f"{items[1]['prompt_id']}_P+"]["flags"] == ["web_links"], "links in a response are flagged")
    last = R[f"{items[-1]['prompt_id']}_P+"]
    ok(last["source"] == "manual_paste" and last["response_text"] == "pasted answer" and last["flags"] == ["manual_entry"], "pasted response saved on Next and flagged")
    ix = items[I["value_alignment"]]; ch = data["choices"][ix["prompt_id"]]; B = ix["choice"]["options"][1]
    ok(ch["choice"] == "B" and ch["text"] == B["text"] and ch["code"] == B["code"] and ch["question"].startswith("Imagine you asked"), "pick saved with its question and code")
    if n_fu:
        fit = next(i_ for i_ in items if i_.get("follow_up")); fi = items.index(fit)
        fm, fr = R[f"{fit['prompt_id']}_P-"], R[f"{fit['prompt_id']}_P-_followup"]
        ok(fr["condition"] == "P-" and fr["prompt"] == fit["follow_up"] and fr["user_message_sent"] == fit["follow_up"]
           and fr["response_text"] == f"{fi} fu P-" and fr["conversation_url"] == fm["conversation_url"], "P- follow-up record in the same conversation")
        ok(R[f"{fit['prompt_id']}_P+_followup"]["response_text"] == f"{fi} fu P+", "P+ follow-up record")
    f = data["followup"]
    ok(f["source"] == "auto" and f["conversation"][1]["text"].startswith("Liberal 60") and f["choice"] == "done" and f["missing_traits"] == ["political orientation", "race/ethnicity"] and f["prompts"] == [P1, P2] and not f["flags"], "follow-up record")
    ok(data["battery"]["allocation"]["stage_id"] == "pilot_60" and data["participant_key"] == KEY, "allocation metadata and participant key exported")
    ok(S.get("submitted") == {"participant_key": KEY, "stage_id": "pilot_60"} and S.get("submits") == 1, "submit notified once after the download, keyed by the generated key")
    with sp.expect_download(): sp.click("#dl")  # repeated download re-notifies; idempotency is server-side
    for _ in range(50):
        if S.get("submits", 0) >= 2: break
        sp.wait_for_timeout(100)
    ok(S.get("submits") == 2, "repeated download re-notifies submit")
    ok(not errors, f"no page errors {errors}")

    # Restore the settings the study changed
    expect(sp.locator("details.checklist")).not_to_have_attribute("open", "")  # complete: the checklist starts collapsed
    act("restore"); expect(err).to_have_text("Your original settings are back.", timeout=20000)
    ok(S["mem"] is False and S["web"] is True, "original settings restored on ChatGPT")

    sp.locator("details.manual summary").last.click(); act("wipe")
    expect(title).to_have_text("Consent")
    ok(sp.evaluate("chrome.storage.local.get().then(x => Object.keys(x).length)") == 0, "delete wipes storage")
    ctx.close()
