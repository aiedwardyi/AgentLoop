# Independent evaluation

On July 22, 2026, AgentLoop ran the reproducible [query parser fixture](../examples/query-parser) with three cycles available and polish disabled. The [plan](../examples/query-parser/PLAN.md) requested the complete repair in one pass and prohibited artificial cycle boundaries. The [guidelines](../examples/query-parser/GUIDELINES.md) defined ten acceptance criteria.

| Cycle | Worker result | Independent critic result |
| --- | --- | --- |
| 1 | Repaired the parser and added nine passing tests. | `FAIL`: valid percent escapes remained encoded when a field also contained malformed escapes. |
| 2 | Fixed tolerant decoding and added regression coverage. | `PASS`: all criteria were satisfied and 11 tests passed. |

The first worker's own suite passed. A fresh critic tested beyond it, found a real defect, and converted the finding into instructions for the next fresh worker. No package dependencies were added.

## Reproduce

1. Start the daemon and select **+ New**, then **Loop**.
2. Set **Project** to `examples/query-parser` and **Max cycles** to `3`.
3. Leave polish disabled and select **Start loop**.
