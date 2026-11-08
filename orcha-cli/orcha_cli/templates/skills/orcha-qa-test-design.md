---
description: The test-design standard for Orcha QA scenarios — coverage model, techniques, generation procedure, quality bar and anti-patterns. Read it before drafting, revising or reviewing scenarios (/orcha-qa-draft, or any agent that calls propose_scenario).
allowed-tools: Read
---

# Test design for Orcha QA scenarios

You are about to write scenarios people will trust to
say "this works". A scenario that passes on a broken app, or fails on a working one, costs more
than no scenario. This page says **what** to cover, **which inputs** to pick and **what good looks
like**; `/orcha-qa-draft` says how to read the project and call `propose_scenario`.

## 1. The coverage model

Organise coverage by quality characteristic (ISO/IEC 25010), not by screens. A screen-only suite
tests the happy path five times and the failure path never.

| Characteristic | What an Orcha QA scenario can prove today |
|---|---|
| Functional suitability | journeys complete; business rules hold; what was saved is right (read back on its own screen) |
| Performance efficiency | the user sees a result within a budget (`within Ns`); no endless spinner |
| Usability and accessibility | controls have spoken labels (checks read the accessibility tree); errors explain themselves |
| Reliability | empty, invalid and long input a real user types; leaving and returning keeps state |
| Security | a signed-out user is bounced; secrets are never shown; another user's record is refused |
| Compatibility | the same journey on iOS, Android and the web; phone, tablet and desktop viewports |
| Maintainability (of the scenario) | it reads as a user goal, owns its data and survives a redesign |

Out of scope — say so instead of faking it: load testing, penetration testing, unit tests,
pixel-perfect visual diffs, failure injection on the backend (no API stubs yet). Orcha QA runs one
user at a time through the real UI of a simulator, an emulator or a browser.

## 2. The generation procedure

Steps 1–3 are thinking; propose nothing yet.

1. **Read the context**, as far as you need: the briefing of an exploration (personas, journeys,
   risks); existing scenarios from `list_project` (your duplicate list); open findings (a defect
   that happened once predicts the next); the code (screens, forms, validation, permission checks,
   state enums, what each journey saves); the map (`read_map`). Infer the app's test-data profile
   (locale, currency, phone and plate formats, sample names) from the code before drafting.
2. **Build a risk-ranked coverage matrix.** Rows are features, columns the characteristics above.
   Score each cell impact × likelihood, each 1–3. Impact: 3 money, data loss, access or legal; 2 a
   core journey blocked; 1 cosmetic. Likelihood: 3 changed recently, failed before, or complex
   rules; 2 moderate logic; 1 static. Work from the highest score down; cells scoring 1–2 rarely
   earn a scenario.
3. **Pick a technique per cell.**

   | The cell has | Use | Becomes |
   |---|---|---|
   | an input with ranges or formats | equivalence partitions + boundary values | one scenario with an `## Examples` table |
   | outcomes that depend on 2–4 conditions | a decision table | one scenario per distinct outcome |
   | a lifecycle (draft → published) | state transitions | one scenario per transition path |
   | many settings that combine | pairwise | an `## Examples` table with a pairwise row set |
   | a known weak spot or past bug | error guessing | a regression scenario tagged `regression` |

4. **Write each scenario** (shape below): the user's point of view; outcomes, not clicks; one
   workflow, 2–5 criteria ending in its point; a check for every quoted label; no selectors, ids or
   sleeps; a read-back of what was saved; a fresh start; realistic data; `[warning]` on the
   nice-to-haves.
5. **Self-review** every draft against §3. Fix, then propose. A draft failing a rule you cannot fix
   is a coverage gap, not a scenario.
6. **Do not duplicate.** Same journey and inputs: don't propose (or propose under the same name to
   sharpen a draft). Same journey, other inputs: a row in its `## Examples`. Same criteria on both
   platforms: one scenario per platform only when reaching it differs.
7. **State the coverage gaps**: what you did not cover and why, one line each.

The canonical shape (scenario markdown v3; `propose_scenario` takes the same as fields or as
`markdown`):

