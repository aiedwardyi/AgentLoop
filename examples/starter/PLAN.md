# Text summary utility

Build a small CommonJS utility in `text-summary.js`. It must export `summarize(text)` and provide a command-line entry point.

## Cycle 1

- Create the core implementation for normal, non-empty text.
- Return an object with `words` and `characters`.
- Export the function with `module.exports`.
- Update `STATE.md` with the completed core work.
- Stop after the core behavior. Do not add input validation, empty or whitespace handling, or a usage comment in this cycle.

## Cycle 2

When `STATE.md` says the core is complete, or critic feedback requests it:

- Add the remaining hardening and command-line behavior required by `GUIDELINES.md`.
- Run `node text-summary.js "one two"` to verify the command-line output.
- Update `STATE.md` with the completed hardening work and the verification result.
