# Prior art: deterministic job relevance scoring approaches

Research notes for applyrn's scoring layer (ranks gate-passers only; gates handle
US-only / seniority / non-engineering separately). Profile: SWE/data/ML internships

- new-grad, US, summer 2027. No LLM, no embeddings, no training data.

Current engine (`packages/relevance/src/engine.ts` → `scoreRole()`) is already a
small instance of **Approach 3**: additive points (title early-marker 30 + track
label 30 + title skills 15 ea + US/remote 10 + desc skills 5 ea capped 20;
threshold 15 = dead code). Each approach below is judged as an _upgrade path_
from there.

---

## Approach 1 — BM25 / BM25F over title + description (static IDF)

**Prior art:** Robertson–Spärck Jones probabilistic retrieval; Elasticsearch /
Lucene `bm25` similarity with per-field boosts (this is what LinkedIn-style
job search and ATS candidate search use as their base ranking feature — the
learned layers sit _on top_ of BM25-family features, not instead of them).

**Core formula** (BM25 with per-term saturation and document-length
normalization):

```
idf(t)  = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)      # classic def; N/df unavailable without corpus
sat(t,f) = tf(t,f) * (k1 + 1) / (tf(t,f) + k1 * (1 - b + b * len(f)/avgLen(f)))
score(q,d) = Σ_{t∈q} idf(t) * Σ_{f∈{title,desc}} w_f * sat(t,f)
# standard params: k1 = 1.2..2.0, b = 0.75 (use b = 0 for title — titles shouldn't be length-penalized)
# field weights: w_title ≈ 3.0, w_desc ≈ 1.0  (same "title dominates" instinct as the current engine)
```

**IDF without a corpus — three options, cheapest first:**

1. **Static hand-authored term table** (recommended v1). You don't need real
   IDF, you need _relative rarity among tech-job vocabulary_. Author ~50–150
   query terms (the profile keywords) with weights: specific wins big
   (`pytorch: 4.5, kubernetes: 4.0, kafka: 3.5, embedded: 4.0`), generic
   barely moves the needle (`software: 0.6, engineer: 0.4, team: 0.2`,
   or omit generics entirely). Unknown terms default to ~1.0. This is
   deterministic and auditable — it's just your current skill list with
   calibrated weights instead of flat 15/5 points.
2. **Empirical IDF from your own D1 history.** You persist every job seen,
   gated or not — that _is_ a corpus. Maintain an FTS5 index (supported in
   D1/SQLite) or periodically `COUNT(*) WHERE description LIKE '%term%'` for
   the ~150 vocabulary terms and store `df(term)` in a table. Real IDF, still
   fully deterministic, adapts as the feed mix drifts. Natural v2.
3. **Published frequency table** derived from any public job-text corpus;
   frozen at build time. Least effort, least tailored — usually not worth it
   over option 1.

**Pseudo-code (minimal form, option 1):**

```ts
const K1 = 1.5,
  B_DESC = 0.75,
  AVG_DESC_TOKENS = 600; // fixed constants, tune once
function bm25Score(title: string, desc: string): number {
  const tT = termCounts(tokenize(title)),
    tD = termCounts(tokenize(desc));
  let s = 0;
  for (const term of PROFILE_TERMS) {
    // ~50-150 profile terms
    const idf = STATIC_IDF[term] ?? 1.0;
    const satT = sat(tf(tT, term), /*len-norm*/ 1);
    const satD = sat(tf(tD, term), tD.total / AVG_DESC_TOKENS);
    s += idf * (3.0 * satT + 1.0 * satD);
  }
  return normalize(s); // see "spread" below
}
// sat(tf, L) = tf*(K1+1) / (tf + K1*L)
```

**What spreads scores:** IDF does almost all the work. Saturation alone
compresses everything — tf 3 and tf 30 are within ~15% of each other — so a
posting matching only generic terms and one matching `pytorch` must land far
apart, and that gap comes from the idf multiplier. Secondary spread source:
field weighting means title hits are worth ~3× equal desc hits.

**What clusters scores:** dropping IDF (all terms equal) collapses the scale;
long 64KB boilerplate descriptions accumulate many weak generic matches that
sum up (mitigate with `b` length normalization + excluding stopword-ish
generics from PROFILE_TERMS); zero-match postings all pile at 0 (bimodal, not
clustered — acceptable).

**Failure modes:** static table encodes author bias and goes stale (new hot
framework unscored until you add it); bag-of-words ignores negation ("no
Kubernetes required" scores) and adjacency ("machine learning" splits into two
weak unigrams — fix with bigram entries in the table); score scale is opaque
to humans (needs normalization for display); empirically-derived IDF drifts as
your crawl mix changes (recompute on schedule, keep old scores frozen).

