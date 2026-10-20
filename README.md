# PIW Study Helper

A Chrome side-panel extension for the MIT study **"LLM Personalization in the Wild"**. It does the
ChatGPT data-collection sections of the Qualtrics pilot (Section 2 "ChatGPT Memory" and
Section 3 "Prompt Battery") for the participant: no copy/paste and no screenshots.
Screening, demographics and formal consent stay in Qualtrics.

It only works on `chatgpt.com`. Its only network request is downloading the prompt datasets from GitHub; it uploads
nothing. Data stays in the browser until the participant downloads a JSON file and uploads it to the survey.

## Setup

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (`piw-extension`).
3. Pin the extension and click its icon. The study side panel opens.
4. Open `https://chatgpt.com` in a tab of the same window and sign in.

Chrome 116 or later is required (side panel API).

## What the participant does

Every step works the same way. The instructions are short clickable actions (e.g. **Open a new Temporary Chat**,
**Insert the prompt**). **Next** checks the step and, if something is wrong, shows the first problem with a one-click fix.
Steps that read ChatGPT have a collapsed **"Not working? Manual steps"** section with a paste box (saved on Next, flagged
`manual_entry`) and **Copy diagnostic info** for reporting problems (page structure only, no message or memory text).
New steps slide in. A banner appears and Next is disabled when the active tab isn't chatgpt.com, and **✕** (top right) closes the panel. Progress is
saved (reloading the extension does not clear it), so reopening it from the toolbar icon resumes the same step.
**↺** (top left, next to the title) starts over from Consent and deletes everything collected so far.

| # | Step | What the helper does / checks |
|---|------|-------------------------------|
| 1 | Consent + Prolific ID | Nothing is read from ChatGPT before this. **Agree & start** samples the prompt battery (see below). |
| 2 | ChatGPT plan | Link to chatgpt.com/settings/billing plus a reference picture; self-reported. |
| 3 | Settings & memory | Opens the Personalization page and turns **Enable memory** on. Expands *Additional ChatGPT settings*, turns **Web Search** off and clicks **Save**. Clicks **Manage** next to Memory Overview, waits until it has loaded and stable, and saves the text above "Dive Deeper". Next re-reads the toggles. |
| 4 | Profile card | The traits prompt in a new regular chat, before any study prompt can influence it. |
| 5 | Follow-up (optional) | Participant says whether traits are missing, picks them from a multi-select, and either skips or sends the two follow-up prompts with the traits filled in. |
| 6 | Part 1: Temporary Chat (P−) | Every battery prompt, each in a new Temporary Chat. Prompts from a dataset with `option_*` columns get the participant's own ranking first. |
| 7 | Part 2: Regular chat (P+) | The same prompts, each in a new regular chat (memory on). |
| 8 | Review & export | Status table with flags, **Download my data**, Preview, Withdraw (delete). |

On every prompt step the participant ticks one box confirming ChatGPT's settings, worded for the plan chosen in step 2:

| Plan | Temporary Chat | Regular chat | "Show me how" guide |
|---|---|---|---|
| Plus, Pro, Team, Other | Thinking effort Instant, model GPT-6 | Chat selected, Instant, GPT-6 | `paid-temp-chat.gif`, `paid-chat.webm` |
| Free, Go (no model picker) | Think off | Chat selected, Think off | `free-go-think-off.jpg`, `free-go-chat.webm` |

The Part 1 intro image follows the plan too (`paid-temp-chat-toggle.jpg` / `free-go-temp-chat.jpg`).

### Prompt battery (sampled at runtime)

The battery is not part of the extension, so prompts can change without a new Chrome Web Store review. On **Agree & start**
the panel reads `battery.json` at the root of the dataset repo:

```json
{ "datasets": ["sbb", "moral_judgment", "recommendation_steering",
               "information_prioritization", "personalized_issue_framing", "explanatory_grounding"] }
```

Each name is a file in `datasets/` (`sbb` → `datasets/sbb.csv`), and participants get the datasets in this order. If the
repo has no `battery.json`, every `.csv` in `datasets/` is used, in alphabetical order (found through GitHub's API, which allows
60 requests per hour per IP address). One random row is drawn from each dataset and saved with the participant's data, so a
later edit never changes a session that has already started.

