// Side panel: walks the participant through the study and stores results in chrome.storage.local.

const CHATGPT = "https://chatgpt.com/";
const SETTINGS_URL = CHATGPT + "settings/personalization";
const BILLING_URL = CHATGPT + "settings/billing";
const TEMP_URL = CHATGPT + "?temporary-chat=true";
const POLL_MS = 1500;

// Things the extension cannot observe reliably; exported so analysts know they rest on the participant.
const UNVERIFIED = [
  "Whether web search was actually used for a response (only links in the response are counted)",
  "Chat mode (not Work), and Instant thinking + GPT-6 (Plus/Pro/Team/Other) or Think off (Free/Go): confirmed by the participant per prompt, not observed",
  "Settings remaining unchanged after the settings check",
];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COPY_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

let state;
let timer = null;
let busy = 0; // number of actions / Next checks running; live updates pause meanwhile
let checking = false; // Next is running its checks
const freshUi = () => ({ confirmed: false, pickManual: false, pickSelf: false, clicked: false, conv: null, lastText: null, discarded: null, settings: null, followup: null, traits: null, pick: null });
let ui = freshUi();

const newData = () => ({
  schema_version: 6,
  extension_version: chrome.runtime.getManifest().version,
  participant_id: "",
  consent: null,
  started_at: null,
  completed_at: null,
  battery: null, // sampled prompts: { source, sampled_at, items: [{ dataset, prompt_id, prompt, choice? }] }
  account: null,
  settings: null,
  memory_overview: null,
  choices: {}, // participant's pick per prompt_id: { dataset, question, choice, text, code, saved_at }
  responses: {},
  followup: null,
  unverified: UNVERIFIED,
});

const D = () => state.data;
const steps = () => buildSteps(D().battery?.items);
const step = () => steps()[state.step];
const item = (i) => D().battery.items[i];
const promptOf = (s) => (s.capture.prompt ? PROMPTS[s.capture.prompt] : s.capture.followup ? item(s.capture.item).follow_up : item(s.capture.item).prompt);
const save = () => chrome.storage.local.set({ piw: state });
const update = async (fn) => { fn(D()); await save(); render(); };

// The kinds of chat a step can need. `pick` = the dropdown choice; `blue` = blue send button; `ok` checks a read conversation.
const CHATS = {
  regular: { name: "regular chat", url: CHATGPT, blue: true, ok: (c) => !c.temporary },
  temporary: { name: "Temporary Chat", url: TEMP_URL, ok: (c) => c.temporary },
  personalized: { name: "Personalized Temporary Chat", url: TEMP_URL, pick: true, blue: true, ok: (c) => c.personalized === true },
  unpersonalized: { name: "Unpersonalized Temporary Chat", url: TEMP_URL, pick: false, ok: (c) => c.personalized === false },
};
// Accounts with the Personalized/Unpersonalized dropdown run P+ and P− in a Temporary Chat; the others use a regular chat
// for P+ and a Temporary Chat for P−. The profile card and follow-up always use a regular chat. Whether the account has
// the dropdown is unknown until the first Temporary Chat is opened (see newChat).
const hasToggle = () => D().account.personalization_toggle;
const chatOf = (personalized) => CHATS[hasToggle() ? (personalized ? "personalized" : "unpersonalized") : personalized ? "regular" : "temporary"];
const chatFor = (s) => (s.capture.prompt ? CHATS.regular : chatOf(s.capture.personalized));

// Tamper-evidence for the downloaded file: HMAC over canonical JSON (sorted keys, no whitespace), checked by
// scripts/verify.js (keep canon/SIG_KEY in sync). Deters hand-editing only — the key ships with the extension.
const SIG_KEY = "0f4d3a579a13ac7277591e41c8bc7f6c6e20a62e81f402036f00da6c93c563b5";
const canon = (v) => Array.isArray(v) ? `[${v.map((x) => canon(x === undefined ? null : x)).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  : JSON.stringify(v);
async function hmac(text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIG_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- ChatGPT tab ----------

async function chatTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith(CHATGPT) ? tab : null;
}

async function run(fn, ...args) {
  const tab = await chatTab();
  if (!tab) throw new Error("Switch to your ChatGPT tab first.");
  const target = { tabId: tab.id };
  await chrome.scripting.executeScript({ target, files: ["chatgpt.js"] });
  const [{ result }] = await chrome.scripting.executeScript({
    target,
    args: [fn, args],
    func: async (fn, args) => {
      try { return { value: await globalThis.PIW[fn](...args) }; } catch (e) { return { error: String(e) }; }
    },
  });
  if (!result || "error" in result) throw new Error(`Couldn't read the ChatGPT page (${result?.error ?? "no result"}). Try reloading the ChatGPT tab.`);
  return result.value;
}

// Navigates the ChatGPT tab (opening one if needed) and waits for it to load.
async function openChat(url) {
  const tab = (await chatTab()) || (await chrome.tabs.query({ url: CHATGPT + "*", currentWindow: true }))[0];
  let id = tab?.id;
  const loaded = new Promise((resolve) => {
    const done = (tabId, info) => { if ((id === undefined || tabId === id) && info.status === "complete") { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(resolve, 15000);
  });
  if (tab) await chrome.tabs.update(id, { url, active: true });
  else id = (await chrome.tabs.create({ url })).id;
  await loaded;
  await sleep(800); // let ChatGPT's app render
}

async function newChat(chat) {
  await openChat(chat.url);
  if (chat.url === TEMP_URL && hasToggle() === undefined) {
    const found = (await until(() => run("readPersonalized"), (v) => v != null, 4000)) != null;
    await update((d) => { d.account.personalization_toggle = found; });
    if (found) chat = CHATS.unpersonalized;
  }
  if (chat.pick === undefined) return;
  // The dropdown sometimes doesn't show a choice until the page is reloaded, so if it didn't stick, reload and read it again.
  if ((await until(() => run("setPersonalized", chat.pick), (v) => v != null)) === chat.pick) return;
  await openChat(chat.url);
  if ((await until(() => run("readPersonalized"), (v) => v === chat.pick, 4000)) === chat.pick) return;
  ui.pickManual = true;
  renderPick();
  throw new Error(`Couldn't select ${chat.pick ? "Personalized" : "Unpersonalized"} at the top right. Choose it yourself before sending.`);
}

// Polls get() until test(value) passes or time runs out; returns the last value.
async function until(get, test, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await get(); if (test(v)) return v; } catch {}
    if (Date.now() > end) return v;
    await sleep(600);
  }
}

