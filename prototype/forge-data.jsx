/* eslint-disable */
// Forge — autonomous content improvement. Mock data: the Synthetical
// scoring assets (personas, reference sets) the user picks from, plus a
// fully-simulated run (rounds, candidates, scores, lineage) so the loop
// can be demoed end-to-end without any backend.
//
// Naming: the feature is "Forge". The doc-pane action reads "Improve".
// Personas come from the user's *existing* Synthetical org (read-only in
// v1) — we list them, we don't author them here.

// ─── Synthetical org binding (read-only header context) ────────────────
const FORGE_ORG = { name: 'Oxbow Research', org_id: 'ssr-org-7f3a', connected: true, scoringModel: 'ssr-likert-4' };

// ─── Personas — the synthetic audience ─────────────────────────────────
// segment buckets so the gallery can group/filter. `cares` is the one-line
// the loop optimizes toward; `lean` tags how they typically score this kind
// of doc (helps the demo feel real in the per-persona breakdown).
const FORGE_PERSONAS = [
  { id: 'p-dana',   name: 'Dana Okafor',     title: 'VP, Procurement',        seg: 'Buyer',         initials: 'DO', accent: '#3D5688', cares: 'Predictable line items. Hates surprise overages.',     lean: 'tough' },
  { id: 'p-marcus', name: 'Marcus Reyes',    title: 'Eng Lead · 50-seat org', seg: 'Decision-maker',initials: 'MR', accent: '#3F6B5C', cares: "Won't get throttled mid-sprint.",                    lean: 'mid' },
  { id: 'p-priya',  name: 'Priya Nair',      title: 'FinOps Analyst',         seg: 'Buyer',         initials: 'PN', accent: '#8E3B59', cares: 'Models cost per seat to the dollar.',                lean: 'tough' },
  { id: 'p-tomas',  name: 'Tomas Berg',      title: 'Staff Engineer',         seg: 'Power user',    initials: 'TB', accent: '#C8643A', cares: 'Raw capability over price.',                        lean: 'warm' },
  { id: 'p-ling',   name: 'Ling Wei',        title: 'IT Director',            seg: 'Gatekeeper',    initials: 'LW', accent: '#2A6F8A', cares: 'Security, audit trail, a hard cap she controls.',    lean: 'tough' },
  { id: 'p-sofia',  name: 'Sofia Marchetti', title: 'Startup Founder',        seg: 'Champion',      initials: 'SM', accent: '#8A4A3A', cares: 'Speed. Will pay for leverage.',                     lean: 'warm' },
  { id: 'p-andre',  name: 'Andre Dupont',    title: 'CFO / Budget owner',     seg: 'Buyer',         initials: 'AD', accent: '#6B4A8A', cares: 'A clean ROI story for the board.',                   lean: 'mid' },
  { id: 'p-hana',   name: 'Hana Kim',        title: 'Developer Advocate',     seg: 'Influencer',    initials: 'HK', accent: '#C49A3A', cares: 'Developer experience and honest docs.',             lean: 'warm' },
  { id: 'p-ravi',   name: 'Ravi Shah',       title: 'Mid-market PM',          seg: 'Decision-maker',initials: 'RS', accent: '#4A7A6B', cares: 'Team-wide adoption without a fight.',                lean: 'mid' },
  { id: 'p-greta',  name: 'Greta Olsen',     title: 'Skeptical Engineer',     seg: 'Detractor',     initials: 'GO', accent: '#7A6F58', cares: 'Smells marketing. Wants numbers, not adjectives.',   lean: 'tough' },
  { id: 'p-noah',   name: 'Noah Bennett',    title: 'Ops Manager',            seg: 'Buyer',         initials: 'NB', accent: '#B5683A', cares: 'Billing simple enough to explain in one line.',     lean: 'mid' },
  { id: 'p-yuki',   name: 'Yuki Tanaka',     title: 'Enterprise Architect',   seg: 'Gatekeeper',    initials: 'YT', accent: '#5A6B8A', cares: 'Has to scale cleanly to 500 seats.',                lean: 'tough' },
];

