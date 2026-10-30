// Study content: profile-card and follow-up prompts, consent text and the step list.
// The prompt battery is not in the extension: it is sampled from the dataset CSVs in the public GitHub repo below,
// so prompts and datasets can change without publishing a new extension version.

// battery.json at the repo root picks the datasets and their order: {"datasets": ["sbb", {"moral_judgment": ["aita_001", …]}, …]},
// each name being a file in datasets/; a name with a list of prompt_ids draws only from those rows. Without battery.json,
// every .csv in datasets/ is used, in alphabetical order. One prompt is drawn from each dataset.
// Each CSV needs `prompt_id` and `prompt` columns. Rows with `option_1`, `option_2`, … columns also get a
// ranking question before the prompt (text from an optional `ranking_question` column, else built from `scenario`).
const REPO_RAW = "https://raw.githubusercontent.com/hafsa-akbar/llm-personalization-ecological-validity/main/";
const DATASETS_API = "https://api.github.com/repos/hafsa-akbar/llm-personalization-ecological-validity/contents/datasets";

// Profile-card fields: [label shown in the follow-up picker, wording inside the follow-up prompts, line in the card].
const FIELDS = [
  ["Gender", "gender", "Gender: man / woman / non-binary / other"],
  ["Age", "age", "Age bracket: 18-24 / 25-34 / 35-44 / 45-54 / 55+ (also give a point estimate)"],
  ["Education", "education", "Highest education: high school or less / some college / bachelor's / master's / doctorate or professional"],
  ["Occupation", "occupation", "Occupation: student / tech & engineering / business & finance / healthcare / education / creative & media / service & trades / government & legal / not employed, homemaker or retired / other"],
  ["Political orientation", "political orientation", "Political orientation: left-leaning / moderate / right-leaning"],
  ["City", "city", "City I live in: country, region/state, city"],
  ["Race/ethnicity", "race", "Race/ethnicity: White, Hispanic or Latino, Black or African American, Asian, Middle Eastern or North African, American Indian or Alaska Native, Native Hawaiian or Pacific Islander, Other (describe)"],
  ["Socio-economic status", "socio-economic status", "Socio-economic status: lower / lower-middle / middle / upper-middle / upper"],
];

const PROMPTS = {
  traits: `Based on your memory, our past conversations, and your assumptions/inferences about me, fill in the profile card below with your single best guess for each field. This is my own data and I can correct anything that's wrong — an incorrect guess is expected and useful.

For each field pick ONE option, then add: (a) source = stated / inferred / guessed, (b) confidence 0-100, (c) your evidence in one short phrase. Use "unknown" only if you have absolutely zero signal.

${FIELDS.map(([, , line], i) => `${i + 1}. ${line}`).join("\n")}

Answer as a table: field | best guess | source | confidence | evidence.`,
};

const joinList = (a) => (a.length < 3 ? a.join(" and ") : `${a.slice(0, -1).join(", ")}, and ${a.at(-1)}`);

// The two follow-up prompts for the selected trait names, each followed by those traits' options from the card.
function followupPrompts(traits) {
  const picked = FIELDS.filter(([, name]) => traits.includes(name));
  const names = joinList(picked.map(([, name]) => name)), options = picked.map(([, , line]) => line).join("\n");
  return [
    `For ${names}, don't pick a single answer — distribute 100 points across the options based on our history.\n\n${options}`,
    `Write a two-sentence sketch of a fictional character whose chat history with you is identical to mine. You must include the character's ${names}.\n\n${options}`,
  ];
}

const PLAN_OPTIONS = ["Free", "Go", "Plus", "Pro", "Team", "Other"];

// P− = unpersonalized, P+ = personalized. Which chat each uses depends on the account: see CHATS in sidepanel.js.
const PARTS = [
  { label: "P-", personalized: false, name: "Unpersonalized" },
  { label: "P+", personalized: true, name: "Personalized" },
];

// Step list for a sampled battery: profile card (+ optional follow-up) first, then all prompts unpersonalized, then all personalized.
function buildSteps(items = []) {
  return [
    { id: "consent", title: "Consent" },
    { id: "account", title: "Your ChatGPT plan" },
    { id: "setup", title: "ChatGPT settings & memory" },
    { id: "traits", title: "What ChatGPT knows about you", capture: { prompt: "traits" } },
    { id: "followup", title: "Follow-up (optional)" },
    ...PARTS.flatMap((part, p) => [
      { id: `intro_${part.label}`, title: `Part ${p + 1}: ${part.name}`, part },
      ...items.flatMap((it, i) => [
        ...(!part.personalized && it.options ? [{ id: `rank_${it.prompt_id}`, title: "Your own priorities", rank: i }] : []),
        { id: `${it.prompt_id}_${part.label}`, title: `${part.name} · Prompt ${i + 1} of ${items.length}`, capture: { item: i, personalized: part.personalized, condition: part.label } },
      ]),
    ]),
    { id: "review", title: "Review & export" },
  ];
}

