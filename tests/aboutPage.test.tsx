import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { AppRouter } from "../src/AppRouter";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("theme-ready");
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("About page route", () => {
  it("renders the about page for /about/ with the required sections", () => {
    window.history.replaceState({}, "", "/about/");

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<AppRouter />);
    });

    expect(host.textContent).toContain("Bitcoin ATC quantile model methodology");
    expect(host.textContent).toContain("The paper");
    expect(host.textContent).toContain("What this project does");
    expect(host.textContent).toContain("Why?");
    expect(host.textContent).toContain("I first heard about Cowen's paper from a video");
    expect(host.textContent).toContain("What this page does not do");
    const backLinks = [...host.querySelectorAll("a")].filter((item) =>
      item.textContent?.includes("Back to dashboard"),
    );
    expect(backLinks.length).toBe(1);
    expect(host.querySelector('button[role="switch"]')).toBeTruthy();

    act(() => {
      root.unmount();
    });
  });

  it("keeps the legacy ?page=about URL compatible and normalizes it", () => {
    window.history.replaceState({}, "", "/?page=about");

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(<AppRouter />);
    });

    expect(window.location.pathname).toBe("/about/");
    expect(window.location.search).toBe("");
    expect(host.textContent).toContain("Bitcoin ATC quantile model methodology");

    act(() => {
      root.unmount();
    });
  });

  it("keeps dashboard and about navigation inside the React app", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })),
    );
    vi.stubGlobal("scrollTo", vi.fn());

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<AppRouter />);
    });

    const aboutLink = [...host.querySelectorAll("a")].find(
      (item) => item.textContent === "About",
    );
    expect(aboutLink).toBeTruthy();

    await act(async () => {
      aboutLink?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/about/");
    expect(window.location.search).toBe("");
    expect(host.textContent).toContain("Bitcoin ATC quantile model methodology");

    const backLink = [...host.querySelectorAll("a")].find((item) =>
      item.textContent?.includes("Back to dashboard"),
    );
    expect(backLink).toBeTruthy();

    await act(async () => {
      backLink?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(host.textContent).toContain(
      "Bitcoin price through asymmetric quantile bands",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