Each CSV needs `prompt_id` and `prompt` columns. Rows with `option_1`, `option_2`, … columns get a ranking question before
the P− prompt; its text comes from an optional `ranking_question` column, otherwise from `scenario`
("Imagine this situation: “…” Which of these would be most important for you?").

To add prompts, add rows. To add a dataset, add its CSV to `datasets/` and its name to `battery.json`. The repo has to stay public.

### Checklist on each prompt step

| Check | How | Blocks Next? |
|---|---|---|
| Temporary Chat on (Part 1) / off (Part 2, profile card) | URL has `temporary-chat=true` | yes |
| New chat with only the study prompt | exactly one user message, and the conversation hasn't been saved for another step | yes |
| Prompt sent exactly as written | whitespace-insensitive comparison | yes |
| ChatGPT finished responding | no stop button, and the text is unchanged between two reads | yes |
| ChatGPT settings for the plan (see above) | **not observed** — participant ticks a confirmation box | yes (box must be ticked) |
| Web links in the response | counted and saved; the record is flagged `web_links` | no |

The checks run quietly while the participant works. When the response is complete and every check passes, **Check & save**
turns green. Clicking it with a problem shows the first one, with a link to fix it. If the helper can't read the response, the participant pastes it
into the box under "Not working? Manual steps" and it is saved on Next, flagged `manual_entry` (`source: "manual_paste"`).

## Output JSON (abridged)

```jsonc
{
  "schema_version": 4, "extension_version": "1.0.0",
  "participant_id": "…", "consent": { "agreed_at": "ISO" },
  "started_at": "ISO", "completed_at": "ISO",
  "battery": { "source": "https://raw.githubusercontent.com/…/battery.json", "sampled_at": "ISO",
               "items": [{ "dataset": "sbb", "prompt_id": "sbb_001", "prompt": "…" },
                         { "dataset": "information_prioritization", "prompt_id": "info_013", "prompt": "…",
                           "options": ["…"], "ranking_question": "…" }, …] },
  "account":  { "plan": "Plus", "reported_at": "ISO" },
  "settings": { "observed_at": "ISO", "memory_enabled": { "observed": true, "self_report": null },
                "web_search": { "observed": false, "self_report": null }, "flags": [] },
  "memory_overview": { "text": "…", "source": "auto | manual_paste", "captured_at": "ISO", "flags": [] | ["manual_entry"] },
  "rankings": { "info_013": { "dataset": "information_prioritization", "question": "…", "order": ["most important first", …] } },
  "responses": {
    "sbb_001_P-": {
      "prompt_id": "sbb_001", "dataset": "sbb", "condition": "P-", "prompt": "…", "user_message_sent": "…",
      "response_text": "No", "response_html": "<p>No</p>", "model_slug": "gpt-…",
      "conversation_url": "https://chatgpt.com/?temporary-chat=true", "temporary_chat_observed": true,
      "web_links_in_response": 0, "flags": [] | ["web_links"] | ["manual_entry"],
      "source": "auto | manual_paste", "captured_at": "ISO"
    },
    "sbb_001_P+": { "condition": "P+", "temporary_chat_observed": false, … },
    "traits": { "prompt_id": "traits", "condition": null, … }
  },
  "followup": { "choice": "none | skipped | done", "missing_traits": ["political orientation", "race"],
                "prompts": ["…", "…"], "conversation": [{ "role": "user", "text": "…" }, …],
                "source": "auto | manual_paste", "captured_at": "ISO", "flags": [] },
  "unverified": ["…"]
}
```

`response_text` is the rendered text. In code blocks it includes ChatGPT's header text (e.g. `json` / `Copy code`).
`response_html` keeps the original formatting, including tables and code.

## Limitations: what can't be reliably verified

- **Web search usage: not verifiable.** The panel records the Web Search toggle as it appeared during the
  settings check and counts links in each response. A response without links does not prove search was off.
  The participant could also change the setting after the check.
