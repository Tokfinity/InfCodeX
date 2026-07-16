/**
 * Remove the OUTER blank lines (leading + trailing) from a renderable string,
 * ANSI-aware. Internal blank lines are preserved.
 *
 * Why: `info` / `event` transcript rows are composed as `${icon} ${text}` and
 * then split on "\n" by the row wrapper (`wrapText`). When `text` begins with a
 * blank line, the icon lands alone on the first visual row and the real message
 * drops to the second — a wasted line. Slash commands trigger this constantly:
 * many print `console.log(chalk.cyan("\n[Switched ...]"))`, and that output is
 * captured verbatim into an `info` history item, so the stored text is
 * `ESC[36m \n [Switched ...] ESC[39m` — a leading newline sitting *behind* a
 * leading ANSI color code, which a plain `.trim()` cannot reach (the string
 * does not start with whitespace).
 *
 * Only the outer blanks are removed; blank lines *inside* a multi-line message
 * are intentional and preserved.
 */

// ANSI SGR run, e.g. chalk's `ESC[36m` ... `ESC[39m`. Built from a char code so
// no raw escape byte lives in source (also keeps us clear of no-control-regex).
const ESC = String.fromCharCode(27);
const ANSI_SGR_RUN = `(?:${ESC}\[[0-9;]*m)*`;

// Leading: a run of ANSI codes, then one or more blank lines. The capture keeps
// the leading ANSI codes so the message's color survives.
const LEADING_OUTER_BLANK = new RegExp(`^(${ANSI_SGR_RUN})(?:[ \t\r]*\n)+`);

// Trailing: one or more blank lines, then a run of trailing ANSI codes (reset).
const TRAILING_OUTER_BLANK = new RegExp(`(?:\n[ \t\r]*)+(${ANSI_SGR_RUN})$`);

export function stripOuterBlankLines(text: string): string {
  return text
    .replace(LEADING_OUTER_BLANK, "$1")
    .replace(TRAILING_OUTER_BLANK, "$1");
}
