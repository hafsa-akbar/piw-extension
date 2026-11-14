# PIW Study Helper

Chrome extension for the MIT study **LLM Personalization in the Wild**. It opens in the side panel next to ChatGPT, guides
participants through the study, inserts each prompt, and saves ChatGPT's responses to a file they upload to the survey.
It only works on chatgpt.com; responses stay in the browser until the participant uploads them — only a random participant
key and assigned prompt IDs reach the study's allocation server ([privacy policy](PRIVACY.md)).

## Try it locally

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension icon next to a chatgpt.com tab.

## Prompts

The prompts are not in the extension. Each participant gets one prompt from each dataset listed in `battery.json` in
[llm-personalization-ecological-validity](https://github.com/hafsa-akbar/llm-personalization-ecological-validity).
An entry can also limit a dataset to some of its prompts, e.g. `{"moral_judgment": ["aita_001", "aita_004"]}`.
ChatGPT is sent `prompt_short` if the CSV has it, else `prompt`. A CSV with a `participant_prompt` column (like
`value_alignment.csv`: a question, options `A.`–`D.`, then "Which response do you prefer?") also asks the participant
to pick one option before that prompt's unpersonalized chat; `code_1`…`code_4` are saved with the pick.
Edit that repo to change prompts; no new extension version needed.

## Prompt allocation

Which prompt a participant gets per dataset is decided centrally so coverage stays balanced across participants: consent
calls the `allocate` Supabase Edge Function with a generated participant key (a UUID kept in the browser — the Prolific ID
never leaves it; the exported JSON carries both so they can be joined at analysis), and the final download calls `submit`.
Supabase stores only prompt IDs, quotas and assignment status (`supabase/`); prompt text and ChatGPT responses never pass
through it. "Start over" wipes the key, so a restarted participant counts as new — the abandoned assignment expires on
its own.

- **Eligibility**: `battery.json` (GitHub) says which prompts *can* run; `stage_prompt_targets.is_active` (Supabase) gates
  recruitment. A prompt is assigned only when both allow it — turning it off in either place stops new assignments without
  touching history. Counts live only in `assignments` and never reset, including across battery changes.
- **Balancing**: each prompt has an integer `target`; prompts are picked with probability ∝
  `max(0, target − submitted − α·pending)` (α = 0.6, env `PIW_ALPHA`). `weight`/`group_id` are bookkeeping for choosing
  targets (e.g. shares 50/12.5/12.5/12.5/12.5 → targets 60/15/15/15/15); the allocator balances on targets alone.
- **Lifecycle**: assignments stay `pending` for 70 min (env `PIW_TTL_MINUTES`), lazily `expired` afterwards; a returning
  participant always gets their original assignment back, never a reroll; downloading flips `pending`/`expired` to
  `submitted` (idempotent — repeated downloads can't double-count, and late submissions after expiry still count).
- **Exhaustion**: a category past all its targets still assigns (the least-over-target prompt) and is flagged in the
  response's `exhausted` list — explicit overflow, never a silent uniform fallback.

Test locally (Postgres + psycopg2, no supabase CLI needed): `python3 scripts/simulate_allocation.py`.
Deploy: `supabase db push`, then `supabase functions deploy allocate submit` (config.toml sets `verify_jwt = false` for
both — required, since the publishable key is not a JWT), then paste the project's publishable key into `SUPABASE_KEY` in
`study.js`. Smoke-test with that same publishable key in the `apikey` header — POST `/functions/v1/allocate` with
`{"participant_key":"smoke_test"}`, check the `assignments` rows, POST `/functions/v1/submit` and confirm it returns
`{"updated":…}` rather than a 401 — then delete the `smoke_test` rows.

## Files

| | |
|---|---|
| `study.js` | profile-card prompt, follow-ups, consent text, step order |
| `sidepanel.js` | the panel's steps and checks |
| `chatgpt.js` | reads and fills the ChatGPT page (update its selectors if ChatGPT changes) |
| `store/` | Chrome Web Store listing text and images |
| `scripts/test_e2e.py` | end-to-end test against a mocked ChatGPT |
| `scripts/simulate_allocation.py` | allocator scenario simulation against a local Postgres |
| `supabase/` | allocator: SQL migration, Edge Functions, local-test schema |
| `scripts/verify.js` | tamper check for submitted files: `node scripts/verify.js data/*.json` |
| `scripts/qualtrics_upload_check.js` | paste into the Qualtrics upload question's JS to reject bad files at upload |

## Release

Bump `version` in `manifest.json`, then zip and upload it in the Chrome Web Store dashboard:

```sh
zip -qr ../piw-extension.zip manifest.json background.js chatgpt.js study.js sidepanel.* assets icons -x "*.DS_Store"
```
