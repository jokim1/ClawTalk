# ClawTalk — Agent Eval Suite

> **Status:** spec (skeleton) · **Generated:** 2026-05-30
> Structural contract for the Phase 13 offline agent-eval gate (per [`05-build-plan.md`](./05-build-plan.md) Phase 13 + [`06-agent-system-design.md`](./06-agent-system-design.md) §14.6). Scenario content + grader prompts are TODO at impl time — this doc locks in the harness shape so the eval gate is buildable from spec.

## 1. What the eval gate checks

The 5 default agents (Strategist / Critic / Researcher / Editor / Quant per [`03-agents.md`](./03-agents.md)) have never been tested against each other in a multi-agent run. This eval harness runs the default team on representative prompts and grades each agent's response against the **`AgentAuditResult` rubric** in `06-agent-system-design.md` §14.6:

- **`roleAdherence`** — did the agent stay in its declared role + use its method?
- **`nonDuplication`** — did it avoid repeating other agents' points?
- **`evidenceDiscipline`** — did it cite a source for empirical claims?
- **`methodAdherence`** — did it follow the role's stated method (e.g., Strategist frames; Researcher cites)?
- **`usefulness`** — does the response advance the conversation toward a recommendation?
- **`concision`** — within token / sentence budget per role?

Each dimension scored 0–10 by a grader agent (see §3). Pass thresholds per role TBD at impl time; the harness exposes them as config.

## 2. Test scenarios (TODO at impl time)

The eval suite runs N representative scenarios. Each scenario is:

```ts
type EvalScenario = {
  id: string;                    // 's-pricing-launch', 's-hiring-tradeoff', …
  description: string;           // one sentence
  team: 'default' | string;      // 'default' = the 5 canonical roles; or a named TeamComposition
  mode: 'ordered' | 'parallel';
  rounds_limit: 1 | 2 | 3 | 5;
  user_prompt: string;           // the user turn that kicks off the Talk
  expected_dynamics: string;     // prose: what the harness should see if the team is working
  pass_criteria: {               // per-role rubric thresholds
    strategist?: Partial<AgentAuditResult>;
    critic?: Partial<AgentAuditResult>;
    researcher?: Partial<AgentAuditResult>;
    editor?: Partial<AgentAuditResult>;
    quant?: Partial<AgentAuditResult>;
  };
};
```

**v1 scenarios** (Joseph to write at Phase 13 impl):

1. **`s-pricing-launch`** — pricing decision under uncertainty (Strategist frames + Quant numbers + Critic challenges + Researcher cites comp data + Editor synthesizes).
2. **`s-hiring-tradeoff`** — a senior vs two mid-level engineer hire (forces method differentiation; tests non-duplication when Strategist + Critic + Editor all have related but distinct jobs).
3. **`s-empirical-claim-required`** — a market-sizing question where every agent should defer to Researcher; tests `evidenceDiscipline` strictly.
4. **`s-edge-case-pushback`** — a deliberately weak user proposal; tests whether Critic actually pushes back vs. rubber-stamping.
5. **`s-synthesis-quality`** — a complex multi-thread decision; tests Editor's synthesis discipline (does it land a clear recommendation or hedge?).

Each scenario is a JSON file under `eval/scenarios/<scenario_id>.json` matching the `EvalScenario` shape.

## 3. Grader prompts (TODO at impl time)

A separate **grader agent** runs against each agent reply + the full Talk transcript. One grader prompt per rubric dimension. Grader is a system agent (`is_system=true`, `role_key='eval_grader'`) per §11 §4.

```ts
type GraderPrompt = {
  dimension: keyof AgentAuditResult;       // 'roleAdherence' | … | 'concision'
  system_prompt: string;                   // grader's role + scoring methodology
  user_template: string;                   // template with {agentRole}, {agentReply}, {talkTranscript} slots
  output_schema: 'numeric_0_to_10';        // strict numeric output for deterministic aggregation
};
```

Graders live at `eval/graders/<dimension>.json`. The harness loops every (scenario, agent_reply, dimension) triple, runs the grader, and aggregates into `AgentAuditResult` rows.

## 4. Harness contract

- Implementation lives in `eval/` (sibling of `src/`). Runs against the worker via `dev:worker`.
- One CLI: `npm run eval -- --scenarios=all --workspace=<id>`.
- Output: a JSON report + a pretty-printed table grouped by (scenario, agent, dimension).
- Pass/fail per scenario: scenario passes if every per-role dimension hits its threshold. Suite passes if every scenario passes.
- Launch-blocking per `engineering-notes.md` §3 — v1 cannot ship without the suite passing.

## 5. What's in scope here vs. impl time

**In scope here (locked in this doc):**
- `EvalScenario` TS shape.
- `GraderPrompt` TS shape.
- 5 scenario IDs + 1-sentence descriptions.
- The dimension list (matches §06 §14.6 `AgentAuditResult`).
- File-layout convention (`eval/scenarios/`, `eval/graders/`).
- CLI surface (`npm run eval`).
- Launch-blocking status.

**Deferred to Phase 13 impl:**
- The actual `user_prompt` + `expected_dynamics` + `pass_criteria` thresholds for each scenario.
- The actual grader `system_prompt` + `user_template` per dimension.
- The CLI flags (`--workspace`, `--scenarios`, output format).
- Wiring into CI (whether `eval` runs on every PR or only pre-launch).

When Phase 13 starts, this doc gets the deferred sections filled in; nothing about the contract above changes.
