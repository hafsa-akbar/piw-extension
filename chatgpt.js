// Injected into the chatgpt.com tab on demand by the side panel (never runs on its own).
// All ChatGPT-specific selectors live here; update them if ChatGPT changes its DOM.

globalThis.PIW = {
  SEL: {
    message: "[data-message-author-role]",
    unit: "[data-chatgpt-search-unit-key]", // 2026 layout: key ends in ":user" / ":assistant"
    userBubble: '[data-user-message-bubble="true"]',
    userText: ".whitespace-pre-wrap",
    unfinishedTurn: '[data-talvt-turn-state]:not([data-talvt-turn-state="complete"])',
    messageFallback: "[data-turn]",
    turn: 'article, [data-testid^="conversation-turn"]',
    markdown: ".markdown",
    stop: '[data-testid="stop-button"], button[aria-label^="Stop"]',
    composer: '#prompt-textarea[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea#prompt-textarea, form textarea',
    switch: '[role="switch"]',
  },

  visible: (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
  norm: (s) => String(s ?? "").replace(/\s+/g, " ").trim(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  onSettingsPage: () => /\/settings\/personalization|#settings\/personalization/i.test(location.pathname + location.hash),

  // ---------- Conversation page ----------

  readConversation() {
    const S = this.SEL;
    const url = new URL(location.href);
    const messages = this.findMessages().map(([role, el]) => {
      if (role === "user") {
        const bubble = el.querySelector(S.userBubble) || el;
        return { role, text: this.stripSpeaker((bubble.querySelector(S.userText) || bubble).innerText) };
      }
      const body = el.querySelector(S.markdown) || el;
      return {
        role,
        text: this.stripSpeaker(body.innerText),
        html: body.innerHTML,
        model_slug: el.getAttribute("data-message-model-slug") || el.querySelector("[data-message-model-slug]")?.getAttribute("data-message-model-slug") || null,
        link_count: body.querySelectorAll("a[href^='http']").length,
      };
    }).filter((m) => m.role === "user" || m.role === "assistant");
    return {
      url: url.origin + url.pathname + url.search,
      temporary: url.searchParams.get("temporary-chat") === "true",
      personalized: url.searchParams.get("temporary-chat") === "true" ? this.readPersonalized() : null,
      generating: !!document.querySelector(`${S.stop}, ${S.unfinishedTurn}`),
      messages,
    };
  },

  // [role, element] pairs in page order, trying each known ChatGPT layout in turn.
  findMessages() {
    const S = this.SEL;
    const outermost = (sel) => [...document.querySelectorAll(sel)].filter((el) => !this.inSidebar(el) && !el.parentElement?.closest(sel));
    let els = outermost(S.message);
    if (els.length) return els.map((el) => [el.getAttribute("data-message-author-role"), el]);
    els = outermost(S.unit);
    if (els.length) return els.map((el) => [this.unitRole(el.getAttribute("data-chatgpt-search-unit-key")), el]);
    els = outermost(S.messageFallback);
    if (els.length) return els.map((el) => [el.getAttribute("data-turn"), el]);
    // Last resort: turn containers labelled by screen-reader headings ("You said:" / "ChatGPT said:").
    return outermost(S.turn).map((el) => {
      const label = [...el.querySelectorAll("h1, h2, h3, h4, h5, h6, .sr-only")].map((h) => h.textContent).join(" ");
      return [/you said/i.test(label) ? "user" : /chatgpt said/i.test(label) ? "assistant" : null, el];
    }).filter(([role]) => role);
  },

  unitRole: (key) => (/:user$/i.test(key) ? "user" : /assistant/i.test(key) ? "assistant" : null),

  stripSpeaker: (text) => text.replace(/^\s*(you said|chatgpt said):?\s*/i, "").trim(),

  composer() {
    return [...document.querySelectorAll(this.SEL.composer)].find(this.visible) || null;
  },

  // Puts the prompt in the composer. The participant presses Send.
  insertPrompt(text) {
    const box = this.composer();
    if (!box) return "no_composer";
    const has = () => this.norm(box.value ?? box.innerText).includes(this.norm(text).slice(0, 60));
    box.focus();
    if (box.tagName === "TEXTAREA") {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return has() ? "ok" : "failed";
    }
    const selectAll = () => getSelection().selectAllChildren(box);
    selectAll();
    const data = new DataTransfer();
    data.setData("text/plain", text);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    if (has()) return "ok";
    selectAll();
    document.execCommand("insertText", false, text);
    return has() ? "ok" : "failed";
  },

  // ---------- Personalized / Unpersonalized dropdown (top right of a Temporary Chat, on accounts that have it) ----------

  personalizedButton() {
    return [...document.querySelectorAll("button")].find((b) => this.visible(b) && /^(un)?personalized$/i.test(this.norm(b.innerText))) || null;
  },

  // true/false = Personalized/Unpersonalized; null = new chat without the dropdown. The dropdown disappears once a
  // message is sent; after that the user's bubble is blue when personalized and gray when not.
  readPersonalized() {
    const btn = this.personalizedButton();
    if (btn) return /^personalized$/i.test(this.norm(btn.innerText));
    const user = this.findMessages().find(([role]) => role === "user")?.[1];
    return user ? this.isBlue(user.querySelector(this.SEL.userBubble) || user) : null;
  },

  // Whether the first opaque background in `el` (itself or a descendant) is blue rather than gray.
  isBlue(el) {
    const bg = [el, ...el.querySelectorAll("*")].map((e) => getComputedStyle(e).backgroundColor).find((c) => !/transparent|, 0\)$/.test(c));
    if (!bg) return false;
    const [r, , b] = bg.match(/[\d.]+/g).map(Number);
    return b - r > 20;
  },

  // ChatGPT's menus open on a pointer press, not a plain click; menu items may have a description under the label.
  async setPersonalized(want) {
    const btn = this.personalizedButton();
    if (!btn) return null;
    if (this.readPersonalized() !== want) {
      this.press(btn);
      await this.sleep(400);
      const label = want ? /^personalized\b/i : /^unpersonalized\b/i;
      const item = [...document.querySelectorAll('[role^="menuitem"], [role="option"]')].find((el) => this.visible(el) && label.test(this.norm(el.innerText)));
      if (item) this.press(item);
      await this.sleep(400);
    }
    return this.readPersonalized();
  },

  press(el) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    el.click();
  },

  // ---------- Personalization settings ----------

  switchRows() {
    return [...document.querySelectorAll(this.SEL.switch)].map((sw) => {
      let row = sw;
      while (row.parentElement && row.parentElement.querySelectorAll(this.SEL.switch).length === 1) row = row.parentElement;
      const on = sw.getAttribute("aria-checked") === "true" || sw.getAttribute("data-state") === "checked";
      return { sw, label: row.innerText.trim(), on };
    });
  },

  LABELS: { memory: /enable memory|reference saved memories/i, web: /web search/i },

  findSwitch(key) {
    return this.switchRows().filter((r) => this.LABELS[key].test(r.label)).sort((a, b) => a.label.length - b.label.length)[0] || null;
  },

  clickByText(re) {
    const el = [...document.querySelectorAll("button, summary, [role=button], a")].find((b) => this.visible(b) && !b.disabled && re.test(this.norm(b.innerText)));
    el?.click();
    return !!el;
  },

  // null = toggle not found. `expand` opens "Additional ChatGPT settings" if Web Search is hidden in it.
  async readSettings(expand = false) {
    if (!this.onSettingsPage()) return { on_page: false };
    if (expand && !this.findSwitch("web") && this.clickByText(/^additional chatgpt settings/i)) await this.sleep(400);
    return { on_page: true, memory_enabled: this.findSwitch("memory")?.on ?? null, web_search: this.findSwitch("web")?.on ?? null };
  },

  // Flips a settings toggle to `want`, clicks Save if the page has one, and returns the new state.
  async setToggle(key, want) {
    if (!this.onSettingsPage()) return { on_page: false };
    if (!this.findSwitch(key) && this.clickByText(/^additional chatgpt settings/i)) await this.sleep(400);
    const row = this.findSwitch(key);
    if (!row) return { on_page: true, state: null };
    if (row.on !== want) {
      row.sw.click();
      await this.sleep(400);
      if (this.clickByText(/^save( changes)?$/i)) await this.sleep(800);
    }
    return { on_page: true, state: this.findSwitch(key)?.on ?? null };
  },

  // Clicks "Manage" next to Memory Overview.
  openMemoryOverview() {
    if (this.memoryOverviewText() !== null) return true;
    const manage = [...document.querySelectorAll("button, a, [role=button]")].filter((b) => this.visible(b) && /^manage$/i.test(this.norm(b.innerText)));
    const btn = manage.find((b) => /memory (overview|summary)/i.test(b.closest("section, li, div:has(> button)")?.innerText || "")) || manage[0];
    btn?.click();
    return !!btn;
  },

  // Everything above the "Dive deeper" heading, or null if the Memory Overview isn't open.
  memoryOverviewText() {
    const scopes = [...document.querySelectorAll('[role="dialog"]'), document.querySelector("main")].filter(Boolean).reverse();
    for (const el of scopes) {
      const text = el.innerText;
      const cut = text.search(/dive deeper/i);
      if (cut > 0) return text.slice(0, cut).trim();
    }
    return null;
  },

  inSidebar: (el) => !!el.closest('nav, aside, [aria-label="Chat history"]'),

  // Tag/attribute path from the element holding `probe` (start of the study prompt) up to <body>,
  // ignoring the chat-history sidebar. No text content.
  structureAround(probe) {
    if (!probe) return null;
    const hit = [...document.body.querySelectorAll("*")].find((el) => !this.inSidebar(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes(probe)));
    if (!hit) return "prompt not found outside the sidebar";
    const path = [];
    for (let el = hit; el !== document.body; el = el.parentElement)
      path.push(el.tagName.toLowerCase() + [...el.attributes].map((a) => `[${a.name}="${a.value.slice(0, 60)}"]`).join(""));
    return path;
  },

  // Nested tag/attribute outline of an element (3 levels, no text) — shows how responses are structured.
  outline(el, depth = 3) {
    if (!el) return null;
    const self = el.tagName.toLowerCase() + [...el.attributes].filter((a) => a.name !== "style").map((a) => `[${a.name}="${a.value.slice(0, 40)}"]`).join("");
    return depth && el.children.length ? { [self]: [...el.children].slice(0, 6).map((c) => this.outline(c, depth - 1)) } : self;
  },

  // What the reader can see, without any message or memory content. Shared by participants when something breaks.
  diagnose(probe) {
    const count = (s) => document.querySelectorAll(s).length;
    return {
      url: location.origin + location.pathname + location.search,
      messages: count(this.SEL.message),
      turns: count(this.SEL.messageFallback),
      composers: [...document.querySelectorAll(this.SEL.composer)].map((e) => `${e.tagName}#${e.id}.${e.className}`.slice(0, 80) + (this.visible(e) ? " (visible)" : "")),
      switches: this.switchRows().map((r) => `${r.label.slice(0, 50)} = ${r.on}`),
      personalized: this.readPersonalized(),
      personalized_button: this.outline(this.personalizedButton()),
      menu_items: [...document.querySelectorAll('[role^="menuitem"], [role="option"]')].map((el) => `${el.getAttribute("role")}: ${this.norm(el.innerText).slice(0, 40)}`),
      dialogs: count('[role="dialog"]'),
      stop_button: count(this.SEL.stop),
      turns_found: this.findMessages().map(([role]) => role),
      unit_keys: [...document.querySelectorAll(this.SEL.unit)].map((e) => e.getAttribute("data-chatgpt-search-unit-key")),
      turn_states: [...document.querySelectorAll("[data-talvt-turn-state]")].map((e) => e.getAttribute("data-talvt-turn-state")),
      assistant_outline: this.outline(this.findMessages().find(([role]) => role !== "user")?.[1]),
      main: !!document.querySelector("main"),
      prompt_structure: this.structureAround(probe),
    };
  },
};
