import { spawn } from 'node:child_process';
import process from 'node:process';

export async function checkCliCommandInstalled(command: string): Promise<boolean> {
    try {
        const isWin = process.platform === 'win32';
        const child = spawn(isWin ? `${command}.cmd` : command, ['--version']);
        return await new Promise((resolve) => {
            child.on('close', (code) => resolve(code === 0));
            child.on('error', () => resolve(false));
        });
    } catch {
        return false;
    }
}
