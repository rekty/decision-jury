import test from "node:test";
import assert from "node:assert/strict";
import {
  DILEMMAS,
  JURY_MODELS,
  VERIFIED_MODELS,
  MAX_ATTEMPTS,
  aggregate,
  askMember,
  decisionBody,
  dilemmaById,
  isVerified,
  modelLabel,
  normalizeProbabilities,
  optionKeys,
  parseDecision,
  runJury,
  settle,
} from "../shared/jury.js";

const trolley = dilemmaById("trolley");
const keys = optionKeys(trolley);

const reply = (over = {}) => ({
  answers: {
    verdict: {
      type: "choice",
      choice: "pull",
      confidence: 0.8,
      probabilities: { pull: 0.9, stay: 0.1 },
      ...over,
    },
  },
  usage: { input_tokens: 300, output_tokens: 40 },
});

test("the decision body asks one typed choice question with the round's options", () => {
  const body = decisionBody(trolley);
  assert.match(body.state, /trolley/i);
  assert.equal(body.questions.verdict.type, "choice");
  assert.equal(body.questions.verdict.instructions, trolley.question);
  assert.deepEqual(Object.keys(body.questions.verdict.criteria), keys);
  for (const key of keys) assert.ok(body.questions.verdict.criteria[key].length > 10);
});

test("a well-formed answer is read as choice plus distribution", () => {
  const parsed = parseDecision(reply(), keys);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.choice, "pull");
  assert.equal(parsed.confidence, 0.8);
  assert.deepEqual(parsed.distribution, { pull: 0.9, stay: 0.1 });
});

test("probabilities are re-normalised and foreign options are dropped", () => {
  const parsed = parseDecision(
    reply({ probabilities: { pull: 3, stay: 1, maybe: 99 }, choice: "maybe" }),
    keys,
  );
  assert.equal(parsed.error, undefined, "an option the round does not offer is not an error");
  assert.equal(parsed.choice, "pull", "the choice falls back to the highest probability");
  assert.deepEqual(parsed.distribution, { pull: 0.75, stay: 0.25 });
});

test("numeric strings are accepted, negatives and junk are not", () => {
  const parsed = parseDecision(reply({ probabilities: { pull: "0.6", stay: "-0.2" } }), keys);
  assert.deepEqual(parsed.distribution, { pull: 1, stay: 0 });
  assert.equal(parsed.choice, "pull");
});

test("an answer without usable probabilities is rejected", () => {
  assert.ok(parseDecision({ answers: { verdict: { choice: "pull" } } }, keys).error);
  assert.ok(parseDecision({ answers: { verdict: { probabilities: { pull: 0, stay: 0 } } } }, keys).error);
  assert.ok(parseDecision({}, keys).error);
  assert.ok(parseDecision("not json", keys).error);
  assert.ok(parseDecision(reply({ probabilities: { other: 1 } }), keys).error);
});

test("a JSON string reply is parsed like an object", () => {
  const parsed = parseDecision(JSON.stringify(reply()), keys);
  assert.equal(parsed.choice, "pull");
});

test("the answer is found even when the question key differs", () => {
  const parsed = parseDecision({ answers: { decision: { choice: "stay", probabilities: { stay: 0.7, pull: 0.3 } } } }, keys);
  assert.equal(parsed.choice, "stay");
});

test("the jury distribution is the mean of its members", () => {
  const members = [
    { model: "a", choice: "pull", distribution: { pull: 0.9, stay: 0.1 } },
    { model: "b", choice: "pull", distribution: { pull: 0.5, stay: 0.5 } },
  ];
  const result = aggregate(members, keys);
  assert.equal(result.winner, "pull");
  assert.equal(Number(result.distribution.pull.toFixed(4)), 0.7);
  assert.equal(result.size, 2);
  assert.equal(result.votes, 2);
  assert.equal(result.unanimous, true);
  assert.equal(Number(result.margin.toFixed(4)), 0.4);
});

test("a split jury is not unanimous, and failed members are counted as split", () => {
  const members = [
    { model: "a", choice: "pull", distribution: { pull: 0.8, stay: 0.2 } },
    { model: "b", choice: "stay", distribution: { pull: 0.3, stay: 0.7 } },
    { model: "c", error: "no answer" },
  ];
  const result = aggregate(members, keys);
  assert.equal(result.unanimous, false);
  assert.equal(result.size, 2);
  assert.equal(result.split, 1);
  assert.equal(Number(result.distribution.pull.toFixed(4)), 0.55);
  assert.equal(result.winner, "pull");
});

test("no usable member leaves the jury with nothing", () => {
  assert.equal(aggregate([{ error: "x" }], keys), null);
  assert.equal(aggregate([], keys), null);
  assert.equal(aggregate(undefined, keys), null);
});

test("settling chips is even money and doubles on a unanimous jury", () => {
  assert.deepEqual(settle({ bet: 25, correct: false, unanimous: true }), { delta: -25, payout: 0 });
  assert.deepEqual(settle({ bet: 25, correct: true, unanimous: false }), { delta: 0, payout: 25 });
  assert.deepEqual(settle({ bet: 25, correct: true, unanimous: true }), { delta: 25, payout: 50 });
  assert.deepEqual(settle({ bet: -10, correct: true, unanimous: false }), { delta: 0, payout: 0 });
  assert.deepEqual(settle({ bet: 12.6, correct: true, unanimous: false }), { delta: 0, payout: 13 });
});