- **Thinking effort / Think, model and Chat-vs-Work are self-reported.** The controls disappear from ChatGPT's page once a conversation
  starts, so the participant confirms them with a checkbox on each prompt step. Each response's model slug is still recorded.
- **Settings automation clicks ChatGPT's own controls.** It flips the toggle, then clicks "Save" if one appears, then re-reads
  the toggle to confirm. It never assumes the click worked.
- **P− / P+ is the chat type.** Temporary Chat no longer offers a personalization toggle, so P− = Temporary Chat and
  P+ = a regular chat with memory on. Regular chats are saved to the participant's history, so ChatGPT may draw on earlier
  study chats. The profile card runs first to keep it clean.
- **Temporary Chat** is detected only by the `temporary-chat=true` URL parameter.
- **Settings toggles** are matched by label text ("Enable memory" / "Reference saved memories", "Web search").
  If the wording changes, the step falls back to flagged self-report.
- **DOM drift.** All ChatGPT selectors are at the top of `chatgpt.js`. Before each study wave, do one
  full pilot run on a real account.
- **Pilot memory gate.** The memory toggle is only checked at the settings step. A participant could turn
  it off afterwards and the panel would not notice.

## Survey decisions to confirm

- Order: profile card and optional follow-up first (so the study prompts can't influence it), then all prompts in Temporary Chat, then all in regular chats.
- The follow-up prompts list every selected trait in one message (e.g. "For political orientation and race, …"), followed by
  those traits' option lines from the profile card. Card and follow-ups are built from the same `FIELDS` list in `study.js`.
  Prompt 1 no longer ends with "giving 0 to anything you'd definitively rule out" — that is the wording as given for this version.
- Profile card: field 8 "Socio-economic status: lower / lower-middle / middle / upper-middle / upper" was added (not in the pilot survey).

## Privacy design

- No content script is registered. The side panel injects `chatgpt.js` into the chatgpt.com tab only
  after consent, and only when a study step needs a reading.
- It reads only the conversation currently on screen. It never reads the chat-history sidebar or past
  conversations. It saves a response only when it passes the step's checks, or when the participant pastes it in.
- Permissions: `sidePanel`, `storage`, `scripting`, and host access to `https://chatgpt.com/*` only.
- Nothing is uploaded. The only download is the public prompt datasets (data, never code). Removing the extension or clicking "Delete my data" erases local data.

## Files

```
manifest.json      MV3 manifest
icons/             icon.svg (source) and the PNG sizes Chrome uses
background.js      opens the side panel when the icon is clicked
study.js           profile-card prompt, follow-up templates, dataset repo URLs, consent, step list
chatgpt.js         DOM reader injected into chatgpt.com         ← edit selectors here
sidepanel.*        the guided UI, validation and export
store/             Chrome Web Store listing text and images (not packaged)
PRIVACY.md         privacy policy linked from the Store listing
scripts/test_e2e.py        loads the extension in Chromium and runs the whole flow against a mocked chatgpt.com
```

```sh
pip install playwright && python3 -m playwright install chromium && python3 scripts/test_e2e.py            # add --battery to also test battery.json
```

## Publishing

`store/` holds what the Chrome Web Store asks for and is not part of the package: `LISTING.md` (text to paste into each
tab), three 1280×800 screenshots and the 440×280 promo tile. The privacy policy is `PRIVACY.md` at the top of this repo.

Build the package from this folder (bump `version` in `manifest.json` first for every update):

```sh
zip -qr -X ../piw-extension-$(grep -o '"version": "[^"]*' manifest.json | cut -d'"' -f4).zip \
  manifest.json background.js chatgpt.js study.js sidepanel.html sidepanel.css sidepanel.js assets icons -x "*.DS_Store"
```

The Store needs the privacy policy at a public URL: use the GitHub link to `PRIVACY.md` in this repo.

## What was taken from ShareLM

ShareLM collects conversations from 10+ chat sites and uploads them to a public dataset
server. This extension keeps only its ChatGPT message selectors (`[data-message-author-role]`), its
approach of reading messages from the DOM, and the idea of a consent gate before any collection. The
following were dropped: the other platforms, the Heroku upload and 24-hour queue, canvas tracking,
ratings, the popup and the on-page badges.
