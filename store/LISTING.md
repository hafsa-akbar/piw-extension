# Chrome Web Store listing — text to paste

## Store listing tab

**Name** (from the manifest): PIW Study Helper (MIT)

**Summary** (from the manifest): Guided data collection for the MIT 'LLM Personalization in the Wild' study. Works only on chatgpt.com.

**Description:**

> PIW Study Helper is for participants in the MIT research study "LLM Personalization in the Wild". If you were not invited to the study, you don't need it.
>
> It opens in Chrome's side panel next to ChatGPT and walks you through the study step by step:
> • checks your ChatGPT memory and web search settings
> • opens each chat and inserts each study prompt for you
> • saves ChatGPT's responses, so there is no copy/paste or screenshots
>
> Everything stays in your browser until you download your data on the last step and upload it to the study survey. The extension only works on chatgpt.com, and only reads the chats opened for the study.

**Category:** Education (or Tools)
**Language:** English
**Store icon:** `store/store-icon-128.png` (128×128 with 16 px transparent padding, per the Store image guidelines)
**Screenshots:** `store/screenshot-1.png`, `store/screenshot-2.png`, `store/screenshot-3.png` (1280×800)
**Small promo tile:** `store/promo-small-440x280.png`

## Privacy practices tab

**Single purpose:**

> Guides participants of an MIT research study through sending study prompts to ChatGPT and collecting ChatGPT's responses, with their consent, into a file they upload to the study survey.

**Permission justifications:**

- **sidePanel:** The study instructions are shown in Chrome's side panel next to ChatGPT.
- **storage:** Saves the participant's progress and collected responses locally until they download them.
- **scripting:** When the participant works on a study step, reads the current ChatGPT chat or settings page and inserts the study prompt into ChatGPT's message box.
- **Host permission (https://chatgpt.com/*):** The study takes place on ChatGPT. The extension runs on no other site.

**Remote code:** No, I am not using remote code. (The prompt list downloaded from GitHub is data, not code.)

**Data usage — tick:**

- Personally identifiable information (Prolific ID; the Memory Overview may contain personal details)
- Personal communications (prompts and ChatGPT's responses)
- Website content (ChatGPT's responses and settings)

**Certify all three:** not sold to third parties; not used or transferred for purposes unrelated to the single purpose;
not used to determine creditworthiness or for lending.

**Privacy policy URL:** `https://github.com/hafsa-akbar/piw-extension/blob/main/PRIVACY.md`

## Distribution tab

**Visibility:** Unlisted (only people with the link can install it).