// Shows the banner off ChatGPT and disables Next on steps that need to read it.
async function refreshBanner() {
  const s = step(), off = !(await chatTab());
  $("#banner").hidden = s.id === "consent" || !off;
  if (!checking) $("#next").disabled = off && (["setup", "followup"].includes(s.id) || (s.capture && !getRecord(s)));
}

// ---------- Rendering ----------

const view = (s) => VIEWS[s.capture ? "capture" : s.part ? "intro" : s.choice !== undefined ? "choice" : s.id];
const mark = { ok: "✓", bad: "✗", wait: "○" };
const line = (status, html) => `<li><span class="dot ${status}">${mark[status]}</span><span>${html}</span></li>`;
const act = (name, label) => `<a class="act" data-act="${name}">${label}</a>`;
const promptBlock = (text) => `<div class="prompt"><button class="copy" data-copy="${esc(text)}" title="Copy">${COPY_ICON}</button><pre>${esc(text)}</pre></div>`;
const sendIcon = (chat) => `the <svg class="send" viewBox="0 0 24 24" aria-label="Send"><circle cx="12" cy="12" r="12" fill="${chat.blue ? "#4d81ef" : "#8f8f8f"}"/>
  <path d="M12 17V7m-4.5 4.5L12 7l4.5 4.5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> button`;
const guideVideo = (personalized) => `<video class="shot" src="assets/${personalized ? "" : "un"}personalized-guide.mp4" autoplay loop muted playsinline></video>`;
// The dropdown step's checkbox: ticked by the helper when the page shows the right choice. The participant can tick it
// only after the helper said it couldn't select or confirm the choice (ui.pickManual).
function renderPick() {
  const box = $("#pick"), chat = chatFor(step());
  if (!box) return;
  const auto = !!ui.conv && chat.ok(ui.conv);
  box.innerHTML = `<label class="check"><input type="checkbox" id="pickbox" ${auto || ui.pickSelf ? "checked" : ""} ${ui.pickManual ? "" : "disabled"}>
    <span><b>${chat.pick ? "Personalized" : "Unpersonalized"}</b> is selected in the Temporary Chat</span></label>`;
  $("#pickbox").onchange = (e) => (ui.pickSelf = e.target.checked);
}
// Free and Go have a Think button (left off) and no model picker; paid plans pick Instant thinking and GPT-6.
const basicPlan = () => ["Free", "Go"].includes(D().account?.plan);
function confirmBox(chat) {
  const basic = basicPlan();
  const model = basic ? "<b>Think</b> is off" : "Thinking effort is <b><u>Instant</u></b> and the model is <b><u>GPT-6</u></b>";
  const text = chat === CHATS.regular ? `<b>Chat</b> is selected${basic ? " and " : ", "}${model}` : model;
  const guide = chat === CHATS.regular ? `<video src="assets/${basic ? "free-go" : "paid"}-chat.webm" autoplay loop muted playsinline></video>`
    : basic ? `<img src="assets/free-go-think-off.jpg" alt="The Think button in ChatGPT's message box, left off">`
    : `<video src="assets/paid-model.webm" autoplay loop muted playsinline></video>`;
  return `
    <label class="check"><input type="checkbox" id="confirm" ${ui.confirmed ? "checked" : ""}> <span>${text}</span></label>
    <details class="where"><summary>Show me how</summary>${guide}</details>`;
}
const bindConfirm = () => { const c = $("#confirm"); if (c) c.onchange = () => (ui.confirmed = c.checked); };
const manual = (html) => `<details class="manual"><summary>Not working? Manual steps</summary>${html}
  <p class="muted">Something broken? ${act("diagnose", "Copy diagnostic info")} and send it to the research team (it contains no messages or memory text).</p></details>`;

function render() {
  clearInterval(timer);
  setErrors();
  const all = steps(), s = step(), v = view(s);
  $("#title").textContent = s.title;
  $("#progress-label").textContent = `Step ${state.step + 1} of ${all.length}`;
  $("#progress").style.width = `${(100 * state.step) / (all.length - 1)}%`;
  $("#view").innerHTML = v.html(s);
  bind($("#view"));
  v.bind?.(s);
  cue();
  $("#back").style.visibility = state.step === 0 ? "hidden" : "visible";
  $("#next").hidden = s.id === "review";
  $("#next").textContent = v.nextLabel || "Next";
  $("#next").classList.remove("ready");
  if (v.live) { v.live(s); timer = setInterval(() => !busy && v.live(s), POLL_MS); }
  refreshBanner();
}

// Wires [data-act] elements to the current view's actions and [data-copy] buttons to the clipboard.
function bind(root) {
  root.querySelectorAll("[data-act]").forEach((el) => (el.onclick = async (e) => {
    e.preventDefault();
    if (el.classList.contains("busy")) return;
    busy++;
    ui.clicked = true;
    cue();
    el.classList.add("busy");
    setErrors();
    try { await (view(step()).actions?.[el.dataset.act] || COMMON[el.dataset.act])(step(), el); }
    catch (err) { setErrors([esc(err.message)]); }
    finally { busy--; el.classList.remove("busy"); }
  }));
  root.querySelectorAll("[data-copy]").forEach((el) => (el.onclick = async () => {
    await navigator.clipboard.writeText(el.dataset.copy);
    el.textContent = "✓";
    setTimeout(() => (el.innerHTML = COPY_ICON), 1200);
  }));
}

