# Savor

Savor is a local-first household cookbook, meal planner, grocery list, and cooking companion. The app is a static React PWA hosted on GitHub Pages; private household data syncs through a separate private GitHub repository.

## Local development

```bash
pnpm install
pnpm dev
```

Run `pnpm lint`, `pnpm test:domain`, and `pnpm build` before publishing.

## Private sync setup

1. Create a separate **private** repository named `savor-data`.
2. Create one fine-grained personal access token per device.
3. Give each token access to only `savor-data`, with **Contents: read and write**. Do not grant the token access to this Pages repository.
4. Open Savor settings and enter the repository owner, repository name, and token.

The token stays only in memory for the open page and is never committed, backed up, written to browser storage, or cached by the service worker. Reloading or closing the page requires reconnecting with that device's token. The public Pages bundle contains no recipes or household credentials beyond the bundled demo cookbook.

GitHub stores synchronized state at `savor/v1/state.json` and compressed photos under `savor/v1/media/` in the private data repository.

## Skylight and grocery printing

- Add the Calendar's `@ourskylight.com` device email in **Household settings → Skylight Sidekick**. From the meal planner, **Send week to Skylight** opens a prepared email draft; the user reviews and sends it. Native menu imports require Skylight Calendar Plus.
- **Print list** on the grocery screen opens the browser print dialog with a clean, store-section-ordered layout. The current **Hide checked** setting controls which items are included.
