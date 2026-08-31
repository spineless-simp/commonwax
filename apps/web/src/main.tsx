import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ArtistLogoProvider } from "./artistLogos";
import { PlayerProvider } from "./player";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><PlayerProvider><ArtistLogoProvider><App /></ArtistLogoProvider></PlayerProvider></StrictMode>
);
