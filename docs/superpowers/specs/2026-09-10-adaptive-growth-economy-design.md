# Adaptive Growth Economy

## Purpose

LifeOS should use rewards and penalties to strengthen the behavioral capabilities that currently limit progress. It should learn from verified outcomes, change emphasis as the user improves, and remain understandable enough that every coin movement can be audited.

The system is intended to address a recurring pattern: strong initial enthusiasm, inconsistent attendance, short attention spans, abandoned commitments, and long gaps after a lapse. It is not a general-purpose game economy and it must not reward raw activity volume. Its job is to help the user become better at showing up, sustaining attention, following through, and recovering.

This design extends the closed-loop coaching commitments introduced in migration 045. It preserves the current reward store, custom reward management, adaptive store pricing, idempotent redemption, and append-only `coin_ledger`. The main change is a central evidence and settlement layer for earning and forfeiting coins.

## Research basis

### Loss framing and commitment stakes

A 281-person randomized controlled trial compared daily feedback with gain, lottery, and loss-framed incentives for a 7,000-step goal. Participants in the loss-framed arm achieved the goal on 45% of days versus 30% in the control arm; only the loss-framed arm was significantly better than control. The groups no longer differed during the incentive-free follow-up.[^1] An earlier 57-person randomized trial also found better short-term weight loss with deposit contracts and lottery incentives, while much of the advantage was not sustained after incentives stopped.[^2]

LifeOS should therefore use a visible commitment stake, but it should taper the stake as behavior stabilizes and measure whether behavior survives that taper. It should not assume that a larger loss always produces more durable behavior.

A systematic review and meta-analysis of 34 studies found that personal financial incentives improved health-related behavior, but evidence beyond three months after incentive removal was weak.[^3] That supports immediate settlement and gradual fading, with long-term behavior included in the objective.

### Planning and stable contexts

A meta-analysis of 94 independent tests reported a medium-to-large effect of implementation intentions on goal attainment. The useful mechanism is a concrete if-then plan specifying when, where, and how action begins.[^4] Accepted LifeOS commitments should therefore include a start cue and a minimum first action, rather than only a deadline or task title.

Habit research suggests that repetition in a stable context increases automaticity. A six-week study of study habits and a habit-building app dataset both found that context stability predicted automaticity and goal attainment.[^5] A later randomized study found that consistent-context planning produced stronger maintained automaticity than varied-context planning, although it did not by itself guarantee maintained walking.[^6] LifeOS should reward repeated execution under a useful cue while still measuring real performance.

There is no scientifically defensible universal twenty-one-day habit threshold. In one 84-day randomized habit-formation study, successful participants took a median of 59 days to reach peak automaticity.[^7] Reward fading should depend on the individual's evidence rather than a fixed calendar milestone.

### Adaptive interventions

The HeartSteps micro-randomized trial repeatedly randomized context-sensitive activity suggestions. Across 44 adults over six weeks, a suggestion increased the next 30-minute step count by an estimated 14%, but the result was modest and narrowly missed conventional statistical significance.[^8] This illustrates why LifeOS should log intervention probabilities and measure proximal outcomes instead of assuming that a plausible message works.

The 168-participant DIAMANTE randomized trial compared control, random messages, and reinforcement-learning-selected messages. The adaptive arm increased step counts over 24 weeks and outperformed the other arms.[^9] This supports personalized selection, while the difference in domain and population means it does not prove that the same algorithm will improve studying.

LifeOS should use a constrained contextual bandit for safe intervention choices. Penalty rules themselves should remain bounded by explicit policy until enough personal evidence exists.

### Autonomy and intrinsic motivation

A meta-analysis of 128 experiments found that expected tangible rewards contingent on engagement, completion, or performance could reduce later free-choice engagement, while positive feedback improved free-choice behavior and reported interest.[^10] Coins must therefore communicate progress and competence rather than become the only reason to act. The system must explain each decision, preserve user choice, taper external rewards, and measure voluntary behavior after bonuses decline.

## Design principles

