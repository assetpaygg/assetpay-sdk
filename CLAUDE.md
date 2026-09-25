# CLAUDE.md

`@assetpay/assetpay-sdk`: the TypeScript Node SDK for the AssetPay public API (`https://api.assetpay.gg/docs/public`). The API lives in the sibling repo `../assetpay-api`; read its controllers and DTOs before changing a wire shape here.

## Commands

```bash
pnpm build             # tsdown -> dist/
pnpm typecheck         # tsc over src and test, including the spec drift checks
pnpm lint              # biome check .
pnpm test              # unit tier: MockAgent, plus a loopback socket.io server for realtime
pnpm test:integration  # staging smoke, needs ASSETPAY_TEST_API_KEY
pnpm check:package     # build + publint + attw
pnpm spec:pull         # refresh openapi.json from the public spec and regenerate its types
pnpm spec:types        # regenerate test/contract/openapi.d.ts from openapi.json
```

## Layout

- `src/client.ts` builds the modules from one `HttpClient`; `asClient()` rebinds the same modules to a `ClientSession`.
- `src/internal/http.ts` is the only place that touches undici. Retry policy is the pure `classify()`.
- `src/internal/token.ts` mints and decodes client JWTs. It must stay byte-compatible with `ClientAuthService.signClientToken` in the API.
- `src/webhooks.ts` must never import undici or anything that does: `@assetpay/assetpay-sdk/webhooks` is for webhook-only services.
- `src/realtime.ts` is the `./realtime` subpath. It never imports undici, and loads `socket.io-client` (an optional peer) with a dynamic import so a missing peer is a typed error. API keys only.
- `src/modules/*` are one file per API domain. Merchant and client scopes that differ get two classes in the same file.
- `src/types/*` are hand-written wire types. No supplier or backing-market names anywhere in types, errors or docs.
- `test/contract/drift.ts` compares them with `openapi.d.ts` (generated, never edited): key sets both ways, widened value types, and exact enums where the spec has them. A failure names the path, e.g. `spec only: .items[].foo`.

## Invariants

- A trade-creating POST (`sell`, `buy`, `quickBuy`, `deposit`, `withdraw`, `quickWithdraw`) is retried only after a connect-phase failure or a refusal key. Anything else that may have reached the server throws with `ambiguous: true`. Changing that can buy or deposit twice.
- `crypto.withdraw` sends the same body `requestId` on every attempt.
- `reconcile` resends a trade-creating POST once, and only when it failed ambiguously and carries an `externalId`; the server's `(merchantId, externalId)` unique index is what makes that safe. If neither the resend nor the lookup yields a trade, the original ambiguous error is thrown.
- Locally minted tokens always carry `exp`, at most 24h.
- Webhook approvals are classified by body alone, so an approval can never be read as a plain event and acknowledged with a 2xx.
- `test/unit/spec.test.ts` fails when the public spec gains, loses or moves an operation. Fix the SDK, not the test.

## Style

- Single quotes, semicolons, LF, 100 columns (biome).
- Default to zero comments. One short line only when the why is not obvious. No JSDoc blocks.
- Tests explain why an invariant matters in a comment above the case; that is the one place longer comments belong.
- Fakes stand in for the network only (undici `MockAgent`). Never re-implement SDK logic in a test.
- No em-dashes in README prose.

## Releasing

Never publish, tag or push without being asked. Releases go through the `Publish to npm` workflow on a GitHub release (npm trusted publishing with provenance). The package is `@assetpay/assetpay-sdk`; 0.1.0 was published by hand because npm only accepts a trusted publisher on a package that already exists.