// A "click here" pointer on the first link of the plan and profile-card steps, until a link is clicked.
function cue() {
  $(".cue")?.remove();
  if (["account", "traits"].includes(step().id) && !ui.clicked) $("#view [data-act]").insertAdjacentHTML("afterend", `<span class="cue">← click here</span>`);
}

function setErrors(list = []) {
  const box = $("#errors");
  box.hidden = !list.length;
  box.innerHTML = list[0] ?? ""; // one problem at a time
  bind(box);
}

function go(delta) {
  state.step = Math.max(0, Math.min(steps().length - 1, state.step + delta));
  ui = freshUi();
  save();
  render();
  const v = $("#view");
  v.classList.remove("enter-fwd", "enter-back");
  void v.offsetWidth; // restart the animation
  v.classList.add(delta < 0 ? "enter-back" : "enter-fwd");
  v.scrollTop = 0;
}

// Actions available on every step.
const COMMON = {
  diagnose: async () => {
    const s = step();
    const info = await run("diagnose", s.capture ? promptOf(s).slice(0, 40) : null);
    await navigator.clipboard.writeText(JSON.stringify({ step: s.id, version: chrome.runtime.getManifest().version, ...info }, null, 2));
    setErrors(["Diagnostic info copied to your clipboard."]);
  },
};

// ---------- Steps ----------

