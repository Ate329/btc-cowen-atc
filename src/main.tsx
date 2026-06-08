import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AppRouter } from "./AppRouter";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
