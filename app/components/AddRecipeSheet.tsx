'use client';

import {
  AlertCircle, ArrowLeft, Camera, CheckCircle2, ClipboardPaste, FileImage,
  ExternalLink, Instagram, Link2, LoaderCircle, PenLine, ScanLine, Upload, X,
} from 'lucide-react';
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { createBlankDraft, isIngredientSectionHeading, makeId, parseIngredientLine, parseRecipeText } from '../../lib/domain';
import type { ImportRecipeUrl } from '../../lib/github-import-queue';
import { prepareRecipeImage } from '../../lib/image-processing';
import { parseRecipeSourceUrl, type RecipeSourceUrl } from '../../lib/recipe-source';
import type { Attachment, ImportResult, Ingredient, Instruction, Recipe, RecipeDraft, RecipeSourceLink } from '../../lib/types';

type ReviewInput = { draft: RecipeDraft; warnings: string[]; provider: ImportResult['provider'] | 'manual'; sourcesChecked?: RecipeSourceLink[] };

// Hosts that an older importer recorded as "sources checked" because they sit
// in Instagram's page footer. They are never where a recipe lives.
const BOILERPLATE_HOSTS = /(?:^|\.)(?:meta\.com|meta\.ai|facebook\.com|fb\.com|threads\.net|threads\.com|whatsapp\.com|messenger\.com|oculus\.com|apple\.com|google\.com)$/i;

function recipeToDraft(recipe: Recipe): RecipeDraft {
  const draft = { ...recipe };
  for (const key of ['dateAdded', 'dateModified', 'lastCooked', 'timesCooked', 'revision', 'deletedAt'] as const) {
    Reflect.deleteProperty(draft, key);
  }
  return draft;
}

function isSectionLine(line: string): boolean {
  return /:$/.test(line) && !/^\d/.test(line) && line.length <= 60 && !/^https?:/i.test(line);
}

// Ingredient and step lists are edited as plain text. Section headings travel
// as lines ending in ":" so an imported "For the sauce:" survives a round trip;
// a bare "Ingredients:" or "Steps:" heading returns to no section.
export function ingredientsToText(list: Ingredient[]): string {
  const lines: string[] = [];
  let section: string | null = null;
  for (const ingredient of list) {
    const next = ingredient.section ?? null;
    if (next !== section) {
      section = next;
      lines.push(section ? `${section}:` : 'Ingredients:');
    }
    lines.push(ingredient.rawText);
  }
  if (lines[0] === 'Ingredients:') lines.shift();
  return lines.join('\n');
}

export function ingredientsFromText(value: string): Ingredient[] {
  let section: string | null = null;
  return value.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    if (isSectionLine(line) || isIngredientSectionHeading(line)) {
      const name = line.replace(/:$/, '').trim();
      section = /^ingredients?$/i.test(name) ? null : name;
      return [];
    }
    return [parseIngredientLine(line, section)];
  });
}

export function instructionsToText(list: Instruction[]): string {
  const lines: string[] = [];
  let section: string | null = null;
  list.forEach((step, index) => {
    const next = step.section ?? null;
    if (next !== section) {
      section = next;
      lines.push(section ? `${section}:` : 'Steps:');
    }
    lines.push(`${index + 1}. ${step.text}`);
  });
  if (lines[0] === 'Steps:') lines.shift();
  return lines.join('\n');
}

export function instructionsFromText(value: string): Instruction[] {
  let section: string | null = null;
  const steps: Instruction[] = [];
  for (const raw of value.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (isSectionLine(line) && !/^\d+[.)]/.test(line)) {
      const name = line.slice(0, -1).trim();
      section = /^(?:steps?|instructions?|directions?|method)$/i.test(name) ? null : name;
      continue;
    }
    const text = line.replace(/^(?:step\s*)?\d+[.):]\s*/i, '').replace(/^[-•*]\s*/, '');
    if (!text) continue;
    steps.push({
      id: makeId('step'), stepNumber: steps.length + 1, section, text,
      timerMinutes: Number(text.match(/\b(\d+)\s+minutes?\b/i)?.[1] ?? '') || null,
    });
  }
  return steps;
}

