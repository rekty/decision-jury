[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

# JURY

A game where decision models form a jury. Read a case with real stakes, bet chips on the verdict
you think the models will reach, then see how each model split its probability across the options.

Live: <https://rekty.github.io/decision-jury/> · Built for Pollinations quest
[#19176](https://github.com/pollinations/pollinations/issues/19176).

## How a round works

1. The page shows one dilemma from a small pack of cases: the facts, a question, and two or three
   options.
2. You pick the option you think the jury will favour and stake 10, 25 or 50 chips.
3. Each jury member is asked the same typed question through `POST /alpha/decisions`:

   ```json
   {
     "model": "vllm-sr/d3",
     "state": "A runaway trolley is rolling toward five track workers …",
     "questions": {
       "verdict": {
         "type": "choice",
         "instructions": "Should the lever be pulled?",
         "criteria": { "pull": "…", "stay": "…" }
       }
     }
   }
   ```

4. Every reply is `{ choice, confidence, probabilities }`. The app checks the choice against the
   options the round offers, drops unknown keys, re-normalises the probabilities, and averages the
   distributions into the jury's own distribution. The highest average is the verdict.
5. Chips settle even money, doubled when every member of the jury picked the same option. A model
   that refuses or answers unusably is retried once with a stricter instruction, then counted as
   absent — the round still resolves with the members that answered. If **no** member answers, the
   round has no verdict and the stake is refunded rather than lost (`settleRound` in
   `shared/jury.js`), so a dead API never charges the player.

## Which models are on the jury

| Model | Status |
|---|---|
| `vllm-sr/d3` | measured: answered a choice question with probabilities in 5.2 s |
| `microsoft/microsoft-decision-1` | measured: answered in 5.1 s |
| `typesafe/jev-1.14`, `openai/gpt-6-luna-decisions`, `liquid/d1`, `jaredpalmer/kev-4b`, `perplexity/pplx-decider-v1.2` | paid only — a Quest-only key gets `402`, so the game does not call them |
| `respan/span-01-lite` | only accepts `noul` questions, so it cannot answer a `choice` round |

## Paying

Bring Your Own Pollen over the device flow. There is no backend, no database and no server-side
secret: the key lives in this tab's session storage, is sent only to `gen.pollinations.ai`, and the
score is kept in `localStorage`. Open `?demo=1` to see a round built from recorded replies without
spending anything.

## Run and test

```bash
npx serve -l 8099 .        # or any static server
node --test                # 20 tests: parsing, normalising, jury math, payout, refund, retry
```

The tests use an injected sender, so they need no key and no network.

## Honest limits

- The probabilities are the models' own; a confident jury can be confidently wrong. That is the
  game, not a bug.
- Only two free decision models exist, so the jury is two votes wide. The paid models are named in
  the page instead of silently skipped.
- The five paid models could not be measured without paid Pollen, so they are listed as unmeasured.
