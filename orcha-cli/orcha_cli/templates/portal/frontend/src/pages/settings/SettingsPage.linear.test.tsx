/**
 * Settings — Linear layout contract: the grouped section list (clusters +
 * glyphs, no stripe element), the SettingsGroup (title + description ABOVE a
 * box) and SettingRow (label/desc left, control right) building blocks.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingRow, SettingRows, SettingsGroup } from "./settingsUi";
import { clusterSections, sectionMeta } from "./SettingsPage";

describe("settings section list clusters", () => {
  it("groups the V2 sections into Project / Access / Personal in first-seen order", () => {
    const keys = ["general", "execution", "provider-keys", "github-access", "members", "pairing", "interface"].map((key) => ({ key }));
    const out = clusterSections(keys);
    expect(out.map((c) => c.cluster)).toEqual(["Project", "Access", "Personal"]);
    expect(out[0].items.map((i) => i.key)).toEqual(["general", "execution", "provider-keys", "github-access"]);
    expect(out[1].items.map((i) => i.key)).toEqual(["members", "pairing"]);
  });

  it("an unknown downstream section still gets a home (More) and a glyph", () => {
    expect(sectionMeta("billing")).toEqual({ icon: "more", cluster: "More" });
    expect(clusterSections([{ key: "general" }, { key: "billing" }]).map((c) => c.cluster)).toEqual(["Project", "More"]);
  });
});

describe("SettingsGroup / SettingRow", () => {
  afterEach(cleanup);

  it("puts the title and description above the box, the content inside it", () => {
    render(
      <SettingsGroup title="Agent workspace" lead="Where agents run." settab="execution" flush>
        <SettingRows id="rows">
          <SettingRow label="Isolated worktrees" desc="Each agent in its own worktree.">
            <button type="button">Toggle</button>
          </SettingRow>
        </SettingRows>
      </SettingsGroup>,
    );
    const card = document.querySelector(".set-card")!;
    expect(card).toHaveAttribute("data-settab", "execution");
    const head = card.querySelector(".card-h")!;
    expect(head.querySelector("h2")).toHaveTextContent("Agent workspace");
    expect(head.querySelector(".lead")).toHaveTextContent("Where agents run.");
    const box = card.querySelector(".card-b")!;
    expect(box).toHaveClass("is-flush");
    expect(box.querySelector(".lead")).toBeNull();
    // a row is a <dl> term (label + muted description) with its control as the value
    const row = box.querySelector("dl#rows .set-rowi")!;
    expect(row.querySelector("dt .set-rowi-l")).toHaveTextContent("Isolated worktrees");
    expect(row.querySelector("dt .set-rowi-d")).toHaveTextContent("Each agent in its own worktree.");
    expect(row.querySelector("dd")).toContainElement(screen.getByRole("button", { name: "Toggle" }));
  });

  it("a group without a title renders no heading (the page supplies the one title)", () => {
    render(<SettingsGroup><p>body</p></SettingsGroup>);
    expect(document.querySelector(".set-card .card-h")).toBeNull();
    expect(document.querySelector(".set-card .card-b")).not.toHaveClass("is-flush");
  });
});
