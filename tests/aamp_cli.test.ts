import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/kodax_cli.js';

const TEST_DIR = path.join(os.tmpdir(), `kodax-aamp-cli-test-${Date.now()}`);

const { runAampServerMock } = vi.hoisted(() => ({
  runAampServerMock: vi.fn(),
}));

const { aampSdkTransportCtorMock } = vi.hoisted(() => ({
  aampSdkTransportCtorMock: vi.fn(),
}));

const { prepareRuntimeConfigMock } = vi.hoisted(() => ({
  prepareRuntimeConfigMock: vi.fn(() => ({})),
}));

const { createDefaultAampLoggerMock } = vi.hoisted(() => ({
  createDefaultAampLoggerMock: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../src/aamp_server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aamp_server.js')>();
  return {
    ...actual,
    runAampServer: runAampServerMock,
  };
});

vi.mock('../src/aamp_sdk_transport.js', () => ({
  AampSdkTransport: class {
    constructor(config: unknown, logger: unknown) {
      aampSdkTransportCtorMock(config, logger);
    }
  },
}));

vi.mock('../src/aamp_logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aamp_logger.js')>();
  return {
    ...actual,
    createDefaultAampLogger: createDefaultAampLoggerMock,
  };
});

vi.mock('@kodax-ai/repl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/repl')>();
  return {
    ...actual,
    prepareRuntimeConfig: prepareRuntimeConfigMock,
  };
});

