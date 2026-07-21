# Quality Guidelines

- `parseQuery(input)` accepts strings and throws `TypeError` for other values.
- A leading `?` is optional; an empty query returns an empty object.
- Keys and values decode percent escapes and convert `+` to spaces.
- Repeated keys become arrays in encounter order.
- A key without `=` receives an empty string value.
- Malformed percent escapes remain readable instead of crashing the parser.
- Keys such as `__proto__`, `constructor`, and `prototype` cannot mutate object prototypes.
- The command-line entry point accepts one query argument, prints JSON, and shows usage with a non-zero exit when missing.
- Tests use the built-in Node test runner and cover every requirement.
- No package dependencies are added.
