'use client';

import {
  AlertCircle, ArrowLeft, Camera, CheckCircle2, ClipboardPaste, FileImage,
  ExternalLink, Instagram, Link2, LoaderCircle, PenLine, ScanLine, Upload, X,
} from 'lucide-react';
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { createBlankDraft, makeId, parseIngredientLine, parseRecipeText } from '../../lib/domain';
import { prepareRecipeImage } from '../../lib/image-processing';
import { parseRecipeSourceUrl } from '../../lib/recipe-source';
import type { ImportResult, Instruction, Recipe, RecipeDraft } from '../../lib/types';

function recipeToDraft(recipe: Recipe): RecipeDraft {
  const draft = { ...recipe };
  for (const key of ['dateAdded', 'dateModified', 'lastCooked', 'timesCooked', 'revision', 'deletedAt'] as const) {
    Reflect.deleteProperty(draft, key);
  }
  return draft;
}

function ingredientsFromText(value: string) {
  let section: string | null = null;
  return value.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    if (line.endsWith(':') && !/^\d/.test(line)) {
      section = line.slice(0, -1);
      return [];
    }
    return [parseIngredientLine(line.replace(/^[-•]\s*/, ''), section)];
  });
}

function instructionsFromText(value: string): Instruction[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const text = line.replace(/^\d+[.)]\s*/, '').replace(/^[-•]\s*/, '');
    return {
      id: makeId('step'), stepNumber: index + 1, section: null, text,
      timerMinutes: Number(text.match(/\b(\d+)\s+minutes?\b/i)?.[1] ?? '') || null,
    };
  });
}

