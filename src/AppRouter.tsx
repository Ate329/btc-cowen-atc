import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import AboutPage from "./components/AboutPage";
import App from "./App";
import { applyPageSeo, type SeoPage } from "./lib/seo";

type Page = SeoPage;

function getPageFromUrl(url: URL): Page | null {
  if (url.pathname === "/about" || url.pathname === "/about/") {
    return "about";
  }

  if (url.pathname !== "/") {
    return null;
  }

  const page = url.searchParams.get("page");
  if (page === "about") {
    return "about";
  }

  if (page !== null) {
    return null;
  }

  return "dashboard";
}

function getCurrentPage(): Page {
  return getPageFromUrl(new URL(window.location.href)) ?? "dashboard";
}

function normalizeCurrentLocation(page: Page) {
  const url = new URL(window.location.href);
  const isLegacyAboutRoute =
    page === "about" &&
    (url.pathname === "/about" || url.searchParams.get("page") === "about");

  if (!isLegacyAboutRoute) return;

  const nextPath = `/about/${url.hash}`;
  const currentPath = `${url.pathname}${url.search}${url.hash}`;
  if (nextPath !== currentPath) {
    window.history.replaceState({}, "", nextPath);
  }
}

function isPlainLeftClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function getAppUrl(anchor: HTMLAnchorElement): URL | null {
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;

  const url = new URL(anchor.href);
  if (url.origin !== window.location.origin) {
    return null;
  }

  const page = getPageFromUrl(url);
  if (!page) return null;

  if (page === "about") {
    url.pathname = "/about/";
    url.search = "";
  }

  return url;
}

function scrollToRouteTarget(url: URL) {
  if (url.hash) {
    window.requestAnimationFrame(() => {
      document.querySelector(url.hash)?.scrollIntoView({ block: "start" });
    });
    return;
  }

  try {
    window.scrollTo({ left: 0, top: 0, behavior: "auto" });
  } catch {
    // jsdom does not implement scrollTo; browsers do.
  }
}

export function AppRouter() {
  const [page, setPage] = useState<Page>(() => getCurrentPage());

  const syncPage = useCallback(() => {
    const nextPage = getCurrentPage();
    normalizeCurrentLocation(nextPage);
    setPage(nextPage);
  }, []);

  useEffect(() => {
    applyPageSeo(page);
  }, [page]);

  useLayoutEffect(() => {
    syncPage();

    const handlePopState = () => syncPage();

    const handleDocumentClick = (event: MouseEvent) => {
      if (!isPlainLeftClick(event)) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;

      const url = getAppUrl(anchor);
      if (!url) return;

      event.preventDefault();

      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const nextPath = `${url.pathname}${url.search}${url.hash}`;
      if (nextPath !== currentPath) {
        window.history.pushState({}, "", nextPath);
      }

      flushSync(syncPage);
      scrollToRouteTarget(url);
    };

    window.addEventListener("popstate", handlePopState);
    document.addEventListener("click", handleDocumentClick);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("click", handleDocumentClick);
    };
  }, [syncPage]);

  if (page === "about") {
    return <AboutPage />;
  }

  return <App />;
}