1. **Verified behavior over self-description.** Objective or corroborated evidence should carry more weight than a task status alone.
2. **Uncertainty is not failure.** Missing, stale, or contradictory telemetry must never cause a penalty.
3. **Accepted commitments create accountability.** A penalty may apply only after the user accepts a specific start, duration, and minimum action.
4. **Process before outcome.** LifeOS rewards starting, sustained engagement, completion, and recovery. It does not reward being busy.
5. **One growth edge at a time.** The policy concentrates extra reinforcement on the most consequential trainable constraint.
6. **Stable base, adaptive margin.** Existing base rewards remain understandable. Personalization adjusts bounded bonuses and stakes.
7. **No debt spiral.** Balance never becomes negative, losses are capped, and repeated failure causes task simplification and investigation rather than escalating punishment.
8. **Every decision is reconstructable.** Evidence, inputs, model version, calculation, and ledger effects are stored.
9. **Learning must establish uplift.** A reply or click is not success. The model learns from subsequent starts, focus, completion, and return behavior.
10. **Store economics stay separate.** Earning policy and reward pricing may share context, but neither silently modifies the other.

## Behavioral capability model

LifeOS maintains five capability estimates.

| Capability | Meaning | Primary outcome |
|---|---|---|
| `show_up` | Begin an accepted commitment close to its cue | Start delay and whether a start occurred |
| `attention_stability` | Remain engaged with the intended work | Target-aligned verified intervals divided by scored intervals |
| `follow_through` | Complete a meaningful portion of the commitment | Verified elapsed/planned ratio, capped at one |
| `consistency` | Return across planned days without extreme gaps | Minimum viable block completed on scheduled days |
| `recovery` | Resume purposeful action after a lapse | Time to next verified start and its completion quality |

Each normalized evidence event has:

```text
capability
outcome y in [0, 1]
confidence q in [0, 1]
source and source id
observed time
context snapshot
goal and commitment links
```

Initial confidence guidance is:

| Evidence | Confidence |
|---|---:|
| Finalized Guardian Evidence V2 intervals | 1.00 |
| Guardian session outcome with sufficient finalized intervals | 0.90 |
| User action corroborated by a linked task/session event | 0.80 |
| Manual completion without corroboration | 0.50 |
| Passive browser or app activity without target linkage | 0.30 |
| Missing, stale, conflicting, or technically invalid data | 0.00 |

Confidence is a policy input, not a claim that an evidence source is correct with that literal probability. Calibration can change these values after correction data accumulates.

`source reliability` begins at one and is calibrated only from resolved user corrections. A source is reduced or suspended from penalty decisions when its classifications are repeatedly overturned. This keeps evidence coverage and source accuracy as separate quantities.

### Bayesian update

Each capability uses a fractional Beta-Binomial estimate. It begins with a weak neutral prior `Beta(2, 2)`. For an event with outcome `y`, confidence `q`, source reliability `r`, and recency weight `d`:

```text
w = q * r * d
alpha += w * y
beta  += w * (1 - y)
capability mean = alpha / (alpha + beta)
effective evidence = alpha + beta - 4
```

Every weekly recomputation decays evidence beyond the prior with a 28-day half-life. This lets the model adapt when the user's behavior changes while preventing one good or bad day from rewriting the profile.

The posterior interval is retained. Penalties require direct evidence for the specific commitment and do not rely on a low population-level capability estimate. Capability uncertainty affects bonuses and target selection only.

### Outcome definitions

`show_up` is one at or before a five-minute grace period, 0.75 within ten minutes, 0.5 after a missed-start intervention, and zero when the 30-minute intervention window closes without a start.

`attention_stability` is the proportion of finalized, scored intervals classified as target-aligned or productive. Uncertain, idle, locked, private, and unobserved intervals are removed from the denominator. A session needs a minimum evidence duration before this capability updates.

`follow_through` is verified elapsed time divided by planned time, capped at one. It becomes one at or above 80% when the intended milestone is also satisfied; otherwise the continuous ratio is retained.

`consistency` is evaluated once per local day. A scheduled day succeeds when at least one accepted minimum viable block is completed. Unscheduled recovery days do not count as failures.

`recovery` begins after an abandoned commitment or missed scheduled day. The score combines return delay and the quality of the first returning session:

```text
recovery = exp(-hours_to_return / 24) * returned_session_quality
```

A return within hours scores more than one several days later, but any real return receives positive evidence.

## Selecting the growth edge

The policy chooses one primary capability for a seven-day training window. A secondary capability is allowed only after at least twenty effective evidence units and only when it does not compete with the primary target.

