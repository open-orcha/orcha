"""Industry project templates — the built-in catalog (general-mode-templates feature).

A template is DATA, never behaviour: a starter roster (roles + system prompts + reporting
lines), routines (created through the routines API handler, so they are normal routines),
definition-of-done presets, project-objective examples and the project mode it suits.
Applying one (templates_routes.py) is always a human-confirmed action that goes through
the existing creation paths — this module only describes what COULD be created.

Every template is validated at import (``validate_template``) so a typo in the catalog
fails the test suite and app start-up, not a human's "Apply" click. The same validator is
exposed for callers that build a template dict from elsewhere (e.g. a portable template
file), so they share one shape.
"""

from __future__ import annotations

import re
from typing import Iterable

from portal_backend import routine_schedule as sched
from portal_backend.limits import MAX_DESC_LEN, MAX_DOD_LEN, MAX_NAME_LEN, MAX_PROMPT_LEN

PROJECT_MODES = ("code", "general")
ALIAS_RE = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
KEY_RE = re.compile(r"^[a-z][a-z0-9-]{1,47}$")
MAX_ROLES = 12
MAX_ROUTINES = 12
MAX_DOD_PRESETS = 20
MAX_PRESET_LABEL = 60

# ---------------------------------------------------------------------------
# Prompt scaffolding — every seeded agent gets the same honest working rules.
# ---------------------------------------------------------------------------

_RULES_CODE = (
    "How you work:\n"
    "- Work on a branch and deliver through a pull request; never push to main.\n"
    "- Keep changes small and reviewable; include or update tests for what you change.\n"
    "- Say in your done summary what you changed, how you verified it, and the PR link.\n"
)
_RULES_GENERAL = (
    "How you work:\n"
    "- Your output is a DELIVERABLE (a document, brief, plan, table or report), not code.\n"
    "  Save it in the project workspace or attach it to the task, and name it clearly.\n"
    "- Start each task by restating the definition of done; finish by checking every point.\n"
    "- Cite sources for facts and numbers; mark anything you could not verify as unverified.\n"
    "- Say in your done summary where the deliverable is and what a reviewer should check.\n"
)
_RULES_ALWAYS = (
    "- Use Orcha requests to ask teammates or the human for input instead of guessing.\n"
    "- Stop at needs_verification: a human verifies your work — never self-certify.\n"
    "- You cannot hire or create agents; if the team needs a new role, propose it to your\n"
    "  manager or the human.\n"
)


def build_prompt(title: str, mission: str, duties: Iterable[str], mode: str) -> str:
    lines = [f"You are the {title} on this project. {mission}", "", "What you own:"]
    lines += [f"- {d}" for d in duties]
    lines.append("")
    lines.append((_RULES_CODE if mode == "code" else _RULES_GENERAL) + _RULES_ALWAYS)
    return "\n".join(lines).strip()


def _role(key, alias, title, mission, duties, mode, reports_to=None):
    return {
        "key": key,
        "alias": alias,
        "role": title,
        "reports_to": reports_to,
        "prompt": build_prompt(title, mission, duties, mode),
    }


def _routine(key, title, description, dod, cron, assignee, priority=100):
    return {
        "key": key,
        "title": title,
        "description": description,
        "definition_of_done": dod,
        "cron": cron,
        "assignee": assignee,
        "priority": priority,
    }


def _preset(key, label, text):
    return {"key": key, "label": label, "text": text}


# ---------------------------------------------------------------------------
# The catalog
# ---------------------------------------------------------------------------

