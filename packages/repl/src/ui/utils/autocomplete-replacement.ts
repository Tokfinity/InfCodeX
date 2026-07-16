export type AutocompleteReplacementType =
  | "command"
  | "argument"
  | "file"
  | "skill";

export interface AutocompleteReplacementInput {
  text: string;
  type: AutocompleteReplacementType;
}

export interface AutocompleteReplacement {
  start: number;
  end: number;
  replacement: string;
}

export function buildAutocompleteReplacement(
  input: string,
  cursorOffset: number,
  completion: AutocompleteReplacementInput
): AutocompleteReplacement {
  const safeCursorOffset = Math.max(0, Math.min(cursorOffset, input.length));
  const beforeCursor = input.slice(0, safeCursorOffset);

  if (completion.type === "command" || completion.type === "skill") {
    const lastSlashIndex = beforeCursor.lastIndexOf("/");
    return {
      start: lastSlashIndex === -1 ? 0 : lastSlashIndex,
      end: safeCursorOffset,
      replacement: completion.text,
    };
  }

  if (completion.type === "argument") {
    const match = beforeCursor.match(/\S+$/);
    if (match) {
      const currentToken = match[0];
      const tokenStart = safeCursorOffset - currentToken.length;
      if (currentToken.startsWith("/") && beforeCursor.lastIndexOf("/") === tokenStart) {
        return {
          start: safeCursorOffset,
          end: safeCursorOffset,
          replacement: ` ${completion.text}`,
        };
      }
    }
    return {
      start: match ? safeCursorOffset - match[0].length : safeCursorOffset,
      end: safeCursorOffset,
      replacement: completion.text,
    };
  }

  const lastAtIndex = beforeCursor.lastIndexOf("@");
  return {
    start: lastAtIndex === -1 ? 0 : lastAtIndex,
    end: safeCursorOffset,
    replacement: completion.text,
  };
}