const VIEWS = {
  consent: {
    nextLabel: "Agree & start",
    html: () => `
      <div class="consent">${CONSENT_HTML}</div>
      <label>Prolific ID <span class="muted">(optional)</span><input type="text" id="pid" value="${esc(D().participant_id)}"></label>
      <details class="help"><summary>How do I find my Prolific ID?</summary><ol>
        <li>Log in to your Prolific account.</li>
        <li>Go to the <b>Account</b> page.</li>
        <li>Your Prolific ID is shown there. Copy it into the box above.</li>
      </ol></details>
      <label class="check"><input type="checkbox" id="age" ${D().consent ? "checked" : ""}> I am 18 or older.</label>
      <label class="check"><input type="checkbox" id="agree" ${D().consent ? "checked" : ""}> I agree to let this helper collect the data listed above from chatgpt.com during this study.</label>`,
    next: async () => {
      if (!$("#age").checked || !$("#agree").checked) return ["Tick both boxes to continue."];
      let battery = D().battery;
      // Allocation is keyed by a generated participant key, not the Prolific ID, which never leaves the browser.
      try { battery ||= await sampleBattery(D().participant_key ||= crypto.randomUUID()); }
      catch (e) { return [`Couldn't load the study prompts. Try again in a minute; if it keeps failing, contact the research team. <span class="muted">(${esc(e.message)})</span>`]; }
      await update((d) => {
        d.participant_id = $("#pid").value.trim();
        d.consent = { agreed_at: now() };
        d.started_at ||= now();
        d.battery = battery;
      });
    },
  },

  account: {
    html: () => `
      <p>1. ${act("billing", "Open your billing page")}<br><span class="muted">Log in if ChatGPT asks.</span></p>
      <p>2. Your plan is the name at the top, e.g. <b>ChatGPT Plus</b>:</p>
      <img class="shot" src="assets/billing.png" alt="chatgpt.com/settings/billing showing the plan name, ChatGPT Plus">
      <p>3. Choose it here:</p>
      <select id="plan"><option value="">Select…</option>${PLAN_OPTIONS.map((p) => `<option ${D().account?.plan === p ? "selected" : ""}>${p}</option>`).join("")}</select>`,
    actions: { billing: () => openChat(BILLING_URL) },
    next: async () => {
      const plan = $("#plan").value;
      if (!plan) return ["Choose your plan."];
      await update((d) => { d.account = { plan, reported_at: now() }; });
    },
  },

  setup: {
    html: () => {
      const m = D().memory_overview;
      return `
        <p class="muted">Click through these steps in order, or click <b>Do all of this for me</b>.</p>
        <ul class="tasks" id="tasks">${setupTasks()}</ul>
        <p><button class="primary" data-act="all">Do all of this for me</button></p>
        ${m ? `<details><summary class="muted">Your captured Memory Overview${m.source === "manual_paste" ? " (pasted manually)" : ""}</summary><pre>${esc(m.text)}</pre></details>` : ""}
        ${manual(`
          <ol>
            <li>Click your profile icon on bottom left of dashboard → <b>Settings</b> → <b>Personalization</b> (or simply go to chatgpt.com/settings/personalization).</li>
            <li>Turn <b>Enable memory</b> on.</li>
            <li>Under <b>Additional ChatGPT settings</b>, turn <b>Web Search</b> off, then click <b>Save</b>.</li>
          </ol>
          <p>If the helper can't read a toggle, confirm it yourself:</p>
          <label class="check"><input type="checkbox" id="selfmem" ${D().settings?.memory_enabled?.self_report ? "checked" : ""}> "Enable memory" is on</label>
          <label class="check"><input type="checkbox" id="selfweb" ${D().settings?.web_search?.self_report === false ? "checked" : ""}> "Web Search" is off</label>`)}`;
    },
    bind: () => {
      $("#selfmem").onchange = (e) => saveSettings({ memSelf: e.target.checked ? true : null }, false);
      $("#selfweb").onchange = (e) => saveSettings({ webSelf: e.target.checked ? false : null }, false);
    },
    live: async () => {
      try { ui.settings = await run("readSettings"); } catch { ui.settings = null; }
      if (ui.settings?.on_page) await saveSettings({ observed: ui.settings }, false);
      const tasks = $("#tasks");
      if (tasks && !busy) { tasks.innerHTML = setupTasks(); bind(tasks); }
    },
    actions: {
      open: () => openChat(SETTINGS_URL),
      memory: () => toggle("memory", true),
      web: () => toggle("web", false),
      overview: () => captureOverview(),
      all: async () => { await toggle("memory", true); await toggle("web", false); await captureOverview(); },
    },
    next: async () => {
      await ensureSettingsPage();
      const s = D().settings, errors = [];
      const mem = s?.memory_enabled.observed ?? s?.memory_enabled.self_report;
      const web = s?.web_search.observed ?? s?.web_search.self_report;
      if (mem === false) errors.push(`Enable memory is off — ${act("memory", "turn it on")}.`);
      if (mem == null) errors.push(`Couldn't find the Enable memory toggle. Confirm it under "Manual steps".`);
      if (web === true) errors.push(`Web Search is on — ${act("web", "turn it off")}.`);
      if (web == null) errors.push(`Couldn't find the Web Search toggle. Confirm it under "Manual steps".`);
      if (!D().memory_overview) errors.push(`${act("overview", "Capture your Memory Overview")}.`);
      return errors;
    },
  },

  intro: {
    html: (s) => s.part.personalized ? `
      <p>That's Part 1 done!</p>
      <p>Now we will ask ChatGPT for the <b>personalized</b> answers: the same ${D().battery.items.length} prompts again, each in a <b>new ${chatOf(true).name}</b>
      ${hasToggle() ? "" : " (Temporary Chat off)"}.</p>
      ${hasToggle() ? guideVideo(true) : ""}` : `
      <p>To see how ChatGPT personalizes its answers, we first need its <b>baseline</b> answers, which <i>aren't</i> personalized to you.
      Temporary Chat gives us these "unpersonalized" responses and operates in an incognito mode.</p>
      <p>For this section, we will ask you to insert ${D().battery.items.length} prompts one by one, each in a new Temporary Chat:</p>
      ${hasToggle() ? guideVideo(false) : `<img class="shot" src="assets/${basicPlan() ? "free-go-temp-chat.jpg" : "paid-temp-chat-toggle.jpg"}" alt="The Temporary Chat icon at the top right of ChatGPT, off and then on">`}
      ${hasToggle() === undefined ? `<p>${act("newchat", "Open a new Temporary Chat")} to start.</p>` : ""}
      <p class="muted">Don't tell ChatGPT you're in a study, and don't send anything other than the prompt.</p>`,
    actions: { newchat: () => newChat(chatOf(false)) },
  },

  capture: {
    nextLabel: "Check & save",
    html: (s) => {
      const chat = chatFor(s), rec = getRecord(s), text = promptOf(s), n = chat.pick === undefined ? 1 : 2;
      return `
        ${s.capture.followup ? `
          <p>1. Stay in the same ${chat.name} — this follow-up continues the conversation you just had.</p>
          <p>2. ${act("insert", "Insert the follow-up")}, then press ${sendIcon(chat)} in ChatGPT to send it.</p>` : `
          <p>1. ${act("newchat", `Open a new ${chat.name}`)}.</p>
          ${n === 2 ? `<div class="stepline"><span>2.</span><div><div id="pick"></div>
            <details class="where"><summary>Show me how</summary>${guideVideo(chat.pick)}</details></div></div>` : ""}
          <div class="stepline"><span>${n + 1}.</span><div>${confirmBox(chat)}</div></div>
          <p>${n + 2}. ${act("insert", "Insert the prompt")}, then press ${sendIcon(chat)} in ChatGPT to send it.</p>`}
        ${promptBlock(text)}
        ${rec ? `<div class="box">${rec.flags.length ? `<span class="warn">⚠ Saved with flags: ${esc(rec.flags.join(", "))}</span>` : `<span class="ok">✓ Saved</span>`}
              <pre>${esc(rec.response_text)}</pre><p>${act("redo", "Discard and redo")}</p></div>`
          : `<p class="status" id="status"></p>`}
        ${rec ? "" : manual(`
          <p>Copy/paste ChatGPT's response to the prompt here:</p>
          <textarea id="manualresp" placeholder="Paste ChatGPT's response"></textarea>
          <p>You can use the copy icon under the response to copy it exactly:</p>
          <img class="shot small" src="assets/copy-response.png" alt="The Copy response icon under ChatGPT's answer">`)}`;
    },
    bind: () => { bindConfirm(); renderPick(); },
    // Checks run silently; they only become messages when Next is clicked. A finished response highlights Next.
    live: async (s) => {
      if (getRecord(s)) return;
      try { ui.conv = await run("readConversation"); } catch { ui.conv = null; }
      if (step().id !== s.id) return; // the participant moved on while ChatGPT was being read
      const text = ui.conv?.messages.filter((m) => m.role === "assistant")[s.capture.followup ? 1 : 0]?.text ?? null;
      if (ui.conv) ui.conv.stable = text !== null && text === ui.lastText;
      ui.lastText = text;
      renderPick();
      const ready = !!ui.conv && !blockers(checks(ui.conv, s)).length;
      $("#next").classList.toggle("ready", ready);
      const status = $("#status");
      if (status) status.innerHTML = ready ? `<span class="ok">✓ ChatGPT has responded. Click <b>Check &amp; save</b>.</span>`
        : `<span class="muted">When ChatGPT has finished responding, click Check &amp; save.</span>`;
    },
    actions: {
      newchat: (s) => newChat(chatFor(s)),
      insert: (s) => insert(promptOf(s)),
      redo: async (s) => {
        ui.discarded = getRecord(s)?.response_text ?? null;
        await update((d) => { delete d.responses[s.id]; delete d.responses[`${s.id}_followup`]; }); // a follow-up answered in the discarded chat goes with it
      },
    },
    next: async (s) => {
      if (getRecord(s)) return;
      if (!s.capture.followup && !ui.confirmed) return [`Tick the box in step ${chatFor(s).pick === undefined ? 2 : 3} once ChatGPT's settings match.`];
      await VIEWS.capture.live(s);
      await sleep(900);
      await VIEWS.capture.live(s); // second read confirms the response stopped changing
      const blocking = ui.conv ? blockers(checks(ui.conv, s)) : [];
      if (ui.conv && !blocking.length) return saveCapture(s, ui.conv);
      const pasted = $("#manualresp").value.trim();
      if (pasted) return setRecord(s, { ...recordBase(s), response_text: pasted, source: "manual_paste", captured_at: now(), flags: ["manual_entry"] });
      if (!ui.conv) return ["Switch to your ChatGPT tab first."];
      if (blocking[0].code === "chat" && chatFor(s).pick !== undefined) { ui.pickManual = true; renderPick(); }
      return blocking.map((c) => c.hint);
    },
  },

  choice: {
    nextLabel: "Save & continue",
    html: (s) => {
      const c = item(s.choice).choice;
      ui.pick ??= D().choices[item(s.choice).prompt_id]?.choice ?? null;
      ui.choiceAt ??= Date.now();
      return `
        <div class="intro">${c.intro.split(/\n\s*\n/).map((t) => /^["“].*["”]$/s.test(t.trim()) ? `<blockquote>${esc(t.trim().slice(1, -1))}</blockquote>` : `<p>${esc(t)}</p>`).join("")}</div>
        <p class="ask"><b>${esc(c.question)}</b></p>
        <p class="bad">Please read the options carefully.</p>
        ${c.options.map((o) => `<label class="option"><input type="radio" name="pick" value="${o.label}" ${ui.pick === o.label ? "checked" : ""}>
          <span class="letter">${o.label}</span><span>${esc(o.text)}</span></label>`).join("")}
        <p class="muted" id="dwell"></p>`;
    },
    bind: () => document.querySelectorAll("input[name=pick]").forEach((r) => (r.onchange = () => { ui.pick = r.value; setErrors(); })),
    live: (s) => {
      const done = D().choices[item(s.choice).prompt_id] || Date.now() - ui.choiceAt >= 60000;
      $("#dwell").textContent = done ? "" : `You can continue in ${Math.ceil((60000 - (Date.now() - ui.choiceAt)) / 1000)} s.`;
      $("#next").classList.toggle("ready", !!done && !!ui.pick);
    },
    next: (s) => {
      if (!D().choices[item(s.choice).prompt_id] && Date.now() - ui.choiceAt < 60000)
        return ["Please spend at least 1 minute on this question, to make sure you've read the options."];
      if (!ui.pick) return ["Pick one response."];
      const it = item(s.choice), o = it.choice.options.find((x) => x.label === ui.pick);
      return update((d) => { d.choices[it.prompt_id] = { dataset: it.dataset, question: it.choice.text, choice: o.label, text: o.text, code: o.code, saved_at: now() }; });
    },
  },

  followup: {
    html: () => {
      const f = D().followup;
      ui.followup ??= f?.choice ?? null;
      ui.traits ??= f?.missing_traits ?? [];
      const mode = ui.followup;
      const radio = (value, text) => `<label class="check"><input type="radio" name="fu" value="${value}" ${mode === value ? "checked" : ""}> ${text}</label>`;
      return `
        <p>Did ChatGPT leave any trait in its profile card as "unknown" (or refuse to guess)?</p>
        ${radio("none", "No, it guessed every trait")}
        ${radio("done", "Yes, and I'd like to ask ChatGPT follow-up questions")}
        ${radio("skipped", "Yes, but I'd rather move on without follow-up questions")}
        <div ${mode === "done" || mode === "skipped" ? "" : "hidden"}>
          <p>Which traits are missing?</p>
          <details class="dropdown"><summary id="traitsum">${traitSummary()}</summary>
            <div class="menu">${FIELDS.map(([label, name]) => `<label class="check"><input type="checkbox" name="trait" value="${name}" ${ui.traits.includes(name) ? "checked" : ""}> ${label}</label>`).join("")}</div>
          </details>
        </div>
        <div ${mode === "done" ? "" : "hidden"}>
          <p>1. ${act("newchat", "Open a new regular chat")}.</p>
          <div class="stepline"><span>2.</span><div>${confirmBox(CHATS.regular)}</div></div>
          <div id="fuprompts">${followupSteps()}</div>
          <p class="status" id="status"></p>
          ${manual(`
            <p>Copy/paste ChatGPT's responses to the prompts here:</p>
            <textarea id="manualfu" placeholder="Paste ChatGPT's responses"></textarea>
            <p>You can use the copy icon under each response to copy it exactly:</p>
            <img class="shot small" src="assets/copy-response.png" alt="The Copy response icon under ChatGPT's answer">`)}
        </div>`;
    },
    bind: () => {
      document.querySelectorAll("input[name=fu]").forEach((r) => (r.onchange = () => { ui.followup = r.value; render(); }));
      document.querySelectorAll("input[name=trait]").forEach((c) => (c.onchange = () => {
        ui.traits = [...document.querySelectorAll("input[name=trait]:checked")].map((x) => x.value);
        $("#traitsum").textContent = traitSummary();
        $("#fuprompts").innerHTML = followupSteps();
        bind($("#fuprompts"));
      }));
      bindConfirm();
    },
    live: async (s) => {
      if (ui.followup !== "done") return;
      try { ui.conv = await run("readConversation"); } catch { ui.conv = null; }
      if (step().id !== s.id || ui.followup !== "done") return;
      const n = followupConversation(ui.conv)?.length;
      $("#next").classList.toggle("ready", !!n);
      $("#status").innerHTML = n ? `<span class="ok">✓ Follow-up chat found (${n} messages). Click <b>Next</b> to save it.</span>`
        : `<span class="muted">Once ChatGPT has answered, click Next.</span>`;
    },
    actions: {
      newchat: () => newChat(CHATS.regular),
      p1: () => insert(followupPrompts(ui.traits)[0]),
      p2: () => insert(followupPrompts(ui.traits)[1]),
    },
    next: async () => {
      const mode = ui.followup;
      if (!mode) return ["Choose an option."];
      if (mode === "none") return update((d) => { d.followup = { choice: "none", missing_traits: [], captured_at: now(), flags: [] }; });
      if (!ui.traits.length) return ["Select the missing traits."];
      if (mode === "skipped") return update((d) => { d.followup = { choice: "skipped", missing_traits: [...ui.traits], captured_at: now(), flags: [] }; });
      if (!ui.confirmed) return ["Tick the box in step 2 once ChatGPT's settings match."];
      const prompts = followupPrompts(ui.traits), pasted = $("#manualfu").value.trim();
      let c = null;
      try { c = await run("readConversation"); } catch {}
      if (!followupConversation(c)) {
        if (pasted) return update((d) => { d.followup = { choice: "done", missing_traits: [...ui.traits], prompts, pasted_response: pasted, source: "manual_paste", captured_at: now(), flags: ["manual_entry"] }; });
        if (!c) return ["Switch to your ChatGPT tab first."];
        if (c.generating) return ["ChatGPT is still responding."];
        if (c.messages.some((m) => m.role === "user" && norm(m.text) === norm(PROMPTS.traits))) return [`This is the profile-card chat. ${act("newchat", "Open a new regular chat")} for the follow-up.`];
        return [`No follow-up answer on the ChatGPT page yet. ${act("newchat", "Open a new regular chat")} and send Prompt 1.`];
      }
      const flags = [];
      if (c.temporary) flags.push("followup_in_temporary_chat");
      if (c.messages.some((m) => m.role === "user" && !prompts.some((p) => norm(p) === norm(m.text)))) flags.push("followup_message_not_study_prompt");
      await update((d) => {
        d.followup = {
          choice: "done", missing_traits: [...ui.traits], prompts,
          conversation: c.messages.map(({ role, text, model_slug }) => ({ role, text, ...(model_slug ? { model_slug } : {}) })),
          conversation_url: c.url, source: "auto", captured_at: now(), flags,
        };
      });
    },
  },

  review: {
    html: () => {
      const rows = steps().filter((s) => s.capture || s.choice !== undefined || ["account", "setup", "followup"].includes(s.id)).map((s) => {
        const rec = recordOf(s), flags = rec?.flags || [];
        return { missing: !rec, html: `<tr><td>${esc(s.title)}</td><td>${!rec ? `<span class="bad">✗ missing</span>` : flags.length ? `<span class="warn">⚠ ${esc(flags.join(", "))}</span>` : `<span class="ok">✓</span>`}</td></tr>` };
      });
      const missing = rows.filter((r) => r.missing).length, complete = !missing;
      const init = D().settings.initial;
      const was = [init.memory_enabled === false && "<b>Enable memory</b> was off", init.web_search === true && "<b>Web Search</b> was on"].filter(Boolean);
      return `
        <details class="checklist" ${complete ? "" : "open"}><summary>${complete ? `<span class="ok">✓ All ${rows.length} steps saved</span>`
          : `<span class="bad">✗ ${missing} of ${rows.length} steps missing</span>`}</summary><table>${rows.map((r) => r.html).join("")}</table></details>
        ${complete ? `
          <div class="box final"><p><b>All done! Last steps:</b></p><ol>
            <li><b>Download your data</b> with the button below.</li>
            <li><b>Note where it's saved</b> — normally your Downloads folder. You'll need to find this file in a moment.</li>
            ${was.length ? `<li><b>Restore your ChatGPT settings</b> (optional). Before the study, ${joinList(was)}.
              <br><button data-act="restore">Restore my original settings</button></li>` : ""}
            <li><b>Close this panel</b> (✕ top right) and <b>go back to the Prolific survey</b>, which tells you how to upload the file.</li>
          </ol></div>` : `<p class="bad">Some steps are missing — go Back to finish them.</p>`}
        <p><button id="dl" class="primary" ${complete ? "" : "disabled"}>Download my data</button> ${act("preview", "Preview")}</p>
        <p id="saved" class="ok" hidden></p>
        <pre id="json" hidden></pre>
        <details class="manual"><summary>Withdraw</summary><p>This permanently deletes everything this helper stored in your browser.</p><p>${act("wipe", "Delete my data")}</p></details>`;
    },
    bind: () => {
      $("#dl").onclick = async () => {
        D().completed_at = now();
        await save();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...D(), integrity: await hmac(canon(D())) }, null, 2)], { type: "application/json" }));
        a.download = `piw_${(D().participant_id || "participant").replace(/\W+/g, "_")}_${D().completed_at.slice(0, 10)}.json`;
        a.click();
        $("#saved").hidden = false;
        $("#saved").textContent = `✓ Downloaded ${a.download}`;
        const stage = D().battery.allocation?.stage_id; // absent for participants who started before the allocator existed
        if (stage) try { await supa("submit", { participant_key: D().participant_key, stage_id: stage }); }
        catch { setErrors(["Your file downloaded, but the study server couldn't be notified. Check your connection and click <b>Download my data</b> again."]); }
      };
    },
    actions: {
      preview: () => { const p = $("#json"); p.hidden = !p.hidden; p.textContent = JSON.stringify(D(), null, 2); },
      restore: async () => {
        const init = D().settings.initial;
        // ensureSettingsPage before each toggle: saving the first one can re-render and collapse the extras section.
        for (const [key, k] of [["memory", "memory_enabled"], ["web", "web_search"]]) if (init[k] != null) { await ensureSettingsPage(); await run("setToggle", key, init[k]); }
        setErrors(["Your original settings are back."]);
      },
      wipe: () => startOver("Delete all study data stored by this extension?"),
    },
  },
};

