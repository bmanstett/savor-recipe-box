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

The token is saved in that device's browser storage so reloads, closing the app, and normal app updates do not require another login. It is stored separately from household data and is never committed, backed up, synchronized to GitHub, or cached by the service worker. Savor removes a saved credential when GitHub reports that it is invalid or cannot access the configured repository, when GitHub sync is disconnected, or when the app's site data is deleted. The public Pages bundle contains no recipes or household credentials beyond the bundled demo cookbook.

Because Savor is a static web app, the saved token is readable by code running on Savor's origin rather than protected by an OS keychain or an HttpOnly cookie. Keep each token limited to the private data repository, use a separate token per device, and revoke a device's token from GitHub if that device is lost.

GitHub stores synchronized state at `savor/v1/state.json` and compressed photos under `savor/v1/media/` in the private data repository.

Link imports also require `.github/workflows/savor-recipe-import.yml` in that private repository. Copy [`scripts/savor-data-recipe-import.yml.example`](scripts/savor-data-recipe-import.yml.example), replace its importer placeholder with the full commit SHA being deployed, and change `main` if the private repository uses another default branch. The workflow runs with `contents: write` only and invokes the importer from this public app repository at that pinned commit. The device token still needs only **Contents: read and write**; it does not need Actions, Workflows, or access to the public app repository.

## Skylight and grocery printing

- Add the Calendar's `@ourskylight.com` device email in **Household settings → Skylight Sidekick**. From the meal planner, **Send week to Skylight** opens a prepared email draft; the user reviews and sends it. Gmail is the per-device default, and the review dialog or household settings can switch future drafts to the device's default mail app. Native menu imports require Skylight Calendar Plus.
- **Print list** on the grocery screen opens the browser print dialog with a clean, store-section-ordered layout. The current **Hide checked** setting controls which items are included.

## Meal planning and prep optimization

- Every planning flow asks whether a recipe is for **Breakfast**, **Lunch**, **Snack**, or **Dinner**.
- Checking off a grocery item records its purchase time. **Optimize week** uses those timestamps and conservative ingredient-storage categories to suggest which planned meals belong earlier in the week.
- Optimization is preview-only until the user chooses **Apply suggested days**. It never changes meal types or silently rearranges the plan.
- **Prep** is a separate, recipe-linked Sunday quick reference based on the dates currently saved in the planner. Lunches are treated as Sunday meal prep, with later portions flagged for freezing when appropriate.

Freshness guidance is intentionally conservative. Package dates, refrigerator temperature, visible spoilage, and official food-safety guidance always take precedence over the optimizer.

## Recipe and Instagram link imports

Because GitHub Pages is static, Savor uses the private data repository as an asynchronous import queue. The app writes a small request under `savor/v1/imports/requests/`, a private GitHub Action processes it, and the app polls `savor/v1/imports/results/` before opening the normal editable review screen.

- Ordinary recipe pages are read directly by the Action. Schema.org `Recipe` JSON-LD is preferred; a conservative text parser is used only when structured data is absent.
- For a public Instagram link, the Action uses Jina Reader to inspect public page text, creator attribution, and a bounded set of relevant creator/recipe links — including common link-in-bio pages (Linktree and similar) found on the creator's profile. Candidate links are prioritized by how well they match the recipe title in the caption so the crawl budget is spent on the right page. The submitted public URL is sent to that reader with its do-not-track option; the GitHub token and household data are never sent there.
- Savor does not sign into Instagram, bypass private or blocked content, read unrelated posts, or claim to transcribe reel video/audio. When a recipe exists only in the video, a private post, or an inaccessible comment, the app falls back to a pasted caption/creator comment or user-provided screenshots.
- Imported fields are never silently saved. Title, ingredients, instructions, attribution, and every source checked remain visible and user-correctable first.

Import request and result files live in the private repository and therefore remain in its Git history. Remove that repository if the household wants to erase its complete private import history.
