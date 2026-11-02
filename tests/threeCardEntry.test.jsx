import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Entry } from "../src/components/ThreeCardReading.jsx";

const baseProps = {
  active: true,
  question: "",
  setQuestion: () => {},
  onSubmit: () => {},
  starting: false,
  onRetryQuota: () => {},
};

describe("Three Cards entry quota state", () => {
  it("shows the question form while a daily question remains", () => {
    const html = renderToStaticMarkup(<Entry
      {...baseProps}
      quota={{ status: "ready", limit: 3, used: 2, remaining: 1 }}
    />);

    expect(html).toContain("Write the question you’ve been carrying…");
    expect(html).toContain("Begin the reading");
  });

  it("replaces the input with tomorrow copy after the third daily question", () => {
    const html = renderToStaticMarkup(<Entry
      {...baseProps}
      quota={{ status: "exhausted", limit: 3, used: 3, remaining: 0 }}
    />);

    expect(html).not.toContain("<input");
    expect(html).not.toContain("Begin the reading");
    expect(html).toContain("The cards have answered today’s three questions—come back tomorrow.");
  });
});
