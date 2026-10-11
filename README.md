# @himetrica/errorkit

Error tracking for the browser, React, Node.js and Next.js, by [Himetrica](https://himetrica.com).

Errors are grouped into issues with a readable title, and every issue is tied to the visitor and session that hit it, so you see who was affected, what they did before the error, and how much revenue those customers represent.

ErrorKit is built to stay cheap and quiet: an error is sent in full once per session, repeats are folded into counters, and known noise (browser extensions, cross-origin `Script error.`, ResizeObserver warnings) is dropped before it leaves the browser.

## Install

```bash
npm install @himetrica/errorkit
```

## Browser

```ts
import { init } from "@himetrica/errorkit";

init({
  apiKey: "hm_...", // your project's public API key
  release: "web@1.4.2",
  environment: "production",
});
```

That's it: uncaught errors, unhandled promise rejections and errors thrown inside timers and event listeners are captured. If the Himetrica tracker is on the page, errors are linked to the same visitor and session automatically.

Capture something yourself:

```ts
import { captureException, captureMessage, setTag, setUser } from "@himetrica/errorkit";

try {
  await checkout();
} catch (err) {
  captureException(err, { tags: { step: "checkout" } });
}

captureMessage("Payment provider slow", "warning");
setTag("plan", "pro");
setUser({ id: "user_123" });
```

### Options

| Option | Default | |
| --- | --- | --- |
| `apiKey` | required | Project public API key |
| `apiUrl` | `https://app.himetrica.com` | Ingest origin |
| `release` | | Version of your app; enables per-release regressions and source maps |
| `environment` | | e.g. `production`, `staging` |
| `sampleRate` | `1` | 0..1, share of errors sent |
| `beforeSend` | | `(event) => event \| null`, edit or drop an event |
| `ignoreErrors` | | Messages to drop (string or RegExp) |
| `denyUrls` | | Script URLs whose errors are dropped |
| `captureConsole` | `false` | Also capture `console.error` |
| `wrapBrowserApis` | `true` | Wrap timers and listeners for complete stacks |
| `propagateSession` | `true` | Send the visitor/session to your own API (same origin) so backend errors join the same journey |
| `maxPerSession` | `20` | Distinct errors sent in full per session |
| `enabled` | `true` | Turn the SDK off |

## React

```tsx
import { ErrorBoundary } from "@himetrica/errorkit/react";

<ErrorBoundary fallback={({ error, reset }) => <button onClick={reset}>Try again</button>}>
  <App />
</ErrorBoundary>;
```

`useErrorKit()` returns `captureException` and `captureMessage` for components.

## Script tag

```html
<script
  src="https://unpkg.com/@himetrica/errorkit/dist/errorkit.global.js"
  data-api-key="hm_..."
  data-release="web@1.4.2"
  data-environment="production"
></script>
```

## Node.js

```ts
import { init, errorKitExpress } from "@himetrica/errorkit/node";

init({ secretKey: process.env.HIMETRICA_SECRET_KEY!, release: "api@2.0.1", environment: "production" });

app.use(errorKitExpress.requestHandler());
// ...routes
app.use(errorKitExpress.errorHandler());
```

Uncaught exceptions and unhandled rejections are captured. Framework handlers only report server errors (5xx or errors without a status). Hono (`errorKitHono()`) and Fastify (`errorKitFastify(app)`) are supported too. Use your project's **secret** key (`hm_sk_...`) on the server, never in the browser.

## Next.js

```ts
// instrumentation.ts
import { register as registerErrorKit, onRequestError } from "@himetrica/errorkit/next";

export function register() {
  registerErrorKit(); // reads HIMETRICA_SECRET_KEY, VERCEL_ENV, VERCEL_GIT_COMMIT_SHA
}

export { onRequestError };
```

Works on the Node.js and Edge runtimes. For the browser side, call `init` from `@himetrica/errorkit` in a client component.

## Source maps

Upload your source maps with [`@himetrica/errorkit-build`](https://www.npmjs.com/package/@himetrica/errorkit-build) so stack traces show your original code instead of minified bundles.

## License

Apache-2.0
