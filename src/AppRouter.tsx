import AboutPage from "./components/AboutPage";
import App from "./App";

export function AppRouter() {
  const page = new URLSearchParams(window.location.search).get("page");

  if (page === "about") {
    return <AboutPage />;
  }

  return <App />;
}