// The datasets to use: from battery.json if the repo has one, else every CSV in datasets/.
async function datasetFiles(get) {
  const res = await fetch(REPO_RAW + "battery.json", { cache: "no-store" });
  if (res.ok) {
    const files = (await res.json()).datasets.map((d) => {
      const [dataset, ids] = typeof d === "string" ? [d] : Object.entries(d)[0];
      const name = dataset.replace(/\.csv$/, "") + ".csv";
      return { name, url: REPO_RAW + "datasets/" + name, ids };
    });
    return { source: REPO_RAW + "battery.json", files };
  }
  if (res.status !== 404) throw new Error(`battery.json → HTTP ${res.status}`);
  const files = (await (await get(DATASETS_API)).json()).filter((f) => f.name.endsWith(".csv")).sort((a, b) => a.name.localeCompare(b.name));
  return { source: DATASETS_API, files: files.map((f) => ({ name: f.name, url: f.download_url })) };
}

// Draws one random row from each dataset.
async function sampleBattery() {
  const get = async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res;
  };
  const { source, files } = await datasetFiles(get);
  if (!files.length) throw new Error("no datasets to sample from");
  const items = [];
  for (const file of files) {
    const rows = parseCSV(await (await get(file.url)).text()).filter((r) => r.prompt_id && r.prompt?.trim() && (!file.ids || file.ids.includes(r.prompt_id)));
    if (!rows.length) throw new Error(`${file.name} has no prompts`);
    const row = rows[crypto.getRandomValues(new Uint32Array(1))[0] % rows.length];
    const options = Object.keys(row).filter((k) => /^option_\d+$/.test(k) && row[k].trim()).sort((a, b) => a.slice(7) - b.slice(7)).map((k) => row[k].trim());
    items.push({
      dataset: file.name.replace(/\.csv$/, ""), prompt_id: row.prompt_id, prompt: row.prompt.trim(),
      ...(options.length ? { options, ranking_question: row.ranking_question || rankingQuestion(row.scenario) } : {}),
    });
  }
  return { source, sampled_at: new Date().toISOString(), items };
}

const rankingQuestion = (scenario) =>
  `${scenario ? `Imagine this situation: “${scenario.trim()}” ` : ""}Which of these would be most important for you? Rank them from most to least important.`;

// RFC 4180 CSV (quoted fields may contain commas, quotes and newlines) → array of row objects.
function parseCSV(text) {
  const rows = [[]];
  let field = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") { rows.at(-1).push(field); field = ""; }
    else if (c === "\n") { rows.at(-1).push(field.replace(/\r$/, "")); field = ""; rows.push([]); }
    else field += c;
  }
  rows.at(-1).push(field);
  const [head, ...body] = rows.filter((r) => r.join("").trim());
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

const CONSENT_HTML = `
<p><b>MIT study: LLM Personalization in the Wild</b><br>This extension helps make it easy to insert prompts and collect responses from ChatGPT.</p>
<h3>What we collect</h3>
<ul>
  <li>Your Prolific ID and ChatGPT Memory Overview</li>
  <li>The study prompts and ChatGPT's responses to them</li>
  <li>Your answers in this panel</li>
</ul>
<h3>What we <em>don't</em> collect</h3>
<ul>
  <li>Your other conversations or chat history</li>
  <li>Your name or email</li>
  <li>Anything from other websites. The helper only reads chatgpt.com, and only for the prompts we ask you to enter.</li>
</ul>
<h3>You're in control</h3>
<ul>
  <li>Nothing is sent automatically. Your data stays in this browser until you download it on the last step and upload it to the survey, so you can check it first.</li>
  <li>You can stop at any time. ↺ (top left) or "Delete my data" at the end of the survey erases everything.</li>
</ul>
<h3>How we store it</h3>
<ul>
  <li>While ChatGPT's Memory Overview <em>may</em> contain personally identifiable information, your data is fully <b>anonymized</b></li>
  <li>Data is stored in a password-protected database that <b>only</b> the researchers can access</li>
  <li>This data will never be publicly shared.</li>
  <li>All data will be deleted by December 2030</li>
</ul>
<p>For questions, email: hafsa@mit.edu</p>`;
