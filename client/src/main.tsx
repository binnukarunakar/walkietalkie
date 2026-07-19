import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { App } from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    {/* reducedMotion="user": every Framer animation collapses to opacity-only
        when the OS asks for reduced motion — one switch, whole app. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