```
## Add a driver by phone number
Category: Form
Persona: Owner
Description: An owner adds a driver with a Kenyan mobile number and finds them on the Drivers list.
Needs: signed in
1. The Drivers screen offers an "Add driver" action
   Check: Button "Add driver"
2. Saving driver {{driver}} with phone {{phone}} confirms with "Driver added"
   Check: text "Driver added" appears within 10s
   Saved: record "{{driver}}" after relaunch -> Phone is "{{shown}}"
3. The Drivers list shows {{driver}} with the number as {{shown}}
   Check: text ~"{{driver}}"
4. The driver is marked as the main driver [warning]

## Examples
| phone            | shown      |
| ---              | ---        |
| 0712 345 678     | 0712345678 |
| +254 712 345 678 | 0712345678 |

## Data
driver = one of Grace Otieno | Brian Kamau | Achieng Wanjiru | Kevin Mutua | Faith Njeri | Peter Ochieng
```

**Check grammar**: `text "exact"` | `text ~"substring"` | `<Role> "label" [visible|appears|absent|
enabled|disabled|value "v"]`, optionally `within Ns`. Scope by role only when a captured screen of
that platform showed the role (a sign-in "Create account" may be a `Link`, not a `Button`);
otherwise `text "..."`. A toast, snackbar, or a dialog the next tap answers is checked with
`appears`. Quote the distinctive words, not a whole composite label. One check per thing on screen.

**Credentials are never scenario data.** Sign-in belongs to the target's notes and the device's
test account; never write a real password, PIN, code or token in a criterion, check, `## Data` or
`## Examples`.

## 3. The quality bar

A scenario passes only when all of these hold (the lint checks the first ones and
`propose_scenario` returns its notes):

1. One workflow, 2–5 criteria ending in its point; no screen inventory, no side rule, no
   reach-only criterion.
2. No criterion starts like an instruction: Tap, Click, Type, Enter, Go to, Open, Wait.
3. No selectors or test ids in criteria (`#id`, `id=`, xpath, testID).
4. No fixed waits ("wait 5 seconds"); checks poll with `within Ns`.
5. Every `## Examples` column is used by a `{{column}}`; every `{{placeholder}}` is bound by Data
   or a column.
6. No two criteria say the same thing.
7. Every quoted UI text has a check; transient states use `appears`.
8. No dates, times, ids or absolute counts in checks.
9. The scenario owns its data and does not depend on another scenario's records (`depends_on` only
   for real prerequisites such as signing in).
10. The name and description state a user goal; it is not a duplicate.
11. Every value is realistic for the domain and locale; no run tags or junk (`test123`, `asdf`,
    `Baby1023`); every `one of` / `pattern` generator parses.
12. Every criterion that creates or edits data has a `Saved:` read-back naming each field the user
    entered and each optional field left empty.

## 4. Anti-patterns to rewrite on sight

| Smell | Rewrite to | Why |
|---|---|---|
| "Wait 3 seconds, then …" | `Check: … within 10s` | fixed waits are slow when fast and flaky when slow |
| `Check: text "Driver added"` on a toast | `Check: text "Driver added" appears` | the toast is gone when the criterion is judged |
| "Edit the truck from the previous scenario" | the scenario creates its own truck | one failure cascades; order becomes a hidden input |
| "The list shows 3 trucks", "the first truck" | the record this run created, by its generated name | other runs and real users share the account |
| `QA-1234 Otieno`, `Baby1023`, `test123` | a generated realistic value (`one of`, `pattern`) | junk hides real formatting and validation bugs |
| "Log Feeding shows Left, Right, Both, Bottle and Solid; Save does nothing until a type is chosen; a Left feeding with no amount shows a Left Breast card" | the workflow alone ("Saving a Left feeding with no amount shows a Left Breast card", "its detail has no Amount row"), and the rule as its own scenario | one scenario, one workflow: a failure names one broken thing |
| "Saving returns to Today and the entry shows", nothing else | the same plus `Saved: record "Feeding" after relaunch -> Amount empty` | the screen after Save looked right while every feeding stored a phantom amount |
| "Tap Add, type the name, tap Save" | "Saving a driver named {{driver}} confirms with "Driver added"" | criteria are outcomes; the tester works out the taps |
