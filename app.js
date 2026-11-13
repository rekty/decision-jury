import {
  DILEMMAS,
  VERIFIED_MODELS,
  aggregate,
  modelLabel,
  optionKeys,
  runJury,
  settleRound,
} from "./shared/jury.js";
import { connected, decide, pollDevice, signOut, startDevice, useKey } from "./shared/pollen.js";

const $ = (id) => document.getElementById(id);

const BETS = [10, 25, 50];
const DEMO_MEMBERS = [
  { model: "vllm-sr/d3", choice: "pull", distribution: { pull: 0.97, stay: 0.03 }, confidence: 0.95, attempts: 1, ms: 5254 },
  { model: "microsoft/microsoft-decision-1", choice: "pull", distribution: { pull: 0.65, stay: 0.35 }, confidence: 0.65, attempts: 1, ms: 5131 },
];

const state = {
  index: 0,
  pick: null,
  bet: 10,
  chips: Number(localStorage.getItem("jury.chips") || 100),
  streak: 0,
  best: Number(localStorage.getItem("jury.best") || 0),
  busy: false,
  tokens: 0,
};

const dilemma = () => DILEMMAS[state.index % DILEMMAS.length];

function say(text, bad = false) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("bad", Boolean(bad));
}

function pollenLabel() {
  const button = $("pollen");
  const on = connected();
  button.textContent = on ? "Pollen connected" : "Connect Pollen";
  button.dataset.on = on ? "1" : "0";
}

function saveChips() {
  localStorage.setItem("jury.chips", String(state.chips));
  localStorage.setItem("jury.best", String(state.best));
}

function renderCase() {
  const round = dilemma();
  state.pick = null;
  $("case-no").textContent = `Case ${state.index + 1} of ${DILEMMAS.length}`;
  $("case-chips").textContent = `${state.chips} chips`;
  $("case-title").textContent = round.title;
  $("case-state").textContent = round.state;
  $("case-question").textContent = round.question;

  const options = $("options");
  options.replaceChildren(
    ...round.options.map((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", "false");
      button.dataset.key = option.key;
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = option.key;
      const body = document.createElement("span");
      const label = document.createElement("strong");
      label.textContent = option.label;
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = option.detail;
      body.append(label, detail);
      button.append(key, body);
      button.addEventListener("click", () => choose(option.key));
      return button;
    }),
  );

  const bets = $("bet-chips");
  bets.replaceChildren(
    ...BETS.map((amount) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("role", "radio");
      chip.dataset.amount = String(amount);
      chip.textContent = String(amount);
      chip.disabled = amount > state.chips;
      chip.setAttribute("aria-checked", String(amount === state.bet));
      chip.addEventListener("click", () => {
        state.bet = amount;
        for (const node of bets.children) node.setAttribute("aria-checked", String(node === chip));
      });
      return chip;
    }),
  );
  if (state.bet > state.chips) {
    const affordable = [...BETS].reverse().find((amount) => amount <= state.chips) || BETS[0];
    state.bet = affordable;
    for (const node of bets.children) node.setAttribute("aria-checked", String(node.dataset.amount === String(affordable)));
  }

  $("result").hidden = true;
  $("empty").hidden = false;
  $("next").hidden = true;
  $("go").disabled = true;
  say(
    connected()
      ? "Pick the verdict you think the jury will reach, then convene it."
      : "Connect your Pollen first: the jury is the only paid step.",
  );
}

function choose(key) {
  if (state.busy || $("result").hidden === false) return;
  state.pick = key;
  for (const node of $("options").children) {
    node.setAttribute("aria-checked", String(node.dataset.key === key));
  }
  $("go").disabled = !connected();
}

function setBusy(busy) {
  state.busy = busy;
  $("go").disabled = busy || !state.pick || !connected();
  for (const node of $("options").children) node.disabled = busy || !$("result").hidden;
  for (const node of $("bet-chips").children) node.disabled = busy || node.dataset.amount > state.chips;
}

