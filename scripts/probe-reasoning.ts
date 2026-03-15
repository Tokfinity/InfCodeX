import {
  clearReasoningOverride,
  getProvider,
  isProviderConfigured,
  loadReasoningOverride,
  saveReasoningOverride,
  type ProviderName,
} from '@kodax/coding';

const TARGET_PROVIDERS: ProviderName[] = [
  'zhipu-coding',
  'kimi-code',
  'minimax-coding',
];

const WRITE_OVERRIDES = process.argv.includes('--write-overrides');

type ProbeResult = {
  provider: ProviderName;
  model: string;
  configured: boolean;
  defaultAttempt: string;
  budgetAccepted?: boolean;
  fallbackToToggle?: boolean;
  recommendedOverride: string;
  status: 'ok' | 'skipped' | 'error';
  details?: string;
};

async function probeProvider(providerName: ProviderName): Promise<ProbeResult> {
  const provider = getProvider(providerName);
  const model = provider.getModel();
  const baseUrl = provider.getBaseUrl();
  const configured = isProviderConfigured(providerName);
  const defaultAttempt = provider.getConfiguredReasoningCapability();

  if (!configured) {
    return {
      provider: providerName,
      model,
      configured,
      defaultAttempt,
      recommendedOverride: 'skipped',
      status: 'skipped',
      details: 'missing API key',
    };
  }

  const existingOverride = provider.getReasoningOverride();
  clearReasoningOverride(provider.name, {
    baseUrl,
    model,
  });
  let probeSucceeded = false;

  try {
    await provider.stream(
      [{ role: 'user', content: 'Probe reasoning support. Reply with a short acknowledgment.' }],
      [],
      'You are a probe request for provider reasoning compatibility.',
      {
        enabled: true,
        mode: 'balanced',
        depth: 'medium',
        taskType: 'qa',
        executionMode: 'implementation',
      },
    );

    const detectedOverride = loadReasoningOverride(provider.name, {
      baseUrl,
      model,
    });

    const recommendedOverride =
      detectedOverride ?? (defaultAttempt === 'native-budget'
        ? 'budget'
        : defaultAttempt === 'native-effort'
          ? 'effort'
          : defaultAttempt === 'native-toggle'
            ? 'toggle'
            : 'none');

    probeSucceeded = true;

    return {
      provider: providerName,
      model,
      configured,
      defaultAttempt,
      budgetAccepted: defaultAttempt === 'native-budget' ? !detectedOverride : undefined,
      fallbackToToggle: detectedOverride === 'toggle',
      recommendedOverride,
      status: 'ok',
    };
  } catch (error) {
    return {
      provider: providerName,
      model,
      configured,
      defaultAttempt,
      recommendedOverride: 'error',
      status: 'error',
      details: error instanceof Error ? error.message : String(error),
    };
  } finally {
    const detectedOverride = loadReasoningOverride(provider.name, {
      baseUrl,
      model,
    });

    if (!WRITE_OVERRIDES) {
      clearReasoningOverride(provider.name, {
        baseUrl,
        model,
      });
      if (existingOverride) {
        saveReasoningOverride(
          provider.name,
          { baseUrl, model },
          existingOverride,
        );
      }
    } else if (!probeSucceeded) {
      clearReasoningOverride(provider.name, {
        baseUrl,
        model,
      });
      if (existingOverride) {
        saveReasoningOverride(
          provider.name,
          { baseUrl, model },
          existingOverride,
        );
      }
    } else if (!detectedOverride && existingOverride) {
      clearReasoningOverride(provider.name, {
        baseUrl,
        model,
      });
    }
  }
}

async function main(): Promise<void> {
  console.log(`Reasoning probe (${WRITE_OVERRIDES ? 'write overrides' : 'report only'})`);
  console.log('');

  for (const providerName of TARGET_PROVIDERS) {
    const result = await probeProvider(providerName);
    const lines = [
      `${result.provider}/${result.model}`,
      `  default attempt: ${result.defaultAttempt}`,
      `  status: ${result.status}`,
    ];

    if (result.status === 'ok') {
      lines.push(`  budget accepted: ${result.budgetAccepted === undefined ? 'n/a' : result.budgetAccepted ? 'yes' : 'no'}`);
      lines.push(`  fallback to toggle: ${result.fallbackToToggle ? 'yes' : 'no'}`);
      lines.push(`  final recommended override: ${result.recommendedOverride}`);
    } else if (result.details) {
      lines.push(`  details: ${result.details}`);
    }

    console.log(lines.join('\n'));
    console.log('');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
