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
const freshUi = () => ({ confirmed: false, conv: null, lastText: null, discarded: null, settings: null, followup: null, traits: null, order: null });
let ui = freshUi();

const newData = () => ({
  schema_version: 4,
  extension_version: chrome.runtime.getManifest().version,
  participant_id: "",
  consent: null,
  started_at: null,
  completed_at: null,
  battery: null, // sampled prompts: { source, sampled_at, items: [{ dataset, prompt_id, prompt, options?, ranking_question? }] }
  account: null,
  settings: null,
  memory_overview: null,
  rankings: {},
  responses: {},
  followup: null,
  unverified: UNVERIFIED,
});

const D = () => state.data;
const steps = () => buildSteps(D().battery?.items);
const step = () => steps()[state.step];
const item = (i) => D().battery.items[i];
const promptOf = (s) => (s.capture.prompt ? PROMPTS[s.capture.prompt] : item(s.capture.item).prompt);
const save = () => chrome.storage.local.set({ piw: state });
const update = async (fn) => { fn(D()); await save(); render(); };

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

const view = (s) => VIEWS[s.capture ? "capture" : s.part ? "intro" : s.rank !== undefined ? "rank" : s.id];
const mark = { ok: "✓", bad: "✗", wait: "○" };
const line = (status, html) => `<li><span class="dot ${status}">${mark[status]}</span><span>${html}</span></li>`;
const act = (name, label) => `<a class="act" data-act="${name}">${label}</a>`;
const promptBlock = (text) => `<div class="prompt"><button class="copy" data-copy="${esc(text)}" title="Copy">${COPY_ICON}</button><pre>${esc(text)}</pre></div>`;
const sendIcon = (temporary) => `<img class="send" src="assets/send-${temporary ? "temp" : "regular"}.png" alt="Send">`;
// Free and Go have a Think button (left off) and no model picker; paid plans pick Instant thinking and GPT-6.
const basicPlan = () => ["Free", "Go"].includes(D().account?.plan);
function confirmBox(temporary) {
  const basic = basicPlan();
  const model = basic ? "<b>Think</b> is off" : "Thinking effort is <b>Instant</b> and the model is <b>GPT-6</b>";
  const text = temporary ? model : `<b>Chat</b> is selected${basic ? " and " : ", "}${model}`;
  const guide = !temporary ? `<video src="assets/${basic ? "free-go" : "paid"}-chat.webm" autoplay loop muted playsinline></video>`
    : basic ? `<img src="assets/free-go-think-off.jpg" alt="The Think button in ChatGPT's message box, left off">`
    : `<img src="assets/paid-temp-chat.gif" alt="In a Temporary Chat, open Thinking effort, choose Instant, then choose GPT-6">`;
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
      <label>Prolific ID<input type="text" id="pid" value="${esc(D().participant_id)}"></label>
      <label class="check"><input type="checkbox" id="age" ${D().consent ? "checked" : ""}> I am 18 or older.</label>
      <label class="check"><input type="checkbox" id="agree" ${D().consent ? "checked" : ""}> I agree to let this helper collect the data listed above from chatgpt.com during this study.</label>`,
    next: async () => {
      const pid = $("#pid").value.trim(), errors = [];
      if (!pid) errors.push("Enter your Prolific ID.");
      if (!$("#age").checked || !$("#agree").checked) errors.push("Tick both boxes to continue.");
      if (errors.length) return errors;
      let battery = D().battery;
      try { battery ||= await sampleBattery(); }
      catch (e) { return [`Couldn't load the study prompts. Try again in a minute; if it keeps failing, contact the research team. <span class="muted">(${esc(e.message)})</span>`]; }
      await update((d) => {
        d.participant_id = pid;
        d.consent = { agreed_at: now() };
        d.started_at ||= now();
        d.battery = battery;
      });
    },
  },

  account: {
    html: () => `
      <p>1. ${act("billing", "Open your billing page")} (log in if ChatGPT asks).</p>
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
        <ul class="tasks" id="tasks">${setupTasks()}</ul>
        <p><button class="primary" data-act="all">Do all of this for me</button></p>
        ${m ? `<details><summary class="muted">Your captured Memory Overview${m.source === "manual_paste" ? " (pasted manually)" : ""}</summary><pre>${esc(m.text)}</pre></details>` : ""}
        ${manual(`
          <ol>
            <li>Click your profile icon on bottom left of dashboard → <b>Settings</b> → <b>Personalization</b> (or simply go to chatgpt.com/settings/personalization).</li>
            <li>Turn <b>Enable memory</b> on.</li>
            <li>Under <b>Additional ChatGPT settings</b>, turn <b>Web Search</b> off, then click <b>Save</b>.</li>
            <li>Click <b>Manage</b> next to Memory Overview, copy everything above the "Dive Deeper" heading and paste it here:</li>
          </ol>
          <textarea id="manualmem" placeholder="Paste your Memory Overview — it's saved when you click Next"></textarea>
          <p>If the helper can't read a toggle, confirm it yourself:</p>
          <label class="check"><input type="checkbox" id="selfmem" ${D().settings?.memory_enabled?.self_report ? "checked" : ""}> "Enable memory" is on</label>
          <label class="check"><input type="checkbox" id="selfweb" ${D().settings?.web_search?.self_report === false ? "checked" : ""}> "Web Search" is off</label>`)}`;
    },
    bind: () => {
      $("#selfmem").onchange = (e) => saveSettings({ memSelf: e.target.checked ? true : null });
      $("#selfweb").onchange = (e) => saveSettings({ webSelf: e.target.checked ? false : null });
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
      const pasted = $("#manualmem").value.trim();
      if (!D().memory_overview && pasted) D().memory_overview = { text: pasted, source: "manual_paste", captured_at: now(), flags: ["manual_entry"] };
      await openSettings();
      const r = await until(() => run("readSettings", true), (v) => v?.memory_enabled != null && v?.web_search != null, 5000);
      if (r?.on_page) await saveSettings({ observed: r }, false);
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
    html: (s) => s.part.temporary ? `
      <p>To see how ChatGPT personalizes its answers, we first need its <b>baseline</b> answers, which <i>aren't</i> personalized to you.
      Temporary Chat gives us these "unpersonalized" responses and operates in an incognito mode.</p>
      <p>For this section, we will ask you to insert ${D().battery.items.length} prompts one by one, each in a new Temporary Chat:</p>
      <img class="shot" src="assets/${basicPlan() ? "free-go-temp-chat.jpg" : "paid-temp-chat-toggle.jpg"}" alt="The Temporary Chat icon at the top right of ChatGPT, off and then on">
      <p class="muted">Don't tell ChatGPT you're in a study, and don't send anything other than the prompt.</p>` : `
      <p>That's Part 1 done!</p>
      <p>Now we will ask ChatGPT for the <b>personalized</b> answers: the same ${D().battery.items.length} prompts again, each in a <b>new regular chat</b> (Temporary Chat off).</p>`
  },

  capture: {
    nextLabel: "Check & save",
    html: (s) => {
      const { temporary } = s.capture, rec = getRecord(s), text = promptOf(s);
      return `
        <p>1. ${act("newchat", temporary ? "Open a new Temporary Chat" : "Open a new chat")}.</p>
        <div class="stepline"><span>2.</span><div>${confirmBox(temporary)}</div></div>
        <p>3. ${act("insert", "Insert the prompt")}, then press ${sendIcon(temporary)} in ChatGPT to send it.</p>
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
    bind: bindConfirm,
    // Checks run silently; they only become messages when Next is clicked. A finished response highlights Next.
    live: async (s) => {
      if (getRecord(s)) return;
      try { ui.conv = await run("readConversation"); } catch { ui.conv = null; }
      if (step().id !== s.id) return; // the participant moved on while ChatGPT was being read
      const text = ui.conv?.messages.find((m) => m.role === "assistant")?.text ?? null;
      if (ui.conv) ui.conv.stable = text !== null && text === ui.lastText;
      ui.lastText = text;
      const ready = !!ui.conv && !blockers(checks(ui.conv, s)).length;
      $("#next").classList.toggle("ready", ready);
      const status = $("#status");
      if (status) status.innerHTML = ready ? `<span class="ok">✓ ChatGPT has responded. Click <b>Check &amp; save</b>.</span>`
        : `<span class="muted">When ChatGPT has finished responding, click Check &amp; save.</span>`;
    },
    actions: {
      newchat: (s) => openChat(s.capture.temporary ? TEMP_URL : CHATGPT),
      insert: (s) => insert(promptOf(s)),
      redo: async (s) => {
        ui.discarded = getRecord(s)?.response_text ?? null;
        await update((d) => { delete d.responses[s.id]; });
      },
    },
    next: async (s) => {
      if (getRecord(s)) return;
      if (!ui.confirmed) return ["Tick the box in step 2 once ChatGPT's settings match."];
      await VIEWS.capture.live(s);
      await sleep(900);
      await VIEWS.capture.live(s); // second read confirms the response stopped changing
      const blocking = ui.conv ? blockers(checks(ui.conv, s)) : [];
      if (ui.conv && !blocking.length) return saveCapture(s, ui.conv);
      const pasted = $("#manualresp").value.trim();
      if (pasted) return setRecord(s, { ...recordBase(s), response_text: pasted, source: "manual_paste", captured_at: now(), flags: ["manual_entry"] });
      if (!ui.conv) return ["Switch to your ChatGPT tab first."];
      return blocking.map((c) => c.hint);
    },
  },

  rank: {
    nextLabel: "Save & continue",
    html: (s) => {
      const it = item(s.rank);
      const order = (ui.order ||= [...(D().rankings[it.prompt_id]?.order || it.options)]);
      return `
        <p>${esc(it.ranking_question)}</p>
        <p class="muted">Drag to reorder: most important at the top.</p>
        <ol class="rank">${order.map((o) => `<li draggable="true" data-v="${esc(o)}"><span class="grip">⋮⋮</span>${esc(o)}</li>`).join("")}</ol>`;
    },
    bind: () => {
      const list = $("ol.rank");
      let dragged = null;
      list.querySelectorAll("li").forEach((li) => {
        li.ondragstart = () => { dragged = li; li.classList.add("dragging"); };
        li.ondragend = () => { li.classList.remove("dragging"); ui.order = [...list.children].map((x) => x.dataset.v); };
        li.ondragover = (e) => {
          e.preventDefault();
          const r = li.getBoundingClientRect();
          if (dragged && dragged !== li) list.insertBefore(dragged, e.clientY < r.top + r.height / 2 ? li : li.nextSibling);
        };
      });
    },
    next: (s) => {
      const it = item(s.rank);
      return update((d) => { d.rankings[it.prompt_id] = { dataset: it.dataset, question: it.ranking_question, order: [...ui.order], saved_at: now() }; });
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
        ${guessFollowup() ? `<p class="warn">⚠ Its response mentions "unknown" or a refusal, so some traits are probably missing.</p>` : ""}
        ${radio("none", "No, it guessed every trait")}
        ${radio("done", "Yes, and I'll ask the follow-up questions")}
        ${radio("skipped", "Yes, but I'd rather skip the follow-up")}
        <div ${mode === "done" || mode === "skipped" ? "" : "hidden"}>
          <p>Which traits are missing?</p>
          <details class="dropdown"><summary id="traitsum">${traitSummary()}</summary>
            <div class="menu">${FIELDS.map(([label, name]) => `<label class="check"><input type="checkbox" name="trait" value="${name}" ${ui.traits.includes(name) ? "checked" : ""}> ${label}</label>`).join("")}</div>
          </details>
        </div>
        <div ${mode === "done" ? "" : "hidden"}>
          <p>1. ${act("newchat", "Open a new chat")}.</p>
          <div class="stepline"><span>2.</span><div>${confirmBox(false)}</div></div>
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
      newchat: () => openChat(CHATGPT),
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
        if (c.url === D().responses.traits?.conversation_url) return [`This is the profile-card chat. ${act("newchat", "Open a new chat")} for the follow-up.`];
        return [`No follow-up answer on the ChatGPT page yet. ${act("newchat", "Open a new chat")} and send Prompt 1.`];
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
      const rows = steps().filter((s) => s.capture || s.rank !== undefined || ["account", "setup", "followup"].includes(s.id)).map((s) => {
        const rec = recordOf(s), flags = rec?.flags || [];
        return { missing: !rec, html: `<tr><td>${esc(s.title)}</td><td>${!rec ? `<span class="bad">✗ missing</span>` : flags.length ? `<span class="warn">⚠ ${esc(flags.join(", "))}</span>` : `<span class="ok">✓</span>`}</td></tr>` };
      });
      const complete = !rows.some((r) => r.missing);
      return `
        <table>${rows.map((r) => r.html).join("")}</table>
        ${complete ? `<p>All done. Download your data and upload the <code>.json</code> file in the survey.</p>` : `<p class="bad">Some steps are missing — go Back to finish them.</p>`}
        <p><button id="dl" class="primary" ${complete ? "" : "disabled"}>Download my data</button> ${act("preview", "Preview")}</p>
        <pre id="json" hidden></pre>
        <details class="manual"><summary>Withdraw</summary><p>This permanently deletes everything this helper stored in your browser.</p><p>${act("wipe", "Delete my data")}</p></details>`;
    },
    bind: () => {
      $("#dl").onclick = async () => {
        D().completed_at = now();
        await save();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify(D(), null, 2)], { type: "application/json" }));
        a.download = `piw_${D().participant_id.replace(/\W+/g, "_")}_${D().completed_at.slice(0, 10)}.json`;
        a.click();
      };
    },
    actions: {
      preview: () => { const p = $("#json"); p.hidden = !p.hidden; p.textContent = JSON.stringify(D(), null, 2); },
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
  d.settings ||= { memory_enabled: { observed: null, self_report: null }, web_search: { observed: null, self_report: null }, flags: [] };
  if (observed) {
    if (observed.memory_enabled != null) d.settings.memory_enabled.observed = observed.memory_enabled;
    if (observed.web_search != null) d.settings.web_search.observed = observed.web_search;
    d.settings.observed_at = now();
  }
  if (memSelf !== undefined) d.settings.memory_enabled.self_report = memSelf;
  if (webSelf !== undefined) d.settings.web_search.self_report = webSelf;
  d.settings.flags = ["memory_enabled", "web_search"].filter((k) => d.settings[k].observed == null && d.settings[k].self_report != null).map((k) => `${k}_self_reported`);
  await save();
  if (rerender) render();
}

const openSettings = async () => { if (!(await chatTab())?.url.includes("/settings/personalization")) await openChat(SETTINGS_URL); };

async function ensureSettingsPage() {
  await openSettings();
  const r = await until(() => run("readSettings"), (v) => v?.on_page, 8000);
  if (!r?.on_page) throw new Error("Couldn't open the Personalization settings page.");
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
  if (!(await run("openMemoryOverview"))) throw new Error(`Couldn't find the "Manage" button next to Memory Overview. Use Manual steps below.`);
  let prev = null;
  const text = await until(() => run("memoryOverviewText"), (t) => { const stable = !!t && t === prev; prev = t; return stable; }, 30000);
  if (!text) throw new Error(`The Memory Overview didn't load (looked for the "Dive Deeper" heading). Try again, or use Manual steps.`);
  await update((d) => { d.memory_overview = { text, source: "auto", captured_at: now(), flags: [] }; });
}

// ---------- Prompt capture ----------

const getRecord = (s) => D().responses[s.id];
const setRecord = (s, rec) => update((d) => { d.responses[s.id] = rec; });

function recordOf(s) {
  if (s.capture) return getRecord(s);
  if (s.rank !== undefined) return D().rankings[item(s.rank).prompt_id];
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

function guessFollowup() {
  const t = D().responses.traits?.response_text || "";
  return /\bunknown\b|can['’]?t (determine|tell|guess|infer)|unable to|won['’]?t (guess|infer)|not able to/i.test(t);
}

// The follow-up chat's messages, or null if the page doesn't show a finished follow-up chat.
function followupConversation(c) {
  if (!c || c.generating || c.url === D().responses.traits?.conversation_url) return null;
  return c.messages.some((m) => m.role === "assistant" && m.text) ? c.messages : null;
}

const blockers = (L) => L.filter((c) => c.status !== "ok");

const traitSummary = () => (ui.traits.length ? FIELDS.filter(([, n]) => ui.traits.includes(n)).map(([l]) => l).join(", ") : "Select the missing traits");

function followupSteps() {
  if (!ui.traits.length) return `<p class="muted">Select the missing traits above to see the prompts.</p>`;
  const [p1, p2] = followupPrompts(ui.traits);
  return `
    <p>3. ${act("p1", "Insert Prompt 1")} and press ${sendIcon(false)} to send it.</p>${promptBlock(p1)}
    <p>4. If ChatGPT still doesn't answer, ${act("p2", "insert Prompt 2")} in the same chat and send it. Then click Next.</p>${promptBlock(p2)}`;
}

// What this step requires of the current ChatGPT page. status: ok | bad | wait; each hint says how to fix it.
function checks(conv, s) {
  const { temporary } = s.capture;
  const users = conv.messages.filter((m) => m.role === "user"), bots = conv.messages.filter((m) => m.role === "assistant");
  const u = users[0], bot = bots[0], L = [];
  const add = (code, status, hint) => L.push({ code, status, hint });
  const reopen = act("newchat", temporary ? "Open a new Temporary Chat" : "Open a new chat");

  add("temporary", conv.temporary === temporary ? "ok" : "bad", `${temporary ? "This isn't a Temporary Chat." : "This is a Temporary Chat; this prompt needs a regular one."} ${reopen}.`);
  const reused = conv.url.includes("/c/") && Object.entries(D().responses).some(([id, r]) => id !== s.id && r.conversation_url === conv.url);
  add("new_chat", !u ? "wait" : users.length === 1 && bots.length <= 1 && !reused ? "ok" : "bad",
    !u ? `${act("insert", "Insert the prompt")} and send it.` : `This chat was already used. ${reopen}.`);
  if (u) add("prompt_match", norm(u.text) === norm(promptOf(s)) ? "ok" : "bad", `The message doesn't match the prompt. ${reopen} and insert it again.`);
  add("response_complete", bot?.text && !conv.generating && conv.stable !== false ? "ok" : "wait", "Waiting for ChatGPT to finish responding.");
  if (bot?.text && bot.text === ui.discarded) add("discarded", "bad", `This is the response you discarded. ${reopen}.`);
  return L;
}

// Called once every blocking check passes, so the only possible flag is web_links.
async function saveCapture(s, conv) {
  const u = conv.messages.find((m) => m.role === "user"), bot = conv.messages.find((m) => m.role === "assistant");
  await setRecord(s, {
    ...recordBase(s),
    user_message_sent: u?.text ?? null,
    response_text: bot.text,
    response_html: bot.html,
    model_slug: bot.model_slug,
    conversation_url: conv.url,
    temporary_chat_observed: conv.temporary,
    web_links_in_response: bot.link_count,
    flags: bot.link_count ? ["web_links"] : [],
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
  if (errors?.length) { setErrors(errors); refreshBanner(); }
  else go(1);
};
async function startOver(question) {
  if (!confirm(question)) return;
  await chrome.storage.local.clear();
  state = { step: 0, data: newData() };
  ui = freshUi();
  render();
}

$("#restart").onclick = () => startOver("Start over from the beginning? This deletes everything collected so far.");
$("#close").onclick = () => window.close();
$("#goto-chatgpt").onclick = async (e) => {
  e.preventDefault();
  const [tab] = await chrome.tabs.query({ url: CHATGPT + "*", currentWindow: true });
  if (tab) chrome.tabs.update(tab.id, { active: true });
  else chrome.tabs.create({ url: CHATGPT });
};
chrome.tabs.onActivated.addListener(refreshBanner);
chrome.tabs.onUpdated.addListener(refreshBanner);
chrome.storage.local.get("piw").then(({ piw }) => {
  state = piw?.data?.schema_version === 4 ? piw : { step: 0, data: newData() };
  render();
});
