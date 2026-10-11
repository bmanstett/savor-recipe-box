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

## Using Savor on an iPhone

Savor is designed to be installed from Safari with **Share → Add to Home Screen**. The installed app opens full-screen, works offline, and keeps its own sign-in to the private data repository.

- **Saving a recipe from another app** (NYT Cooking, Instagram, Safari, any food blog): tap Share in that app, choose **Copy Link**, open Savor, tap **+ → Start from a link**, then tap **Paste**. Savor reads the public page through the private data repository and opens an editable review before anything is saved. The link stays attached to the recipe and is one tap away from the recipe page and from cooking mode. Links without a scheme (`cooking.nytimes.com/…`) and `http://` links are repaired automatically. On Android and desktop Chrome, Savor also appears directly in the system share sheet.
- **When a page cannot be read automatically** (private Instagram posts, recipes that live only in a video, pages behind a sign-in), paste the caption or recipe text, or attach screenshots; the original link is still kept.
- **Back gesture**: the iPhone edge swipe (and the Android back button) closes the open recipe, cooking mode, sheet, or settings instead of leaving the app.
- **Cooking mode** opens on the current step with the ingredient list one tap away, remembers which step you were on for half a day, keeps the screen awake on request, and runs its kitchen timer by the clock so it stays correct after switching apps.
- Settings open by themselves only on the very first launch or when the saved GitHub token needs replacing.

## Grocery list

- The list is built from the week's planned meals (**Refresh from meal plan**) or added to from any recipe (**Add these ingredients to groceries**, which merges into the existing rows instead of replacing them). Rows keep their ids and checked state across refreshes.
- Tap a row to check it off; it settles for a moment and then moves to **In the cart** at the bottom. Tap it there to put it back. A list option keeps checked items in place instead.
- The ⋯ button on a row shows which recipes need it, lets you move it to another aisle, mark it as something you usually have (it becomes a pantry staple and leaves future lists), or remove it.
- Water, ice, and trace amounts of water ("a splash of water to loosen") never appear on the list. Pantry staples are matched loosely: "freshly ground black pepper", "Pepper", and "salt and pepper to taste" all count as the staples **salt** and **black pepper**. Ranges such as "2–3 cloves garlic" buy for the larger amount, "a pinch of saffron" stays on the list, and tins and cans of the same ingredient combine.
- Aisles follow the store route configured in Settings; sections can be collapsed while shopping.

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

