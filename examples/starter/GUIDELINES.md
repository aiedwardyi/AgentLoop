# Quality Guidelines

- `text-summary.js` exists and exports `summarize(text)` through CommonJS.
- `summarize('one two')` returns `{ words: 2, characters: 7 }`.
- Non-string input throws a `TypeError`.
- Empty and whitespace-only strings return `{ words: 0, characters: 0 }`.
- Words are separated by one or more whitespace characters.
- The command-line entry point joins its arguments and prints the summary as JSON.
- The first line is a concise usage comment showing `node text-summary.js "one two"`.
- `STATE.md` records completed work and a verification result.
- Only files inside this starter project are changed.
