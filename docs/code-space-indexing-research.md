# Code Space indexing/search/intelligence — build-vs-adopt research

> Scratch research doc (not committed — see task instructions). Written 2026-08-06.
> Scope: evaluate open-source foundations to replace/augment the hand-rolled regex
> symbol indexer and GitHub-code-search-only contents search in
> `portal_backend/code_space_routes.py`, per `docs/orcha-code-space-design.md` Phase 3.

## Baseline being replaced (read first)

- **Symbol indexer**: per-language regex tables (Kotlin, Swift, TS/JS, Python, Go),
  no AST, no cross-file resolution — candidate name matches only. Budgeted 40
  GitHub Contents-API file fetches per backend request; a cold 789-file repo takes
  ~20 request-chunks to fully warm, each observed at ~15s. State cached in-process
  per `(container_id, ref)`, 10-minute TTL.
- **Contents search**: fully delegated to GitHub's `/search/code` — default-branch-only,
  can't search PR branches or arbitrary refs, subject to GitHub's own quirks/limits.
- **Fetch**: `GET /repos/{repo}/git/trees/{sha}?recursive=1` once (cached), then one
  `GET /repos/{repo}/contents/{path}` per file needed — no local clone, no tarball.
- **Frontend**: zero highlighting/fuzzy-search dependencies today — hand-rolled
  tokenizer, no Cmd/Ctrl+P quick-open yet.
- **Constraints**: Python 3.12 FastAPI, `python:3.12-slim` Docker base (confirmed —
  no `git` binary in the image by default), 4GB shared VM, Postgres already running,
  React 18 + Vite frontend with no CDN dependencies, self-hostable + permissive
  licenses only (AGPL = hard reject, flag it).

---

## 1. Recommendation matrix

### 1a. Parsing / symbol extraction

| Option | License | Maturity (2026) | Fit | Why |
|---|---|---|---|---|
| **tree-sitter** (`py-tree-sitter` + `tree-sitter-language-pack`) | MIT (both) | py-tree-sitter 0.26.0 (Jun 2026), language-pack 1.14.3 (Aug 2026); active, GitHub/Aider/Zed all use it | **5/5** | manylinux **and musllinux** wheels for both packages — zero compiler in the Docker build, ~3MB total wheel payload. All 6 target languages covered. Standardized `tags.scm` convention for symbol extraction (same mechanism GitHub's own code nav and Aider's repo-map use) — a near-drop-in upgrade path from the current regex tables to AST-accurate extraction with the *same* output shape (name/kind/line). |
| universal-ctags | **GPL-2.0** (core binary) | Actively maintained, release Jul 2026, 7.3k★ | 3/5 | Battle-tested, JSON output available (`--output-format=json`, needs libjansson build), but it's a shelled-out system binary (not a pip wheel) — bigger image/build footprint than tree-sitter, and copyleft licensing on a shipped binary is worth a legal look before adopting. Extraction is still regex/heuristic per language, not a real AST — a smaller accuracy jump over today's baseline than tree-sitter gives. |
| SCIP/LSIF indexers (scip-typescript, scip-java, scip-python, lsif-go, …) | Apache-2.0 (mostly, not fully re-verified per-repo) | Mixed; scip-typescript healthy (1-5k lines/sec), scip-python status unclear | **1/5** | **Reject.** Every real indexer requires that language's actual build/dependency-resolution step (npm install, Gradle/Maven, go mod download, a working venv) to produce accurate output. That's the opposite of "index an arbitrary fetched repo on demand" — no generic multi-language indexer exists. This is built for CI-integrated single-known-codebase indexing, not a stateless multi-repo backend. |
| stack-graphs (GitHub) | Apache-2.0/MIT | **Archived by GitHub, Sep 2025** — no longer maintained | 2/5 | Technically the *correct* end-state (real cross-file "go to definition" resolution, not candidate matching), built on tree-sitter. But frozen with confirmed rule coverage for only 2 of 6 target languages (TypeScript, Python), and per-language adoption means writing nontrivial name-binding-semantics rules from scratch with no upstream to share the load. Note as future-direction, not actionable now. |

