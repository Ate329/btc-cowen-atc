import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import AboutPage from "../src/components/AboutPage";
import { THEME_STORAGE_KEY } from "../src/lib/theme";

let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  document.documentElement.classList.remove("theme-ready");
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("theme toggle", () => {
  it("uses system dark theme when no stored preference exists", async () => {
    stubMatchMedia({ dark: true });
    renderAboutPage();

    await act(async () => {});

    const toggle = getThemeToggle();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("persists a user theme switch", async () => {
    stubMatchMedia({ dark: false });
    renderAboutPage();

    const toggle = getThemeToggle();
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("renders the switch in the about page header", () => {
    stubMatchMedia({ dark: false });
    const host = renderAboutPage();

    expect(host.textContent).toContain("Back to dashboard");
    expect(getThemeToggle()).toBeTruthy();
  });

  it("keeps inherited app text tied to live theme variables", () => {
    const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const appStyles = readFileSync(
      resolve(process.cwd(), "src/styles.css"),
      "utf8",
    );

    expect(indexHtml).toContain("color: var(--ink, ${ink});");
    expect(indexHtml).toContain("background: var(--bg, ${colors[theme]});");
    expect(appStyles).toMatch(/\.app\s*{[^}]*color:\s*var\(--ink\);/s);
  });
});

function renderAboutPage() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<AboutPage />);
  });

  return host;
}

function getThemeToggle() {
  const toggle = document.querySelector<HTMLButtonElement>(
    'button[role="switch"]',
  );
  expect(toggle).toBeTruthy();
  return toggle!;
}

function stubMatchMedia({ dark }: { dark: boolean }) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-color-scheme") ? dark : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}
