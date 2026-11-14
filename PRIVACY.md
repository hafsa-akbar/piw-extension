# PIW Study Helper — Privacy Policy

PIW Study Helper is a Chrome extension for participants in the MIT research study "LLM Personalization in the Wild".
It helps participants send the study's prompts to ChatGPT and collect ChatGPT's responses.

## What the extension reads

Only while a participant works through the study steps, and only on chatgpt.com:

- the participant's Prolific ID and ChatGPT plan (typed or chosen in the extension)
- whether ChatGPT's "Enable memory" and "Web search" settings are on
- the participant's ChatGPT Memory Overview
- the study prompts and ChatGPT's responses to them, in the chats opened for the study
- the participant's answers in the extension (which example response they prefer, and follow-up choices)

It does not read other conversations, the chat history list, names, email addresses, or anything on other websites.

## Where the data goes

The extension does not send this data anywhere. It is stored in the participant's own browser
(`chrome.storage.local`) until the participant downloads it as a file on the last step and uploads that file to the study
survey. Participants can review the file before uploading it. The file includes an `integrity` checksum of its own
contents (no extra data) so the research team can tell whether a file was edited after download.

The extension makes two kinds of network request. It downloads the public list of study prompts from GitHub
(github.com/hafsa-akbar/llm-personalization-ecological-validity); that request contains no participant data. It also
contacts the study's allocation server (Supabase) twice: at consent, sending only a randomly generated participant key
to receive the participant's assigned prompt IDs, and at download, to record that the file was downloaded. The Prolific
ID, ChatGPT content, memory text, and responses are never sent to either.

## How the research team handles submitted data

Submitted data is anonymized and kept in a password-protected database that only the researchers can access.
It is never sold or publicly shared, and it is used only for this study. All data will be deleted by December 2030.

## Your control

Participants can stop at any time. "Start over" (↺) or "Delete my data" erases everything the extension stored, and
removing the extension does the same.

## Contact

Hafsa Akbar, MIT — hafsa@mit.edu