function bar(name, value, winner) {
  const row = document.createElement("div");
  row.className = "bar-row";
  row.dataset.winner = winner ? "1" : "0";
  const label = document.createElement("span");
  label.className = "bar-name";
  label.textContent = name;
  const track = document.createElement("span");
  track.className = "bar-track";
  const fill = document.createElement("span");
  fill.className = "bar-fill";
  fill.style.width = `${Math.round(value * 100)}%`;
  track.append(fill);
  const number = document.createElement("span");
  number.className = "bar-value";
  number.textContent = `${Math.round(value * 100)}%`;
  row.append(label, track, number);
  return row;
}

function showResult(result, round) {
  const win = result.winner && state.pick === result.winner;
  const outcome = settleRound({ bet: state.bet, pick: state.pick, result });
  state.chips = Math.max(0, state.chips + outcome.delta);
  if (result.winner) {
    state.streak = win ? state.streak + 1 : 0;
    state.best = Math.max(state.best, state.streak);
  } else {
    state.streak = 0;
  }
  saveChips();

  $("empty").hidden = true;
  $("result").hidden = false;
  $("next").hidden = false;
  $("case-chips").textContent = `${state.chips} chips`;

  const badge = $("result-badge");
  if (!result.winner) {
    badge.textContent = "No verdict";
    badge.dataset.state = "tie";
  } else if (win) {
    badge.textContent = outcome.payout > state.bet ? "Win — unanimous" : "Win";
    badge.dataset.state = "win";
  } else {
    badge.textContent = "Wrong call";
    badge.dataset.state = "lose";
  }

  $("result-title").textContent = result.winner
    ? `${round.options.find((option) => option.key === result.winner)?.label || result.winner} — ${Math.round(
        (result.distribution[result.winner] || 0) * 100,
      )}%`
    : "The jury could not agree on a verdict";

  $("result-sub").textContent = result.winner
    ? `${result.votes} of ${result.size} model${result.size === 1 ? "" : "s"} picked it${
        result.split ? `, ${result.split} did not answer` : ""
      }. Your pick: ${
        round.options.find((option) => option.key === state.pick)?.label || "—"
      }. Chips ${outcome.delta === 0 ? "+0" : outcome.delta > 0 ? `+${outcome.delta}` : outcome.delta}, stake ${
        state.bet
      }. Streak ${state.streak} (best ${state.best}).`
    : "No usable answer came back, so your stake is refunded and the round pays nothing.";

  const bars = $("bars");
  bars.replaceChildren(
    ...round.options.map((option) =>
      bar(option.label, result.distribution?.[option.key] || 0, option.key === result.winner),
    ),
  );

  const members = $("members");
  members.replaceChildren(
    ...result.members.map((member) => {
      const item = document.createElement("li");
      if (member.error) item.dataset.bad = "1";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = modelLabel(member.model);
      const vote = document.createElement("span");
      vote.className = "vote";
      vote.textContent = member.error
        ? member.error
        : `${member.choice} · ${Math.round((member.distribution[member.choice] || 0) * 100)}%`;
      item.append(who, vote);
      if (member.attempts > 1) {
        const retry = document.createElement("span");
        retry.className = "retry";
        retry.textContent = `retried ×${member.attempts}`;
        item.append(retry);
      }
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = member.error ? "—" : `${member.ms} ms`;
      item.append(num);
      return item;
    }),
  );

  const answered = result.members.filter((member) => !member.error).length;
  $("meter").innerHTML = `Jury <b>${answered}/${result.members.length}</b> answered · ${state.tokens} tokens billed in this session · chips <b>${state.chips}</b>`;
}

