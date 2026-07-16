/**
 * Tracks the mapping between KodaX session ids and CLI-native session ids.
 */
export class CLISessionManager {
    private mapping = new Map<string, string>();

    /**
     * Look up the CLI session id for a KodaX session.
     */
    get(kodaxSessionId: string): string | undefined {
        return this.mapping.get(kodaxSessionId);
    }

    /**
     * Record the CLI session id for a KodaX session.
     */
    set(kodaxSessionId: string, cliSessionId: string): void {
        this.mapping.set(kodaxSessionId, cliSessionId);
    }

    /**
     * Remove the mapping for a KodaX session.
     */
    delete(kodaxSessionId: string): void {
        this.mapping.delete(kodaxSessionId);
    }
}
