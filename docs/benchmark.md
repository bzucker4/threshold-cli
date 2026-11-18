# Rule attachment case study

The existing Threshold illustration cites a **10,482 → 54** token footprint. The original before/after rule files and paths were unavailable during this build, so that figure is pending reproduction with the pinned tokenizer. Publish it as a verified case study only after recovering the original inputs and recording the measured results.

## Reproduction

1. Preserve the original tracked rules in a baseline commit and record the representative edit paths.
2. Make a second commit that changes only rule metadata to narrow attachment. Keep the bodies byte-for-byte where possible. Record any changes needed to split a rule and identify the destination of its moved text.
3. Make a third commit for any wording reductions or deletions. Record both diffs on the same paths so scoping and pruning can be attributed separately.
4. Run `threshold diff --base BASELINE_SHA --head SCOPE_SHA --format json` and `threshold diff --base SCOPE_SHA --head FINAL_SHA --format json`. Publish the commit IDs, exact shareable MDC inputs, paths, tokenizer version, and each stage’s measured footprint. Include a path where the scoped rule still applies.
5. Describe the measurements as static rule-attachment footprint estimates for the shown configuration.