function firstUrlIn(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"'’”)\]]+/i);
  return match ? match[0].replace(/[.,;:!?]+$/, '') : null;
}

function usefulSourceLinks(links: RecipeSourceLink[] | undefined): RecipeSourceLink[] | undefined {
  if (!links?.length) return undefined;
  const kept = links.filter((link) => {
    try {
      return !BOILERPLATE_HOSTS.test(new URL(link.url).hostname);
    } catch {
      return false;
    }
  });
  return kept.length ? kept.map((link) => ({ ...link })) : undefined;
}

function providerLabel(provider: ImportResult['provider'] | 'manual'): string {
  switch (provider) {
    case 'schema-org':
    case 'microdata': return 'Structured page data';
    case 'linked-recipe': return 'Linked recipe page';
    case 'instagram-caption': return 'Public Instagram caption';
    case 'public-reader': return 'Public page text';
    case 'text-parser': return 'Parsed recipe text';
    case 'manual-photo': return 'Original image preserved';
    default: return 'Manual recipe';
  }
}

export function AddRecipeSheet({ initialRecipe, initialUrl = null, initialMode = 'choose', canImportLinks, onClose, onSave, onImportRecipeUrl, onOpenSettings }: {
  initialRecipe: Recipe | null;
  initialUrl?: string | null;
  initialMode?: 'choose' | 'link' | 'paste' | 'manual';
  canImportLinks: boolean;
  onClose: () => void;
  onSave: (draft: RecipeDraft) => Promise<void>;
  onImportRecipeUrl: ImportRecipeUrl;
  onOpenSettings?: () => void;
}) {
  const startManually = !initialRecipe && initialMode === 'manual';
  const [phase, setPhase] = useState<'source' | 'review'>(initialRecipe || startManually ? 'review' : 'source');
  const [draft, setDraft] = useState<RecipeDraft>(() => initialRecipe ? recipeToDraft(initialRecipe) : createBlankDraft(startManually ? 'manual' : 'manual'));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [provider, setProvider] = useState<ImportResult['provider'] | 'manual'>('manual');
  const [url, setUrl] = useState(initialUrl ?? '');
  const [pastedText, setPastedText] = useState('');
  const [mode, setMode] = useState<'choose' | 'link' | 'paste'>(initialUrl ? 'link' : initialMode === 'link' || initialMode === 'paste' ? initialMode : 'choose');
  const errorRef = useRef<HTMLDivElement>(null);
  // The link the household started from. It is kept on the recipe even when
  // automatic extraction fails and the text is pasted, a screenshot attached,
  // or the recipe typed by hand, so the original is always one tap away.
  const [pendingSource, setPendingSource] = useState<RecipeSourceUrl | null>(null);
  const [keepSource, setKeepSource] = useState(true);
  const [importFailed, setImportFailed] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [importStage, setImportStage] = useState<'queued' | 'reading' | 'structuring' | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; recovery?: string[] } | null>(null);
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const [ingredientText, setIngredientText] = useState(() => ingredientsToText(draft.ingredients));
  const [instructionText, setInstructionText] = useState(() => instructionsToText(draft.instructions));
  const fileRef = useRef<HTMLInputElement>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const autoStarted = useRef(false);
  const canReadClipboard = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !processing && !saving) onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, processing, saving]);

  useEffect(() => () => importAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!processing) { setElapsed(0); return undefined; }
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, [processing]);

  // A link shared into Savor (share sheet or shortcut) starts extracting on
  // its own; the person already chose it, so no second tap is needed.
  useEffect(() => {
    if (!initialUrl || autoStarted.current) return undefined;
    autoStarted.current = true;
    rememberLink(initialUrl);
    if (canImportLinks) void runImport(initialUrl);
    // StrictMode mounts twice in development: the unmount cleanup aborts the
    // first attempt, so the guard is released to let the remount start again.
    return () => { autoStarted.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl, canImportLinks]);

  // Whatever route the person takes after typing or sharing a link (paste,
  // screenshots, manual entry, settings), the link travels with the recipe.
  function rememberLink(value = url) {
    const source = parseRecipeSourceUrl(value);
    if (!source) return;
    setPendingSource(source);
    setKeepSource(true);
  }

  function openReview(result: ReviewInput) {
    const importedLinks = usefulSourceLinks(result.draft.sourceLinks) ?? usefulSourceLinks(result.sourcesChecked);
    const importedDraft = importedLinks ? { ...result.draft, sourceLinks: importedLinks } : { ...result.draft, sourceLinks: undefined };
    setDraft(importedDraft);
    setWarnings(result.warnings);
    setProvider(result.provider);
    setIngredientText(ingredientsToText(importedDraft.ingredients));
    setInstructionText(instructionsToText(importedDraft.instructions));
    setPhase('review');
    setMode('choose');
    setError(null);
  }

  function applyPendingSource(target: RecipeDraft): RecipeDraft {
    if (!pendingSource || !keepSource) return target;
    const next = { ...target };
    next.sourceType = 'url';
    next.sourceURL ||= pendingSource.href;
    next.sourceName ||= pendingSource.sourceName;
    if (pendingSource.kind === 'instagram' && !next.sourceLinks?.some((link) => link.url === pendingSource.href)) {
      next.sourceLinks = [{ kind: 'instagram-post', url: pendingSource.href, label: 'Original Instagram post' }, ...(next.sourceLinks ?? [])];
    }
    return next;
  }

  async function runImport(rawUrl: string) {
    setProcessing(true);
    setError(null);
    setImportFailed(false);
    const source = parseRecipeSourceUrl(rawUrl);
    try {
      if (!source) throw new Error('unsupported');
      setPendingSource(source);
      setKeepSource(true);
      const controller = new AbortController();
      importAbortRef.current?.abort();
      importAbortRef.current = controller;
      const result = await onImportRecipeUrl(source.href, {
        signal: controller.signal,
        onProgress: (stage) => setImportStage(stage),
      });
      const nextDraft = { ...result.draft };
      nextDraft.sourceType = 'url';
      nextDraft.sourceURL ||= source.href;
      nextDraft.sourceName ||= source.sourceName;
      openReview({ ...result, draft: nextDraft });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const message = caught instanceof Error && caught.message !== 'unsupported'
        ? caught.message
        : 'Enter a complete link that starts with https://';
      setImportFailed(Boolean(source));
      setError({
        message,
        recovery: source ? [
          source.kind === 'instagram'
            ? 'Open the post, copy the caption or the creator’s recipe comment, and paste it here. The post link stays attached.'
            : 'Open the page, copy the recipe text, and paste it here. The link stays attached.',
        ] : undefined,
      });
    } finally {
      importAbortRef.current = null;
      setImportStage(null);
      setProcessing(false);
    }
  }

  async function importLink(event: FormEvent) {
    event.preventDefault();
    await runImport(url);
  }

  async function pasteLinkFromClipboard() {
    setClipboardNote(null);
    try {
      const text = await navigator.clipboard.readText();
      const found = firstUrlIn(text);
      if (!found) {
        setClipboardNote('No link was found on the clipboard. Copy the recipe link first, then try again.');
        return;
      }
      setUrl(found);
      setError(null);
    } catch {
      setClipboardNote('Savor could not read the clipboard. Paste the link into the field instead.');
    }
  }

  async function importText(event: FormEvent) {
    event.preventDefault();
    setProcessing(true);
    setError(null);
    try {
      const result = parseRecipeText(pastedText);
      const withSource = applyPendingSource(result.draft);
      if (withSource.sourceURL && pendingSource) {
        result.warnings.unshift(`${pendingSource.kind === 'instagram' ? 'The Instagram post link' : 'The original link'} stays attached to this recipe.`);
      }
      openReview({ ...result, draft: withSource, provider: 'text-parser' });
    } catch {
      setError({ message: 'Savor could not structure the pasted recipe.', recovery: ['Try again or create the recipe manually.'] });
    } finally { setProcessing(false); }
  }

  async function uploadPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    setProcessing(true);
    setError(null);
    try {
      const attachments: Attachment[] = [];
      for (const file of files.slice(0, 8)) {
        const prepared = await prepareRecipeImage(file);
        attachments.push({
          id: makeId('attachment'),
          type: 'original-photo' as const,
          url: prepared.dataUrl,
          mimeType: prepared.mimeType,
          originalFilename: file.name || (prepared.mimeType === 'image/jpeg' ? 'recipe-photo.jpg' : 'recipe-photo.webp'),
          captureDate: new Date().toISOString(),
        });
      }
      const photoWarning = 'Original image compressed and preserved. Review and transcribe the visible recipe before saving.';
      if (phase === 'review') {
        // The text boxes hold the person's edits; only the images change here.
        setDraft((current) => ({
          ...current,
          attachments: [...current.attachments, ...attachments],
          heroImage: current.heroImage ?? attachments[0]?.url ?? null,
        }));
        setWarnings((current) => [...new Set([...current, photoWarning])]);
        return;
      }
      const next = applyPendingSource(createBlankDraft('photo'));
      next.attachments = [...next.attachments, ...attachments];
      next.heroImage ||= attachments[0]?.url ?? null;
      openReview({ draft: next, provider: 'manual-photo', warnings: [photoWarning] });
    } catch (caught) {
      setError({
        message: caught instanceof Error ? caught.message : 'The image could not be uploaded.',
        recovery: ['Try a JPEG, PNG, WebP, or HEIC photo, or a smaller crop.'],
      });
    } finally {
      setProcessing(false);
      event.target.value = '';
    }
  }

  function startManual() {
    openReview({ draft: applyPendingSource(createBlankDraft('manual')), warnings: [], provider: 'manual' });
  }

  function update<K extends keyof RecipeDraft>(key: K, value: RecipeDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function failSave(message: string) {
    setError({ message });
    window.requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }

  async function save() {
    // Lines that were not edited keep their ids, so grocery contributions and
    // other references to an ingredient survive a plain edit of the recipe.
    // Each previous id is handed out once, so two identical lines never share one.
    const bucket = <T,>(rows: T[], keyOf: (row: T) => string) => {
      const buckets = new Map<string, T[]>();
      for (const row of rows) buckets.set(keyOf(row), [...(buckets.get(keyOf(row)) ?? []), row]);
      return buckets;
    };
    const ingredientKey = (item: Pick<Ingredient, 'section' | 'rawText'>) => `${item.section ?? ''}\u0000${item.rawText}`;
    const previousIngredients = bucket(draft.ingredients, ingredientKey);
    const previousSteps = bucket(draft.instructions, (item) => item.text);
    const ingredients = ingredientsFromText(ingredientText).map((item) => {
      const match = previousIngredients.get(ingredientKey(item))?.shift();
      return match ? { ...item, id: match.id } : item;
    });
    const instructions = instructionsFromText(instructionText).map((item) => {
      const match = previousSteps.get(item.text)?.shift();
      return match ? { ...item, id: match.id, timerMinutes: match.timerMinutes ?? item.timerMinutes } : item;
    });
    const sourceURL = draft.sourceURL?.trim() || null;
    const parsedSource = sourceURL ? parseRecipeSourceUrl(sourceURL) : null;
    if (sourceURL && !parsedSource) {
      failSave('The source link must be a complete web address, like https://example.com/recipe');
      return;
    }
    const next: RecipeDraft = { ...draft, ingredients, instructions, sourceURL: parsedSource?.href ?? null, title: draft.title.trim() };
    if (next.sourceURL && next.sourceType === 'manual') next.sourceType = 'url';
    if (!next.title) { failSave('Give this recipe a title before saving.'); return; }
    if (!ingredients.length && !instructions.length) { failSave('Add at least one ingredient or instruction before saving.'); return; }
    setSaving(true);
    setError(null);
    try { await onSave(next); } finally { setSaving(false); }
  }

  const reviewCount = ingredientsFromText(ingredientText).filter((item) => item.needsReview).length;
  const headerTitle = phase === 'review'
    ? (initialRecipe ? 'Edit recipe' : 'Review recipe')
    : mode === 'link' ? 'Import from a link' : mode === 'paste' ? 'Paste recipe text' : 'Add a recipe';
  const headerSubtitle = phase === 'review'
    ? 'Everything stays structured and user-correctable.'
    : mode === 'link' ? 'Food blogs, NYT Cooking, Instagram.'
      : mode === 'paste' ? 'Headings like Ingredients and Method help keep the structure.'
        : 'Choose the easiest way to bring it into your cookbook.';
  const stageCopy = importStage === 'queued'
    ? 'Sending the request to your private repository.'
    : importStage === 'structuring'
      ? 'The result is ready; checking its recipe fields.'
      : elapsed > 45
        ? 'Still working. GitHub sometimes takes a minute to start the private importer.'
        : 'Waiting for the private GitHub Action to read the public page.';

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !processing && !saving) onClose(); }}>
      <section className={phase === 'review' ? 'add-sheet review-sheet' : 'add-sheet'} role="dialog" aria-modal="true" aria-labelledby="add-recipe-title">
        <header className="sheet-header">
          <div>
            {mode !== 'choose' || (phase === 'review' && !initialRecipe) ? <button className="sheet-back" type="button" disabled={processing || saving} onClick={() => phase === 'review' ? setPhase('source') : setMode('choose')}><ArrowLeft size={17} />Back</button> : <p className="eyebrow">{initialRecipe ? 'Your cookbook' : 'Universal capture'}</p>}
            <h1 id="add-recipe-title">{headerTitle}</h1>
            <p>{headerSubtitle}</p>
          </div>
          <button className="icon-button" aria-label="Close" type="button" disabled={processing || saving} onClick={onClose}><X size={20} /></button>
        </header>

        <div className="sheet-content">
          {phase === 'source' && mode === 'choose' ? (
            <div className="capture-options">
              {error ? <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={error} onPaste={() => { setError(null); setMode('paste'); }} onManual={startManual} /></div> : null}
              <button type="button" onClick={() => setMode('link')}><span className="capture-icon"><Link2 size={21} /></span><span><strong>Start from a link</strong><small>Any recipe page, NYT Cooking, or a public Instagram post</small></span><ArrowLeft className="capture-arrow" size={16} /></button>
              <button type="button" onClick={() => fileRef.current?.click()}><span className="capture-icon"><ScanLine size={21} /></span><span><strong>Photo or screenshot</strong><small>Preserve the original and transcribe it</small></span><ArrowLeft className="capture-arrow" size={16} /></button>
              <button type="button" onClick={() => setMode('paste')}><span className="capture-icon"><ClipboardPaste size={21} /></span><span><strong>Paste recipe text</strong><small>Automatically structures ingredients and steps</small></span><ArrowLeft className="capture-arrow" size={16} /></button>
              <button type="button" onClick={startManual}><span className="capture-icon"><PenLine size={21} /></span><span><strong>Create manually</strong><small>Fast keyboard-first recipe entry</small></span><ArrowLeft className="capture-arrow" size={16} /></button>
              <input ref={fileRef} className="sr-only" type="file" accept="image/*" multiple onChange={uploadPhotos} />
              <aside className="privacy-note"><Camera size={17} /><p><strong>Private by default.</strong> Photos are compressed on this device, then synced only to your private GitHub data repository.</p></aside>
            </div>
          ) : null}

          {phase === 'source' && mode === 'link' ? (
            <form className="capture-form" noValidate onSubmit={importLink}>
              <div className="capture-form-icon"><Link2 size={24} /></div>
              <label className="field-label">Recipe link
                <div className="link-input-row">
                  <input autoFocus={!initialUrl} type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" placeholder="https://" value={url} onChange={(event) => { setUrl(event.target.value); setClipboardNote(null); }} disabled={processing} />
                  {canReadClipboard ? <button className="button button-secondary" type="button" disabled={processing} onClick={pasteLinkFromClipboard}><ClipboardPaste size={16} />Paste</button> : null}
                </div>
                {clipboardNote ? <small>{clipboardNote}</small> : null}
              </label>
              <p className="field-help">From the NYT Cooking app or Instagram, tap Share, choose Copy Link, then come back and tap Paste. Savor reads the public page through your private GitHub repository and opens an editable review before anything is saved.</p>
              {!canImportLinks ? (
                <div className="capture-error" role="status">
                  <AlertCircle size={18} />
                  <div>
                    <strong>Link import needs your private GitHub sync</strong>
                    <p>Savor runs link imports through your private data repository so the public app never needs a server. Connect it in Settings, or paste the recipe text instead.</p>
                    <div>{onOpenSettings ? <button type="button" onClick={() => { rememberLink(); onOpenSettings(); }}>Open settings</button> : null}<button type="button" onClick={() => { rememberLink(); setError(null); setMode('paste'); }}>Paste text instead</button></div>
                  </div>
                </div>
              ) : null}
              {error ? <ErrorBox error={error} onPaste={() => { rememberLink(); setError(null); setMode('paste'); }} onManual={() => { rememberLink(); startManual(); }} onPhotos={() => { rememberLink(); fileRef.current?.click(); }} openUrl={importFailed ? pendingSource?.href ?? null : null} /> : null}
              <input ref={fileRef} className="sr-only" type="file" accept="image/*" multiple onChange={uploadPhotos} />
              <aside className="privacy-note"><Instagram size={17} /><p><strong>Public pages only.</strong> Savor never signs in to a site, never bypasses a login or paywall, and never sends your GitHub token anywhere except GitHub. If a page keeps its recipe behind a sign-in, paste the text instead.</p></aside>
              {processing ? <div className="import-progress" role="status" aria-live="polite"><span>{stageCopy}</span><button className="button button-ghost" type="button" onClick={() => importAbortRef.current?.abort()}>Cancel</button></div> : null}
              <button className="button button-primary full-button" type="submit" disabled={processing || !url.trim() || !canImportLinks}>{processing ? <><LoaderCircle className="spin" size={17} />{importStage === 'queued' ? 'Queued in GitHub…' : importStage === 'structuring' ? 'Structuring recipe…' : `Reading the page… ${elapsed ? `${elapsed}s` : ''}`}</> : 'Extract recipe'}</button>
            </form>
          ) : null}

          {phase === 'source' && mode === 'paste' ? (
            <form className="capture-form paste-form" onSubmit={importText}>
              <div className="capture-form-icon">{pendingSource?.kind === 'instagram' ? <Instagram size={24} /> : <ClipboardPaste size={24} />}</div>
              {pendingSource && importFailed ? (
                <div className="capture-error" role="status">
                  <AlertCircle size={18} />
                  <div>
                    <strong>Automatic extraction needs a little help</strong>
                    <p>{pendingSource.kind === 'instagram'
                      ? 'Private or blocked posts, and recipes shown only in the video, cannot be read automatically. Open the post, copy the caption or the creator’s recipe comment, and paste it below.'
                      : 'This page did not expose its recipe to the importer. Open it, copy the recipe text, and paste it below.'}</p>
                    <div><a className="button button-secondary" href={pendingSource.href} target="_blank" rel="noreferrer">Open the {pendingSource.kind === 'instagram' ? 'post' : 'page'}<ExternalLink size={13} /></a></div>
                  </div>
                </div>
              ) : null}
              {pendingSource ? (
                <div className="field-label">
                  <span>Original link</span>
                  <button className="button button-secondary full-button source-keep-toggle" type="button" aria-pressed={keepSource} onClick={() => setKeepSource((current) => !current)}>
                    {keepSource ? <CheckCircle2 size={16} /> : <Link2 size={16} />}
                    <span>{keepSource ? `Keeping the ${pendingSource.sourceName} link` : 'Link will not be kept'}</span>
                  </button>
                  <small>{pendingSource.href}</small>
                </div>
              ) : null}
              <label className="field-label">{pendingSource?.kind === 'instagram' ? 'Caption or recipe text' : 'Recipe text'}<textarea autoFocus rows={13} placeholder={pendingSource?.kind === 'instagram' ? 'Copy the recipe caption from Instagram and paste it here…' : 'Chicken Piccata\nServes 4\n\nIngredients\n2 chicken breasts\n½ cup flour\n\nInstructions\n1. Slice the chicken…'} value={pastedText} onChange={(event) => setPastedText(event.target.value)} /></label>
              <p className="field-help">Headings such as Ingredients, Directions, Method, and section names help the parser preserve structure. You can fix anything on the next screen.</p>
              {error ? <ErrorBox error={error} onManual={startManual} /> : null}
              <button className="button button-primary full-button" type="submit" disabled={processing || pastedText.trim().length < 8}>{processing ? <><LoaderCircle className="spin" size={17} />Structuring recipe…</> : 'Review recipe'}</button>
            </form>
          ) : null}

          {phase === 'review' ? (
            <div className="review-layout">
              <aside className="review-preview">
                <div className="review-image">
                  {draft.heroImage ? <img alt="Recipe preview" src={draft.heroImage} /> : <div className="review-image-empty"><FileImage size={28} /><span>Add a finished-dish photo later</span></div>}
                </div>
                {draft.attachments.length ? <div className="attachment-strip">{draft.attachments.map((attachment) => <img alt="Original recipe attachment" src={attachment.url} key={attachment.id} />)}</div> : null}
                <button className="button button-secondary full-button" type="button" onClick={() => fileRef.current?.click()}><Upload size={16} />{draft.attachments.length ? 'Add another page' : 'Attach original image'}</button>
                <input ref={fileRef} className="sr-only" type="file" accept="image/*" multiple onChange={uploadPhotos} />
                <div className="review-status"><CheckCircle2 size={17} /><div><strong>{initialRecipe ? 'Editing a saved recipe' : providerLabel(provider)}</strong><small>{initialRecipe ? (initialRecipe.sourceName ? `Saved from ${initialRecipe.sourceName}` : 'Changes apply when you save') : reviewCount ? `${reviewCount} ingredient${reviewCount === 1 ? ' needs' : 's need'} review` : 'Ready for your review'}</small></div></div>
                {draft.sourceLinks?.length ? <div className="import-sources"><strong>Linked sources</strong>{draft.sourceLinks.map((source) => <a key={`${source.kind}:${source.url}`} href={source.url} target="_blank" rel="noreferrer">{source.label}<ExternalLink size={12} /></a>)}</div> : null}
              </aside>

              <div className="review-form">
                {warnings.length ? <div className="review-warning"><AlertCircle size={18} /><div><strong>Take a quick look</strong>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div> : null}
                <div ref={errorRef}>{error ? <ErrorBox error={error} /> : null}</div>
                <div className="form-section">
                  <div className="form-section-heading"><span>01</span><div><h2>The essentials</h2><p>What you’ll recognize in the cookbook.</p></div></div>
                  <label className="field-label wide-field">Recipe title<input autoFocus={!initialRecipe} value={draft.title} onChange={(event) => update('title', event.target.value)} placeholder="Recipe name" /></label>
                  <label className="field-label wide-field">Description<textarea rows={2} value={draft.description} onChange={(event) => update('description', event.target.value)} placeholder="A short, useful description" /></label>
                  <div className="field-grid four-fields">
                    <label className="field-label">Servings<input type="number" inputMode="numeric" min="1" value={draft.servings ?? ''} onChange={(event) => update('servings', event.target.value ? Number(event.target.value) : null)} /></label>
                    <label className="field-label">Prep minutes<input type="number" inputMode="numeric" min="0" value={draft.prepTime ?? ''} onChange={(event) => update('prepTime', event.target.value ? Number(event.target.value) : null)} /></label>
                    <label className="field-label">Cook minutes<input type="number" inputMode="numeric" min="0" value={draft.cookTime ?? ''} onChange={(event) => update('cookTime', event.target.value ? Number(event.target.value) : null)} /></label>
                    <label className="field-label">Cuisine<input value={draft.cuisine ?? ''} onChange={(event) => update('cuisine', event.target.value || null)} placeholder="Optional" /></label>
                  </div>
                </div>

                <div className="form-section">
                  <div className="form-section-heading"><span>02</span><div><h2>Ingredients</h2><p>One ingredient per line. End a line with “:” to start a section.</p></div></div>
                  <label className="field-label wide-field">Ingredient lines<textarea className="structured-textarea" rows={Math.min(14, Math.max(7, ingredientText.split('\n').length + 1))} value={ingredientText} onChange={(event) => setIngredientText(event.target.value)} placeholder={'Sauce:\n2 tbsp olive oil\n1 medium onion, diced\n½ cup cream'} /></label>
                  {reviewCount ? <p className="confidence-note"><AlertCircle size={14} />{reviewCount} line{reviewCount === 1 ? ' has' : 's have'} an uncertain quantity or an either/or choice. Take a look before saving.</p> : null}
                </div>

                <div className="form-section">
                  <div className="form-section-heading"><span>03</span><div><h2>Instructions</h2><p>One clear step per line.</p></div></div>
                  <label className="field-label wide-field">Cooking steps<textarea className="structured-textarea" rows={Math.min(14, Math.max(7, instructionText.split('\n').length + 1))} value={instructionText} onChange={(event) => setInstructionText(event.target.value)} placeholder={'1. Heat the oven to 425°F.\n2. Season the chicken…'} /></label>
                </div>

                <div className="form-section compact-form-section">
                  <div className="form-section-heading"><span>04</span><div><h2>Remember it</h2><p>Where it came from, tags, and household notes.</p></div></div>
                  <label className="field-label wide-field">Source link<input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={draft.sourceURL ?? ''} onChange={(event) => update('sourceURL', event.target.value || null)} placeholder="https://… (opens from the recipe and from cooking mode)" /></label>
                  <div className="field-grid two-fields">
                    <label className="field-label">Source name<input value={draft.sourceName ?? ''} onChange={(event) => update('sourceName', event.target.value || null)} placeholder="Instagram, NYT Cooking, Grandma’s card" /></label>
                    <label className="field-label">Creator or author<input value={draft.author ?? ''} onChange={(event) => update('author', event.target.value || null)} placeholder="@creator or recipe author" /></label>
                  </div>
                  <label className="field-label wide-field">Tags<input value={draft.tags.join(', ')} onChange={(event) => update('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} placeholder="Weeknight, favorite" /></label>
                  <label className="field-label wide-field">Notes<textarea rows={3} value={draft.notes} onChange={(event) => update('notes', event.target.value)} placeholder="The details your household will want next time" /></label>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {phase === 'review' ? (
          <footer className="sheet-footer"><p>{saving ? 'Saving privately…' : 'Changes are validated before they enter your cookbook.'}</p><div><button className="button button-ghost" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" disabled={saving} onClick={save}>{saving ? <><LoaderCircle className="spin" size={17} />Saving…</> : initialRecipe ? 'Save changes' : 'Save recipe'}</button></div></footer>
        ) : null}
        {processing && mode === 'choose' ? <div className="processing-overlay" role="status"><LoaderCircle className="spin" size={28} /><strong>Preparing your recipe…</strong><span>Keeping the original safely attached.</span></div> : null}
      </section>
    </div>
  );
}

function ErrorBox({ error, onPaste, onManual, onPhotos, openUrl }: {
  error: { message: string; recovery?: string[] };
  onPaste?: () => void;
  onManual?: () => void;
  onPhotos?: () => void;
  openUrl?: string | null;
}) {
  return (
    <div className="capture-error" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>{error.message}</strong>
        {error.recovery?.length ? <p>{error.recovery.join(' ')}</p> : null}
        <div>
          {openUrl ? <a className="button button-secondary" href={openUrl} target="_blank" rel="noreferrer">Open link<ExternalLink size={13} /></a> : null}
          {onPaste ? <button type="button" onClick={onPaste}>Paste text instead</button> : null}
          {onPhotos ? <button type="button" onClick={onPhotos}>Attach screenshots</button> : null}
          {onManual ? <button type="button" onClick={onManual}>Create manually</button> : null}
        </div>
      </div>
    </div>
  );
}
