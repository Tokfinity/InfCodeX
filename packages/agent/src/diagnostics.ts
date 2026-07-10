export type KodaXDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export interface KodaXDiagnostic {
  readonly source: string;
  readonly level: KodaXDiagnosticLevel;
  readonly message: string;
  readonly detail?: unknown;
}

export type KodaXDiagnosticSink = (diagnostic: KodaXDiagnostic) => void;

let diagnosticSink: KodaXDiagnosticSink | undefined;

export function setKodaXDiagnosticSink(sink: KodaXDiagnosticSink | undefined): () => void {
  const previous = diagnosticSink;
  diagnosticSink = sink;
  return () => {
    diagnosticSink = previous;
  };
}

export function emitKodaXDiagnostic(diagnostic: KodaXDiagnostic): void {
  const sink = diagnosticSink;
  if (sink) {
    try {
      sink(diagnostic);
    } catch {
      // Diagnostics must never affect the primary runtime path.
    }
    return;
  }

  if (process.env.KODAX_DIAGNOSTICS_STDERR !== '1') {
    return;
  }

  try {
    process.stderr.write(`${formatKodaXDiagnostic(diagnostic)}\n`);
  } catch {
    // No fallback diagnostic sink is available here.
  }
}

export function formatKodaXDiagnostic(diagnostic: KodaXDiagnostic): string {
  const detail = formatDiagnosticDetail(diagnostic.detail);
  return `[${diagnostic.source}] ${diagnostic.level}: ${diagnostic.message}${detail ? ` ${detail}` : ''}`;
}

function formatDiagnosticDetail(detail: unknown): string {
  if (detail === undefined) {
    return '';
  }
  if (detail instanceof Error) {
    return detail.stack ?? detail.message;
  }
  if (typeof detail === 'string') {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
