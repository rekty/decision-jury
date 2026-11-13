// The jury is made of decision models: each one returns a choice plus a probability
// for every option. Nothing the model says is trusted — keys are checked against the
// options the round actually offers, numbers are parsed and re-normalised, and a reply
// that cannot be read is retried once and then dropped from the jury.

export const JURY_MODELS = [
  { id: "vllm-sr/d3", label: "d3", free: true },
  { id: "microsoft/microsoft-decision-1", label: "MD-1", free: true },
  { id: "typesafe/jev-1.14", label: "Jev", free: false },
  { id: "openai/gpt-6-luna-decisions", label: "Luna", free: false },
  { id: "liquid/d1", label: "D1", free: false },
  { id: "jaredpalmer/kev-4b", label: "Kev", free: false },
  { id: "perplexity/pplx-decider-v1.2", label: "Decider", free: false },
];

// Measured with /alpha/decisions: both answer a `choice` question with probabilities.
export const VERIFIED_MODELS = ["vllm-sr/d3", "microsoft/microsoft-decision-1"];

export function isVerified(id) {
  return VERIFIED_MODELS.includes(String(id || ""));
}

export function modelLabel(id) {
  return JURY_MODELS.find((m) => m.id === id)?.label || String(id || "?");
}

export const MAX_ATTEMPTS = 2;

// Four dilemmas, each with the facts the models need and two or three options.
export const DILEMMAS = [
  {
    id: "trolley",
    title: "The lever",
    state:
      "A runaway trolley is rolling toward five track workers who cannot hear it. You stand at a lever that would divert it onto a side track, where one worker is standing. Nobody else can act, and there is no time to warn anyone.",
    question: "Should the lever be pulled?",
    options: [
      { key: "pull", label: "Pull the lever", detail: "One dies instead of five." },
      { key: "stay", label: "Do nothing", detail: "You did not choose the track." },
    ],
  },
  {
    id: "ship",
    title: "Ship it Friday",
    state:
      "A small team has a payment feature that passes its tests but has never run against a real bank sandbox. Deploying on Friday afternoon means a bug would sit until Monday. Waiting a week delays a launch that three customers have already been promised.",
    question: "What should the team do?",
    options: [
      { key: "ship", label: "Deploy on Friday", detail: "Keep the promise, accept the risk." },
      { key: "wait", label: "Wait for Monday", detail: "Test in the sandbox, break the promise." },
      { key: "flag", label: "Ship behind a flag", detail: "Deploy, but off by default." },
    ],
  },
  {
    id: "hire",
    title: "The strong maybe",
    state:
      "A five-person team has one open role. Candidate A is excellent but needs three months of onboarding. Candidate B is adequate today and can start on Monday. The team is already behind on a deadline that pays for both salaries.",
    question: "Who should be hired?",
    options: [
      { key: "a", label: "Candidate A", detail: "Best long-term, slow start." },
      { key: "b", label: "Candidate B", detail: "Ships now, lower ceiling." },
    ],
  },
  {
    id: "refund",
    title: "The late refund",
    state:
      "A customer bought a yearly plan eleven months ago and used it heavily. They now ask for a full refund because they are switching jobs. The terms allow a refund only in the first thirty days, but the support agent has discretion and the customer is calm and polite.",
    question: "Should the refund be granted?",
    options: [
      { key: "full", label: "Full refund", detail: "Break the terms, keep goodwill." },
      { key: "none", label: "Refuse", detail: "Apply the terms as written." },
      { key: "partial", label: "Partial refund", detail: "Meet in the middle." },
    ],
  },
];

export function dilemmaById(id) {
  return DILEMMAS.find((d) => d.id === id) || null;
}

export function optionKeys(dilemma) {
  return (dilemma?.options || []).map((option) => option.key);
}

/** The request body for POST /alpha/decisions. */
export function decisionBody(dilemma) {
  const criteria = {};
  for (const option of dilemma.options) criteria[option.key] = `${option.label} — ${option.detail}`;
  return {
    state: `${dilemma.state}\n\nDecide as a careful, practical person would.`,
    questions: {
      verdict: {
        type: "choice",
        instructions: dilemma.question,
        criteria,
      },
    },
  };
}