**Verdict: tree-sitter, adopt now.** Confirms the brief's guess. GPL licensing rules out ctags as a first choice; SCIP is architecturally incompatible with "arbitrary repo, no build step"; stack-graphs is dead upstream and covers too few languages.

One flagged risk worth a line in any follow-up: `tree-sitter-language-pack`'s ownership has forked/renamed across orgs (`grantjenks` → `xberg-io`/`kreuzberg-dev`) and the Kotlin grammar specifically has several competing implementations (`fwcd`, `Joakker`, `tormodatt`, `tree-sitter-grammars`) — pin an exact version and spot-check the bundled Kotlin/Swift grammars before relying on them, since those two are the least "official" of the six.

### 1b. Text/code search

| Option | License | Maturity (2026) | Fit | Why |
|---|---|---|---|---|
| **pg_trgm** (Postgres extension, `contrib`) | PostgreSQL License (permissive) | Ships with core Postgres, no separate release cycle | **4/5** | Zero new infra — `CREATE EXTENSION` + a GIN index, reuses the connection pool already there. Character-trigram matching is the *right* primitive for code (doesn't break on `camelCase`/`snake_case` the way word-boundary FTS does). Documented failure modes (index "poisoning" on common substrings, multi-second `ORDER BY`) were all observed at 1000x+ our scale (Sourcegraph's fleet, a 20k-repo/88GB corpus) — at 789–5k files expect index overhead in the single-digit MB and low-ms queries for most patterns. |
| Postgres FTS (`tsvector`/GIN) | PostgreSQL License | Same as above | **1/5 for this use case** | **Reject for code search specifically.** Confirmed via Postgres's own bug tracker: `to_tsvector('simple','light_bulb')` splits into `'bulb':2 'light':1` — word-boundary tokenization destroys `snake_case`/dotted-path identifiers, which is most of what you search for in code. Use pg_trgm, not tsvector, for this. |
| Zoekt (sourcegraph/zoekt, orig. google/zoekt) | **Apache-2.0** (confirmed) | Active, Sourcegraph's and GitLab's production code-search backend | **2/5** | Technically the best-in-class trigram engine for this exact job (Sourcegraph prefers it over Postgres precisely because of the poisoning/ranking issues above) — but it's architected as a **separate always-on fleet service** (`zoekt-indexserver` + `zoekt-webserver`, its own HTTP/gRPC API). GitLab's own smallest documented self-hosted sizing tier is **16GB webserver + 6GB indexer RAM** — doesn't fit in a 4GB shared VM at any repo count. Right tool, wrong operational shape for this box. |
| ripgrep subprocess / **`git grep <ref>`** | MIT/Unlicense (rg); part of git | Both mature | **4/5** | Two distinct strategies — confirmed directly from ripgrep's maintainer: `git grep <ref>` searches **any ref/tag/commit against the git object DB with no checkout**, which ripgrep itself deliberately doesn't replicate (would need libgit2-style plumbing). For the any-ref requirement, `git grep <ref>` on a shallow/bare clone is the most direct native answer — zero index to keep in sync with arbitrary refs, zero capacity planning. Costs: no relevance ranking, pure O(corpus) per query, needs a homegrown concurrency cap on a shared VM (N concurrent greps = N processes). |
| tantivy / tantivy-py | **MIT** (confirmed) | tantivy-py 0.26.0 (Apr 2026), actively maintained (2 active maintainers), manylinux wheels | **4/5** | In-process (no subprocess/service), purpose-built full-text engine with **configurable tokenization** (can be made identifier-aware, avoiding the FTS word-boundary trap), BM25 ranking, segment-based commits map cleanly onto "index just the new commit's diff." Costs: a second index living outside Postgres (its own file lifecycle on disk) — real but far lighter than Zoekt. No benchmark found at our exact 1-5k-file scale; treat resource numbers as needing a quick prototype, not yet measured. |
| Whoosh | BSD-2 | **Abandoned** — upstream unmaintained; its main community fork (`Sygil-Dev/whoosh-reloaded`) self-declares "NO LONGER MAINTAINED" | **1/5** | **Reject.** Confirmed dead on both the original and the commonly-cited fork. Don't build a load-bearing feature on an orphaned dependency in 2026, regardless of historical merit. |

