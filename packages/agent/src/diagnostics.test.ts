import { describe, expect, it, vi } from 'vitest';
import { runWithProviderCredential } from '@kodax-ai/llm';

import { emitKodaXDiagnostic, setKodaXDiagnosticSink } from './diagnostics.js';

describe('diagnostic sink registration', () => {
  it('keeps the newest live sink active when an older host closes first', () => {
    const first = vi.fn();
    const second = vi.fn();
    const restoreFirst = setKodaXDiagnosticSink(first);
    const restoreSecond = setKodaXDiagnosticSink(second);

    restoreFirst();
    emitKodaXDiagnostic({ source: 'test', level: 'info', message: 'still routed' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    restoreSecond();
  });

  it('restores the next live sink and makes cleanup idempotent', () => {
    const first = vi.fn();
    const second = vi.fn();
    const restoreFirst = setKodaXDiagnosticSink(first);
    const restoreSecond = setKodaXDiagnosticSink(second);

    restoreSecond();
    restoreSecond();
    emitKodaXDiagnostic({ source: 'test', level: 'warn', message: 'fallback' });

    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledOnce();
    restoreFirst();
  });

  it('redacts the active provider credential before calling a diagnostic sink', () => {
    const sink = vi.fn();
    const restore = setKodaXDiagnosticSink(sink);
    try {
      runWithProviderCredential('openai', 'diagnostic-secret', () => {
        emitKodaXDiagnostic({
          source: 'test',
          level: 'error',
          message: 'provider returned diagnostic-secret',
          detail: { error: new Error('diagnostic-secret leaked') },
        });
      });

      const delivered = sink.mock.calls[0]?.[0];
      expect(JSON.stringify(delivered)).not.toContain('diagnostic-secret');
      expect(delivered).toMatchObject({
        message: 'provider returned [REDACTED_CREDENTIAL]',
      });
    } finally {
      restore();
    }
  });
});