const num = (value) => {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

/** Turn whatever the model sent into a distribution over the round's options, or null. */
export function normalizeProbabilities(raw, keys) {
  if (!raw || typeof raw !== "object" || !keys.length) return null;
  const picked = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key)) continue;
    const p = num(value);
    if (p === null || p < 0) continue;
    picked[key] = p;
  }
  const sum = Object.values(picked).reduce((a, b) => a + b, 0);
  if (!Object.keys(picked).length || sum <= 0) return null;
  const distribution = {};
  for (const key of keys) distribution[key] = (picked[key] || 0) / sum;
  return distribution;
}

/**
 * Read one /alpha/decisions reply. Returns `{ choice, distribution, confidence }`, or
 * `{ error }` when the answer is missing, names an option the round does not offer, or
 * carries no usable probabilities.
 */
export function parseDecision(raw, keys) {
  let body = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      return { error: "reply was not JSON" };
    }
  }
  const answer = body?.answers?.verdict || body?.answers?.[Object.keys(body?.answers || {})[0]] || null;
  if (!answer || typeof answer !== "object") return { error: "no answer for the question" };
  const distribution = normalizeProbabilities(answer.probabilities, keys);
  if (!distribution) return { error: "no usable probabilities" };
  let choice = typeof answer.choice === "string" ? answer.choice : null;
  if (!choice || !keys.includes(choice)) {
    choice = keys.reduce((best, key) => (distribution[key] > distribution[best] ? key : best), keys[0]);
  }
  const confidence = num(answer.confidence);
  return { choice, distribution, confidence: confidence === null ? null : Math.min(1, Math.max(0, confidence)) };
}

/** The jury's own distribution: the mean of every member's distribution. */
export function aggregate(members, keys) {
  const usable = (members || []).filter((member) => member && member.distribution);
  if (!usable.length) return null;
  const distribution = {};
  for (const key of keys) {
    distribution[key] = usable.reduce((sum, member) => sum + (member.distribution[key] || 0), 0) / usable.length;
  }
  const ranked = [...keys].sort((a, b) => distribution[b] - distribution[a]);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const topVotes = usable.filter((member) => member.choice === winner).length;
  return {
    distribution,
    winner,
    margin: runnerUp === undefined ? 1 : distribution[winner] - distribution[runnerUp],
    votes: topVotes,
    size: usable.length,
    unanimous: topVotes === usable.length,
    split: members.length - usable.length,
  };
}

/** Chips risked against the verdict: even money, doubled when the jury is unanimous. */
export function settle({ bet, correct, unanimous }) {
  const stake = Math.max(0, Math.round(Number(bet) || 0));
  if (!correct) return { delta: -stake, payout: 0 };
  const payout = stake * (unanimous ? 2 : 1);
  return { delta: stake * (unanimous ? 1 : 0), payout };
}

/** One model's verdict, with a single stricter retry when the reply is unusable. */
export async function askMember({ model, dilemma, send, maxAttempts = MAX_ATTEMPTS }) {
  const keys = optionKeys(dilemma);
  const body = decisionBody(dilemma);
  let attempts = 0;
  let lastError = null;
  let ms = 0;
  let usage = null;
  while (attempts < Math.max(1, maxAttempts)) {
    attempts += 1;
    const reply = await send({ model, body: attempts === 1 ? body : {
      ...body,
      questions: { ...body.questions, verdict: { ...body.questions.verdict, instructions: `${dilemma.question} Answer with one of these keys only: ${keys.join(", ")}.` } },
    } });
    const payload = reply?.text ?? reply;
    const parsed = parseDecision(payload, keys);
    ms = Number(reply?.ms) || 0;
    if (reply?.usage) usage = { ...(usage || {}), ...reply.usage };
    if (!parsed.error) return { model, ...parsed, attempts, ms, usage };
    lastError = parsed.error;
  }
  return { model, error: lastError, attempts, ms, usage };
}

/** Ask the whole jury, in order so the page can show progress. */
export async function runJury({ dilemma, models, send, maxAttempts = MAX_ATTEMPTS, onMember }) {
  const members = [];
  for (const model of models) {
    // One model refusing (402 on a paid model, a timeout) costs that member only.
    let member;
    try {
      member = await askMember({ model, dilemma, send, maxAttempts });
    } catch (error) {
      member = { model, error: error?.message || "the request failed", attempts: 0 };
    }
    members.push(member);
    onMember?.(member, members.length);
  }
  const result = aggregate(members, optionKeys(dilemma));
  return {
    members,
    ...(result || {
      distribution: null,
      winner: null,
      normalized: false,
      votes: 0,
      size: 0,
      unanimous: false,
      split: members.length,
      margin: 0,
      error: "the jury returned nothing usable",
    }),
  };
}
