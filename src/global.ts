// Script-tag build of the browser SDK: dist/errorkit.global.js.
//
//   <script src="https://cdn.../errorkit.global.js"
//           data-api-key="hm_..." data-release="web@1.42.0" data-environment="production"></script>
//
// Exposes window.HimetricaErrorKit (same API as the npm entry) and initializes
// itself from the data attributes of its own <script> tag. Without data-api-key it
// only exposes the API, so the page can call HimetricaErrorKit.init({...}) itself.
// Load it early (in <head>, without defer) to catch startup errors.

import * as ErrorKit from "./index";

declare global {
  interface Window {
    HimetricaErrorKit?: typeof ErrorKit;
  }
}

if (typeof window !== "undefined") {
  window.HimetricaErrorKit = ErrorKit;
  const script = document.currentScript as HTMLScriptElement | null;
  const data = script?.dataset;
  if (data?.apiKey) {
    ErrorKit.init({
      apiKey: data.apiKey,
      apiUrl: data.apiUrl || undefined,
      release: data.release || undefined,
      environment: data.environment || undefined,
      captureConsole: data.captureConsole === "true",
      allowLocalhost: data.allowLocalhost === "true",
    });
  }
}
