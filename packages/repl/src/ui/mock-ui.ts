/**
 * Mock UI Context - Mock UI 上下文实现
 *
 * 用于测试的 Mock 实现，可以预配置响应
 */

import type { UIContext } from './context.js';

/**
 * MockUIContext - Mock UI 上下文
 *
 * @example
 * ```typescript
 * const mockUI = new MockUIContext({
 *   selects: ['option1', 'option2'],
 *   confirms: [true, false],
 *   inputs: ['input1', 'input2']
 * });
 *
 * // Will return 'option1' on first select() call
 * const selected = await mockUI.select("Choose", ["A", "B"]);
 * ```
 */
export class MockUIContext implements UIContext {
  private selectIndex = 0;
  private confirmIndex = 0;
  private inputIndex = 0;

  constructor(private responses: {
    selects?: string[];
    confirms?: boolean[];
    inputs?: string[];
  }) {}

  /**
   * Show a selector and return the user's choice
   *
   * Returns pre-configured responses in order, or undefined if no more responses
   */
  async select(_title: string, _options: string[]): Promise<string | undefined> {
    if (!this.responses.selects || this.selectIndex >= this.responses.selects.length) {
      return undefined;
    }
    return this.responses.selects[this.selectIndex++];
  }

  /**
   * Show a confirmation dialog
   *
   * Returns pre-configured responses in order, or false if no more responses
   */
  async confirm(_message: string): Promise<boolean> {
    if (!this.responses.confirms || this.confirmIndex >= this.responses.confirms.length) {
      return false;
    }
    return this.responses.confirms[this.confirmIndex++];
  }

  /**
   * Show a text input dialog
   *
   * Returns pre-configured responses in order, or undefined if no more responses
   */
  async input(_prompt: string, _defaultValue?: string): Promise<string | undefined> {
    if (!this.responses.inputs || this.inputIndex >= this.responses.inputs.length) {
      return undefined;
    }
    return this.responses.inputs[this.inputIndex++];
  }

  /**
   * Reset all response indices
   * 重置所有响应索引
   */
  reset(): void {
    this.selectIndex = 0;
    this.confirmIndex = 0;
    this.inputIndex = 0;
  }
}
