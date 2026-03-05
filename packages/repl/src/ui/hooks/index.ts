/**
 * Hooks 导出
 */

export { useTextBuffer } from "./useTextBuffer.js";
export type { UseTextBufferOptions } from "./useTextBuffer.js";

export { useKeypress, createKeyMatcher } from "./useKeypress.js";
export type { UseKeypressOptions } from "./useKeypress.js";

export { useInputHistory } from "./useInputHistory.js";
export type { UseInputHistoryOptions, UseInputHistoryReturn } from "./useInputHistory.js";

export { useAutocomplete, AutocompleteContextProvider, useAutocompleteContext } from "./useAutocomplete.js";
export type { UseAutocompleteOptions, UseAutocompleteReturn } from "./useAutocomplete.js";
// Note: File is useAutocomplete.tsx but imports use .js extension for ESM
