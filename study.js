// Study content: profile-card and follow-up prompts, consent text and the step list.
// The prompt battery is not in the extension: it is sampled from the dataset CSVs in the public GitHub repo below,
// so prompts and datasets can change without publishing a new extension version.

// battery.json at the repo root picks the datasets and their order: {"datasets": ["sbb", {"moral_judgment": ["aita_001", …]}, …]},
// each name being a file in datasets/; a name with a list of prompt_ids limits eligibility to those rows. Without battery.json,
// every .csv in datasets/ is used, in alphabetical order. Which prompt a participant gets per dataset is decided by the
// Supabase allocator (quota-balanced across participants; see README "Prompt allocation"), not drawn locally.
// Each CSV needs `prompt_id` and `prompt` columns; ChatGPT gets `prompt_short` instead of `prompt` when present.
// Rows with a `participant_prompt` column ("…\n\nA. …\n\nB. …\n\nWhich response do you prefer?") also get a
// pick-one question before the unpersonalized prompt; `code_1`, `code_2`, … label the options A, B, … in the data.
// A non-empty `follow_up` column adds a second message, sent verbatim in the same chat right after the response, in both parts.
const REPO_RAW = "https://raw.githubusercontent.com/hafsa-akbar/llm-personalization-ecological-validity/main/";
const DATASETS_API = "https://api.github.com/repos/hafsa-akbar/llm-personalization-ecological-validity/contents/datasets";

const SUPABASE_URL = "https://frgzptcagazvqrfaxeuz.supabase.co";
const SUPABASE_KEY = "sb_publishable_lN8gH2I7YtvN6hsge2Rh8Q_tr7xtqbL";