def _software_team():
    m = "code"
    return {
        "key": "software-team",
        "version": 1,
        "name": "Software team",
        "mode": m,
        "summary": "A small product engineering team: a lead who plans, two builders, QA and docs.",
        "roles": [
            _role("lead", "tech-lead", "Tech lead · planning & review",
                  "You turn the project objective into small, well-scoped tasks and keep the team unblocked.",
                  ["Break goals into tasks with clear definitions of done and priorities.",
                   "Review plans and pull requests from the team before a human verifies.",
                   "Route questions and dependencies between teammates."], m),
            _role("backend", "backend-dev", "Backend engineer",
                  "You build and maintain the server side: APIs, data and integrations.",
                  ["API endpoints, database migrations (additive) and background jobs.",
                   "Unit and integration tests for everything you touch."], m, "lead"),
            _role("frontend", "frontend-dev", "Frontend engineer",
                  "You build the user interface and keep it fast and accessible.",
                  ["Screens, components and client-side state.",
                   "Accessibility (labels, focus, contrast) and responsive layout."], m, "lead"),
            _role("qa", "qa-engineer", "QA engineer",
                  "You find bugs before users do and keep the test suite honest.",
                  ["Write reproduction steps and regression tests for every bug.",
                   "Run the suite before release and report flaky or failing tests."], m, "lead"),
            _role("docs", "docs-writer", "Technical writer",
                  "You keep the README, guides and changelog accurate.",
                  ["Update docs whenever behaviour changes.",
                   "Write the release notes for each release."], m, "lead"),
        ],
        "routines": [
            _routine("dependency-audit", "Dependency audit {{date}}",
                     "List outdated or vulnerable dependencies and propose upgrades.",
                     "A short report lists each outdated/vulnerable package, its risk, and a proposed upgrade task.",
                     "0 9 * * 1", "backend"),
            _routine("weekly-triage", "Weekly bug triage {{date}}",
                     "Review open bugs, deduplicate them, and set priorities.",
                     "Every open bug has a priority and an owner or a reason it is parked.",
                     "0 10 * * 1", "qa"),
        ],
        "dod_presets": [
            _preset("feature-pr", "Feature (PR)",
                    "Implemented behind a pull request; tests cover the new behaviour; CI is green; "
                    "the PR description explains what changed and how it was verified."),
            _preset("bug-fix", "Bug fix",
                    "A failing regression test reproduces the bug; the fix makes it pass; "
                    "no unrelated changes; PR links the report."),
            _preset("docs-update", "Docs update",
                    "The affected guide/README section is updated and matches current behaviour; "
                    "examples were run and work."),
        ],
        "objective_examples": [
            "Ship a public REST API for our booking service with auth, rate limits and docs.",
            "Rebuild the settings screen in React and reach 90+ Lighthouse accessibility.",
            "Cut the test suite's flaky failures to zero and keep CI under 10 minutes.",
        ],
    }


def _marketing_team():
    m = "general"
    return {
        "key": "marketing-team",
        "version": 1,
        "name": "Marketing team",
        "mode": m,
        "summary": "Plan campaigns, write content, grow organic reach and report what worked.",
        "roles": [
            _role("lead", "marketing-lead", "Marketing lead · campaigns & calendar",
                  "You own the marketing plan and the content calendar, and keep the team on message.",
                  ["Turn the objective into campaigns with goals, audiences and channels.",
                   "Keep a weekly content calendar and assign each piece.",
                   "Review drafts for positioning and brand voice before a human verifies."], m),
            _role("content", "content-writer", "Content writer",
                  "You write clear, on-brand long-form and short-form content.",
                  ["Blog posts, landing-page copy, newsletters and case studies.",
                   "Offer 2-3 headline options and a meta description with every article."], m, "lead"),
            _role("seo", "seo-specialist", "SEO specialist",
                  "You make sure the right people can find our content.",
                  ["Keyword research and content briefs with search intent.",
                   "On-page recommendations (titles, headings, internal links)."], m, "lead"),
            _role("social", "social-manager", "Social media manager",
                  "You adapt our content for each social channel and plan posting.",
                  ["Channel-specific post drafts with hooks and calls to action.",
                   "A posting schedule that matches the content calendar."], m, "lead"),
            _role("analyst", "marketing-analyst", "Marketing analyst",
                  "You measure what worked and recommend what to do next.",
                  ["Campaign and channel performance summaries from the data you are given.",
                   "Clear recommendations, with the numbers behind them and their sources."], m, "lead"),
        ],
        "routines": [
            _routine("content-calendar", "Content calendar for the week of {{date}}",
                     "Plan this week's content: topics, owners, channels and publish dates.",
                     "A calendar table lists every piece for the week with owner, channel, date and status.",
                     "0 9 * * 1", "lead"),
            _routine("monthly-report", "Marketing performance report {{date}}",
                     "Summarise last month's campaign and channel results.",
                     "A one-page report covers each active campaign's results vs goal, with sources, and 3 recommendations.",
                     "0 9 1 * *", "analyst"),
        ],
        "dod_presets": [
            _preset("blog-post", "Blog post",
                    "An 800-1,200 word draft in the brand voice, 2-3 headline options, a meta description "
                    "(under 160 characters), sources cited, and target keyword used naturally."),
            _preset("campaign-brief", "Campaign brief",
                    "One page: goal and success metric, audience, key message, channels, budget/timeline, "
                    "and the list of assets needed with owners."),
            _preset("social-pack", "Social post pack",
                    "One post per channel (LinkedIn, X, Instagram) sized for the channel, each with a hook, "
                    "a call to action and a suggested visual."),
            _preset("newsletter", "Newsletter",
                    "Subject line + preview text options, 3-5 sections with links, one clear call to action, "
                    "proof-read with no broken links."),
        ],
        "objective_examples": [
            "Launch our new product tier and reach 500 trial sign-ups in 6 weeks.",
            "Publish two SEO articles a week and double organic traffic this quarter.",
            "Run a customer-story campaign with four case studies and a webinar.",
        ],
    }


