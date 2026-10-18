import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { App } from "./App.tsx";
import { Providers } from "./ui.tsx";
import { BrandProvider } from "./brand.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <BrandProvider>
        <Providers>
          <App />
        </Providers>
      </BrandProvider>
    </BrowserRouter>
  </StrictMode>,
);
