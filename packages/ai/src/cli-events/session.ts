/**
 * 管理 KodaX Session 到 CLI Session 的映射
 */
export class CLISessionManager {
    private mapping = new Map<string, string>();

    /**
     * 获取 CLI Session ID
     */
    get(kodaxSessionId: string): string | undefined {
        return this.mapping.get(kodaxSessionId);
    }

    /**
     * 设置 CLI Session ID
     */
    set(kodaxSessionId: string, cliSessionId: string): void {
        this.mapping.set(kodaxSessionId, cliSessionId);
    }

    /**
     * 清理 Session
     */
    delete(kodaxSessionId: string): void {
        this.mapping.delete(kodaxSessionId);
    }
}
