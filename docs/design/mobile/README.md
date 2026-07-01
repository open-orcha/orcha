# Orcha Mobile — Design Package (GH #30)

End-to-end design for the native iOS + Android Orcha companion apps
([issue #30](https://github.com/open-orcha/orcha/issues/30)): manage agents on the go against a
locally-running Orcha. One visual language shared with the web portal; platform-adapted skeletons
(Material 3 for Android, HIG for iOS). Designed by Dana; Andrew (Android) and Ethan (iOS) build
from these documents.

**How to review:** read the docs in order below; open any `mockups/*.html` file in a browser —
they are static, self-contained phone-framed mockups (no build step, no JS), each frame annotated
with intent and the exact API endpoints it uses.

## Contents

| Doc | What it covers |
|---|---|
| [01-foundations.md](01-foundations.md) | Palette (light+dark), status→color contract, type, spacing, radii, elevation, launcher-icon export matrix |
| [tokens/orcha-mobile-tokens.json](tokens/orcha-mobile-tokens.json) | Machine-readable design tokens, mapped 1:1 from portal CSS; M3 ColorScheme + SwiftUI mapping included |
| [02-ia-navigation.md](02-ia-navigation.md) | Screen inventory, navigation maps per platform, connectivity/realtime model, deep links |
| [flows/03-pairing.md](flows/03-pairing.md) | QR pairing (portal modal + app scanner + all failure modes) — includes NEW portal/API work |
| [flows/04-containers-home.md](flows/04-containers-home.md) | Containers home + Add, container Home tab (action queue), settings, unreachable states |
| [flows/05-tasks.md](flows/05-tasks.md) | Tasks list, task detail (close/cancel), task thread (read + send) |
| [flows/06-runs.md](flows/06-runs.md) | Worker-runs list → run detail with streaming logs |
| [flows/07-requests.md](flows/07-requests.md) | Requests list, detail, respond / nudge / close / accept / reject / convert |
| [flows/08-approvals.md](flows/08-approvals.md) | Plan-approval sheet + task-completion (verify) sheet |
| [flows/09-agents.md](flows/09-agents.md) | Agents list, agent detail, controls (model picker, wakes), agent runs |
| [flows/10-converse.md](flows/10-converse.md) | Converse with an agent (text v1; attachments v2) |
| [flows/11-create-task.md](flows/11-create-task.md) | Create task + assign to agent |
| [12-component-inventory.md](12-component-inventory.md) | Every component ↔ portal equivalent ↔ M3/SwiftUI counterpart; icon language; status copy |
| [13-api-asks.md](13-api-asks.md) | Everything the backend can't serve today (pairing endpoint, mobile auth, …) — nothing silently assumed |
| `mockups/` | `mobile.css` (shared kit) + one HTML gallery per flow, both platforms + empty/loading/error/unreachable states |

## Scope traceability (issue #30 → flow)

| #30 requirement | Flow |
|---|---|
| Review tasks, close/cancel | 05 |
| Read/send task-thread messages | 05 |
| Review/respond/nudge/close requests | 07 |
| Approvals: plan + verify | 08 |
| Converse with agents | 10 |
| Create tasks, assign to agents | 11 |
| QR pairing, Add button, containers | 03, 04 |

## Ground rules baked into every screen

- API contract = `/openapi.json`; every mockup frame cites its endpoints; gaps are explicit asks in doc 13.
- Both themes everywhere; status colors are the binding contract in 01/tokens.
- Every list/detail has empty, loading, error, and laptop-unreachable states.
- The phone acts as the paired **human** (actor id from pairing) — mutations use their agent id.
