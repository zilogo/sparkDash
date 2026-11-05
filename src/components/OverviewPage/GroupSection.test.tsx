import { describe, expect, it } from "vitest";
import { OverviewPage } from "./OverviewPage";
import { GroupSection } from "./GroupSection";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { SparkSnapshot } from "../../api/types";

const unit = (id: string, group: string | null, online = true): SparkSnapshot => ({ ...makeSpark(id, online), group });

describe("Overview groups", () => {
  it("renders no group sections when no unit has a group", () => {
    const { container } = render(<OverviewPage sparks={[unit("a", null), unit("b", null)]} />);
    expect(container.querySelector(".ov-group")).toBeNull();
    expect(container.querySelectorAll(".ov-sparks")).toHaveLength(1);
  });

  it("renders a section per group with a summary row, ungrouped last", () => {
    const sparks = [unit("a", "DeepSeek"), unit("b", null), unit("c", "DeepSeek", false), unit("d", "Qwen")];
    const { container } = render(<OverviewPage sparks={sparks} />);
    const sections = [...container.querySelectorAll(".ov-group")];
    expect(sections.map((s) => s.querySelector(".ov-group__title")?.textContent)).toEqual(["DeepSeek", "Qwen", "Ungrouped"]);
    const deepseek = sections[0].querySelector(".ov-group__summary")?.textContent ?? "";
    expect(deepseek).toContain("1/2");
    expect(deepseek).toContain("1.0 GB / 4.0 GB");
    expect(sections[0].querySelectorAll(".ov-sparks > *")).toHaveLength(2);
  });

  it("shows an em dash, not zero, for values it cannot know", () => {
    const { container } = render(
      <GroupSection name="Down" members={[unit("a", "Down", false)]}>
        <div />
      </GroupSection>
    );
    const values = [...container.querySelectorAll(".ov-group__summary dd")].map((d) => d.textContent);
    expect(values).toEqual(["0/1", "—", "—"]);
  });
});