For capability `k`:

```text
gap_k = max(0, target_k - posterior_mean_k) / target_k
persistence_k = distinct_failure_days_in_last_14 / scheduled_days_in_last_14
confidence_k = 1 - exp(-effective_evidence_k / 8)

growth_need_k =
    gap_k
  * (0.5 + 0.5 * persistence_k)
  * (0.6 + 0.4 * confidence_k)
  * active_goal_importance_k
  * trainability_k
```

Initial targets are 0.80 for `show_up`, 0.75 for `attention_stability`, 0.80 for `follow_through`, 0.70 for `consistency`, and 0.70 for `recovery`. They are configurable and recorded with the policy version.

`active_goal_importance` comes from the user's explicit goal priority and defaults to one. `trainability` also defaults to one; it is reduced when repeated blocker reports identify external constraints that a smaller commitment or different cue cannot reasonably change. Neither value may be inferred from an LLM-generated personality label.

During cold start, the user's declared priorities supply the prior ordering: showing up, attention stability, then consistency. After evidence accumulates, observed growth need takes over. The weekly choice is frozen to avoid daily oscillation.

## Commitment contract and stake

An accepted coaching commitment creates an adaptive reward contract. Acceptance means the user directly confirmed the commitment, created the scheduled block, or approved a daily plan containing it. An automatically suggested block that the user has not seen is not stake-eligible. The contract records the planned cue, minimum action, planned duration, base reward, primary capability, growth bonus ceiling, stake, policy version, and evidence requirements.

The initial stake is deterministic:

```text
risk = predicted non-completion probability for this context
raw stake = base reward * (0.15 + 0.35 * risk)
stake = round to nearest 5 coins
stake = min(stake, 25 coins, 5% of spendable balance)
```

No stake is created when the balance is below twenty coins. Total stake forfeiture is capped at 10% of the opening daily balance and 15% of the opening weekly balance. The balance can never fall below zero.

At acceptance, the stake is locked through a negative ledger entry and a unique settlement key. On success, a positive entry returns it. A failure causes no second deduction: the already-visible stake is simply not returned. This creates loss framing without surprising retrospective charges.

### Settlement matrix

| Result | Stake | Base reward | Growth bonus |
|---|---:|---:|---:|
| On-time start and outcome at least 0.80 | 100% returned | 100% | 100% |
| Start after intervention, outcome at least 0.80 | 100% returned | 100% | Recovery-weighted 40–80% |
| Verified outcome from 0.50 to 0.79 | Returned in proportion to outcome | Outcome proportion | Up to 40% |
| Verified outcome below 0.50 | Forfeited in proportion to shortfall | Up to 25% | None |
| Unexplained no-show after 30 minutes | Forfeited | None | None |
| Rescheduled before grace period | Returned | None | None |
| Rescheduled after intervention | 75% returned | None | None |
| Technical failure or insufficient evidence | Returned | Deferred or neutral | None |

One pre-grace reschedule is free for a commitment. Further same-day reschedules reduce the returned stake by 25 percentage points, but never exceed the daily cap. A stated blocker does not automatically remove accountability; it changes the recommended next action and may justify a smaller replacement commitment.

### Growth bonus

The bonus is computed only for the active growth edge:

```text
improvement = clamp((outcome - capability_mean) / max(0.2, 1 - capability_mean), 0, 1)
need = growth_need for the active capability

bonus_multiplier = min(1.5, need * evidence_confidence * (0.5 + improvement))
growth_bonus = round_to_5(base_reward * bonus_multiplier)
```

The total earning multiplier cannot exceed 2.5 times the stable base. As the capability remains above target for three consecutive weekly reviews, the bonus ceiling fades by 25% per week. LifeOS continues measuring the capability after the bonus reaches zero to test maintenance.

## Intervention learning

The learning problem is separated into two layers.

### Rule-bound layer

The following are never chosen by a learning algorithm:

- whether uncertain evidence counts as failure;
- negative-balance behavior;
- daily and weekly penalty caps;
- maximum stake and bonus multiplier;
- protected recovery and technical-failure cases;
- irreversible ledger mutation rules.

### Contextual bandit layer

A conservative Thompson-sampling policy chooses among safe intervention variants:

- direct start command;
- two-minute starter step;
- start-or-reschedule choice;
- explicit stake/loss reminder;
- blocker and recovery framing.

Context features include local time band, day of week, location category when available, planned duration, active growth edge, recent sleep and energy, deadline pressure, recent start rate, recent focus quality, last blocker, consecutive misses, notification load, and whether the context matches a previously successful cue.

The bandit optimizes a delayed composite outcome:

```text
0.35 * start_within_10_minutes
+ 0.30 * meaningful_completion
+ 0.20 * verified_attention_quality
+ 0.15 * return_within_24_hours
```

The 24-hour component discourages policies that produce one intense session followed by disengagement.

Every decision records the selected action, alternatives, selection probability, features, policy version, and availability constraints. The first three eligible observations per action use round-robin exploration. Afterwards, at most 20% of eligible decisions explore; the remainder use the best posterior sample. No exploration occurs during high notification fatigue, recovery mode, or deadline emergencies.

Outcomes mature after 24 hours and policy parameters update weekly. The model uses 28-day decay and pooled priors across time contexts so it can learn with one user's sparse data. It does not declare a contextual winner until each viable action has at least eight evaluated outcomes overall and the posterior probability of superiority exceeds 0.80.

## Data model

Migration 046 should add these tables.

### `behavior_evidence_events`

Append-only normalized observations. Columns include source type/id, capability, outcome, confidence, source reliability, context JSON, goal/task/commitment/session links, observed time, policy version, and creation time. A unique key on source type, source id, capability, and event kind prevents duplicate evidence.

### `behavior_capability_state`

One materialized row per capability with prior alpha/beta, posterior alpha/beta, posterior mean and interval, effective evidence, target, trend, growth-need score, active status, model version, and recomputation time. The table is rebuildable from evidence.

### `adaptive_reward_contracts`

One contract per accepted commitment. It stores base coins, stake coins, bonus ceiling, growth capability, acceptance context, required evidence, state, stake ledger id, and settlement timestamps. Commitment id is unique.

### `adaptive_reward_settlements`

Append-only settlement records containing an idempotency key, contract id, outcome components, evidence ids, stake return, base reward, bonus, forfeiture, explanation JSON, policy version, ledger ids, and settled time.

### `adaptive_policy_decisions`

Bandit decision log containing decision point, context features, available actions, selected action, propensity, posterior sample, proximal outcome, delayed outcome, evaluation time, and model version.

### `adaptive_reward_disputes`

User corrections linked to a settlement. Resolution uses compensating ledger entries; historical ledger rows are never edited or deleted.

## Components and boundaries

### `behavior-evidence.ts`

Normalizes and deduplicates events. It knows evidence definitions and confidence but does not award coins.

### `behavior-capabilities.ts`

Rebuilds posterior capability state, applies decay, selects the weekly growth edge, and exposes explanations. Its calculations are pure functions with database orchestration kept thin.

### `adaptive-growth-economy.ts`

Creates reward contracts, calculates stakes and bonuses, and generates settlement plans. It does not write directly to unrelated task or Guardian tables.

### `reward-ledger.ts`

Executes idempotent ledger transactions. It checks balance floors and loss caps, inserts settlement records and coin entries atomically, and creates compensating entries for corrections.

### `adaptive-intervention-policy.ts`

Selects safe coaching variants and evaluates their delayed outcomes. It never changes hard economic constraints.

### Existing integrations

- `coaching-commitments.ts` creates a contract when a commitment becomes accepted and requests settlement when it completes, expires, or is rescheduled.
- `guardian-runtime.ts` emits verified start, attention, and completion evidence. It does not calculate coins.
- `task-time-sessions.ts`, habits, photo proof, tasks, chat completion, and achievements migrate to the central settlement API incrementally. Existing award paths remain until their idempotent replacement is verified.
- `adaptive-rewards.ts` retains store policy and compatibility helpers but delegates new earning decisions to the growth economy.
- `/api/coaching/state` exposes the active growth edge, capability estimates, current contract, and recent settlements.
- `/coach` shows what LifeOS is training, why, the stake, potential reward, evidence, and dispute control.
- `/store` continues to handle spending and redemption history; it may show earning explanations but does not settle earnings.
- The scheduler closes daily consistency/recovery observations and runs weekly capability and policy recomputation.
- Full and tracking resets include the new derived tables and event history according to their current preservation policies.