// ---------- Settings & memory ----------

function setupTasks() {
  const s = D().settings, st = (v, want) => (v === want ? "ok" : v == null ? "wait" : "bad");
  const mem = s?.memory_enabled.observed ?? s?.memory_enabled.self_report;
  const web = s?.web_search.observed ?? s?.web_search.self_report;
  return [
    line(ui.settings?.on_page ? "ok" : "wait", act("open", "Open your Personalization settings")),
    line(st(mem, true), act("memory", "Turn on “Enable memory”")),
    line(st(web, false), `For this study, ${act("web", "turn off Web Search")}`),
    line(D().memory_overview ? "ok" : "wait", `${act("overview", "Capture your Memory Overview")}${D().memory_overview ? "" : ` <span class="muted">— opens Manage and waits for it to load</span>`}`),
  ].join("");
}

async function saveSettings({ observed, memSelf, webSelf }, rerender = true) {
  const d = D();
  d.settings ||= { memory_enabled: { observed: null, self_report: null }, web_search: { observed: null, self_report: null }, initial: {}, flags: [] };
  if (observed) {
    for (const k of ["memory_enabled", "web_search"]) if (observed[k] != null) { d.settings[k].observed = observed[k]; d.settings.initial[k] ??= observed[k]; }
    d.settings.observed_at = now();
  }
  if (memSelf !== undefined) d.settings.memory_enabled.self_report = memSelf;
  if (webSelf !== undefined) d.settings.web_search.self_report = webSelf;
  d.settings.flags = ["memory_enabled", "web_search"].filter((k) => d.settings[k].observed == null && d.settings[k].self_report != null).map((k) => `${k}_self_reported`);
  await save();
  if (rerender) render();
}