**Head-to-head verdict:** pg_trgm wins for this setup specifically *because* Postgres is already running — that's the deciding fact, not raw engine quality. Zoekt is disqualified by operational footprint (fleet-service shape), not license or capability; revisit only if the deployment ever moves to a dedicated multi-repo indexing host with materially more RAM. tantivy-py is the credible second choice if pg_trgm's substring-only ranking proves insufficient in practice — earn it with a demonstrated gap, don't adopt it speculatively. `git grep <ref>` isn't competing with the indexed options; it's the zero-infrastructure complement that solves the any-ref requirement most directly.

### 1c. Fetch strategy

| Option | Confirmed via | Verdict |
|---|---|---|
| **Tarball download** — `GET /repos/{owner}/{repo}/tarball/{ref}` | docs.github.com REST reference | **Adopt now.** One `api.github.com` call (a 302 redirect to codeload.github.com) replaces the entire per-file Contents-API loop. Works with GitHub App installation tokens and private repos (signed download URL, 5-min expiry — start streaming immediately). Zero extra system packages: stdlib `tarfile` + `httpx`/`urllib` only (no `git` binary needed, which `python:3.12-slim` lacks by default anyway). |
| Shallow clone (`git clone --depth 1` with the installation token) | GitHub Apps auth docs | Only worth it if you need `.git` history, incremental `git fetch` deltas, or `git grep <ref>` capability (see §1b) — otherwise strictly heavier: `.git` object-DB overhead adds ~20-40% on-disk vs. an equivalent tarball extraction, and requires installing `git` into the slim image. **Recommendation: adopt tarball as the primary fetch path; add a shallow/bare clone only if `git grep <ref>` (§1b) is also adopted, since that specifically needs `.git` machinery.** |

**Quantified win (789-file reference repo):** today's approach is ~790 API calls (1 tree + ~789 file fetches) chunked at 40/request, ~20 backend round-trips, each observed at ~15s in production. Tarball collapses this to **1-2 total API calls** (~99.7% reduction) and an estimated **1-3 seconds** end-to-end for the fetch+extract phase — a single backend request, no chunk-budget bookkeeping, no resume state across warm-ups. GitHub's own best-practices docs explicitly recommend *serial, not concurrent* Contents-API requests to avoid secondary rate limits, which is exactly the bottleneck the current 40-file budget is working around — tarball sidesteps that constraint entirely rather than optimizing within it.