**Complexity: M** — the math is trivial; the cost is authoring/calibrating the
term table and choosing a normalization for display. Swapping in empirical IDF
later touches only the table loader.

---

## Approach 2 — Weighted category model (title × skills × logistics)

**Prior art:** Simplify.jobs-style match percentages and LinkedIn's "How you
match" panel decompose fit into named facets; ATS scorecards (Greenhouse
interview scorecards) are literally weighted attribute categories rated
independently; resume-keyword matchers (Jobscan et al.) score title-fit and
skills-overlap as separate percentages then combine.

**Structure:** partition evidence into 4–6 independent categories, each scored
0–1 by its own logic, weighted-sum, ×100. The load-bearing choices are (a)
**MAX not SUM inside the title category**, (b) **ratio-based skill overlap**,
(c) emitting per-category subscores.

```ts
const CATS = [
  { name: 'titleFit',  w: 0.40, score: titleFit },   // best-matching title pattern wins
  { name: 'skillFit',  w: 0.30, score: skillOverlap },
  { name: 'typeFit',   w: 0.15, score: employmentTypeFit },
  { name: 'domainFit', w: 0.10, score: deptTeamFit },
  { name: 'recency',   w: 0.05, score: freshness },
];

titleFit = max(PATTERNS.map(p => p.matches(title) ? p.fit : 0));
// PATTERNS ordered most→least specific, mirroring TRACK_LABEL_PRIORITY:
//   'machine learning intern' → 1.0 ; 'data scientist intern' → 0.9 ;
//   'software engineer i' → 0.75 ; 'swe intern' → 0.85 ; 'engineer' → 0.4 …

skillOverlap = |profileSkills ∩ postingSkills| / min(|profileSkills|, CAP);
// denominator choice matters: /|posting| rewards sparse targeted JDs,
// /|profile| rewards broad coverage, /min() is the forgiving middle. Pick ONE, test it.

employmentTypeFit = { INTERN: 1.0, TEMP: 0.7, CONTRACT: 0.6, FULL_TIME: newGradSignal ? 0.9 : 0.3 }[type] ?? 0.5;
deptTeamFit  = dept/team strings hitting ML/data/platform keywords ? hitFraction : 0.5;  // 0.5 = "no signal", not 0
freshness    = exp(-daysOld / 45);

total = Math.round(100 * CATS.reduce((a,c) => a + c.w * c.score(c.job), 0));
return { total, parts: Object.fromEntries(subscores) };   // ALWAYS emit subscores
```

**What spreads scores:** few categories with _wide individual ranges_. An
additive sum of many small uniform contributions regresses to the middle
(CLT); five categories each able to span 0–100% of their weight keep variance
high. Multiplicative variants (`titleFit^0.6 * skillFit^0.4`) spread even
harder — one bad category drags the product down — but are harder to explain;
start additive.

**What clusters:** missing-field defaults set to 0 (every posting lacking
`department` silently loses 10%); too-similar category weights; overlap ratio
with `/|postingSkills|` denominator collapsing on keyword-stuffed 64KB JDs
(denominator explodes → ratio → 0 for everyone; the `min()` form avoids this).

**Failure modes:** weights are politics, not science — expect to retune;
categories fight (perfect-title/zero-skill vs ok-title/ok-skill is a genuine
judgment call encoded in `w`); neutral defaults (0.5 for unknown) must be
deliberate or they become invisible penalties; without emitted subscores the
user sees "68" and cannot ask why.

**Complexity: M.** The current `scoreRole()` is this with categories flattened
into one additive expression; the refactor is mostly _separating and naming_
what's already computed, plus the overlap-ratio function.

---

## Approach 3 — Rule-based additive points, caps + negative points

**Prior art:** SpamAssassin is the canonical deterministic additive scorer —
each test contributes fixed points (positive or negative), per-test effects
are bounded, total crosses a threshold; decades of production tuning produced
exactly the patterns needed here. Same pattern in OSS auto-apply bots and HN
"who's hiring" filter scripts: keyword point tables (+wanted, −banned), sum,
compare to threshold. Credit-scoring reason-code systems (FICO-style) are the
institutional version.

**Formula sketch with diminishing returns per category:**

```
Budget (sums to 100):
  +35  early-career marker IN TITLE (intern/co-op/new grad/level-I)      [once]
  +25  target-track label in TITLE (ml/data/backend/embedded/…)          [once]
  +10  per DISTINCT profile skill in TITLE                               [cap 20]
  +4   per DISTINCT profile skill in DESCRIPTION                         [cap 12]
  +8   US location or Remote-US                                          [once]
  −15  per negative marker (unpaid, "commission only", clearance-required,
       on-site in excluded city)                                         [uncapped]
score = clamp(total, 0, 100)
```