// Opens the settings page and records the toggles as found there (the first reading is kept as `initial`).
async function ensureSettingsPage() {
  if (!(await chatTab())?.url.includes("/settings/personalization")) await openChat(SETTINGS_URL);
  const r = await until(() => run("readSettings", true), (v) => v?.memory_enabled != null && v?.web_search != null, 8000);
  if (!r?.on_page) throw new Error("Couldn't open the Personalization settings page.");
  await saveSettings({ observed: r }, false);
}

async function toggle(key, want) {
  await ensureSettingsPage();
  const r = await run("setToggle", key, want);
  const name = key === "memory" ? "Enable memory" : "Web Search";
  if (r.state === null) throw new Error(`Couldn't find the "${name}" toggle on this page. Use Manual steps below.`);
  await saveSettings({ observed: key === "memory" ? { memory_enabled: r.state } : { web_search: r.state } });
  if (r.state !== want) throw new Error(`Couldn't change "${name}". Please switch it yourself (and click Save if shown).`);
}

async function captureOverview() {
  await ensureSettingsPage();
  if (!(await run("openMemoryOverview"))) throw new Error(`Couldn't find the "Manage" button next to Memory Overview. Reload the ChatGPT tab and try again.`);
  let prev = null;
  const text = await until(() => run("memoryOverviewText"), (t) => { const stable = !!t && t === prev; prev = t; return stable; }, 30000);
  if (!text) throw new Error(`The Memory Overview didn't load (looked for the "Dive Deeper" heading). Try again; if it keeps failing, copy diagnostic info under Manual steps and contact the research team.`);
  await update((d) => { d.memory_overview = { text, source: "auto", captured_at: now(), flags: [] }; });
}