// Saveable "audiences" — bundles of personas + a default reference set +
// survey question. This is how a user reuses an objective.
const FORGE_AUDIENCES = [
  { id: 'aud-eng50', name: '50-seat eng buyers', personaIds: ['p-dana','p-marcus','p-priya','p-tomas','p-ling','p-ravi','p-greta','p-noah'], refSet: 'ref-intent', question: 'q-champion', note: 'The room that has to say yes. Mix of buyers, gatekeepers and the one skeptic.' },
  { id: 'aud-proc',  name: 'Procurement panel',  personaIds: ['p-dana','p-priya','p-andre','p-ling','p-noah'], refSet: 'ref-intent', question: 'q-clarity', note: 'Money-and-risk people only. Brutal on jargon.' },
  { id: 'aud-power', name: 'Power users',        personaIds: ['p-tomas','p-sofia','p-hana','p-greta'], refSet: 'ref-champion', question: 'q-champion', note: 'The people who feel it day to day.' },
];

// Reference sets — the Likert anchor statements that calibrate the scale.
const FORGE_REFSETS = [
  { id: 'ref-intent',   name: 'B2B purchase-intent', ver: 'v3', anchors: 7, note: 'Calibrated against 1,400 real B2B buying decisions.' },
  { id: 'ref-champion', name: 'Champion likelihood', ver: 'v2', anchors: 5, note: 'How hard would they push for it internally?' },
  { id: 'ref-read',     name: 'Reading engagement',  ver: 'v1', anchors: 5, note: 'Will they keep reading past the hook?' },
];

// Survey questions personas answer.
const FORGE_QUESTIONS = [
  { id: 'q-champion', text: 'How likely are you to champion this pricing to your team?' },
  { id: 'q-clarity',  text: 'How clearly does this justify the price for what you get?' },
  { id: 'q-read',     text: 'How likely are you to keep reading past the first paragraph?' },
  { id: 'q-trust',    text: 'How much does this make you trust the company behind it?' },
];

// Mutation strategies — what the rewriter changes each round.
const FORGE_MUTATIONS = [
  { id: 'm-hook',    label: 'Reframe the hook',        on: true },
  { id: 'm-number',  label: 'Lead with the number',    on: true },
  { id: 'm-jargon',  label: 'Cut the jargon',          on: true },
  { id: 'm-struct',  label: 'Tighten the structure',   on: true },
  { id: 'm-proof',   label: 'Add proof / comparison',  on: false },
  { id: 'm-tone',    label: 'Shift the tone',          on: false },
];

// ─── The simulated run ──────────────────────────────────────────────────
// Best composite score per round, climbing toward the target. The live
// chart animates through these.
const FORGE_BASELINE = 6.1;
const FORGE_TARGET   = 7.5;
const FORGE_ROUNDS = [
  { round: 0, best: 6.1, label: 'Baseline', spend: 0,  candidates: 1 },
  { round: 1, best: 6.6, label: 'Round 1',  spend: 14, candidates: 8 },
  { round: 2, best: 7.1, label: 'Round 2',  spend: 33, candidates: 8 },
  { round: 3, best: 7.6, label: 'Round 3',  spend: 51, candidates: 8 },
];
const FORGE_BUDGET = { cap: 75, estLow: 42, estHigh: 58, spend: 51 };