// Calls a study Edge Function (allocate / submit).
async function supa(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${fn} → HTTP ${res.status}`);
  return data;
}

// Profile-card fields: [label shown in the follow-up picker, wording inside the follow-up prompts, line in the card,
// optional line used instead in the point-split follow-up when the field has no fixed options].
const FIELDS = [
  ["Gender", "gender", "Gender: male / female / transgender / none of these"],
  ["Age", "age", "Age bracket: 18-24 / 25-34 / 35-44 / 45-54 / 55-64 / 65+ (also give a point estimate)"],
  ["Education", "education", "Highest education: less than high school / high school graduate (incl. GED) / some college, no degree / associate's degree / bachelor's degree / master's degree / doctoral or professional degree"],
  ["Employment status", "employment status", "Employment status: employed / unemployed and looking for work / not in the labor force (e.g., student, homemaker, retired)"],
  ["Occupation group", "occupation", "Occupation group (if employed, else \"n/a\"): management, business, and financial / computer, engineering, and science / education, legal, community service, arts, and media / healthcare practitioners and technical / service / sales and related / office and administrative support / natural resources, construction, and maintenance / production, transportation, and material moving / armed forces"],
  ["Political orientation", "political orientation", "Political orientation: very liberal / liberal / moderate / conservative / very conservative"],
  ["Location", "location", "Where I live: country, region/state, city", "Where I live: candidate places you choose (country, region/state, city for each)"],
  ["Race/ethnicity", "race/ethnicity", "Race and/or ethnicity (one or more): American Indian or Alaska Native / Asian / Black or African American / Hispanic or Latino / Middle Eastern or North African / Native Hawaiian or Pacific Islander / White"],
  ["Personal income (pre-tax)", "personal income (pre-tax)", "Personal income (pre-tax): less than $25,000 / $25,000–$49,999 / $50,000–$74,999 / $75,000–$99,999 / $100,000 or more"],
];

const PROMPTS = {
  traits: `Based on your memory, our past conversations, and your assumptions/inferences about me, fill in the profile card below with your single best guess for each field. This is my own data and I can correct anything that's wrong — an incorrect guess is expected and useful.

For each field pick ONE option (field 8 may list more than one), then add: (a) source = stated / inferred / guessed, (b) confidence 0-100, (c) your evidence in one short phrase. Use "unknown" only if you have absolutely zero signal.

${FIELDS.map(([, , line], i) => `${i + 1}. ${line}`).join("\n")}

Answer as a table: field | best guess | source | confidence | evidence.`,
};

const joinList = (a) => (a.length < 3 ? a.join(" and ") : `${a.slice(0, -1).join(", ")}, and ${a.at(-1)}`);

// The two follow-up prompts for the selected trait names, each followed by those traits' options from the card.
function followupPrompts(traits) {
  const picked = FIELDS.filter(([, name]) => traits.includes(name));
  const names = joinList(picked.map(([, name]) => name)), options = picked.map(([, , line]) => line).join("\n");
  const splitOptions = picked.map(([, , line, split]) => split ?? line).join("\n");
  return [
    `For ${names}, don't pick a single answer — distribute 100 points across the options based on our history.\n\n${splitOptions}`,
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
        ...(!part.personalized && it.choice ? [{ id: `choice_${it.prompt_id}`, title: "Your preference", choice: i }] : []),
        { id: `${it.prompt_id}_${part.label}`, title: `${part.name} · Prompt ${i + 1} of ${items.length}`, capture: { item: i, personalized: part.personalized, condition: part.label } },
        ...(it.follow_up ? [{ id: `${it.prompt_id}_${part.label}_followup`, title: `${part.name} · Prompt ${i + 1} of ${items.length} — follow-up`, capture: { item: i, personalized: part.personalized, condition: part.label, followup: true } }] : []),
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

// One prompt per dataset, assigned by the allocator; prompt text still comes from the GitHub CSVs.
// `key` is the extension-generated participant key (the server's participant_key column holds it; see the migration).
async function sampleBattery(key) {
  const get = async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res;
  };
  const { source, files } = await datasetFiles(get);
  if (!files.length) throw new Error("no datasets to sample from");
  let alloc;
  try { alloc = await supa("allocate", { participant_key: key }); }
  catch (e) { throw new Error(`no assignment (${e.message})`); }
  const items = [];
  for (const file of files) {
    const dataset = file.name.replace(/\.csv$/, "");
    const assigned = alloc.assignments[dataset];
    if (!assigned) throw new Error(`no assignment for ${dataset}`);
    // An existing assignment is honored even if battery.json has since dropped its id, so file.ids is not consulted here.
    const row = parseCSV(await (await get(file.url)).text()).find((r) => r.prompt_id === assigned && r.prompt?.trim());
    if (!row) throw new Error(`assigned prompt ${assigned} missing from ${file.name}`);
    items.push({
      dataset, prompt_id: row.prompt_id, prompt: (row.prompt_short?.trim() || row.prompt).trim(),
      ...(row.participant_prompt?.trim() ? { choice: parseChoice(row) } : {}),
      ...(row.follow_up?.trim() ? { follow_up: row.follow_up.trim() } : {}),
    });
  }
  const allocation = { stage_id: alloc.stage_id, exhausted: alloc.exhausted, existing: alloc.existing, allocated_at: new Date().toISOString() };
  return { source, sampled_at: new Date().toISOString(), allocation, items };
}

// participant_prompt → { text, intro, question, options: [{ label, text, code }] }: intro, then "A. …" blocks, then the question.
function parseChoice(row) {
  const text = row.participant_prompt.trim().replace(/\r/g, "");
  const [intro, ...blocks] = text.split(/\n\s*\n(?=[A-Z]\. )/);
  const last = blocks.pop().split(/\n\s*\n/);
  blocks.push(last.slice(0, -1).join("\n\n"));
  return {
    text, intro: intro.trim(), question: last.at(-1).trim(),
    options: blocks.map((b, i) => ({ label: b[0], text: b.slice(3).trim(), code: row[`code_${i + 1}`] || null })),
  };
}

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
