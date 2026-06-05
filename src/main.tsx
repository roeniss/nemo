import { render } from "preact";
import App from "./App";
import "./styles.css";

render(<App />, document.getElementById("root")!);

// register the service worker (production only) for offline shell + install
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
