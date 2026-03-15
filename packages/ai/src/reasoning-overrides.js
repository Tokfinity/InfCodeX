import fs from 'fs';
import os from 'os';
import path from 'path';
function getKodaxDir() {
    return process.env.KODAX_HOME ?? path.join(os.homedir(), '.kodax');
}
function getConfigFilePath() {
    return process.env.KODAX_CONFIG_FILE
        ?? path.join(getKodaxDir(), 'config.json');
}
export function reasoningCapabilityToOverride(capability) {
    switch (capability) {
        case 'native-budget':
            return 'budget';
        case 'native-effort':
            return 'effort';
        case 'native-toggle':
            return 'toggle';
        case 'none':
            return 'none';
        default:
            return undefined;
    }
}
export function reasoningOverrideToCapability(override) {
    switch (override) {
        case 'budget':
            return 'native-budget';
        case 'effort':
            return 'native-effort';
        case 'toggle':
            return 'native-toggle';
        case 'none':
        default:
            return 'none';
    }
}
export function buildReasoningOverrideKey(providerName, config, modelOverride) {
    return [
        providerName,
        config.baseUrl ?? '',
        modelOverride ?? config.model,
    ].join('|');
}
function loadStoredConfig() {
    const configFile = getConfigFilePath();
    try {
        if (fs.existsSync(configFile)) {
            return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        }
    }
    catch {
    }
    return {};
}
function saveStoredConfig(config) {
    const configFile = getConfigFilePath();
    try {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
    catch (error) {
        if (process.env.KODAX_DEBUG_OVERRIDES) {
            console.error('[ReasoningOverride] Failed to save config:', error);
        }
    }
}
export function loadReasoningOverride(providerName, config, modelOverride) {
    const stored = loadStoredConfig();
    const key = buildReasoningOverrideKey(providerName, config, modelOverride);
    return stored.providerReasoningOverrides?.[key];
}
export function saveReasoningOverride(providerName, config, override, modelOverride) {
    const stored = loadStoredConfig();
    const key = buildReasoningOverrideKey(providerName, config, modelOverride);
    stored.providerReasoningOverrides = {
        ...(stored.providerReasoningOverrides ?? {}),
        [key]: override,
    };
    saveStoredConfig(stored);
}
export function clearReasoningOverride(providerName, config, modelOverride) {
    const stored = loadStoredConfig();
    const key = buildReasoningOverrideKey(providerName, config, modelOverride);
    if (!stored.providerReasoningOverrides?.[key]) {
        return;
    }
    const nextOverrides = { ...stored.providerReasoningOverrides };
    delete nextOverrides[key];
    stored.providerReasoningOverrides =
        Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined;
    saveStoredConfig(stored);
}
