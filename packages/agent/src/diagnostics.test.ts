import { describe, expect, it, vi } from 'vitest';

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
});
