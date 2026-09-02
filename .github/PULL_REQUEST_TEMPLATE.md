<!-- Thank you for working the forge. Three questions, honestly answered,
     get a PR merged here faster than any amount of polish. -->

## What was broken, and how did you find it?

<!-- A sentence or two. "I hit X doing Y" beats a essay. If it's a feature,
     what job does it let an operator do that they could not do before? -->

## What does this change?

<!-- Plain words. If you made a judgement call, say what you weighed. -->

## How do we know it works?

<!-- The house rule: a test is only accepted if it FAILS with the fix
     reverted — say that you checked. `npm test` and `npm run check` must
     both be green. If it's UI, say how you drove it for real. -->

---

**The safety floor** (tick to confirm you read CONTRIBUTING.md):

- [ ] No new dependencies — or the PR message argues for the exception
- [ ] Anything that reads outside text goes through `fenceUntrusted`, anything that leaves the machine goes through redaction
- [ ] No weakening of `HARD_DENY`, approval gates, or the identity-file lock
- [ ] UK English in comments, docs and user-facing copy