## User experience

Before a commitment begins, LifeOS displays:

```text
Today we are training: showing up
Start: 8:00 PM at the cafe
Minimum action: open the DSA problem and work for 10 minutes
Stake: 10 coins
Earn: 30 base + up to 25 growth bonus
Why: only 3 of the last 7 accepted starts began within ten minutes
```

After settlement, it displays the calculation rather than a generic success message:

```text
Started 4 minutes late · completed 23/25 verified minutes · focus 82%
10 stake returned + 30 base + 20 showing-up bonus
Capability estimate: 54% → 58%
```

After failure:

```text
This commitment expired without a verified start. The 10-coin stake was forfeited.
No additional deduction was made. Daily loss cap remaining: 5 coins.
Next move: a 5-minute restart block, or tell LifeOS what blocked the start.
```

The interface must distinguish observed facts, calculated estimates, and inferences. It must never state that it knows why a failure happened without a user explanation or strong corroborating evidence.

## Failure handling and anti-gaming

- A settlement key makes every contract outcome exactly once, even if Guardian, scheduler, or Telegram retries.
- Late evidence creates a compensating settlement rather than mutating ledger history.
- Conflicting evidence moves a contract to `review_required`; the stake is returned until resolved.
- Outages and stale collectors create neutral outcomes.
- Manually toggling a task does not earn a high-confidence growth bonus without corroborating work evidence.
- Repeating tiny low-value actions cannot farm coins: base rewards have per-source cooldowns and daily ceilings.
- Extending a session after its planned end does not increase reward without a newly accepted contract.
- Multiple evidence sources describing the same work collapse into one canonical event.
- Store price changes cannot be used to retroactively alter an earned or staked amount.
- Corrections update source reliability calibration and can suspend a source from penalty decisions.

## Safety and pause conditions

LifeOS automatically pauses new stakes for seven days when any of these occur:

- the user disputes more than 10% of penalty settlements in a rolling fourteen-day window;
- verified show-up falls by more than twenty percentage points after penalty intensity increases;
- two consecutive daily loss caps are reached;
- the system detects high coaching fatigue or an active recovery episode;
- required evidence coverage falls below 70%;
- the user manually pauses penalties.

During the pause, base rewards and measurement continue. LifeOS asks for one correction or policy preference, simplifies commitments, and does not attempt to recover losses through harsher future stakes.

## Evaluation plan

The system is successful only if behavior improves without increasing disengagement.

### Primary measures

- accepted commitments started within ten minutes;
- meaningful completion rate;
- median verified target-aligned minutes;
- days with at least one minimum viable block;
- median hours to return after a lapse.

### Guardrail measures

- seven-day absence rate;
- notification ignore rate;
- penalty dispute rate;
- proportion of settlements with insufficient evidence;
- coin inflation and spending affordability;
- voluntary continuation after the growth bonus tapers;
- self-reported pressure, usefulness, autonomy, and desire to disable the system.

### Rollout gates

1. **Shadow mode:** compute contracts and settlements without ledger effects for at least seven days or twenty eligible commitments.
2. **Bonus mode:** enable base and growth bonuses while stakes remain virtual.
3. **Small-stake mode:** enable real stakes with five-coin maximum and daily cap after evidence coverage exceeds 80% and shadow disagreements remain below 5%.
4. **Adaptive mode:** enable contextual intervention selection after at least eight outcomes per action overall and a successful two-week small-stake review.
5. **Maintenance test:** taper bonuses for a capability above target for three weeks and verify that its four-week lower credible bound does not materially decline.

The rollout must support immediate fallback to bonus mode without schema rollback.

## Privacy and model limits

Behavioral capability scores describe patterns in LifeOS observations. They are not diagnoses of attention deficit, motivation, personality, intelligence, or mental health. Raw notes, private text, screenshots, and conversation contents should not be copied into economic evidence records. Integrations may emit narrow facts such as an accepted plan, task topic, or verified duration with provenance and user-controlled access.

The algorithm can estimate which measured intervention precedes better behavior. With one person and sparse observations, it cannot establish broad psychological causes. Explanations must say what was observed and what the policy inferred.

## Implementation sequence

