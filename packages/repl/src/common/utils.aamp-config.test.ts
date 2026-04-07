import fsSync from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './utils.js';

describe('AAMP config normalization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes profile-based AAMP config from ~/.kodax/config.json', () => {
    vi.spyOn(fsSync, 'existsSync').mockReturnValue(true);
    vi.spyOn(fsSync, 'readFileSync').mockReturnValue(JSON.stringify({
      aamp: {
        profiles: {
          mailboxA: {
            email: 'agent-a@example.com',
            jmapToken: 'token-a',
            jmapUrl: 'https://meshmail.ai/jmap',
            smtpHost: 'meshmail.ai',
            smtpPort: 2525,
            smtpPassword: 'secret-a',
            allowInsecureTls: true,
            logLevel: 'debug',
          },
        },
      },
    }));

    expect(loadConfig()).toEqual({
      aamp: {
        profiles: {
          mailboxA: {
            email: 'agent-a@example.com',
            jmapToken: 'token-a',
            jmapUrl: 'https://meshmail.ai/jmap',
            smtpHost: 'meshmail.ai',
            smtpPort: 2525,
            smtpPassword: 'secret-a',
            allowInsecureTls: true,
            logLevel: 'debug',
          },
        },
      },
    });
  });

  it('marks malformed aamp.profiles config as invalid for AAMP CLI validation', () => {
    vi.spyOn(fsSync, 'existsSync').mockReturnValue(true);
    vi.spyOn(fsSync, 'readFileSync').mockReturnValue(JSON.stringify({
      aamp: {
        profiles: 'bad-shape',
      },
    }));

    expect(loadConfig()).toEqual({
      aamp: {
        _invalidProfiles: true,
      },
    });
  });
});
