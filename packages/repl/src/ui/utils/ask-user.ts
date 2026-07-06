import type { AskUserQuestionOptions } from "@kodax-ai/coding";
import { ASK_USER_CUSTOM_INPUT_SIGNAL } from "@kodax-ai/agent";

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

export const DEFAULT_CUSTOM_INPUT_LABEL = "Other...";

export function toSelectOptions(
  options: AskUserQuestionOptions["options"],
): SelectOption[] {
  if (!options) return [];
  return options.map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description,
  }));
}

export function appendCustomInputOption(
  selectOptions: SelectOption[],
  options: Pick<AskUserQuestionOptions, "kind" | "allowCustomInput" | "customInputLabel">,
): SelectOption[] {
  if (options.kind === "input" || options.allowCustomInput === false) {
    return selectOptions;
  }
  if (selectOptions.some((option) => option.value === ASK_USER_CUSTOM_INPUT_SIGNAL)) {
    return selectOptions;
  }
  return [
    ...selectOptions,
    {
      label: options.customInputLabel ?? DEFAULT_CUSTOM_INPUT_LABEL,
      value: ASK_USER_CUSTOM_INPUT_SIGNAL,
    },
  ];
}

export function getAskUserDialogTitle(
  options: AskUserQuestionOptions,
): string {
  // Use the LLM-provided question text directly — it matches the user's language.
  return options.question;
}

export function resolveAskUserDefaultChoice(
  options: AskUserQuestionOptions,
): string {
  if (!options.options || options.options.length === 0) return "";

  const cancelOption = options.options.find((option) => {
    const label = option.label.trim().toLowerCase();
    const value = option.value.trim().toLowerCase();
    return label === "cancel" || value === "cancel";
  });

  return cancelOption?.value ?? "";
}
