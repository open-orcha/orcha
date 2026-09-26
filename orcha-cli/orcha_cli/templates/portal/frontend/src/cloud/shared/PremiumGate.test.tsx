/**
 * PremiumGate — renders the title, pitch list, and wires the upgrade button
 * to window.open(upgradeUrl, "_blank", "noopener").
 */
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PremiumGate } from "./PremiumGate";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PremiumGate", () => {
  it("renders the title and every pitch line", () => {
    render(
      <PremiumGate
        feature="members"
        title="Members"
        pitch={["Invite teammates", "Roles: owner, member, viewer"]}
        upgradeUrl="https://orcha.nursoftai.com/#pricing"
      />,
    );
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.getByText("Invite teammates")).toBeInTheDocument();
    expect(screen.getByText("Roles: owner, member, viewer")).toBeInTheDocument();
    expect(screen.getByText(/Team feature/)).toBeInTheDocument();
  });

  it("marks the card with the feature key", () => {
    render(<PremiumGate feature="members" title="Members" pitch={[]} upgradeUrl="https://x" />);
    expect(document.querySelector('[data-premium-feature="members"]')).not.toBeNull();
  });

  it('"Upgrade to Orcha Cloud Team" opens upgradeUrl in a new tab, noopener', () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <PremiumGate feature="members" title="Members" pitch={[]} upgradeUrl="https://orcha.nursoftai.com/#pricing" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Upgrade to Orcha Cloud Team/ }));
    expect(openSpy).toHaveBeenCalledWith("https://orcha.nursoftai.com/#pricing", "_blank", "noopener");
  });

  it("renders with no pitch list when pitch is empty", () => {
    render(<PremiumGate feature="members" title="Members" pitch={[]} upgradeUrl="https://x" />);
    expect(document.querySelector(".pg-pitch")).toBeNull();
  });
});
