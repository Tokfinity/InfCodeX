import { describe, expect, it } from 'vitest';
import { KodaXProviderError } from '@kodax/ai';
import { classifyError, ErrorCategory } from './error-classification.js';

describe('classifyError', () => {
  it('treats provider connection errors as transient', () => {
    const error = new KodaXProviderError(
      'minimax-coding API error: Connection error.',
      'minimax-coding',
    );

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      shouldCleanup: true,
    });
  });

  it('treats provider fetch failures as transient', () => {
    const error = new KodaXProviderError(
      'openai API error: fetch failed',
      'openai',
    );

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      shouldCleanup: true,
    });
  });
});