Diminishing-returns variants for counted things (skill hits):

```
linear-with-cap:  contrib = min(cap, pts * n)
saturating:       contrib = cap * (1 - exp(-n * pts / cap))    // smooth, no cliff
sqrt:             contrib = pts * sqrt(n)                      // gentlest
```

Prefer **hard caps** here: they're explainable ("description can add at most
12") and they _reserve dynamic range_, which is the main anti-clustering tool.

**Distinctness requires canonical skill IDs** — otherwise "ML", "machine
learning", "ML/AI" triple-fire. Map every surface form to one id
(`{'ml': 'ml', 'machine learning': 'ml', 'ai/ml': 'ml'}`) and count ids, not
matches. This is the single highest-value patch to the current engine.

Negative points act as _soft gates inside the score_: unlike the hard gates,
they rank down without suppressing — right behavior for signals you're ~80%
(not 100%) sure about.

**What spreads scores:** asymmetric caps. If title can contribute 35+25+20=80
but description only 12, a description-only match physically cannot exceed
~32 while any title-marker job starts ≥35 — the distribution separates along
exactly the axis the user cares about (title-relevant vs keyword-stuffed).
This is already true of the current engine and is why it works.

**What clusters:** too many categories with comparable caps (everything hits
half its cap → everyone lands mid-scale); counting occurrences instead of
distinct skills (boilerplate JD repeating "python" 9×); clamping at 100 hides
the difference between very-good and exceptional.

**Failure modes:** order-independence means two weak positives impersonate one
strong one; point values invite endless debate (tie each to a rationale in a
comment); synonym double-counting without canonical ids (see above); negative
lists rot (recheck quarterly against suppressed-but-complained items).

**Complexity: S** from the current engine — canonical skill ids + negative
markers + making the desc cap explicit are each small diffs.

---

## Approach 4 — Tiered grades (A/B/C/D) from ordered rule evaluation

**Prior art:** decision lists / ordered-rule classifiers (classic ML, RIPPER-
style: rules evaluated in priority order, first hit wins); credit-bureau
_presentation_ tiers (prime / near-prime / subprime bands cut over a numeric
score); ATS knockout-question-then-tier workflows; incident-severity triage
taxonomies. Two distinct flavors — pick deliberately:

**Flavor A — pure rule cascade** (mutually exclusive by construction):

```
grade(job):                                  // evaluated top-down, FIRST match wins
  A: titleHasEarlyMarker && titleTrackLabel != null && distinctSkillsAnywhere >= 2
  B: titleHasEarlyMarker || (titleTrackLabel != null && distinctSkillsAnywhere >= 1)
  C: trackLabel != null                     // adjacent families: devtools/QA/embedded
  D: default                                 // passed gates, matched nothing
```

**Flavor B — banding a numeric score** (works with ANY of approaches 1–3):

```
A: score >= 75   B: >= 55   C: >= 35   D: else
// cut points should come from the REPLAY DISTRIBUTION, not round numbers:
// take the p50/p80 of scores across historical gate-passers and cut there,
// otherwise bands inherit numeric clustering (see failure modes)
```

**Telegram presentation fit (the actual point of tiers):**

- Direct emoji/prefix mapping: 🔥 A / 👍 B / 📄 C; digest groups by grade;
  per-grade mute config ("notify A+B instantly, C goes in the Sunday digest").
- Kills false precision: "72 vs 74" is noise; "B vs A" is actionable. Users
  tune _thresholds as vocabulary_ ("only ping me for A+") which survives
  score recalibration without re-learning numbers.
- Ordering within a grade still needs a deterministic tiebreak —
  `ORDER BY grade, publishedAt DESC, jobId` — otherwise a flood-day digest
  jitters between runs.
- Con: a heavy day delivers ten A's with no relative ranking; if that bites,
  show grade + score internally sorted, or sub-band A (A+/A).

**Failure modes:** flavor-A cascades accrete into an unmaintainable hairball —
cap at ~8 rules and track each rule's population share in replay (a rule
catching 2% or 60% of traffic is suspect); boundary artifacts split
near-identical jobs across grades (accept it — consistency > fairness at this
scale); flavor-B bands over a clustered score produce one mega-grade
(re-cut bands from quantiles, or fix the underlying spread first).

**Complexity: S** — flavor B is a pure presentation layer over whatever
numeric engine you keep; flavor A replaces the scorer entirely but is ~30
lines.

---

## Approach 5 — Static-vector cosine + freshness/tiebreak modifiers

**Prior art:** Salton's vector-space model (SMART system; the `ltc`/`ltn`
tf-idf weighting schemes are exactly this); Elasticsearch _decay functions_
(`exp`/`gauss` decay on a date field) for the freshness modifier; HN's
gravity ranking (`score / age^g`) as the folk version; pg_trgm-style character
trigram similarity for fuzzy term matching.