describe('AAMP CLI', () => {
  beforeEach(() => {
    prepareRuntimeConfigMock.mockReset();
    prepareRuntimeConfigMock.mockReturnValue({});
    createDefaultAampLoggerMock.mockClear();
    process.env.KODAX_TRACING = '0';
    delete process.env.KODAX_AAMP_EMAIL;
    delete process.env.KODAX_AAMP_JMAP_TOKEN;
    delete process.env.KODAX_AAMP_JMAP_URL;
    delete process.env.KODAX_AAMP_SMTP_HOST;
    delete process.env.KODAX_AAMP_SMTP_PASSWORD;
    delete process.env.KODAX_AAMP_LOG;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.KODAX_TRACING;
    delete process.env.KODAX_AAMP_EMAIL;
    delete process.env.KODAX_AAMP_JMAP_TOKEN;
    delete process.env.KODAX_AAMP_JMAP_URL;
    delete process.env.KODAX_AAMP_SMTP_HOST;
    delete process.env.KODAX_AAMP_SMTP_PASSWORD;
    delete process.env.KODAX_AAMP_LOG;
  });

  it('reports a missing serve subcommand instead of treating AAMP options as root options', async () => {
    const argv = process.argv;
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    process.argv = ['node', 'kodax', 'aamp', '--profile', 'default'];

    try {
      await main();
    } finally {
      process.argv = argv;
      process.exitCode = originalExitCode;
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Missing subcommand] `infcodex aamp` requires `serve`.'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Use `infcodex aamp serve [options]`.'),
    );
  });

  it('wires infcodex aamp serve into the AAMP transport adapter', async () => {
    const argv = process.argv;
    process.argv = [
      'node',
      'kodax',
      'aamp',
      'serve',
      '--email', 'agent@example.com',
      '--jmap-token', 'token',
      '--jmap-url', 'http://localhost:8080/jmap',
      '--smtp-host', 'localhost',
      '--smtp-password', 'secret',
      '--cwd', TEST_DIR,
    ];

    try {
      await main();
    } finally {
      process.argv = argv;
    }

    expect(aampSdkTransportCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      email: 'agent@example.com',
      mailboxToken: 'token',
      baseUrl: 'http://localhost:8080',
      smtpHost: 'localhost',
      smtpPort: 587,
      smtpPassword: 'secret',
      rejectUnauthorized: true,
    }), expect.any(Object));
    expect(runAampServerMock).toHaveBeenCalledWith(expect.objectContaining({
      repoRoot: TEST_DIR,
      mailboxEmail: 'agent@example.com',
      transport: expect.any(Object),
    }));
    expect(createDefaultAampLoggerMock).toHaveBeenCalledWith({
      logLevel: 'info',
    });
  });

  it('loads AAMP profile defaults from config when --profile is specified', async () => {
    const argv = process.argv;
    prepareRuntimeConfigMock.mockReturnValue({
      aamp: {
        profiles: {
          mailboxB: {
            email: 'config-agent@example.com',
            mailboxToken: 'config-token',
            baseUrl: 'https://meshmail.ai/jmap',
            smtpHost: 'meshmail.ai',
            smtpPort: 2525,
            smtpPassword: 'config-secret',
            allowInsecureTls: true,
            logLevel: 'debug',
          },
        },
      },
    });
    process.argv = ['node', 'kodax', 'aamp', 'serve', '--profile', 'mailboxB', '--cwd', TEST_DIR];

    try {
      await main();
    } finally {
      process.argv = argv;
    }

    expect(aampSdkTransportCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      email: 'config-agent@example.com',
      mailboxToken: 'config-token',
      baseUrl: 'https://meshmail.ai',
      smtpHost: 'meshmail.ai',
      smtpPort: 2525,
      smtpPassword: 'config-secret',
      rejectUnauthorized: false,
    }), expect.any(Object));
    expect(createDefaultAampLoggerMock).toHaveBeenCalledWith({ logLevel: 'debug' });
  });

  it('lets CLI flags override a configured AAMP profile', async () => {
    const argv = process.argv;
    prepareRuntimeConfigMock.mockReturnValue({
      aamp: {
        profiles: {
          mailboxB: {
            email: 'config-agent@example.com',
            mailboxToken: 'config-token',
            baseUrl: 'https://meshmail.ai/jmap',
            smtpHost: 'meshmail.ai',
            smtpPort: 2525,
            smtpPassword: 'config-secret',
            allowInsecureTls: false,
            logLevel: 'debug',
          },
        },
      },
    });
    process.argv = [
      'node',
      'kodax',
      'aamp',
      'serve',
      '--profile', 'mailboxB',
      '--email', 'override@example.com',
      '--smtp-password', 'override-secret',
      '--log-level', 'error',
      '--allow-insecure-tls',
      '--cwd', TEST_DIR,
    ];

    try {
      await main();
    } finally {
      process.argv = argv;
    }

    expect(aampSdkTransportCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      email: 'override@example.com',
      mailboxToken: 'config-token',
      smtpPassword: 'override-secret',
      rejectUnauthorized: false,
    }), expect.any(Object));
    expect(createDefaultAampLoggerMock).toHaveBeenCalledWith({ logLevel: 'error' });
  });

  it('requires all mandatory CLI flags when no profile is specified', async () => {
    const argv = process.argv;
    process.env.KODAX_AAMP_EMAIL = 'ignored@example.com';
    process.argv = ['node', 'kodax', 'aamp', 'serve', '--cwd', TEST_DIR];

    try {
      await expect(main()).rejects.toThrow(
        'Missing required AAMP options: email, mailboxToken, baseUrl, smtpHost, smtpPassword. Provide them via --profile <name> or explicit CLI flags.',
      );
    } finally {
      process.argv = argv;
    }

    expect(aampSdkTransportCtorMock).not.toHaveBeenCalled();
    expect(runAampServerMock).not.toHaveBeenCalled();
  });

  it('fails when the requested AAMP profile does not exist', async () => {
    const argv = process.argv;
    prepareRuntimeConfigMock.mockReturnValue({
      aamp: { profiles: { mailboxA: { email: 'config-agent@example.com' } } },
    });
    process.argv = ['node', 'kodax', 'aamp', 'serve', '--profile', 'mailboxB', '--cwd', TEST_DIR];

    try {
      await expect(main()).rejects.toThrow(
        'Unknown AAMP profile "mailboxB". Add it under aamp.profiles in ~/.kodax/config.json or omit --profile and pass all required CLI flags.',
      );
    } finally {
      process.argv = argv;
    }
  });

  it('fails when aamp.profiles is malformed', async () => {
    const argv = process.argv;
    prepareRuntimeConfigMock.mockReturnValue({
      aamp: { profiles: 'bad-shape' },
    });
    process.argv = ['node', 'kodax', 'aamp', 'serve', '--profile', 'mailboxB', '--cwd', TEST_DIR];

    try {
      await expect(main()).rejects.toThrow(
        'Invalid AAMP config in ~/.kodax/config.json: expected aamp.profiles to be an object.',
      );
    } finally {
      process.argv = argv;
    }
  });

  it('accepts canonical mailboxToken/baseUrl CLI flags', async () => {
    const argv = process.argv;
    process.argv = [
      'node',
      'kodax',
      'aamp',
      'serve',
      '--email', 'agent@example.com',
      '--mailbox-token', 'token',
      '--base-url', 'http://localhost:8080/jmap',
      '--smtp-host', 'localhost',
      '--smtp-password', 'secret',
      '--cwd', TEST_DIR,
    ];

    try {
      await main();
    } finally {
      process.argv = argv;
    }

    expect(aampSdkTransportCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      email: 'agent@example.com',
      mailboxToken: 'token',
      baseUrl: 'http://localhost:8080',
      smtpHost: 'localhost',
      smtpPort: 587,
      smtpPassword: 'secret',
      rejectUnauthorized: true,
    }), expect.any(Object));
  });
});
