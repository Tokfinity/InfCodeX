import { redactScopedProviderCredential } from '@kodax-ai/llm';

export type KodaXDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export interface KodaXDiagnostic {
  readonly source: string;
  readonly level: KodaXDiagnosticLevel;
  readonly message: string;
  readonly detail?: unknown;
}

export type KodaXDiagnosticSink = (diagnostic: KodaXDiagnostic) => void;

interface DiagnosticSinkRegistration {
  readonly id: symbol;
  readonly sink: KodaXDiagnosticSink | undefined;
}

const diagnosticSinks: DiagnosticSinkRegistration[] = [];

export function setKodaXDiagnosticSink(sink: KodaXDiagnosticSink | undefined): () => void {
  const registration: DiagnosticSinkRegistration = {
    id: Symbol('kodax-diagnostic-sink'),
    sink,
  };
  diagnosticSinks.push(registration);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    const index = diagnosticSinks.findIndex((item) => item.id === registration.id);
    if (index >= 0) {
      diagnosticSinks.splice(index, 1);
    }
  };
}

export function emitKodaXDiagnostic(diagnostic: KodaXDiagnostic): void {
  const safeDiagnostic = redactScopedProviderCredential(diagnostic);
  const sink = diagnosticSinks.at(-1)?.sink;
  if (sink) {
    try {
      sink(safeDiagnostic);
    } catch {
      // Diagnostics must never affect the primary runtime path.
    }
    return;
  }

  if (process.env.KODAX_DIAGNOSTICS_STDERR !== '1') {
    return;
  }

  try {
    process.stderr.write(`${formatKodaXDiagnostic(safeDiagnostic)}\n`);
  } catch {
    // No fallback diagnostic sink is available here.
  }
}

export function formatKodaXDiagnostic(diagnostic: KodaXDiagnostic): string {
  const safeDiagnostic = redactScopedProviderCredential(diagnostic);
  const detail = formatDiagnosticDetail(safeDiagnostic.detail);
  return `[${safeDiagnostic.source}] ${safeDiagnostic.level}: ${safeDiagnostic.message}${detail ? ` ${detail}` : ''}`;
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