1. Add migration 046, pure capability calculations, evidence normalization, idempotent reward contracts, and shadow settlements.
2. Connect commitment and Guardian outcomes, expose the growth-state API, and add Coach-page explanations.
3. Run shadow validation against real production events and correct evidence mappings.
4. Enable bonus mode and verify ledger idempotency and economy limits.
5. Enable small stakes after the stated coverage and disagreement gates.
6. Add constrained contextual Thompson sampling and delayed-outcome evaluation.
7. Migrate remaining habit, task, proof, chat, and achievement coin sources through the central settlement layer.

## Non-goals

- Diagnosing neurological or psychiatric conditions.
- Monitoring every private action or reading raw personal content to assign penalties.
- Automatically increasing penalty severity without a hard cap.
- Optimizing screen time or activity volume as an end in itself.
- Replacing the reward store or rewriting existing redemption history.
- Using an LLM to calculate balances or make irreversible ledger mutations.
- Claiming causal understanding from correlation alone.

## Sources

[^1]: Patel, M. S., et al. “[Framing Financial Incentives to Increase Physical Activity Among Overweight and Obese Adults: A Randomized, Controlled Trial](https://pubmed.ncbi.nlm.nih.gov/26881417/).” *Annals of Internal Medicine* 164, no. 6 (2016): 385–394. DOI: 10.7326/M15-1635.
[^2]: Volpp, K. G., et al. “[Financial Incentive-Based Approaches for Weight Loss: A Randomized Trial](https://pubmed.ncbi.nlm.nih.gov/19066383/).” *JAMA* 300, no. 22 (2008): 2631–2637. DOI: 10.1001/jama.2008.804.
[^3]: Mantzari, E., et al. “[Personal Financial Incentives for Changing Habitual Health-Related Behaviors: A Systematic Review and Meta-Analysis](https://pubmed.ncbi.nlm.nih.gov/25843244/).” *Preventive Medicine* 75 (2015): 75–85. DOI: 10.1016/j.ypmed.2015.03.001.
[^4]: Gollwitzer, P. M., and P. Sheeran. “[Implementation Intentions and Goal Achievement: A Meta-Analysis of Effects and Processes](https://doi.org/10.1016/S0065-2601%2806%2938002-1).” *Advances in Experimental Social Psychology* 38 (2006): 69–119.
[^5]: Stojanovic, M., A. Grund, and S. Fries. “[Context Stability in Habit Building Increases Automaticity and Goal Attainment](https://pubmed.ncbi.nlm.nih.gov/35756236/).” *Frontiers in Psychology* 13 (2022): 883795.
[^6]: Ebert, J. E. J., and X. Y. Lin. “[Confirming the Causal Role of Consistent Contexts in Developing a Walking Habit: A Randomized Comparison With Varied Contexts](https://pubmed.ncbi.nlm.nih.gov/39225981/).” *Annals of Behavioral Medicine* 58, no. 11 (2024): 741–751.
[^7]: Keller, J., et al. “[Habit Formation Following Routine-Based Versus Time-Based Cue Planning: A Randomized Controlled Trial](https://pubmed.ncbi.nlm.nih.gov/33405284/).” *British Journal of Health Psychology* 26, no. 3 (2021): 807–824.
[^8]: Klasnja, P., et al. “[Efficacy of Contextually Tailored Suggestions for Physical Activity: A Micro-Randomized Optimization Trial of HeartSteps](https://pmc.ncbi.nlm.nih.gov/articles/PMC6401341/).” *Annals of Behavioral Medicine* 53, no. 6 (2019): 573–582.
[^9]: Aguilera, A., et al. “[Effectiveness of a Digital Health Intervention Leveraging Reinforcement Learning: Results From the DIAMANTE Randomized Clinical Trial](https://www.jmir.org/2024/1/e60834).” *Journal of Medical Internet Research* 26 (2024): e60834.
[^10]: Deci, E. L., R. Koestner, and R. M. Ryan. “[A Meta-Analytic Review of Experiments Examining the Effects of Extrinsic Rewards on Intrinsic Motivation](https://selfdeterminationtheory.org/wp-content/uploads/2014/04/1999_DeciKoestnerRyan_Meta.pdf).” *Psychological Bulletin* 125, no. 6 (1999): 627–668.
