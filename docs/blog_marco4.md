# Virtual Office Over Markdown: Turning Claude Into Seven Coworkers

*Átrio Office, a case study from a Brazilian accounting firm. April 2026.*

---

## TL;DR

- **Átrio Office** is a virtual back-office for a Brazilian accounting firm. Seven AI agents — each with their own markdown prompt, tools, and personality — pick up tasks, leave comments, and hand off work to each other.
- Built on **Claude Sonnet 4.5** (via OpenRouter for multi-model routing), with **prompt caching**, **extended thinking**, and a shared **tasks + comments** coordination layer.
- Numbers in production: **98.4% cache hit rate**, **89% cost reduction per agent call**, **$0.0006 per call**, 7 agents online, 120 tasks processed, a dozen closed every week without human orchestration.
- Position: not a chat wrapper, not a Copilot clone — a **vertical office-in-a-box** for accounting, with a **markdown-first portability package** so any firm can self-host it.

---

## The problem: accounting is coordination, not intelligence

Brazilian accounting is ICMS, ISS, DAS, NFS-e, retenções, Simples Nacional — a graph of deadlines where the bottleneck is not "figuring out what to do." The rules are public. The forms are standardized. The bottleneck is **executing hundreds of small tasks coordinated between humans and a dozen client-facing systems**, without losing a single message.

The obvious pitch — "use AI to automate accounting" — misses the shape of the work. An LLM that correctly answers "what's the IRRF on this invoice?" is table stakes. The hard part is:

- A client sends a PDF at 22:14 on a Sunday.
- Luna (front-desk agent) reads it, identifies the company, opens a task, assigns Rodrigo (fiscal agent).
- Rodrigo computes the retenções, drafts the NFS-e payload via Nuvem Fiscal sandbox, flags that the municipal bracket is ambiguous, and **@mentions Diogo** (the human partner) in a task comment.
- Monday morning Diogo replies "usa alíquota 3%" in the same thread. Rodrigo resumes, emits the note, notifies Luna, who closes the loop with the client.

No dashboard. No ticket queue. No "prompt, wait, copy-paste." **A thread. Like a Slack channel, except the coworkers are agents.**

That's what Átrio Office is.

---

## The architecture that made it cheap enough to matter

### 1. Markdown-first: every agent is a file

Each of the 7 agents is an `AGENTS.md` — a markdown file with frontmatter:

```yaml
---
role: campelo
name: Campelo
provider: openrouter
model: anthropic/claude-sonnet-4.5
thinking_budget: 2000
temperature: 0.1
---

# You are Campelo, the senior tax specialist of Átrio...
```

Swap the file, restart the server, the agent's brain is new. **The company's DNA lives in git**, not in a vendor admin panel.

We also shipped a CLI — `atrio-cli export` — that packages all 7 agents, skills, and alert config into a folder another firm can `atrio-cli import` to stand up their own office. No forking required; the portability is the point.

### 2. Prompt caching turned Claude from "too expensive" into "default"

Each agent prompt is **3–6K tokens** of domain rules, active memories, and skill catalogs. Before caching, a call cost about $0.0055. At scale, that's absurd for a small firm.

We wired `cache_control: { type: 'ephemeral' }` on the stable prefix (system + skills + memories). Measured on a controlled A/B over 100 calls:

| | Before | After |
|---|---|---|
| Cache hit rate | 0% | **98.4%** |
| Cost per call | $0.0055 | **$0.0006** |
| P50 latency | 2.1s | **1.3s** |

**-89% cost, -38% latency.** Cache reads are $0.30/MT vs. $3.00/MT on input. That single `cache_control` line decided whether this system lived or died.

### 3. Extended thinking, but only where it earns its keep

We enabled `thinking: { budget_tokens: 2000 }` on **Campelo only** — the tax agent. He's the one where being wrong costs money; a misapplied ISS rate becomes a compliance fine.

Luna (reception), Sneijder (fiscal dispatch), Saldanha (accounting), André (HR), Auditor, Rodrigo — none need deliberation. A 500-token response at 1s is worth more than a 5000-token thought process at 8s.

**Thinking is a scalpel. Use it like one.**

### 4. Tasks + comments, not orchestration DAGs

We don't have LangGraph. We don't have a DAG engine. We have two tables:

