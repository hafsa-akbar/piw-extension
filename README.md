# PIW Study Helper

Chrome extension for the MIT study **LLM Personalization in the Wild**. It opens in the side panel next to ChatGPT, guides
participants through the study, inserts each prompt, and saves ChatGPT's responses to a file they upload to the survey.
It only works on chatgpt.com and never sends participant data anywhere ([privacy policy](PRIVACY.md)).

## Try it locally

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension icon next to a chatgpt.com tab.

## Prompts

The prompts are not in the extension. Each participant gets one random prompt from each dataset listed in `battery.json` in
[llm-personalization-ecological-validity](https://github.com/hafsa-akbar/llm-personalization-ecological-validity).
An entry can also limit a dataset to some of its prompts, e.g. `{"moral_judgment": ["aita_001", "aita_004"]}`.
Edit that repo to change prompts; no new extension version needed.

## Files

| | |
|---|---|
| `study.js` | profile-card prompt, follow-ups, consent text, step order |
| `sidepanel.js` | the panel's steps and checks |
| `chatgpt.js` | reads and fills the ChatGPT page (update its selectors if ChatGPT changes) |
| `store/` | Chrome Web Store listing text and images |
| `scripts/test_e2e.py` | end-to-end test against a mocked ChatGPT |

## Release

Bump `version` in `manifest.json`, then zip and upload it in the Chrome Web Store dashboard:

```sh
zip -qr ../piw-extension.zip manifest.json background.js chatgpt.js study.js sidepanel.* assets icons -x "*.DS_Store"
```