def _operations():
    m = "general"
    return {
        "key": "operations",
        "version": 1,
        "name": "Operations",
        "mode": m,
        "summary": "Document processes, coordinate vendors, and keep a weekly operating review.",
        "roles": [
            _role("lead", "ops-lead", "Operations lead",
                  "You keep the business running smoothly and decide what to fix first.",
                  ["Prioritise operational issues and turn them into tasks.",
                   "Run the weekly operating review and track follow-ups."], m),
            _role("process", "process-analyst", "Process analyst",
                  "You map how work actually happens and make it simpler.",
                  ["Write standard operating procedures (SOPs) people can follow.",
                   "Find bottlenecks and propose measurable improvements."], m, "lead"),
            _role("vendors", "vendor-coordinator", "Vendor coordinator",
                  "You keep track of suppliers, contracts and renewals.",
                  ["A vendor register with owners, costs and renewal dates.",
                   "Comparison sheets when we need to choose or switch a vendor."], m, "lead"),
            _role("reporting", "ops-analyst", "Reporting analyst",
                  "You turn operational data into a short, trustworthy weekly picture.",
                  ["KPI summaries from the data you are given, with sources.",
                   "Flag anomalies and say how confident you are."], m, "lead"),
        ],
        "routines": [
            _routine("weekly-review", "Weekly operating review {{date}}",
                     "Summarise KPIs, open issues and decisions needed this week.",
                     "A one-page review: KPIs vs last week, top 3 issues with owners, and decisions needed.",
                     "0 8 * * 1", "reporting"),
            _routine("renewals", "Vendor renewals check {{date}}",
                     "List contracts renewing in the next 60 days and recommend renew / renegotiate / cancel.",
                     "Every contract renewing within 60 days is listed with cost, owner and a recommendation.",
                     "0 9 1 * *", "vendors"),
        ],
        "dod_presets": [
            _preset("sop", "Standard operating procedure",
                    "Purpose, scope, roles, numbered steps a new hire can follow, exceptions, and an owner "
                    "and review date."),
            _preset("vendor-comparison", "Vendor comparison",
                    "At least three options compared on cost, fit, risks and contract terms, with a "
                    "recommendation and the sources for each figure."),
            _preset("incident-review", "Incident review",
                    "Timeline, impact, root cause, what went well/badly, and follow-up actions with owners "
                    "and dates. Blameless."),
        ],
        "objective_examples": [
            "Document our 10 most common processes as SOPs by the end of the quarter.",
            "Cut software spend 15% by reviewing every vendor contract before renewal.",
            "Set up a weekly operating review the leadership team actually reads.",
        ],
    }


