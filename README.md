# makefun-site-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Selephia/makefun-site-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Selephia/makefun-site-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: byte-identical static site builds, about three times faster than the house baseline on the practice set. `solve.js` is an independent reimplementation of makefun-site's own front matter, template dialect, Markdown subset, slug rule and report, written for speed — whole-run HTML escaping, a single-pass Markdown renderer, and a scope-stack template renderer with no per-character or per-node waste.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json` (or `/input/cases.json`) and writes `$MAKEFUN_OUTPUT_DIR/answers.json` (or `/output/answers.json`). Node 22 or later, nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rhrzs01t&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