export function AddRecipeSheet({ initialRecipe, onClose, onSave }: {
  initialRecipe: Recipe | null;
  onClose: () => void;
  onSave: (draft: RecipeDraft) => Promise<void>;
}) {
  const [phase, setPhase] = useState<'source' | 'review'>(initialRecipe ? 'review' : 'source');
  const [draft, setDraft] = useState<RecipeDraft>(() => initialRecipe ? recipeToDraft(initialRecipe) : createBlankDraft());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [provider, setProvider] = useState<ImportResult['provider'] | 'manual'>(initialRecipe ? 'manual' : 'manual');
  const [url, setUrl] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [mode, setMode] = useState<'choose' | 'link' | 'paste' | 'instagram'>('choose');
  const [instagramSourceURL, setInstagramSourceURL] = useState<string | null>(null);
  const [keepInstagramSource, setKeepInstagramSource] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; recovery?: string[] } | null>(null);
  const [ingredientText, setIngredientText] = useState(() => draft.ingredients.map((item) => item.rawText).join('\n'));
  const [instructionText, setInstructionText] = useState(() => draft.instructions.map((item) => `${item.stepNumber}. ${item.text}`).join('\n'));
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !processing && !saving) onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, processing, saving]);

  function openReview(result: ImportResult | { draft: RecipeDraft; warnings: string[]; provider: 'manual' }) {
    setDraft(result.draft);
    setWarnings(result.warnings);
    setProvider(result.provider);
    setIngredientText(result.draft.ingredients.map((item) => item.rawText).join('\n'));
    setInstructionText(result.draft.instructions.map((item) => `${item.stepNumber}. ${item.text}`).join('\n'));
    setPhase('review');
    setMode('choose');
    setError(null);
  }

  async function importLink(event: FormEvent) {
    event.preventDefault();
    setProcessing(true);
    setError(null);
    try {
      const source = parseRecipeSourceUrl(url);
      if (!source) throw new Error('unsupported');
      if (source.kind === 'instagram') {
        setInstagramSourceURL(source.href);
        setKeepInstagramSource(true);
        setPastedText('');
        setMode('instagram');
        return;
      }
      const next = createBlankDraft('url');
      next.sourceURL = source.href;
      next.sourceName = source.sourceName;
      openReview({
        draft: next,
        provider: 'manual',
        warnings: ['Source link saved. GitHub Pages cannot privately fetch arbitrary recipe sites, so paste or enter the recipe details before saving.'],
      });
    } catch {
      setError({ message: 'Enter a complete public recipe link.', recovery: ['Paste recipe text', 'Create manually'] });
    }
    finally { setProcessing(false); }
  }

  async function importText(event: FormEvent) {
    event.preventDefault();
    setProcessing(true);
    setError(null);
    try {
      const result = parseRecipeText(pastedText);
      if (mode === 'instagram' && instagramSourceURL && keepInstagramSource) {
        result.draft.sourceType = 'url';
        result.draft.sourceURL = instagramSourceURL;
        result.draft.sourceName = 'Instagram';
        result.warnings.unshift('Instagram source link retained. Only the text you pasted was parsed; Savor did not download or inspect the reel.');
      }
      openReview({ ...result, provider: 'text-parser' });
    } catch {
      setError({ message: 'Savor could not structure the pasted recipe.', recovery: ['Try again', 'Create manually'] });
    }
    finally { setProcessing(false); }
  }

  async function uploadPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    setProcessing(true);
    setError(null);
    try {
      const attachments = [];
      for (const file of files.slice(0, 8)) {
        const prepared = await prepareRecipeImage(file);
        attachments.push({
          id: makeId('attachment'),
          type: 'original-photo' as const,
          url: prepared.dataUrl,
          mimeType: prepared.mimeType,
          originalFilename: file.name || 'recipe-photo.webp',
          captureDate: new Date().toISOString(),
        });
      }
      const next = phase === 'review' ? { ...draft } : createBlankDraft('photo');
      next.sourceType = 'photo';
      next.attachments = [...next.attachments, ...attachments];
      next.heroImage ||= attachments[0]?.url ?? null;
      openReview({
        draft: next,
        provider: 'manual-photo',
        warnings: ['Original image compressed and preserved. Review and transcribe the visible recipe before saving.'],
      });
    } catch {
      setError({
        message: 'The image could not be uploaded.',
        recovery: ['Try a JPEG, PNG, or WebP image', 'Use a smaller crop', 'Continue without a photo'],
      });
    } finally {
      setProcessing(false);
      event.target.value = '';
    }
  }

  function startManual() {
    openReview({ draft: createBlankDraft('manual'), warnings: [], provider: 'manual' });
  }

  function update<K extends keyof RecipeDraft>(key: K, value: RecipeDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    const ingredients = ingredientsFromText(ingredientText);
    const instructions = instructionsFromText(instructionText);
    const next = { ...draft, ingredients, instructions };
    if (!next.title.trim()) { setError({ message: 'Give this recipe a title before saving.' }); return; }
    if (!ingredients.length && !instructions.length) { setError({ message: 'Add at least one ingredient or instruction before saving.' }); return; }
    setSaving(true);
    setError(null);
    try { await onSave(next); } finally { setSaving(false); }
  }

  const reviewCount = ingredientsFromText(ingredientText).filter((item) => item.needsReview).length;

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !processing && !saving) onClose(); }}>
      <section className={phase === 'review' ? 'add-sheet review-sheet' : 'add-sheet'} role="dialog" aria-modal="true" aria-labelledby="add-recipe-title">
        <header className="sheet-header">
          <div>
            {mode !== 'choose' || phase === 'review' ? <button className="sheet-back" type="button" onClick={() => phase === 'review' && !initialRecipe ? setPhase('source') : setMode('choose')}><ArrowLeft size={17} />Back</button> : <p className="eyebrow">Universal capture</p>}
            <h1 id="add-recipe-title">{phase === 'review' ? (initialRecipe ? 'Edit recipe' : 'Review recipe') : mode === 'link' ? 'Import from a link' : mode === 'instagram' ? 'Import from Instagram' : mode === 'paste' ? 'Paste recipe text' : 'Add a recipe'}</h1>
            <p>{phase === 'review' ? 'Everything stays structured and user-correctable.' : 'Choose the easiest way to bring it into your cookbook.'}</p>
          </div>
          <button className="icon-button" aria-label="Close" type="button" onClick={onClose}><X size={20} /></button>
        </header>

        <div className="sheet-content">
          {phase === 'source' && mode === 'choose' ? (
            <div className="capture-options">
              {error ? <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={error} onPaste={() => { setError(null); setMode('paste'); }} onManual={startManual} /></div> : null}
              <button type="button" onClick={() => setMode('link')}><span className="capture-icon"><Link2 size={21} /></span><span><strong>Start from a link</strong><small>Preserve the source, then add its details</small></span><ArrowLeft className="capture-arrow" size={16} /></button>
              <button type="button" onClick={() => fileRef.current?.click()}><span className="capture-icon"><ScanLine size={21} /></span><span><strong>Photo or screenshot</strong><small>Preserve the original and transcribe it</small></span><ArrowLeft className="capture-arrow" size={16} /></button>
              <button type="button" onClick={() => setMode('paste')}><span className="capture-icon"><ClipboardPaste size={21} /></span><span><strong>Paste recipe text</strong><small>Automatically structures ingredients and steps</small></span><ArrowLeft className="capture-arrow" size={16} /></button>
              <button type="button" onClick={startManual}><span className="capture-icon"><PenLine size={21} /></span><span><strong>Create manually</strong><small>Fast keyboard-first recipe entry</small></span><ArrowLeft className="capture-arrow" size={16} /></button>
              <input ref={fileRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple onChange={uploadPhotos} />
              <aside className="privacy-note"><Camera size={17} /><p><strong>Private by default.</strong> Photos are compressed on this device, then synced only to your private GitHub data repository.</p></aside>
            </div>
          ) : null}

          {phase === 'source' && mode === 'link' ? (
            <form className="capture-form" onSubmit={importLink}>
              <div className="capture-form-icon"><Link2 size={24} /></div>
              <label className="field-label">Recipe URL<input autoFocus type="url" inputMode="url" placeholder="https://example.com/favorite-recipe" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
              <p className="field-help">A static GitHub Pages app cannot fetch most recipe sites without exposing a proxy. Savor will preserve the source link and let you enter or paste the details safely.</p>
              {error ? <ErrorBox error={error} onPaste={() => { setError(null); setMode('paste'); }} onManual={startManual} /> : null}
              <button className="button button-primary full-button" type="submit" disabled={processing || !url.trim()}>{processing ? <><LoaderCircle className="spin" size={17} />Saving source…</> : 'Continue with source link'}</button>
            </form>
          ) : null}

          {phase === 'source' && (mode === 'paste' || mode === 'instagram') ? (
            <form className="capture-form paste-form" onSubmit={importText}>
              <div className="capture-form-icon">{mode === 'instagram' ? <Instagram size={24} /> : <ClipboardPaste size={24} />}</div>
              {mode === 'instagram' ? (
                <>
                  <div className="capture-error" role="status">
                    <AlertCircle size={18} />
                    <div>
                      <strong>This static app cannot extract reel content directly</strong>
                      <p>It is not simply an offline issue: supported Instagram access requires live Meta metadata or API credentials. Savor does not scrape Instagram, sign in as you, or claim that the reel was imported.</p>
                      <div>{instagramSourceURL ? <a className="button button-secondary" href={instagramSourceURL} target="_blank" rel="noreferrer">Open on Instagram<ExternalLink size={13} /></a> : null}</div>
                    </div>
                  </div>
                  <div className="field-label">
                    <span>Original source</span>
                    <button className="button button-secondary full-button" type="button" aria-pressed={keepInstagramSource} onClick={() => setKeepInstagramSource((current) => !current)}>
                      {keepInstagramSource ? <CheckCircle2 size={16} /> : <Link2 size={16} />}
                      {keepInstagramSource ? 'Instagram source link will be kept' : 'Instagram source link will not be kept'}
                    </button>
                    <small>You can change this before importing. Keeping the link makes it easy to return to the original reel from the saved recipe.</small>
                  </div>
                </>
              ) : null}
              <label className="field-label">{mode === 'instagram' ? 'Caption or recipe text' : 'Recipe text'}<textarea autoFocus rows={13} placeholder={mode === 'instagram' ? 'Copy the recipe caption from Instagram and paste it here…' : 'Chicken Piccata\nServes 4\n\nIngredients\n2 chicken breasts\n½ cup flour\n\nInstructions\n1. Slice the chicken…'} value={pastedText} onChange={(event) => setPastedText(event.target.value)} /></label>
              <p className="field-help">{mode === 'instagram' ? 'Copy the caption—and any recipe details the creator placed in a comment—then paste them here. ' : ''}Headings such as Ingredients, Directions, Method, and section names help the parser preserve structure.</p>
              {error ? <ErrorBox error={error} onManual={startManual} /> : null}
              <button className="button button-primary full-button" type="submit" disabled={processing || pastedText.trim().length < 8}>{processing ? <><LoaderCircle className="spin" size={17} />Structuring recipe…</> : mode === 'instagram' ? 'Review pasted Instagram recipe' : 'Review imported recipe'}</button>
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
                <input ref={fileRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={uploadPhotos} />
                <div className="review-status"><CheckCircle2 size={17} /><div><strong>{provider === 'schema-org' ? 'Structured page data' : provider === 'text-parser' ? 'Parsed recipe text' : provider === 'manual-photo' ? 'Original image preserved' : 'Manual recipe'}</strong><small>{reviewCount ? `${reviewCount} ingredient${reviewCount === 1 ? '' : 's'} need review` : 'Ready for your review'}</small></div></div>
              </aside>

              <div className="review-form">
                {warnings.length ? <div className="review-warning"><AlertCircle size={18} /><div><strong>Take a quick look</strong>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></div> : null}
                {error ? <ErrorBox error={error} /> : null}
                <div className="form-section">
                  <div className="form-section-heading"><span>01</span><div><h2>The essentials</h2><p>What you’ll recognize in the cookbook.</p></div></div>
                  <label className="field-label wide-field">Recipe title<input autoFocus value={draft.title} onChange={(event) => update('title', event.target.value)} placeholder="Recipe name" /></label>
                  <label className="field-label wide-field">Description<textarea rows={2} value={draft.description} onChange={(event) => update('description', event.target.value)} placeholder="A short, useful description" /></label>
                  <div className="field-grid four-fields">
                    <label className="field-label">Servings<input type="number" min="1" value={draft.servings ?? ''} onChange={(event) => update('servings', event.target.value ? Number(event.target.value) : null)} /></label>
                    <label className="field-label">Prep minutes<input type="number" min="0" value={draft.prepTime ?? ''} onChange={(event) => update('prepTime', event.target.value ? Number(event.target.value) : null)} /></label>
                    <label className="field-label">Cook minutes<input type="number" min="0" value={draft.cookTime ?? ''} onChange={(event) => update('cookTime', event.target.value ? Number(event.target.value) : null)} /></label>
                    <label className="field-label">Cuisine<input value={draft.cuisine ?? ''} onChange={(event) => update('cuisine', event.target.value || null)} placeholder="Optional" /></label>
                  </div>
                </div>

                <div className="form-section">
                  <div className="form-section-heading"><span>02</span><div><h2>Ingredients</h2><p>One ingredient per line. Use a line ending in “:” for a section.</p></div></div>
                  <label className="field-label wide-field">Ingredient lines<textarea className="structured-textarea" rows={Math.max(7, ingredientText.split('\n').length + 1)} value={ingredientText} onChange={(event) => setIngredientText(event.target.value)} placeholder={'Sauce:\n2 tbsp olive oil\n1 medium onion, diced\n½ cup cream'} /></label>
                  {reviewCount ? <p className="confidence-note"><AlertCircle size={14} />{reviewCount} line{reviewCount === 1 ? '' : 's'} have an uncertain or missing quantity. Savor will keep them separate in grocery aggregation until corrected.</p> : null}
                </div>

                <div className="form-section">
                  <div className="form-section-heading"><span>03</span><div><h2>Instructions</h2><p>One clear step per line.</p></div></div>
                  <label className="field-label wide-field">Cooking steps<textarea className="structured-textarea" rows={Math.max(7, instructionText.split('\n').length + 1)} value={instructionText} onChange={(event) => setInstructionText(event.target.value)} placeholder={'1. Heat the oven to 425°F.\n2. Season the chicken…'} /></label>
                </div>

                <div className="form-section compact-form-section">
                  <div className="form-section-heading"><span>04</span><div><h2>Remember it</h2><p>Source, tags, and household notes.</p></div></div>
                  <div className="field-grid two-fields">
                    <label className="field-label">Tags<input value={draft.tags.join(', ')} onChange={(event) => update('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} placeholder="Weeknight, favorite" /></label>
                    <label className="field-label">Source name<input value={draft.sourceName ?? ''} onChange={(event) => update('sourceName', event.target.value || null)} placeholder="Grandma’s recipe card" /></label>
                  </div>
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

function ErrorBox({ error, onPaste, onManual }: { error: { message: string; recovery?: string[] }; onPaste?: () => void; onManual?: () => void }) {
  return (
    <div className="capture-error" role="alert">
      <AlertCircle size={18} /><div><strong>{error.message}</strong>{error.recovery?.length ? <p>{error.recovery.join(' · ')}</p> : null}<div>{onPaste ? <button type="button" onClick={onPaste}>Paste text instead</button> : null}{onManual ? <button type="button" onClick={onManual}>Create manually</button> : null}</div></div>
    </div>
  );
}