async function convene() {
  if (state.busy || !state.pick) return;
  const round = dilemma();
  setBusy(true);
  $("result").hidden = true;
  $("empty").hidden = false;
  say("Convening the jury…");

  const send = async ({ model, body }) => {
    const reply = await decide({ model, body });
    const usage = reply.usage || {};
    state.tokens += (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    return reply;
  };

  try {
    const result = await runJury({
      dilemma: round,
      models: VERIFIED_MODELS,
      send,
      onMember: (member, index) => {
        say(
          member.error
            ? `${modelLabel(member.model)}: ${member.error}. Asking the next one…`
            : `${modelLabel(member.model)} voted ${member.choice} (${index}/${VERIFIED_MODELS.length})…`,
        );
      },
    });
    showResult(result, round);
    say(
      result.winner
        ? `Verdict: ${result.winner}${result.unanimous ? " (unanimous)" : ""}. Read the bars, then take the next case.`
        : "The jury returned nothing usable. Try again or switch cases.",
      !result.winner,
    );
  } catch (error) {
    const message =
      error.code === "auth"
        ? "Connect your Pollen first: the jury is the only paid step."
        : error.code === "quota"
          ? "That key is out of Pollen, or it may only spend Quest Pollen."
          : error.message || "the request failed";
    say(message, true);
    if (error.code === "auth") openConnect();
  } finally {
    setBusy(false);
    $("go").disabled = $("result").hidden === false;
  }
}

function openConnect() {
  $("modal-body").innerHTML = "<p>Starting the device flow…</p>";
  $("modal").hidden = false;
  startDevice()
    .then((device) => {
      $("modal-body").innerHTML = `
        <p>Open this page and approve JURY:</p>
        <p><a href="${device.verify}" target="_blank" rel="noopener">${device.verify}</a></p>
        <p>Or enter this code there:</p>
        <p><span class="code">${device.userCode}</span></p>
        <p id="device-state">Waiting for approval…</p>`;
      const timer = setInterval(async () => {
        if ($("modal").hidden) return clearInterval(timer);
        const result = await pollDevice().catch((error) => ({ state: "error", message: error.message }));
        if (result.state === "connected") {
          clearInterval(timer);
          $("modal").hidden = true;
          pollenLabel();
          $("go").disabled = !state.pick;
          say("Pollen connected. Pick a verdict and convene the jury.");
        } else if (result.state === "error" || result.state === "expired") {
          clearInterval(timer);
          const note = $("device-state");
          if (note) note.textContent = `Stopped: ${result.message || result.state}`;
        }
      }, 2200);
    })
    .catch((error) => {
      $("modal-body").innerHTML = `
        <p>Could not start the device flow: ${String(error.message)}</p>
        <p>You can paste an <code>sk_</code> key from
          <a href="https://enter.pollinations.ai/keys" target="_blank" rel="noopener">enter.pollinations.ai/keys</a> instead.</p>
        <p><input id="manual-key" type="text" placeholder="sk_…" autocomplete="off" /></p>
        <p><button id="manual-save" class="pill" type="button">Use this key</button></p>`;
      $("manual-save")?.addEventListener("click", () => {
        try {
          useKey($("manual-key").value);
          $("modal").hidden = true;
          pollenLabel();
          $("go").disabled = !state.pick;
          say("Key accepted.");
        } catch (err) {
          alert(err.message);
        }
      });
    });
}

/* ---------- wiring ---------- */

$("go").addEventListener("click", convene);
$("next").addEventListener("click", () => {
  state.index = (state.index + 1) % DILEMMAS.length;
  renderCase();
});
$("pollen").addEventListener("click", () => {
  if (connected()) {
    signOut();
    pollenLabel();
    $("go").disabled = true;
    say("Pollen disconnected.");
    return;
  }
  openConnect();
});
$("modal-close").addEventListener("click", () => {
  $("modal").hidden = true;
});
$("modal").addEventListener("click", (event) => {
  if (event.target === $("modal")) $("modal").hidden = true;
});

$("jury-note").textContent = `${VERIFIED_MODELS.map(modelLabel).join(", ")} were measured with /alpha/decisions and are used here; the other decision models listed on Pollinations are paid, so this jury does not call them.`;

pollenLabel();
renderCase();

if (new URLSearchParams(location.search).has("demo")) {
  const round = dilemma();
  const result = { members: DEMO_MEMBERS, ...aggregate(DEMO_MEMBERS, optionKeys(round)) };
  state.pick = "pull";
  for (const node of $("options").children) node.setAttribute("aria-checked", String(node.dataset.key === "pull"));
  showResult(result, round);
  say("Bundled round: both answers were recorded from real /alpha/decisions replies. Connect Pollen to play your own.");
}