const fakeJury = (replies) => {
  const calls = [];
  const send = async ({ model, body }) => {
    calls.push({ model, body });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next instanceof Error) throw next;
    const value = typeof next === "function" ? next(calls.length) : next;
    return typeof value === "string" ? { text: value } : value;
  };
  return { send, calls };
};

test("a member that answers first time is asked once", async () => {
  const { send, calls } = fakeJury([{ text: reply(), ms: 900, usage: { input_tokens: 10 } }]);
  const member = await askMember({ model: "vllm-sr/d3", dilemma: trolley, send });
  assert.equal(calls.length, 1);
  assert.equal(member.attempts, 1);
  assert.equal(member.choice, "pull");
  assert.equal(member.ms, 900);
  assert.deepEqual(member.usage, { input_tokens: 10 });
});

test("a member that answers with prose is retried once with a stricter ask", async () => {
  const { send, calls } = fakeJury(["I think the lever should be pulled.", { text: reply(), ms: 800 }]);
  const member = await askMember({ model: "vllm-sr/d3", dilemma: trolley, send });
  assert.equal(calls.length, 2);
  assert.equal(member.attempts, 2);
  assert.equal(member.error, undefined);
  assert.match(calls[1].body.questions.verdict.instructions, /pull, stay/);
  assert.equal(calls[1].body.state, calls[0].body.state, "the facts are unchanged on retry");
});

test("two unusable replies stop at the cap", async () => {
  const { send, calls } = fakeJury(["no", "still no"]);
  const member = await askMember({ model: "vllm-sr/d3", dilemma: trolley, send });
  assert.equal(calls.length, MAX_ATTEMPTS);
  assert.equal(member.error, "reply was not JSON");
  assert.ok(member.model);
});

test("a failing model costs that member only, not the round", async () => {
  const { send } = fakeJury([{ text: reply() }, new Error("402 paid Pollen only")]);
  const seen = [];
  const result = await runJury({
    dilemma: trolley,
    models: ["vllm-sr/d3", "liquid/d1"],
    send,
    onMember: (member, index) => seen.push(`${index}:${member.model}`),
  });
  assert.deepEqual(seen, ["1:vllm-sr/d3", "2:liquid/d1"]);
  assert.equal(result.members.length, 2);
  assert.equal(result.members[1].error, "402 paid Pollen only");
  assert.equal(result.winner, "pull");
  assert.equal(result.size, 1, "only the member that answered counts");
  assert.equal(result.split, 1);
});

test("the jury aggregates the members it got", async () => {
  const { send } = fakeJury([{ text: reply() }, { text: reply({ choice: "stay", probabilities: { pull: 0.2, stay: 0.8 } }) }]);
  const result = await runJury({ dilemma: trolley, models: ["vllm-sr/d3", "microsoft/microsoft-decision-1"], send });
  assert.equal(result.members.length, 2);
  assert.equal(result.winner, "pull");
  assert.equal(result.unanimous, false);
  assert.equal(Number(result.distribution.pull.toFixed(2)), 0.55);
});

test("every dilemma is playable", () => {
  assert.ok(DILEMMAS.length >= 4);
  assert.equal(new Set(DILEMMAS.map((d) => d.id)).size, DILEMMAS.length, "ids are unique");
  for (const dilemma of DILEMMAS) {
    assert.ok(dilemma.title.length > 2);
    assert.ok(dilemma.state.length > 40, `${dilemma.id} needs real facts`);
    assert.ok(dilemma.question.endsWith("?"));
    assert.ok(dilemma.options.length >= 2 && dilemma.options.length <= 3);
    const optionKeysList = optionKeys(dilemma);
    assert.equal(new Set(optionKeysList).size, optionKeysList.length, `${dilemma.id} option keys are unique`);
    for (const option of dilemma.options) {
      assert.ok(option.label.length > 1);
      assert.ok(option.detail.length > 5);
    }
    // Body yang benar-benar dikirim harus lolos parser yang sama setelah dibulatkan.
    const body = decisionBody(dilemma);
    const first = optionKeysList[0];
    const probs = Object.fromEntries(optionKeysList.map((key) => [key, key === first ? 0.7 : 0.3 / (optionKeysList.length - 1)]));
    const parsed = parseDecision({ answers: { verdict: { choice: first, probabilities: probs } } }, optionKeysList);
    assert.equal(parsed.choice, first);
    assert.equal(body.questions.verdict.criteria[first].length > 10, true);
  }
});

test("the model list marks only the measured models as verified", () => {
  assert.deepEqual(VERIFIED_MODELS, ["vllm-sr/d3", "microsoft/microsoft-decision-1"]);
  assert.equal(isVerified("vllm-sr/d3"), true);
  assert.equal(isVerified("typesafe/jev-1.14"), false);
  assert.equal(isVerified(undefined), false);
  for (const id of VERIFIED_MODELS) assert.ok(JURY_MODELS.some((m) => m.id === id && m.free));
  assert.equal(modelLabel("microsoft/microsoft-decision-1"), "MD-1");
  assert.equal(modelLabel("unknown/model"), "unknown/model");
  assert.equal(normalizeProbabilities({ pull: 1, stay: 1 }, ["pull"]).pull, 1);
});
