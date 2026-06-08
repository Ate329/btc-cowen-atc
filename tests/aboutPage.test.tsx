import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { AppRouter } from "../src/AppRouter";

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("About page route", () => {
  it("renders the about page for ?page=about with the required sections", () => {
    window.history.replaceState({}, "", "/?page=about");

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<AppRouter />);
    });

    expect(host.textContent).toContain("What this page is about");
    expect(host.textContent).toContain("The paper");
    expect(host.textContent).toContain("What this project does");
    expect(host.textContent).toContain("Why I built this");
    expect(host.textContent).toContain("What this page does not do");
    const backLinks = [...host.querySelectorAll("a")].filter((item) =>
      item.textContent?.includes("Back to dashboard"),
    );
    expect(backLinks.length).toBe(1);
  });
});