// Versions (candidates) for the gallery — a curated subset across rounds,
// ranked by composite. The winner is round 3. `delta` is vs baseline.
const FORGE_VERSIONS = [
  {
    id: 'v-w', round: 3, score: 7.6, delta: +1.5, heldOut: 7.4, decision: 'winner',
    strategy: 'Plain-language units + procurement-first hook', parent: 'v-2a',
    title: 'Lead with the predictable number, bill in "AI actions"',
    excerpt: 'For a 50-seat engineering org, the question procurement actually asks is "what is the worst case on the invoice?" — so we answer it first: one predictable seat price, a soft cap you set, and usage billed in plain "AI actions," never tokens.',
    feedback: [
      { pid: 'p-dana',  score: 8.1, note: '"Worst case on the invoice" — finally, someone speaks my language. The soft cap closes my biggest objection.' },
      { pid: 'p-greta', score: 6.9, note: 'Still a touch sales-y in the middle, but the numbers are real now. I\u2019d forward this.' },
      { pid: 'p-marcus',score: 7.8, note: 'No token math to decode. I can tell my team what this costs in one sentence.' },
    ],
  },
  {
    id: 'v-2a', round: 2, score: 7.1, delta: +1.0, heldOut: 6.9, decision: 'frontier',
    strategy: 'Cut the jargon (tokens \u2192 actions)', parent: 'v-1b',
    title: 'Same case, but every "token" becomes an "AI action"',
    excerpt: 'A seat + usage hybrid at $32/seat. Each seat includes a generous monthly pool of AI actions; you only pay more if a power user blows past it, and you set the ceiling.',
    feedback: [
      { pid: 'p-priya', score: 7.4, note: 'I can model "actions" per seat. Tokens were a black box I had to pad for.' },
      { pid: 'p-ling',  score: 6.6, note: 'Better. Now show me where I set the cap.' },
    ],
  },
  {
    id: 'v-2b', round: 2, score: 6.8, delta: +0.7, heldOut: 6.5, decision: 'keep',
    strategy: 'Lead with the number', parent: 'v-1a',
    title: 'Open on $32/seat and defend it immediately',
    excerpt: '$32 per seat per month. That lands above Notion AI and below Linear Asks on purpose: premium, but never sticker shock — and here is exactly what the premium buys you.',
    feedback: [
      { pid: 'p-andre', score: 7.0, note: 'The board wants the anchor up front. This does that.' },
      { pid: 'p-tomas', score: 6.6, note: 'Fine, but I care what it does, not what it costs.' },
    ],
  },
  {
    id: 'v-1a', round: 1, score: 6.6, delta: +0.5, heldOut: 6.4, decision: 'keep',
    strategy: 'Reframe the hook', parent: 'baseline',
    title: 'Open on the buyer\u2019s fear, not our positioning',
    excerpt: 'Procurement\u2019s real worry isn\u2019t the headline price — it\u2019s the unbounded invoice. So the strongest pitch leads with the cap, not the cleverness of the hybrid.',
    feedback: [
      { pid: 'p-dana', score: 7.1, note: 'Leading with the cap is right. Now make the unit legible.' },
    ],
  },
  {
    id: 'v-1b', round: 1, score: 6.4, delta: +0.3, heldOut: 6.2, decision: 'keep',
    strategy: 'Tighten the structure', parent: 'baseline',
    title: 'Three claims, three rebuttals, nothing else',
    excerpt: 'The case in three lines; the three places it breaks in three more. No preamble.',
    feedback: [
      { pid: 'p-ravi', score: 6.7, note: 'Scannable. I got the shape in ten seconds.' },
    ],
  },
  {
    id: 'v-1c', round: 1, score: 5.8, delta: -0.3, heldOut: 5.7, decision: 'discard',
    strategy: 'Shift the tone (punchier)', parent: 'baseline',
    title: 'Aggressive, confident, lots of bold',
    excerpt: 'Stop overthinking pricing. $32. Done. Your competitors wish they had the nerve.',
    feedback: [
      { pid: 'p-greta', score: 4.9, note: 'This is exactly the marketing voice I distrust. Hard pass.' },
    ],
  },
];

// The baseline (current draft) opening — used for the diff view.
const FORGE_BASELINE_TEXT = 'For the 50-seat eng band, the strongest position is a seat + usage hybrid with a procurement-friendly cap. Bundled 10M tokens / seat / month covers the median power user with headroom; overage charged at $4 / M tokens.';

// ─── Connection state (Synthetical) ─────────────────────────────────────
// Default connected so the populated Forge page shows; Setup can toggle to
// preview the not-yet-connected onboarding.
function forgeConnected() {
  try { return localStorage.getItem('ct-forge-connected') !== '0'; } catch (e) { return true; }
}
function setForgeConnected(v) {
  try { localStorage.setItem('ct-forge-connected', v ? '1' : '0'); } catch (e) {}
  window.dispatchEvent(new Event('ct-forge-conn'));
}

