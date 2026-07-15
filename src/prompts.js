// Worker prompt protocol and result parsing.
// blocked/question support arrives with the loop slice.
const allowedStatuses = new Set(['done', 'failed']);

const PROTOCOL = [
  'You are an autonomous coding agent.',
  'You will receive one task.',
  'Complete the task fully.',
  'Your final message must end with exactly one line in this form: LOOP_RESULT {"status":"done|failed","summary":"..."}',
].join('\n');

function taskPrompt(task) {
  return `${PROTOCOL}\n\n${task.prompt || ''}`;
}

function matchObject(text, start) {
  const open = text.indexOf('{', start);

  if (open === -1) {
    return null;
  }

  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = open; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open, index + 1);
      }
    }
  }

  return null;
}

function parseLoopResult(text) {
  const lines = String(text || '').split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const marker = lines[index].lastIndexOf('LOOP_RESULT');

    if (marker === -1) {
      continue;
    }

    const json = matchObject(lines[index], marker + 'LOOP_RESULT'.length);

    if (!json) {
      continue;
    }

    try {
      const result = JSON.parse(json);

      if (!result || !allowedStatuses.has(result.status)) {
        continue;
      }

      return {
        status: result.status,
        summary: typeof result.summary === 'string' ? result.summary : '',
      };
    } catch {
    }
  }

  return null;
}

module.exports = {
  PROTOCOL,
  taskPrompt,
  parseLoopResult,
};