def _research():
    m = "general"
    return {
        "key": "research",
        "version": 1,
        "name": "Research",
        "mode": m,
        "summary": "Scope questions, review sources, analyse data and write up findings.",
        "roles": [
            _role("lead", "research-lead", "Research lead",
                  "You frame the research questions and make sure findings answer them.",
                  ["A research plan: questions, methods, sources and timeline.",
                   "Review every write-up for rigour before a human verifies."], m),
            _role("literature", "lit-reviewer", "Literature reviewer",
                  "You find and summarise the most relevant prior work.",
                  ["Annotated bibliographies with full citations.",
                   "Summaries that separate what a source shows from what it claims."], m, "lead"),
            _role("data", "data-analyst", "Data analyst",
                  "You analyse the data you are given and report results honestly.",
                  ["Reproducible analyses with the method, assumptions and limitations stated.",
                   "Tables and charts described in words, with uncertainty where it matters."], m, "lead"),
            _role("writer", "synthesis-writer", "Synthesis writer",
                  "You turn findings into a clear report for non-experts.",
                  ["Executive summaries and full reports with an evidence trail.",
                   "Plain-language explanations of methods and caveats."], m, "lead"),
        ],
        "routines": [
            _routine("literature-digest", "Literature digest {{date}}",
                     "Collect and summarise new sources relevant to the open research questions.",
                     "A digest lists each new source with citation, a 2-3 sentence summary, and relevance.",
                     "0 9 * * 5", "literature"),
        ],
        "dod_presets": [
            _preset("lit-review", "Literature review",
                    "At least 10 relevant sources with full citations, a summary per source, themes across "
                    "sources, and the gaps they leave."),
            _preset("analysis", "Data analysis",
                    "Question, data description, method, results with uncertainty, limitations, and the "
                    "steps to reproduce."),
            _preset("research-report", "Research report",
                    "Executive summary (under 300 words), findings each backed by cited evidence, "
                    "limitations, and recommended next questions."),
        ],
        "objective_examples": [
            "Assess the market for home-battery storage in East Africa and size the opportunity.",
            "Review the evidence on 4-day work weeks and summarise it for our leadership team.",
            "Analyse our churn survey responses and identify the top 5 reasons customers leave.",
        ],
    }


def _customer_support():
    m = "general"
    return {
        "key": "customer-support",
        "version": 1,
        "name": "Customer support",
        "mode": m,
        "summary": "Triage requests, keep the help centre current, and spot patterns worth fixing.",
        "roles": [
            _role("lead", "support-lead", "Support lead",
                  "You make sure customers get fast, correct, kind answers.",
                  ["Set response standards and review tricky replies.",
                   "Escalate product issues with evidence to the right people."], m),
            _role("triage", "triage-agent", "Triage specialist",
                  "You sort incoming requests so the right person handles each one.",
                  ["Categorise and prioritise requests; draft first replies for review.",
                   "Never send anything to a customer yourself — drafts go to a human."], m, "lead"),
            _role("kb", "kb-writer", "Help-centre writer",
                  "You keep the help centre accurate and easy to search.",
                  ["New and updated articles for recurring questions.",
                   "Screenshots/steps checked against the current product."], m, "lead"),
            _role("insights", "support-analyst", "Support insights analyst",
                  "You find the patterns in support requests that the product team should fix.",
                  ["Weekly themes with counts and example requests.",
                   "Clear write-ups of the top issues with suggested fixes."], m, "lead"),
        ],
        "routines": [
            _routine("daily-digest", "Support digest {{date}}",
                     "Summarise yesterday's requests: volume, categories, and anything urgent.",
                     "A short digest with counts by category, urgent items with owners, and draft replies awaiting review.",
                     "0 8 * * 1-5", "triage"),
            _routine("faq-refresh", "Help-centre refresh {{date}}",
                     "Find the most-asked questions without a good article and write or update them.",
                     "At least 3 articles are drafted or updated, each linked to the requests that prompted it.",
                     "0 10 * * 3", "kb"),
        ],
        "dod_presets": [
            _preset("kb-article", "Help-centre article",
                    "Title phrased as the customer's question, numbered steps checked against the product, "
                    "screenshots where useful, and related articles linked."),
            _preset("reply-macro", "Reply template",
                    "A reusable reply with placeholders, the tone guide applied, and when (not) to use it."),
            _preset("issue-report", "Product issue report",
                    "What customers experience, how many were affected (with request links), reproduction "
                    "steps, and the suggested fix or workaround."),
        ],
        "objective_examples": [
            "Answer every support request within 4 business hours with a draft ready for review.",
            "Deflect 30% of repeat questions by rebuilding the help centre.",
            "Give the product team a weekly list of the top customer pain points with evidence.",
        ],
    }


# ---------------------------------------------------------------------------
# Validation (import-time for the catalog; reusable for other template sources)
# ---------------------------------------------------------------------------

class TemplateError(ValueError):
    pass