Caveats (unconfirmed in GitHub's docs, flag before hard-committing to numbers): no published max tarball size; no confirmed ETag/conditional-GET support on the archive endpoint (use the existing ref-sha comparison as the cache-invalidation signal instead — already documented by GitHub as the intended pattern); symlink/submodule/LFS-pointer handling is inferred from standard `git archive` behavior, not GitHub-doc-confirmed.

### 1d. Frontend — highlighters

| Option | License | Bundle (6-lang subset, realistic gzip) | Maintenance | Fit |
|---|---|---|---|---|
| **Shiki** (`@shikijs/engine-javascript`, not the WASM oniguruma engine) | MIT | ~150-200KB steady-state, but lazy-loaded per file/language — a typical session touching 1-2 languages is closer to 30-50KB | Monthly release cadence, 13.7k★, active | **5/5** |
| highlight.js | BSD-3 | ~50-80KB (custom build, 6 languages) | Active but slower cadence (~9 months since last release at research time) | 3/5 |
| Prism.js | MIT | ~25-40KB (smallest) | **v1.30.0 was published ~17 months ago; maintainers are in an explicit feature-freeze pending Prism v2, security-only PRs accepted** | 2/5 |

**Verdict: Shiki**, using the pure-JS engine (not WASM), given the design doc's own framing — this is a collaboration/review surface, not a full IDE, so TextMate-grammar accuracy (same engine VS Code uses) matters more than shaving the last 100KB. Prism's extended feature-freeze is a real adoption risk for anything new in 2026 despite its small size.

### 1e. Frontend — fuzzy finders (Cmd/Ctrl+P quick-open)

| Option | License | Bundle (gzip) | Maintenance | Algorithm fit | Fit |
|---|---|---|---|---|---|
| **fzf-for-js** (`fzf` on npm) | BSD-3 | 5.8KB | **Stale — last tagged release Apr 2023** (3+ years); zero dependencies limits the practical risk | Direct port of the actual fzf subsequence-with-proximity scorer — the closest match to real VS Code Cmd+P ranking | 4/5 |
| Fuse.js | Apache-2.0 | 9.3KB | Active, v7.5.0 | Bitap/edit-distance — tuned for typo-tolerant natural-language matching, not path subsequence ranking; would need real tuning effort to feel right | 3/5 |
| MiniSearch | MIT | 5.8KB | Active, v7.2.0 | **Wrong tool category** — it's a full-text inverted-index engine (Lunr-style), not a path fuzzy-matcher; its "fuzzy" option is edit-distance on tokenized words | 2/5 |

**Verdict:** fzf-for-js is the best algorithmic fit and is low-risk to adopt despite staleness (zero dependencies, small enough to vendor/fork if it ever breaks) — pin the version and treat it as finished, not actively maintained, software. A credible alternative genuinely worth prototyping alongside it: hand-roll a ~100-150 line subsequence scorer (consecutive-char + word-boundary bonuses), consistent with the team's existing comfort maintaining small bespoke matchers (the current hand-rolled highlighter tokenizer is precedent). MiniSearch is the wrong category entirely — keep it in mind only if/when full-text *content* search inside the frontend (not path search) becomes a separate need.

### 1f. LSP path (future phase — resource planning only)

| Server | License | Memory (documented/observed) | Status | Fit (on-demand sandboxed worker, off the shared VM) |
|---|---|---|---|---|
| typescript-language-server / tsserver | Apache-2.0 | ~1-2GB real use, 3GB default ceiling, documented GC-thrash toward that ceiling under load | Mature but soft-capped, not hard-capped | 3/5 — re-evaluate `tsgo --lsp` (TypeScript's Go rewrite, native LSP mode, TS7 RC'd Jun 2026, claims ~2.9x less memory) before building on the classic Node wrapper; timing plausibly aligns with when this phase would actually ship |
| kotlin-language-server (fwcd) | MIT | "Several GB even on small projects"; can drag in a Gradle/Kotlin daemon stack (4.5GB+ observed) | **Deprecated by its own maintainer** — last release Jan 2025 | 1/5 — do not build on this |
| Kotlin/kotlin-lsp (JetBrains, official) | Apache-2.0 | **Unpublished** — biggest data gap found; built on IntelliJ platform, expect at least as heavy as fwcd's until measured | Alpha | 2/5 — only actively-maintained OSS path, but needs direct measurement before any resource commitment |
| sourcekit-lsp (Swift) | Apache-2.0 | Unquantified but multiple open reports of being "the biggest memory user," enough to freeze 8GB machines, on Ubuntu 20.04/24.04, Swift 5.5-6.0.2 | Ships in the official Linux Swift toolchain, so Linux support is real — but does **not background-index**; needs the repo already built before it's useful, adding a compile step per session | 2/5 — highest-risk of the three; budget conservatively and expect an added build-step cost |

**Resource-budget verdict:** running even one LSP session on the current shared 4GB VM is a **non-starter**, not just risky — the *lightest* option (TypeScript) has a soft ceiling around 2-3GB with documented thrash behavior, which alone would starve Postgres/FastAPI/Node on that box during any real indexing event, with no graceful-degradation path in any of the three (issue trackers consistently describe hitting the cap as "crash," not "throttle"). Confirms the design doc's own instinct to defer this.

**Multi-tenant pattern (confirmed across every production system surveyed — Theia, Che, Gitpod, Coder):** one-process/container-per-workspace, spawn-on-demand, warm-with-idle-timeout, evict. Nobody pools a single LSP instance across tenants — isolation wins for exactly the reasons this project would care about (crash containment, no cross-repo state leakage). Minimum realistic shape when this phase gets built: dedicated on-demand workers, not the shared box, budget 2-3GB per active TS session and more for Kotlin/Swift until measured.

**Also worth noting for the eventual plan:** both Sourcegraph and GitLab independently moved *away* from live-LSP-at-query-time toward precomputed index formats (LSIF → SCIP) for code navigation at scale — a real signal that "batch-index and serve from index" may be the more scalable architecture for go-to-definition/references than spinning up a live LSP server per session, even setting aside the 4GB-VM constraint. Worth weighing against pure live-LSP before committing engineering time to the "LSP adapter" provider type.

**Transport tooling:** `monaco-languageclient` (MIT, active) solves only the browser↔LSP WebSocket/JSON-RPC bridging — it explicitly does **not** solve server-side process supervision or per-workspace lifecycle (its own examples hand-roll that part). Small generic LSP-over-WebSocket proxies exist (`lsp-ws-proxy`, `websockets-ls`, both MIT) but same boundary — transport only, not lifecycle. The process-supervision/warm-evict layer has no off-the-shelf answer; it will need to be built regardless of which transport bridge is picked.

---

## 2. Adopt-now shortlist

Confirms the brief's hypothesis, with one addition (fetch strategy) it didn't ask to validate but that turned out to be the single biggest, lowest-risk win found:

1. **Tarball fetch** (`GET /repos/{owner}/{repo}/tarball/{ref}`) replacing the per-file Contents-API loop. ~790 calls → 1-2 calls; ~15s/chunk × ~20 chunks → an estimated 1-3s single request. Zero new dependencies (stdlib `tarfile`), no `git` binary needed.
2. **tree-sitter** (`py-tree-sitter` + `tree-sitter-language-pack`) replacing the regex definition tables. MIT, ~3MB of pre-compiled manylinux/musllinux wheels, no compiler in the Docker build, all 6 languages covered, and the `tags.scm` convention gives a direct, same-shaped upgrade path (name/kind/line) from today's output — this should be closer to a swap than a rewrite.
3. **pg_trgm** replacing GitHub `/search/code` for contents search, since Postgres is already running. Solves the any-ref limitation GitHub's API can't (searches any ref, not just default branch), zero new infrastructure. Use trigram indexing, explicitly *not* `tsvector`/FTS (word-boundary tokenization breaks on code identifiers — confirmed via Postgres's own bug tracker).

Runner-up worth prototyping alongside #3, not instead of it: `git grep <ref>` against a shallow/bare clone (itself now cheap given #1's tarball-adjacent fetch path, or a `--depth 1` clone using the same installation token) as a zero-index complement for rarely-queried refs/PR branches — reserve the pg_trgm index for the default/frequently-queried branch, avoiding the cost of indexing every ref.

---

## 3. Phased adoption plan

### Phase A — fetch + symbol indexer rework (`code/symbols`, `code/outline`, the tree-cache helpers in `github_repo_browse_routes.py`)
- Replace `_fetch_source_file`'s per-path Contents-API call and the `_fetch_full_tree` recursive-tree call with a single tarball fetch per `(repo, sha)`, extracted to a scratch directory (stream, don't buffer fully in memory, given the 4GB VM). Keep the existing ref-sha comparison as the cache-invalidation key (tarball has no confirmed ETag support; ref-sha compare is already the pattern this module uses).
- Replace `_LANGUAGE_PATTERNS`/`_extract_definitions` with tree-sitter parses + `tags.scm` queries per language. Same output contract (`{name, kind, line}` per definition) — the `code/symbols` and `code/outline` route handlers themselves shouldn't need to change shape, just their extraction internals.
- **Expected perf delta:** cold warm-up drops from ~20 chunked backend requests (~15s each) to a single request in the low single-digit seconds; the `SYMBOL_INDEX_BUDGET`/incremental-pending-list machinery in `search_code_symbols` likely becomes unnecessary once the whole tree is available from one tarball extraction rather than 40-files-at-a-time Contents calls — worth re-evaluating whether the budget/polling UX (`indexing`/`indexed`/`total` progress fields) is still needed post-tarball, or whether indexing can just complete synchronously within one request for repos this size.
- Symbol accuracy improves from string-heuristic to AST-based without changing the API surface consumers depend on.

### Phase B — contents search (currently GitHub `/search/code` only, default-branch-only)
- Add a pg_trgm-backed table (e.g. `code_file_contents(container_id, ref_sha, path, content, ...)` with a GIN trigram index) populated from the same tarball extraction Phase A already does — no separate fetch needed, just index what's already on disk/in memory during the tarball unpack.
- Keep GitHub `/search/code` as a fallback for repos too large to index cheaply, or drop it once pg_trgm coverage is validated — decide after a load test against the actual reference repo's most common substrings (the documented "trigram poisoning" failure mode is scale-dependent and worth confirming is a non-issue at 789-5k files before fully committing).
- **Expected perf delta:** unlocks any-ref search (GitHub's API can't do this at all today) as the headline capability, not primarily a speed win over GitHub's own search.
- Add `git grep <ref>` (via a shallow/bare clone reused from the tarball-vs-clone decision in Phase A, if clone ends up adopted for other reasons) as a zero-index complement for refs that don't justify pre-indexing.

### Phase C — frontend (Cmd/Ctrl+P quick-open, code viewer highlighting)
- Add Shiki (`@shikijs/engine-javascript`) for syntax highlighting, replacing the hand-rolled tokenizer, lazy-loading grammars per file opened.
- Add fzf-for-js (pinned) or a small hand-rolled subsequence matcher for the planned Cmd/Ctrl+P quick-open — prototype both against the real file-path list before committing, given fzf-for-js's staleness is a soft concern, not a hard blocker.
- No backend dependency; can ship independently of Phases A/B.

### Phase D — LSP adapters (explicitly deferred, per the design doc)
- Do not build on the shared 4GB VM under any circumstance — confirmed by this research, not just assumed.
- When resourced: dedicated on-demand workers, one-per-active-session, 2-3GB budget for TypeScript (re-check `tsgo --lsp` first, given its 2026 timeline plausibly overlapping delivery), Kotlin and Swift budgeted higher and pending direct measurement (neither has a trustworthy published number today).
- Before committing to live LSP-per-session at all, weigh the precompute-index alternative (SCIP/LSIF, batch-indexed on push/schedule) that both Sourcegraph and GitLab independently converged on for the same problem at their scale — it may be the cheaper, more predictable architecture even setting aside the 4GB constraint.

---

## 4. Explicit rejects

| Option | Reason |
|---|---|
| SCIP/LSIF indexers (scip-typescript, scip-java, scip-python, lsif-go, …) | Every real indexer needs that language's actual build/dependency-resolution step (npm install, Gradle/Maven, go mod, a working venv). Incompatible with "index an arbitrary fetched repo on demand, no build step." No generic multi-language indexer exists. |
| stack-graphs | Archived by GitHub Sep 2025, no longer maintained. Only ever had confirmed rule coverage for 2 of the 6 target languages (TypeScript, Python). Correct end-state architecture, not an actionable near-term option. |
| universal-ctags | **GPL-2.0** on the shipped binary — a real licensing consideration for a distributed Docker image, on top of being a subprocess/system-binary dependency rather than a pip wheel. tree-sitter beats it on license, install footprint, and extraction accuracy (real AST vs. regex heuristics). |
| Postgres FTS (`tsvector`/GIN) for code search | Word-boundary tokenization breaks identifiers (`light_bulb` → `light`/`bulb` — confirmed via Postgres's own bug tracker). Use pg_trgm instead; don't use FTS for this. |
| Zoekt | Apache-2.0 and technically excellent, but architected as a fleet-scale always-on service — GitLab's own smallest self-hosted sizing tier is 16GB+6GB RAM. Doesn't fit a 4GB shared VM regardless of repo count. Revisit only on materially bigger/dedicated infra. |
| Whoosh | Confirmed abandoned upstream; its main community fork self-declares unmaintained. Don't build a load-bearing feature on orphaned software in 2026. |
| Prism.js | Maintainers in an explicit feature-freeze (security-PRs-only) pending a v2 with no announced ship date, ~17 months since last release. Real adoption risk for something new right now despite the smallest bundle size of the three highlighters. |
| MiniSearch (for the Cmd/Ctrl+P path) | Wrong tool category — a full-text inverted-index engine, not a path-subsequence fuzzy matcher. Keep in mind only for a possible separate future need (in-browser full-text content search), not quick-open. |
| kotlin-language-server (fwcd) | Deprecated by its own maintainer in its own README; last release Jan 2025; multi-GB memory even on small projects. Do not build on it even for the deferred LSP phase — use the official JetBrains Kotlin LSP once it's past Alpha and has published resource numbers. |
| Running any LSP server on the shared 4GB portal VM (any language, any phase) | Confirmed non-starter, not just risky: even the lightest option (TypeScript) has a documented soft ceiling around 2-3GB with thrash-not-throttle failure behavior under load, which alone would starve Postgres/FastAPI/Node on that box. Requires dedicated separate infrastructure, exactly as the design doc already assumes. |

---

## 5. Sources

**Parsing/symbols:** https://pypi.org/project/tree-sitter/ · https://pypi.org/project/tree-sitter-language-pack/ · https://github.com/tree-sitter/py-tree-sitter · https://tree-sitter.github.io/tree-sitter/4-code-navigation.html · https://aider.chat/2023/10/22/repomap.html · https://zed.dev/blog/syntax-aware-editing · https://github.com/universal-ctags/ctags · https://github.com/sourcegraph/scip · https://sourcegraph.github.io/scip-java/docs/getting-started.html · https://sourcegraph.com/blog/announcing-scip-typescript · https://github.com/github/stack-graphs · https://github.blog/open-source/introducing-stack-graphs/

**Search:** https://www.postgresql.org/message-id/E1W0z20-0007Gz-9W@wrigleys.postgresql.org · https://github.com/hexops-graveyard/pgtrgm_emperical_measurements · https://sourcegraph.com/blog/postgres-text-search-balancing-query-time-and-relevancy · https://github.com/sourcegraph/zoekt · https://docs.gitlab.com (Zoekt sizing/exact-code-search docs) · https://github.com/BurntSushi/ripgrep/discussions/1580 · https://github.com/quickwit-oss/tantivy · https://github.com/quickwit-oss/tantivy-py · https://github.com/whoosh-community/whoosh · https://github.com/Sygil-Dev/whoosh-reloaded

**Fetch:** https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#download-a-repository-archive-tar · https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation · https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28 · https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28 · https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#get-a-reference

**Frontend:** https://shiki.style/guide/ · https://shiki.style/guide/best-performance · https://github.com/shikijs/shiki · https://bundlephobia.com/package/shiki · https://github.com/highlightjs/highlight.js · https://github.com/PrismJS/prism · https://security.snyk.io/package/npm/prismjs · https://github.com/ajitid/fzf-for-js · https://github.com/krisk/Fuse · https://github.com/lucaong/minisearch

**LSP:** https://github.com/typescript-language-server/typescript-language-server · https://github.com/microsoft/TypeScript/issues/30981 · https://devblogs.microsoft.com/typescript/announcing-typescript-native-previews/ · https://github.com/fwcd/kotlin-language-server · https://github.com/Kotlin/kotlin-lsp · https://kotlinlang.org/docs/kotlin-lsp.html · https://github.com/swiftlang/sourcekit-lsp · https://forums.swift.org/t/high-memory-usage-of-sourcekit-lsp-in-vscode-on-ubuntu-20-04/75518 · https://github.com/TypeFox/monaco-languageclient · https://sourcegraph.com/blog/announcing-scip · https://docs.gitlab.com/user/project/code_intelligence/ · https://github.com/qualified/lsp-ws-proxy · https://github.com/mkslanc/websockets-ls