**Formula sketch:**

```ts
// Controlled vocabulary V (~80-150 canonical terms incl. bigrams: 'machine learning')
// Static idf table as in Approach 1 (or empirical df from D1 later).
// Profile vector: hand-set importance per term (1..3), NOT learned.
vecProfile[v] = idf(v) * importance(v);
vecPosting[v] = idf(v) * (1 + log(tf(v, title)) * 3 + (tf(v, desc) > 0 ? 1 + log(tf(v, desc)) : 0));

cos = dot(vecProfile, vecPosting) / (norm(vecProfile) * max(norm(vecPosting), EPS));
freshness = exp(-daysOld / 45);
score = 100 * cos * (0.85 + 0.15 * freshness); // freshness as modifier, not driver
```

Why cosine instead of raw sum: **length-game resistance for free.** A 64KB JD
stuffed with boilerplate inflates its own norm, self-normalizing the dot
product downward — the same protection the current desc-cap provides, but
continuous instead of a hard ceiling. `(1 + log(tf))` is the classic
log-saturation that stops repetition gaming.

Bigram vocabulary entries fix the "machine learning" splitting problem that
plain BM25-tokenization has; trigram fallback (`Jaccard(char_3grams('node.js'),
char_3grams('nodejs')) > 0.5 → same term`) fixes punctuation/tokenizer
mismatch without any learned model.

**⚠️ Freshness caveat for THIS profile:** summer-2027 internships are posted
months ahead and _should_ score highly at post time — a decay penalty is
backwards for pipeline roles. Either set λ ≈ 0 (drop the term), invert it for
early-career postings (newly-posted internships get a small _boost_ — you
want to apply while the req is fresh), or demote freshness to a pure
tie-breaker within equal primary scores. Do not copy HN gravity uncritically.

**What spreads scores:** the idf-weighted profile vector concentrates mass on
rare skills; cosine punishes unfocused postings. **What clusters:** a broad
profile vector (importance 1 on everything) makes every tech job look ~0.5;
dense vocabularies with correlated terms double-count (python+ml co-occur
everywhere).

**Failure modes:** norm flooring needed for empty/short descriptions;
vocabulary maintenance identical to Approach 1's term table (they share that
cost — pick one of BM25-lite vs cosine, don't build both); opacity same as
any continuous score.

**Complexity: S–M** (roughly equivalent power to Approach 1; treat them as
alternatives).

**Honorable mentions (bolt-ons, not engines):**

- **Batch-percentile display:** report "top 10% today" instead of raw 78 —
  kills drift and spreads perceived differences without touching the engine.
- **Deterministic jitterless tie-breaking:** always `(score, publishedAt, id)`.
- **Two-stage cheap→expensive:** run the free title-only scorer first, only
  tokenize the 64KB description when title score > floor. Pure latency win,
  zero behavioral change if the floor is 0.

---

## Comparison

| #   | Approach                           | Spread mechanism                        | Main failure mode                     | Size  |
| --- | ---------------------------------- | --------------------------------------- | ------------------------------------- | ----- |
| 1   | BM25F, static-IDF table            | idf multiplier × field weights          | term-table staleness; negation-blind  | M     |
| 2   | Weighted categories                | few wide-range categories, MAX-in-title | weight politics; silent null-defaults | M     |
| 3   | Additive points + caps + negatives | asymmetric caps reserve ranges          | synonym double-count                  | **S** |
| 4   | Grade tiers                        | (presentation layer)                    | cascade hairball; clustered bands     | S     |
| 5   | Cosine + modifiers                 | norm self-normalization                 | shared vocab cost with #1             | S–M   |

## Recommendation for applyrn specifically

Keep the additive skeleton (#3 — it's shipped, replay-verified, and its
asymmetric caps already produce the right separation). Highest-value upgrades
in order:

1. **Canonical skill ids** (kills synonym double-count; prerequisite for
   everything else). Small diff, immediate spread improvement.
2. **Emit per-category subscores** alongside the total (#2's structural
   lesson) — enables debugging and future grade labels.
3. **Negative-point markers** inside the score for ~-sure signals (clearance,
   unpaid) that shouldn't be hard gates.
4. **Grade layer for Telegram** (#4 flavor B) cut from replay-distribution
   quantiles, with `(grade, publishedAt, id)` ordering for digests.
5. Later: swap static skill weights for **empirical df from D1** (#1 option 2)
   once the jobs table is large enough for df to be meaningful.

**Spread diagnostic to adopt regardless:** on every PRODUCTION_REPLAY, print a
histogram of scores over gate-passers. If p50→p90 spans < 15 points, scores
are clustering — fix by increasing title dominance or shrinking category count,
never by stretching the display.