```sql
CREATE TABLE tasks (id, title, assigned_to, status, result, tenant_id, ...);
CREATE TABLE task_comments (id, task_id, author_type, author_id, body, mentions TEXT[]);
```

Coordination equals `@mentions`. Luna opens a task assigned to Rodrigo. Rodrigo does work, posts a comment: `@Diogo posso aplicar 3%?`. A WebSocket event fires; Diogo's UI highlights. He types a reply. The orchestrator sees `author_type='human'` and `mentions=['rodrigo']`, and wakes Rodrigo with the full thread as context.

Simple tables, Slack-like UX, **same pattern Paperclip uses to coordinate Claude Code, Codex, and Gemini CLI instances as peers**. Agents are peers, not a hierarchy.

### 5. Mission Control, because invisible queues rot

Tasks pile up. Some get orphaned. Agents crash mid-task and leave stranded work. We built a single page — **Mission Control** — with three tabs:

- **Active**: who's working on what, elapsed time, which tool
- **Pending / Blocked**: queued or erroring, with one-click **Unblock**, **Cancel**, and **Open thread**
- **Done (24h)**: audit trail

On the day we shipped it, Mission Control exposed **108 orphan "SLA alert" tasks** from a watchdog job that had been silently polluting the queue. We moved those alerts to a `notifications` table in the same hour. **A queue you can't see is a queue that's already broken.**

### 6. Adapter pattern: ready to plug any agent

Every LLM provider lives behind `LLMAdapter.generate({ model, messages, ... })`. Registered: `anthropic`, `openrouter`, `grok`, `deepseek`, `minimax`. Plugging something new — a local Claude Code CLI instance, an OpenClaw gateway, a Gemini CLI — is a new adapter file (≈60 lines), not a rewrite.

The adapter contract is deliberately narrow: input is OpenAI-shape messages + tools, output is `{ success, content, tool_calls, usage, provider, model }`. Wire format as intermediate representation. Easy to test, easy to swap.

### 7. Multi-tenant from day one

Every row has `tenant_id`. Middleware reads `X-Atrio-Tenant` and injects into `AsyncLocalStorage`. Today it's `atrio` (us). Tomorrow it's any accounting firm that runs the Company Portability import. **Same binary, same Postgres, isolated data.**

---

## The numbers, honestly

| Metric | Value |
|---|---|
| Agents online | **7** |
| Tasks processed (total) | **120** |
| Tasks closed last 7 days | **12** |
| Approved memories (curated) | **3** of 144 pending |
| Cache hit rate | **98.4%** |
| Cost per call (post-cache) | **$0.0006** |
| Estimated monthly LLM cost | **~$30** for the whole office |

We are not running this at Google scale. We are running this at **small-firm scale**, which is precisely where the ROI is easiest to underwrite and hardest to fake. At $30/month for the full LLM bill, the system pays for itself the first time Luna closes a ticket over the weekend.

---

## What this proves for Claude

Anthropic's thesis is that Claude is *the* agent model. The canonical proof points — Claude Code, SWE-bench, enterprise copilots — are **horizontal and developer-facing**.

Átrio Office is the counter-example: a **vertical, domain-specific, non-developer workforce**, where Claude isn't the product — it's the employee. The customer is a 52-year-old accountant in Recife who doesn't know what an LLM is. He knows Luna answered the client at 22:14 on a Sunday and Rodrigo had the NFS-e ready Monday at 7.

If Anthropic is looking for case studies that aren't "another YC startup bolted Claude onto a chat widget," this is the shape:

1. **Vertical moat** — regulatory, regional, contextual (Brazilian tax law).
2. **Markdown-first portability** — the moat isn't the code, it's the 7 agent prompts, curated over 6 months.
3. **Cache + thinking + tools as first-class patterns**, not afterthoughts.
4. **Human-in-the-loop via comments**, not approval modals.
5. **Real P&L**: replaces a junior-analyst seat at a fraction of the cost.

---

## What's next

- **Natalia** — commercial lead qualification via WhatsApp.
- **Auditor Interno** — continuous controllership, books closed in hours, not weeks.
- **TI Agent** — an observability/ops coworker for the systems themselves.
- Open-sourcing the Company Portability CLI and an agent-template repo so other Brazilian firms can self-host.

---

## Contact

Happy to walk Anthropic DevRel through Mission Control live — the VPS is one `ssh` away.

— Caio Monteiro, founder, Átrio Contabilidade (Recife, BR)