- Any public recipe link works: food blogs, newspaper cooking sites, recipe apps with a public web page, and Instagram posts or reels. The importer is dependency-free Node 20+ (`scripts/process-recipe-imports.mjs`) and only ever fetches public HTTPS pages that resolve to public addresses. Share-tracking parameters (`utm_*`, `igsh`, `fbclid`, `smid`, `sgrp`, `ref`, …) are stripped from the saved source URL, and the link exactly as the app sent it is always listed first in the result's `sourcesChecked`, so the app's check that a result belongs to the link it asked for holds even when the app and the importer strip different parameters.
- Redirects: when a page redirects (a trailing slash, a moved page), the draft's `sourceURL` stays the link that was requested; the final URL is recorded in `sourcesChecked` and on the draft's `sourceLinks` as "Recipe page on <host>" when it differs. Redirects stay on HTTPS: a single `http://` redirect target is retried once as `https://`; a site that insists on plain http fails with "This site only serves an insecure (http) page." Each page fetch runs against an absolute deadline (per hop, DNS included, the timeout is the smaller of the request timeout and the time left), so one slow host cannot consume the whole job.
- Pages are requested with `Accept-Encoding: gzip, br, deflate` and the declared charset (`Content-Type` or `<meta charset>`) is honored. Bodies are read up to 4 MB after decompression (2 MB for the public reader). A larger page is not rejected: reading stops at the cap and whatever arrived is parsed, which is enough because Schema.org data sits in the first few hundred KB; the result only gains a warning (naming the 4 MB or 2 MB cap that was hit) if the recipe turned out incomplete. The first request identifies itself honestly as `SavorRecipeImporter/1.0`; if a site answers that with a 403/406/429/503 or a bot-challenge interstitial, one retry is made with ordinary browser headers, and a page that was readable but merely resembled a challenge is kept if the retry does no better. Nothing is retried past a definitive answer such as a 404.
- Structured data is read in order of reliability: Schema.org `Recipe` JSON-LD (including `@graph`, nested `mainEntity`, Yoast-style graphs whose author and image are separate nodes referenced by `@id`, `HowToSection`/`ItemList` steps, `HowToTip` notes appended to the step before them, HTML-string instructions, named entities such as `&frac12;` and `&eacute;`, IRI and prefixed `@type` values, blocks followed by HTML comments or containing raw control characters), then Schema.org microdata, then the recipe-card markup of common WordPress plugins (WP Recipe Maker, Tasty Recipes, Mediavine Create), then a conservative visible-text parser. Before the text parser runs, the page's `<head>`, navigation, site header, footer, sidebars, forms, comment threads, "related" rails, newsletter and share widgets, cookie banners and ads are dropped (matched by whole id/class tokens, so a WordPress post wrapper tagged `tag-cookies` or a Genesis `content-sidebar-wrap` is kept as content); the page title comes from the first content `<h1>` (including one inside the post's own `<header class="entry-header">`), then `og:title`, then `<title>`, with the site name removed: a part equal to `og:site_name` or to the host name is dropped and otherwise the trailing part after `|`, `-`, `–` or `•` is treated as the suffix; headings such as "Ingredients (Serves 4):", "What you need", "Shopping list", "Procedure" or "Directions" are recognised; "To serve:" and "Serve with:" name ingredient groups; and "Notes"/"Tips"/"Storage" sections become the draft's notes while "Nutrition", "Video", "FAQ", "Comments" and "You might also like" end the method.
- Fallbacks for an ordinary page whose own HTML gave only text or nothing, in order and within the job's request budget: the `<link rel="canonical">` page when it differs, a print view (a `wprm_print`, `?print=` or `/print/` link, or WP Recipe Maker's `/wprm_print/<slug>` guess), the AMP page (`<link rel="amphtml">`), and finally the public Jina Reader for a rendered-text copy, never for publishers known to refuse that reader (Allrecipes, Serious Eats, Simply Recipes, Food & Wine, EatingWell, The Spruce Eats, BHG, Martha Stewart, Southern Living, Real Simple, People). Structured data from any of these views is preferred over page text.
- Hero images: an `https` image URL is only a hotlink, so when the chosen image sits on an ordinary host (never Instagram or Facebook CDNs) it is fetched once within the request budget and, if it is a JPEG, PNG or WebP of at most 600 KB, embedded in the draft as a `data:image/…;base64,` URL, which the app's sync already uploads to a media file. Anything else keeps the URL, and no image problem ever fails an import.
- Paywalled pages are handled honestly. If a page's own structured data marks the recipe as not freely accessible and the public HTML contains no ingredients or steps, the import stops there and is reported as an error that asks the user to open the page in their browser and paste the recipe text into Savor; no alternate view or reader is tried for it. The importer never signs in, bypasses a paywall, or stores credentials for any site, including NYT Cooking; links shared from the NYT Cooking app import normally whenever the public page carries the recipe.
- For a public Instagram link, the importer first reads Instagram's public embed page for the post (`/p/<shortcode>/embed/captioned/`), which carries the full caption and the creator's username without any login. Only if that is unavailable does it fall back to Jina Reader. Recipe links found in the caption, plus a bounded set of creator links, including link-in-bio pages such as Linktree, are then checked, ranked by how well they match the recipe title in the caption. Meta's own boilerplate links (meta.com, facebook.com, threads.com, help.instagram.com, app-store links, …) and generic video, audio and social hosts (YouTube, Vimeo, muse.ai, Spotify, Apple Podcasts, TikTok, …) are never crawled. The submitted public URL is the only thing sent to the reader, with its do-not-track option; the GitHub token and household data are never sent anywhere.
- Every Instagram import keeps its links: the draft's `sourceLinks` list holds the original post, the creator profile when known, and the full recipe page when one was used, so the links stay available while cooking. `sourcesChecked` on the result remains the diagnostic list of everything the importer actually fetched; a page the request budget never allowed is not listed.
- Savor does not sign into Instagram, bypass private or blocked content, read unrelated posts, or claim to transcribe reel video/audio. When a recipe exists only in the video, a private post, or an inaccessible comment, the app falls back to a pasted caption/creator comment or user-provided screenshots.
- Imported fields are never silently saved. Title, ingredients, instructions, attribution, and every source checked remain visible and user-correctable first. Ingredient lines carry extra hints for the grocery list (`quantityMax` for ranges such as "2 or 3 tablespoons", `approximate`, `toTaste`, `skipGrocery` for water and trace amounts such as "a splash of water", and a `note` for parentheticals and size adjectives such as "3–5 lb" from "One 3- to 5-pound chuck roast"). The grocery aisle (`groceryCategory`) comes from an ordered aisle table in which specific items beat generic words, so olive oil is a condiment, green beans and fresh chiles are produce, and anything measured in a can or jar is shelved as such.
- Every result file carries `version: 1` (envelope format) and `importerVersion` (the importer build that produced it, currently `"2"`) on every shape: success, partial, error and invalid request. Every field is clamped to the limits the app validates (title 1 000 characters, description 20 000, at most 500 ingredients and 500 steps, 20 source links, 50 warnings), so a verbose page cannot void its own import.
- The Action processes requests oldest-first, up to `max-jobs` per run and within a `max-run-minutes` wall-clock budget (default 15 minutes); requests it did not start are reported as `deferred` and picked up by the next run. The example workflow commits and pushes whatever results exist even if the importer step fails, and `scripts/process-recipe-imports.mjs` refuses to run on Node older than 20.

Run `node scripts/process-recipe-imports.test.mjs` to exercise the importer against the synthetic fixtures under `scripts/fixtures/`.

After a successful import the app deletes both the request file and its result file from the private repository. Deleted files still exist in that repository's Git history until the repository is rewritten or removed; remove the repository if the household wants to erase its complete private import history.