def validate_template(t: dict) -> dict:
    """Check a template's shape; raise TemplateError naming the first problem."""
    def need(cond, msg):
        if not cond:
            raise TemplateError(f"template {t.get('key')!r}: {msg}")

    need(isinstance(t.get("key"), str) and KEY_RE.match(t["key"]), "key must be a short slug")
    need(isinstance(t.get("version"), int) and t["version"] >= 1, "version must be a positive int")
    need(isinstance(t.get("name"), str) and 0 < len(t["name"]) <= MAX_NAME_LEN, "name required")
    need(t.get("mode") in PROJECT_MODES, f"mode must be one of {PROJECT_MODES}")
    roles, routines, presets = t.get("roles") or [], t.get("routines") or [], t.get("dod_presets") or []
    need(0 < len(roles) <= MAX_ROLES, f"1-{MAX_ROLES} roles")
    need(len(routines) <= MAX_ROUTINES, f"at most {MAX_ROUTINES} routines")
    need(len(presets) <= MAX_DOD_PRESETS, f"at most {MAX_DOD_PRESETS} DoD presets")
    role_keys, aliases = set(), set()
    for r in roles:
        need(KEY_RE.match(r.get("key") or ""), f"role key {r.get('key')!r} invalid")
        need(r["key"] not in role_keys, f"duplicate role key {r['key']!r}")
        role_keys.add(r["key"])
        need(ALIAS_RE.match(r.get("alias") or ""), f"alias {r.get('alias')!r} invalid")
        need(r["alias"] not in aliases, f"duplicate alias {r['alias']!r}")
        aliases.add(r["alias"])
        need(isinstance(r.get("role"), str) and 0 < len(r["role"]) <= 200, f"role title for {r['key']!r}")
        need(isinstance(r.get("prompt"), str) and 0 < len(r["prompt"]) <= MAX_PROMPT_LEN,
             f"prompt for {r['key']!r}")
    for r in roles:
        mgr = r.get("reports_to")
        need(mgr is None or mgr in role_keys, f"{r['key']!r} reports to unknown role {mgr!r}")
        need(mgr != r["key"], f"{r['key']!r} cannot report to itself")
    # no reporting loops inside the template
    parent = {r["key"]: r.get("reports_to") for r in roles}
    for k in parent:
        seen, cur = set(), k
        while cur is not None:
            need(cur not in seen, f"reporting loop through {cur!r}")
            seen.add(cur)
            cur = parent.get(cur)
    rt_keys = set()
    for r in routines:
        need(KEY_RE.match(r.get("key") or ""), f"routine key {r.get('key')!r} invalid")
        need(r["key"] not in rt_keys, f"duplicate routine key {r['key']!r}")
        rt_keys.add(r["key"])
        need(0 < len(r.get("title") or "") <= MAX_NAME_LEN, f"routine {r['key']!r} title")
        need(len(r.get("description") or "") <= MAX_DESC_LEN, f"routine {r['key']!r} description")
        need(0 < len(r.get("definition_of_done") or "") <= MAX_DOD_LEN, f"routine {r['key']!r} DoD")
        need(r.get("assignee") is None or r["assignee"] in role_keys,
             f"routine {r['key']!r} assignee {r.get('assignee')!r} is not a template role")
        try:
            sched.validate(r.get("cron") or "", "UTC")
        except sched.ScheduleError as err:
            raise TemplateError(f"template {t['key']!r}: routine {r['key']!r} cron: {err}") from None
        need(isinstance(r.get("priority", 100), int), f"routine {r['key']!r} priority")
    p_keys = set()
    for p in presets:
        need(KEY_RE.match(p.get("key") or ""), f"preset key {p.get('key')!r} invalid")
        need(p["key"] not in p_keys, f"duplicate preset key {p['key']!r}")
        p_keys.add(p["key"])
        need(0 < len(p.get("label") or "") <= MAX_PRESET_LABEL, f"preset {p['key']!r} label")
        need(0 < len(p.get("text") or "") <= MAX_DOD_LEN, f"preset {p['key']!r} text")
    ex = t.get("objective_examples") or []
    need(all(isinstance(e, str) and 0 < len(e) <= MAX_DESC_LEN for e in ex), "objective examples")
    return t


CATALOG: tuple[dict, ...] = tuple(
    validate_template(t)
    for t in (_software_team(), _marketing_team(), _operations(), _research(), _customer_support())
)
_BY_KEY = {t["key"]: t for t in CATALOG}


def get_template(key: str) -> dict | None:
    return _BY_KEY.get(key)


def summary(t: dict) -> dict:
    """The list-view shape (no prompts)."""
    return {
        "key": t["key"],
        "version": t["version"],
        "name": t["name"],
        "mode": t["mode"],
        "summary": t["summary"],
        "roles": [{"key": r["key"], "alias": r["alias"], "role": r["role"]} for r in t["roles"]],
        "routine_count": len(t["routines"]),
        "dod_preset_count": len(t["dod_presets"]),
        "objective_examples": list(t["objective_examples"]),
    }