// ---------- Prompt capture ----------

const getRecord = (s) => D().responses[s.id];
const setRecord = (s, rec) => update((d) => { d.responses[s.id] = rec; });

function recordOf(s) {
  if (s.capture) return getRecord(s);
  if (s.choice !== undefined) return D().choices[item(s.choice).prompt_id];
  if (s.id === "setup") return D().settings && D().memory_overview ? { flags: [...D().settings.flags, ...D().memory_overview.flags] } : null;
  return D()[s.id];
}

function recordBase(s) {
  const it = s.capture.prompt ? null : item(s.capture.item);
  return { prompt_id: it?.prompt_id ?? s.capture.prompt, dataset: it?.dataset ?? null, condition: s.capture.condition ?? null, prompt: promptOf(s) };
}

async function insert(text) {
  const r = await run("insertPrompt", text);
  if (r === "no_composer") throw new Error("Couldn't find ChatGPT's message box. Click into it and try again, or use the copy button.");
  if (r !== "ok") throw new Error("Couldn't insert the prompt. Use the copy button and paste it instead.");
}

// The follow-up chat's messages, or null if the page doesn't show a finished chat that starts with a follow-up prompt.
// Matched by content, not URL: Temporary Chats can share a URL.
function followupConversation(c) {
  const first = c?.messages.find((m) => m.role === "user");
  if (!first || c.generating || !followupPrompts(ui.traits).some((p) => norm(p) === norm(first.text))) return null;
  return c.messages.some((m) => m.role === "assistant" && m.text) ? c.messages : null;
}

const blockers = (L) => L.filter((c) => c.status !== "ok");

const traitSummary = () => (ui.traits.length ? FIELDS.filter(([, n]) => ui.traits.includes(n)).map(([l]) => l).join(", ") : "Select the missing traits");

function followupSteps() {
  if (!ui.traits.length) return `<p class="muted">Select the missing traits above to see the prompts.</p>`;
  const [p1, p2] = followupPrompts(ui.traits);
  return `
    <p>3. ${act("p1", "Insert Prompt 1")} and press ${sendIcon(CHATS.regular)} to send it.</p>${promptBlock(p1)}
    <p>4. If ChatGPT still doesn't answer, ${act("p2", "insert Prompt 2")} in the same chat and send it. Then click Next.</p>${promptBlock(p2)}`;
}

