import { describe, expect, it } from "vitest";
import { INFCODEX_BANNER_LOGO_LINES } from "./banner-logo.js";

describe("INFCODEX_BANNER_LOGO_LINES", () => {
  it("renders the InfCodeX six-line block logo", () => {
    expect(INFCODEX_BANNER_LOGO_LINES).toEqual([
      "  ██╗███╗   ██╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗",
      "  ██║████╗  ██║██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝",
      "  ██║██╔██╗ ██║█████╗  ██║     ██║   ██║██║  ██║█████╗   ╚███╔╝ ",
      "  ██║██║╚██╗██║██╔══╝  ██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗ ",
      "  ██║██║ ╚████║██║     ╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗",
      "  ╚═╝╚═╝  ╚═══╝╚═╝      ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
    ]);
  });
});
