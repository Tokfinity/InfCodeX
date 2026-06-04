import { afterEach, describe, expect, it } from "vitest";
import {
  detectTerminalHostProfile,
  getTerminalHostCapabilities,
  hasCursorUpViewportYankRisk,
  hasMainScreenRenderScrollRisk,
  resolveConfiguredTuiRendererMode,
  resolveEffectiveTuiRendererMode,
  resolveFullscreenPolicy,
  resolveInteractiveSurfacePreference,
  resetTmuxControlModeProbeForTesting,
} from "./terminal-host-profile.js";

describe("terminal-host-profile", () => {
  afterEach(() => {
    resetTmuxControlModeProbeForTesting();
  });

  it("detects VS Code terminals as xtermjs hosts", () => {
    expect(detectTerminalHostProfile({
      env: {
        TERM_PROGRAM: "vscode",
      } as NodeJS.ProcessEnv,
      platform: "win32",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("xtermjs_host");
  });

  it("treats legacy Windows terminals without WT_SESSION as degraded", () => {
    expect(detectTerminalHostProfile({
      env: {} as NodeJS.ProcessEnv,
      platform: "win32",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("degraded_vt");
  });

  it("treats Windows Terminal backed sessions as degraded even outside win32", () => {
    expect(detectTerminalHostProfile({
      env: {
        WT_SESSION: "1",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("degraded_vt");
  });

  it("keeps VS Code terminals on the xtermjs path before applying WT risk fallback", () => {
    expect(detectTerminalHostProfile({
      env: {
        TERM_PROGRAM: "vscode",
        WT_SESSION: "1",
      } as NodeJS.ProcessEnv,
      platform: "win32",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("xtermjs_host");
  });

  it("detects cursor-up viewport yank risk for Windows-backed native terminals", () => {
    expect(hasCursorUpViewportYankRisk({
      env: {} as NodeJS.ProcessEnv,
      platform: "win32",
    })).toBe(true);

    expect(hasCursorUpViewportYankRisk({
      env: {
        WT_SESSION: "1",
      } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe(true);

    expect(hasCursorUpViewportYankRisk({
      env: {} as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe(false);
  });

  it("treats VS Code terminals as main-screen render scroll risk even outside Windows", () => {
    expect(hasMainScreenRenderScrollRisk({
      env: {
        TERM_PROGRAM: "vscode",
      } as NodeJS.ProcessEnv,
      platform: "linux",
    })).toBe(true);
  });

  it("keeps risky-but-supported terminal hosts on the TUI surface by default", () => {
    expect(resolveInteractiveSurfacePreference({
      env: {
        TERM_PROGRAM: "vscode",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("ink");

    expect(resolveInteractiveSurfacePreference({
      env: {} as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("ink");
  });

  it("lets explicit environment overrides force the interactive surface", () => {
    expect(resolveInteractiveSurfacePreference({
      env: {
        KODAX_FORCE_CLASSIC_REPL: "1",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("classic");

    expect(resolveInteractiveSurfacePreference({
      env: {
        TMUX: "/tmp/tmux-1000/default,1234,0",
        KODAX_FORCE_INK: "1",
      } as NodeJS.ProcessEnv,
      platform: "darwin",
      isTTY: true,
      rawModeSupported: true,
      tmuxControlMode: true,
    })).toBe("ink");

    expect(resolveInteractiveSurfacePreference({
      env: {
        KODAX_TUI_RENDERER: "owned",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: false,
      rawModeSupported: false,
    })).toBe("ink");
  });

  it("routes tmux control mode to the classic surface", () => {
    expect(detectTerminalHostProfile({
      env: {
        TMUX: "/tmp/tmux-1000/default,1234,0",
        TERM_PROGRAM: "iTerm.app",
        TERM: "xterm-256color",
      } as NodeJS.ProcessEnv,
      platform: "darwin",
      isTTY: true,
      rawModeSupported: true,
      tmuxControlMode: true,
    })).toBe("tmux_control_mode");

    expect(resolveInteractiveSurfacePreference({
      env: {
        TMUX: "/tmp/tmux-1000/default,1234,0",
      } as NodeJS.ProcessEnv,
      platform: "darwin",
      isTTY: true,
      rawModeSupported: true,
      tmuxControlMode: true,
    })).toBe("classic");
  });

  it("resolves renderer burn-in mode from environment", () => {
    expect(resolveConfiguredTuiRendererMode({
      env: {
        KODAX_TUI_RENDERER: "owned",
      } as NodeJS.ProcessEnv,
    })).toBe("owned");

    expect(resolveConfiguredTuiRendererMode({
      env: {
        KODAX_FORCE_INK: "1",
      } as NodeJS.ProcessEnv,
    })).toBe("legacy");

    expect(resolveEffectiveTuiRendererMode({
      env: {
        TERM_PROGRAM: "vscode",
      } as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: true,
      rawModeSupported: true,
    })).toBe("owned");
  });

  it("falls back to unsupported control hosts when tty control is unavailable", () => {
    expect(detectTerminalHostProfile({
      env: {} as NodeJS.ProcessEnv,
      platform: "linux",
      isTTY: false,
      rawModeSupported: false,
    })).toBe("unsupported_control_host");
  });

  it("assigns owned viewport capabilities to native VT hosts", () => {
    expect(getTerminalHostCapabilities("native_vt")).toEqual({
      profile: "native_vt",
      ownsViewportByDefault: true,
      supportsMouseTracking: true,
      bufferingMode: "live",
      supportsFullscreenLayout: true,
      supportsOverlaySurface: true,
      supportsSelection: true,
      supportsCopyOnSelect: false,
      supportsWheelHistory: true,
      supportsViewportChrome: true,
      supportsSearchViewport: true,
      supportsStickyPrompt: true,
    });
  });

  it("gives xtermjs hosts Claude-style owned viewport defaults", () => {
    expect(getTerminalHostCapabilities("xtermjs_host")).toEqual({
      profile: "xtermjs_host",
      ownsViewportByDefault: true,
      supportsMouseTracking: true,
      bufferingMode: "live",
      supportsFullscreenLayout: true,
      supportsOverlaySurface: true,
      supportsSelection: true,
      supportsCopyOnSelect: false,
      supportsWheelHistory: true,
      supportsViewportChrome: true,
      supportsSearchViewport: true,
      supportsStickyPrompt: true,
    });
  });

  it("gives degraded hosts Claude-style owned viewport defaults", () => {
    expect(getTerminalHostCapabilities("degraded_vt")).toEqual({
      profile: "degraded_vt",
      ownsViewportByDefault: true,
      supportsMouseTracking: true,
      bufferingMode: "live",
      supportsFullscreenLayout: true,
      supportsOverlaySurface: true,
      supportsSelection: true,
      supportsCopyOnSelect: false,
      supportsWheelHistory: true,
      supportsViewportChrome: true,
      supportsSearchViewport: true,
      supportsStickyPrompt: true,
    });
  });

  it("builds fullscreen policies for owned and legacy renderer modes", () => {
    expect(resolveFullscreenPolicy("degraded_vt", "owned")).toEqual({
      enabled: true,
      promptShell: "virtual",
      transcriptShell: "virtual",
      mouseWheel: true,
      mouseClicks: true,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    });

    expect(resolveFullscreenPolicy("xtermjs_host", "owned")).toEqual({
      enabled: true,
      promptShell: "virtual",
      transcriptShell: "virtual",
      mouseWheel: true,
      mouseClicks: true,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    });

    expect(resolveFullscreenPolicy("native_vt", "legacy")).toEqual({
      enabled: false,
      promptShell: "main-screen",
      transcriptShell: "main-screen",
      mouseWheel: false,
      mouseClicks: false,
      streamingPreview: true,
      transcriptSpinnerAnimation: true,
    });
  });

  // FEATURE_096: Windows-SSH ConPTY auto-downgrade
  describe("remote_conpty_host detection (FEATURE_096)", () => {
    const SSH_ENV: NodeJS.ProcessEnv = { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" } as NodeJS.ProcessEnv;

    it("detects Windows + SSH_CONNECTION as remote_conpty_host", () => {
      expect(detectTerminalHostProfile({
        env: SSH_ENV,
        platform: "win32",
        isTTY: true,
        rawModeSupported: true,
      })).toBe("remote_conpty_host");
    });

    it("detects Windows + SSH_CLIENT as remote_conpty_host", () => {
      expect(detectTerminalHostProfile({
        env: { SSH_CLIENT: "1.2.3.4 22 22" } as NodeJS.ProcessEnv,
        platform: "win32",
        isTTY: true,
        rawModeSupported: true,
      })).toBe("remote_conpty_host");
    });

    it("detects Windows + SSH_TTY as remote_conpty_host", () => {
      expect(detectTerminalHostProfile({
        env: { SSH_TTY: "/dev/pts/0" } as NodeJS.ProcessEnv,
        platform: "win32",
        isTTY: true,
        rawModeSupported: true,
      })).toBe("remote_conpty_host");
    });

    it("does not promote Linux SSH session to remote_conpty_host", () => {
      expect(detectTerminalHostProfile({
        env: SSH_ENV,
        platform: "linux",
        isTTY: true,
        rawModeSupported: true,
      })).toBe("native_vt");
    });

    it("does not promote macOS SSH session to remote_conpty_host", () => {
      expect(detectTerminalHostProfile({
        env: { SSH_TTY: "/dev/ttys001" } as NodeJS.ProcessEnv,
        platform: "darwin",
        isTTY: true,
        rawModeSupported: true,
      })).toBe("native_vt");
    });

    it("keeps VS Code Remote-SSH on the xtermjs path even on Windows", () => {
      // VS Code's xterm.js handles mouse events directly, not via ConPTY VT.
      // xtermjs check must run before remote_conpty_host so VS Code Remote-SSH
      // (TERM_PROGRAM=vscode + SSH_* on win32) is not falsely downgraded.
      expect(detectTerminalHostProfile({
        env: { TERM_PROGRAM: "vscode", SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" } as NodeJS.ProcessEnv,
        platform: "win32",
        isTTY: true,
        rawModeSupported: true,
      })).toBe("xtermjs_host");
    });

    it("returns inline mixed shell (main-screen prompt + virtual transcript) for remote_conpty_host (owned)", () => {
      // FEATURE_214 (v0.7.46): SSH is inline by default. The prompt stays on the
      // main screen (native scrollback); the transcript/review surface enters an
      // alt-screen virtual viewport on Ctrl+O so it never duplicates scrollback.
      expect(resolveFullscreenPolicy("remote_conpty_host", "owned")).toEqual({
        enabled: true,
        promptShell: "main-screen",
        transcriptShell: "virtual",
        mouseWheel: true,
        mouseClicks: true,
        streamingPreview: false,
        transcriptSpinnerAnimation: true,
      });
    });

    it("collapses remote_conpty_host into degraded main-screen for legacy renderer mode", () => {
      expect(resolveFullscreenPolicy("remote_conpty_host", "legacy")).toEqual({
        enabled: false,
        promptShell: "main-screen",
        transcriptShell: "main-screen",
        mouseWheel: false,
        mouseClicks: false,
        streamingPreview: false,
        transcriptSpinnerAnimation: false,
      });
    });
  });

  describe("KODAX_FULLSCREEN escape hatch (FEATURE_096)", () => {
    it("=1 makes Windows-SSH detect fall back through to degraded_vt fullscreen", () => {
      // Force fullscreen wins at detect layer: isRemoteConptyHost short-circuits
      // and the host is classified by its underlying platform path.
      expect(detectTerminalHostProfile({
        env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22", KODAX_FULLSCREEN: "1" } as NodeJS.ProcessEnv,
        platform: "win32",
        isTTY: true,
        rawModeSupported: true,
      })).toBe("degraded_vt");
    });

    it("=0 selects inline mixed shell on an alt-screen-capable host (native_vt)", () => {
      // FEATURE_214 (v0.7.46): opting out of fullscreen selects inline mode —
      // main-screen prompt (native scrollback) + alt-screen virtual transcript.
      const policy = resolveFullscreenPolicy("native_vt", "owned", {
        env: { KODAX_FULLSCREEN: "0" } as NodeJS.ProcessEnv,
      });
      expect(policy).toEqual({
        enabled: true,
        promptShell: "main-screen",
        transcriptShell: "virtual",
        mouseWheel: true,
        mouseClicks: true,
        streamingPreview: false,
        transcriptSpinnerAnimation: true,
      });
    });

    it("=0 selects inline mixed shell for xtermjs_host (main-screen prompt + virtual transcript)", () => {
      const policy = resolveFullscreenPolicy("xtermjs_host", "owned", {
        env: { KODAX_FULLSCREEN: "0" } as NodeJS.ProcessEnv,
      });
      expect(policy.enabled).toBe(true);
      expect(policy.promptShell).toBe("main-screen");
      expect(policy.transcriptShell).toBe("virtual");
      expect(policy.streamingPreview).toBe(false);
      expect(policy.transcriptSpinnerAnimation).toBe(true);
    });

    it("=0 still fully disables a host that cannot drive alt-screen (tmux control mode)", () => {
      // The inline transcript modal needs alt-screen; hosts that can't drive it
      // keep the historical all-main-screen disable policy.
      const policy = resolveFullscreenPolicy("tmux_control_mode", "owned", {
        env: { KODAX_FULLSCREEN: "0" } as NodeJS.ProcessEnv,
      });
      expect(policy.enabled).toBe(false);
      expect(policy.promptShell).toBe("main-screen");
      expect(policy.transcriptShell).toBe("main-screen");
    });

    it("unset value falls back to per-host default (no override)", () => {
      // Confirm the new options arg is non-breaking when absent.
      expect(resolveFullscreenPolicy("native_vt", "owned", {
        env: {} as NodeJS.ProcessEnv,
      }).enabled).toBe(true);
    });
  });
});
