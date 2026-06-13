/**
 * Strip ANSI escape sequences from text before it enters transcript rows.
 * Command implementations may use colored console output for readline, but
 * Ink transcript text must stay plain so hit-testing and copy selection use
 * the same columns users see.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  const csi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  // eslint-disable-next-line no-control-regex
  const osc = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
  // eslint-disable-next-line no-control-regex
  const esc = /\u001b[@-_]/g;
  return text.replace(csi, "").replace(osc, "").replace(esc, "");
}
