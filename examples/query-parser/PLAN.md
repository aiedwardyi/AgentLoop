# Query parser repair

Repair `query-string.js` for use as a dependable CommonJS utility and command-line tool.

- Preserve the `parseQuery(input)` export.
- Replace the fragile parsing behavior with a robust implementation.
- Add focused automated tests and concise command-line usage.
- Complete the task in one pass if possible. Do not create artificial cycle boundaries.