// ─── Runs history — across all docs ─────────────────────────────────────
// The pricing run is the rich one (uses FORGE_VERSIONS); the rest are
// summary-level so the history list feels lived-in.
const FORGE_RUNS = [
  { id: 'run-pricing', doc: 'pricing-v2-draft.md', audience: '50-seat eng buyers', question: 'q-champion',
    status: 'completed', stopped: 'Target reached', base: 6.1, best: 7.6, target: 7.5, heldOut: 7.4,
    rounds: 3, maxRounds: 5, spend: 51, budget: 75, personas: 8, when: '12 m ago', rich: true },
  { id: 'run-launch', doc: 'launch-comms-checklist.md', audience: 'Procurement panel', question: 'q-clarity',
    status: 'running', stopped: null, base: 6.4, best: 7.0, target: 7.4, heldOut: null,
    rounds: 2, maxRounds: 5, spend: 22, budget: 60, personas: 5, when: 'now', rich: false },
  { id: 'run-notion', doc: 'notion-teardown.md', audience: 'Power users', question: 'q-trust',
    status: 'plateaued', stopped: 'Plateaued at round 4', base: 5.9, best: 6.8, target: 7.5, heldOut: 6.6,
    rounds: 4, maxRounds: 6, spend: 40, budget: 50, personas: 4, when: 'yesterday', rich: false },
  { id: 'run-weekly', doc: 'weekly-review-2026-W21.md', audience: 'Power users', question: 'q-read',
    status: 'completed', stopped: 'Target reached', base: 6.6, best: 7.3, target: 7.2, heldOut: 7.1,
    rounds: 2, maxRounds: 4, spend: 18, budget: 40, personas: 4, when: '3 d ago', rich: false },
  { id: 'run-feat', doc: 'feature-gates.md', audience: '50-seat eng buyers', question: 'q-clarity',
    status: 'cancelled', stopped: 'Cancelled at round 1', base: 6.0, best: 6.2, target: 7.5, heldOut: null,
    rounds: 1, maxRounds: 5, spend: 6, budget: 60, personas: 8, when: '4 d ago', rich: false },
];

// ─── Per-persona detail for a version (verbatim "why" + Likert spread) ───
// Keyed versionId → personaId. `likert` is the spread of samples across the
// 1–5 screening scale (sums to samples_per_response). `response` is the raw
// LLM persona answer. Falls back to the short note in FORGE_VERSIONS.feedback.
const FORGE_RESPONSES = {
  'v-w': {
    'p-dana':  { likert: [0,0,1,3,6], response: 'This is the first version that answers the question I actually ask in a vendor review: what is the worst case on this invoice? Leading with a soft cap I control, then billing in "AI actions" instead of tokens, means I can take this to finance without a translation layer. I would forward it.' },
    'p-greta': { likert: [0,1,3,4,2], response: 'The middle still has a whiff of the marketing deck, but the claims are now backed by numbers I can check, and the cap is concrete. That is enough for me to stop rolling my eyes and actually read it. Cut one more adjective and it is genuinely good.' },
    'p-marcus':{ likert: [0,0,2,4,4], response: 'No token arithmetic to decode. I can tell my team in one sentence what this costs and what happens if we go over. That is the bar for me, and this clears it.' },
    'p-priya': { likert: [0,0,2,5,3], response: 'I can finally model this. "AI actions" per seat is a unit I can forecast against last quarter\'s usage; tokens forced me to pad the estimate with a fudge factor. The soft cap also caps my downside in the model.' },
    'p-ling':  { likert: [0,1,3,4,2], response: 'Better. A cap I set is the thing I needed. I would still want a line on audit export before I sign, but the pricing story no longer blocks me.' },
  },
  'v-2a': {
    'p-priya': { likert: [0,1,3,4,2], response: 'Renaming tokens to "actions" is the right move — it is a unit I can put in a spreadsheet. Still want to see where the cap is set, but this is progress.' },
    'p-ling':  { likert: [0,2,4,3,1], response: 'Legible now. The cap is implied but not shown. Show me the control and I move up a point.' },
  },
  'v-2b': {
    'p-andre': { likert: [0,1,3,4,2], response: 'The board wants the anchor stated plainly and defended. Opening on $32 and immediately justifying it is the structure I would present.' },
    'p-tomas': { likert: [1,2,4,2,1], response: 'It is fine. I just care more about what the product does than how the price is framed. The price-first framing is not aimed at me.' },
  },
  'v-1c': {
    'p-greta': { likert: [4,3,2,1,0], response: 'This is exactly the swaggering marketing voice that makes me distrust a vendor. "Your competitors wish they had the nerve" tells me nothing and insults my time. Hard pass.' },
  },
};

// helper: average of a likert spread on the 1–5 scale
function forgeLikertMean(arr) {
  const n = arr.reduce((a, b) => a + b, 0) || 1;
  return arr.reduce((a, b, i) => a + b * (i + 1), 0) / n;
}

Object.assign(window, {
  forgeConnected, setForgeConnected, FORGE_RUNS, FORGE_RESPONSES, forgeLikertMean,
});

Object.assign(window, {
  FORGE_ORG, FORGE_PERSONAS, FORGE_AUDIENCES, FORGE_REFSETS, FORGE_QUESTIONS,
  FORGE_MUTATIONS, FORGE_BASELINE, FORGE_TARGET, FORGE_ROUNDS, FORGE_BUDGET,
  FORGE_VERSIONS, FORGE_BASELINE_TEXT,
});
