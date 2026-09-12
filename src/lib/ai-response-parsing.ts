/**
 * Parse structured activity output defensively. Gemini is asked for JSON mode,
 * but preview models can still append explanatory text or a second value.
 */
export function parseActivityClassificationResponse(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Activity classification must be a JSON array');
    return parsed;
  } catch (directError) {
    const start = trimmed.indexOf('[');
    if (start < 0) throw new Error('Activity classification did not contain a JSON array', { cause: directError });

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '[') depth += 1;
      else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          const parsed = JSON.parse(trimmed.slice(start, i + 1));
          if (!Array.isArray(parsed)) throw new Error('Activity classification must be a JSON array');
          return parsed;
        }
      }
    }
    throw new Error('Activity classification did not contain a complete JSON array', { cause: directError });
  }
}
