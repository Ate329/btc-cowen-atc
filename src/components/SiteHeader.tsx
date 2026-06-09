import { useCallback, useEffect, useState, type ReactNode } from "react";
import { LineChart, Moon, Sun } from "lucide-react";
import {
  applyTheme,
  getInitialTheme,
  getStoredTheme,
  getSystemTheme,
  storeTheme,
  type Theme,
} from "../lib/theme";

type SiteHeaderProps = {
  homeHref: string;
  navLabel: string;
  children: ReactNode;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => {
    finished: Promise<void>;
  };
};

export function SiteHeader({ homeHref, navLabel, children }: SiteHeaderProps) {
  return (
    <header className="site-header">
      <a className="brand" href={homeHref} aria-label="BTC Cowen ATC home">
        <LineChart size={22} />
        <span>BTC Cowen ATC</span>
      </a>
      <div className="site-header-right">
        <nav aria-label={navLabel}>{children}</nav>
        <ThemeToggle />
      </div>
    </header>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const readyFrame =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(() => {
            document.documentElement.classList.add("theme-ready");
          })
        : null;

    return () => {
      if (readyFrame !== null) {
        window.cancelAnimationFrame(readyFrame);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemChange = () => {
      if (getStoredTheme() === null) {
        setTheme(getSystemTheme());
      }
    };

    mediaQuery.addEventListener?.("change", handleSystemChange);
    return () => {
      mediaQuery.removeEventListener?.("change", handleSystemChange);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const commitTheme = () => {
      storeTheme(nextTheme);
      applyTheme(nextTheme);
      setTheme(nextTheme);
    };

    const viewTransitionDocument = document as ViewTransitionDocument;
    if (
      !prefersReducedMotion &&
      typeof viewTransitionDocument.startViewTransition === "function"
    ) {
      const transition = viewTransitionDocument.startViewTransition(commitTheme);
      transition.finished.catch(() => undefined);
      return;
    }

    commitTheme();
  }, [theme]);

  const isDark = theme === "dark";

  return (
    <button
      className="theme-toggle"
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      title={`Switch to ${isDark ? "light" : "dark"} theme`}
      onClick={toggleTheme}
    >
      <span className="theme-toggle-track" aria-hidden="true">
        <span className="theme-toggle-icon theme-toggle-icon-light">
          <Sun size={14} />
        </span>
        <span className="theme-toggle-icon theme-toggle-icon-dark">
          <Moon size={14} />
        </span>
        <span className="theme-toggle-thumb" />
      </span>
    </button>
  );
}