// What this step requires of the current ChatGPT page. status: ok | bad | wait; each hint says how to fix it.
function checks(conv, s) {
  const chat = chatFor(s), fu = !!s.capture.followup, k = fu ? 1 : 0;
  const users = conv.messages.filter((m) => m.role === "user"), bots = conv.messages.filter((m) => m.role === "assistant");
  const u = users[k], bot = bots[k], L = [];
  const add = (code, status, hint) => L.push({ code, status, hint });
  const reopen = act("newchat", `Open a new ${chat.name}`);

  if (fu) {
    // The follow-up must land in the conversation that answered the main prompt; Temporary Chats share a URL, so match by content.
    add("same_chat", users[0] && norm(users[0].text) === norm(item(s.capture.item).prompt) ? "ok" : "bad",
      "This isn't the chat where you sent the prompt. Go <b>Back</b>, <b>Discard and redo</b> it, then send the follow-up in that same chat.");
    add("sent_once", !u ? "wait" : users.length === 2 ? "ok" : "bad",
      !u ? `${act("insert", "Insert the follow-up")} and send it.` : "Extra messages were sent in this chat. Paste ChatGPT's answer under Manual steps.");
  } else {
    add("chat", chat.ok(conv) || ui.pickSelf ? "ok" : "bad", chat.pick === undefined ? `Wrong kind of chat for this prompt. ${reopen}.`
      : `Couldn't confirm <b>${chat.pick ? "Personalized" : "Unpersonalized"}</b> is selected. ${reopen}, or tick step 2 yourself if it is.`);
    const reused = conv.url.includes("/c/") && Object.entries(D().responses).some(([id, r]) => id !== s.id && r.conversation_url === conv.url);
    add("new_chat", !u ? "wait" : users.length === 1 && bots.length <= 1 && !reused ? "ok" : "bad",
      !u ? `${act("insert", "Insert the prompt")} and send it.` : `This chat was already used. ${reopen}.`);
  }
  if (u) add("prompt_match", norm(u.text) === norm(promptOf(s)) ? "ok" : "bad",
    fu ? "The second message doesn't match the follow-up. Insert it again and send it." : `The message doesn't match the prompt. ${reopen} and insert it again.`);
  add("response_complete", bot?.text && !conv.generating && conv.stable !== false ? "ok" : "wait", "Waiting for ChatGPT to finish responding.");
  if (bot?.text && bot.text === ui.discarded) add("discarded", "bad",
    fu ? "This is the response you discarded. Ask ChatGPT to regenerate it, or paste the answer under Manual steps." : `This is the response you discarded. ${reopen}.`);
  return L;
}

// Called once every blocking check passes, so the only possible flags are web_links and a self-reported dropdown choice.
async function saveCapture(s, conv) {
  const k = s.capture.followup ? 1 : 0;
  const u = conv.messages.filter((m) => m.role === "user")[k], bot = conv.messages.filter((m) => m.role === "assistant")[k];
  await setRecord(s, {
    ...recordBase(s),
    user_message_sent: u?.text ?? null,
    response_text: bot.text,
    response_html: bot.html,
    model_slug: bot.model_slug,
    conversation_url: conv.url,
    temporary_chat_observed: conv.temporary,
    personalized_observed: conv.personalized,
    web_links_in_response: bot.link_count,
    flags: [...(bot.link_count ? ["web_links"] : []), ...(chatFor(s).ok(conv) ? [] : ["dropdown_self_reported"])],
    source: "auto",
    captured_at: now(),
  });
}

// ---------- Start ----------

$("#back").onclick = () => go(-1);
$("#next").onclick = async () => {
  const next = $("#next"), label = next.textContent;
  checking = true;
  next.disabled = true;
  next.textContent = "Checking…";
  setErrors();
  busy++;
  let errors;
  try { errors = await view(step()).next?.(step()); }
  catch (e) { errors = [esc(e.message)]; }
  finally { busy--; checking = false; next.disabled = false; next.textContent = label; }
  if (errors?.length) {
    setErrors(errors);
    refreshBanner();
    return;
  }
  go(1);
  // Within a part, saving a prompt opens a new chat for the next one.
  const s = step();
  if (s.capture?.item > 0 && !s.capture.followup && !getRecord(s)) $('#view [data-act="newchat"]').click();
};
async function startOver(question) {
  if (!confirm(question)) return;
  await chrome.storage.local.clear();
  state = { step: 0, data: newData(), zoom: state.zoom };
  ui = freshUi();
  render();
}

function setZoom(z) {
  state.zoom = Math.round(Math.min(1.6, Math.max(0.7, z)) * 10) / 10;
  document.documentElement.style.setProperty("--zoom", state.zoom);
  save();
}

$("#restart").onclick = () => startOver("Start over from the beginning? This deletes everything collected so far.");
$("#close").onclick = () => window.close();
// Clicking a screenshot or video shows it over the whole panel; pinch or Ctrl+scroll zooms it; a click closes it.
let lightboxScale = 1;
$("#view").addEventListener("click", (e) => {
  if (!e.target.matches("img, video")) return;
  lightboxScale = 1;
  $("#lightbox .stage").replaceChildren(e.target.cloneNode());
  $("#lightbox").hidden = false;
});
$("#lightbox").onclick = () => ($("#lightbox").hidden = true);
$("#lightbox").addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return; // plain scrolling pans
  e.preventDefault();
  const box = $("#lightbox .stage"), el = box.firstChild, before = el.getBoundingClientRect();
  lightboxScale = Math.min(6, Math.max(1, lightboxScale * Math.exp(-e.deltaY / 100)));
  el.style.maxWidth = el.style.maxHeight = lightboxScale > 1 ? "none" : "";
  el.style.width = lightboxScale > 1 ? `${lightboxScale * (box.clientWidth - 16)}px` : "";
  const after = el.getBoundingClientRect(); // keep the point under the cursor in place
  box.scrollLeft += after.left + ((e.clientX - before.left) / before.width) * after.width - e.clientX;
  box.scrollTop += after.top + ((e.clientY - before.top) / before.height) * after.height - e.clientY;
}, { passive: false });
$("#zoom-in").onclick = () => setZoom(state.zoom + 0.1);
$("#zoom-out").onclick = () => setZoom(state.zoom - 0.1);
$("#goto-chatgpt").onclick = async (e) => {
  e.preventDefault();
  const [tab] = await chrome.tabs.query({ url: CHATGPT + "*", currentWindow: true });
  if (tab) chrome.tabs.update(tab.id, { active: true });
  else chrome.tabs.create({ url: CHATGPT });
};
chrome.tabs.onActivated.addListener(refreshBanner);
chrome.tabs.onUpdated.addListener(refreshBanner);
chrome.storage.local.get("piw").then(({ piw }) => {
  state = piw?.data?.schema_version === 6 ? piw : { step: 0, data: newData() };
  setZoom(state.zoom ?? 1);
  render();
});
