import { describe, expect, it } from "vitest";

// 这是一个模拟了新方案逻辑的测试函数
// This simulates the proposed logic for isBashReadCommand
function simulateProposedIsBashReadCommand(command: string, isWindows: boolean): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  // 1. Handle line continuations: replace \ followed by newline with space
  let normalizedCommand = command.trim().replace(/\\\r?\n/g, ' ');

  // 2. Reject dangerous shell operators (removed \\ from this baseline)
  const baseIllegalSyntax = /[<>|;`]|\$\(|(?<!&)&(?!&)/;
  if (baseIllegalSyntax.test(normalizedCommand)) {
    return false;
  }

  // 3. Handle backslash safely based on platform
  if (normalizedCommand.includes('\\')) {
    if (isWindows) {
      // Allow \ on Windows (path separator)
    } else {
      // On Unix, only allow \ if it's escaping a space (e.g., folder\ name)
      const withoutEscapedSpaces = normalizedCommand.replace(/\\ /g, '');
      if (withoutEscapedSpaces.includes('\\')) {
        return false;
      }
    }
  }

  // 4. Split and check compound commands
  const subCommands = normalizedCommand.split(/\s*&&\s*/);
  
  // 5. Whitelist check (Simplified for the test simulation)
  const safeCmds = ['git status', 'git diff', 'ls', 'cat', 'node'];
  for (const subCmd of subCommands) {
    let isValid = false;
    let trimmedCmd = subCmd.trim();
    
    // Normalize spaces for argument parsing
    trimmedCmd = trimmedCmd.replace(/\s+/g, ' ');

    for (const safeCmd of safeCmds) {
      if (trimmedCmd === safeCmd || trimmedCmd.startsWith(safeCmd + ' ')) {
        isValid = true;
        break;
      }
    }
    if (!isValid) return false;
  }

  return true;
}


describe("Proposed isBashReadCommand Logic", () => {
  describe("Windows Environment", () => {
    const isWindows = true;

    it("allows Windows path separators", () => {
      expect(simulateProposedIsBashReadCommand("git diff src\\ui\\App.tsx", isWindows)).toBe(true);
      expect(simulateProposedIsBashReadCommand("cat C:\\Users\\test\\file.txt", isWindows)).toBe(true);
    });

    it("allows multiple commands with && and Windows paths", () => {
      expect(simulateProposedIsBashReadCommand("git status && git diff src\\ui", isWindows)).toBe(true);
    });

    it("blocks dangerous execution regardless of backslash", () => {
      expect(simulateProposedIsBashReadCommand("git diff src\\ui ; rm -rf /", isWindows)).toBe(false);
      expect(simulateProposedIsBashReadCommand("cat file.txt > output.txt", isWindows)).toBe(false);
    });
  });

  describe("Unix Environment", () => {
    const isWindows = false;

    it("allows escaped spaces", () => {
      expect(simulateProposedIsBashReadCommand("cat My\\ Folder/file.txt", isWindows)).toBe(true);
    });

    it("blocks other backslashes that might be used for obfuscation/escaping", () => {
      expect(simulateProposedIsBashReadCommand("g\\it status", isWindows)).toBe(false);
      expect(simulateProposedIsBashReadCommand("cat \\$HOME", isWindows)).toBe(false);
    });
  });

  describe("Cross-Platform Features", () => {
    it("allows line continuations (\\n)", () => {
      expect(simulateProposedIsBashReadCommand("git diff \\\n src/ui", true)).toBe(true);
      expect(simulateProposedIsBashReadCommand("git diff \\\n src/ui", false)).toBe(true);
    });

    it("handles multiple spaces gracefully", () => {
      // The simulation normalize spaces internally, which helps flag parsing
      expect(simulateProposedIsBashReadCommand("git   diff    src/ui", true)).toBe(true);
    });
  });
});
