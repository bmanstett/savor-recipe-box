'use client';

import {
  ChevronDown, ChevronUp, Cloud, Download, HardDrive, LogOut, ShieldCheck,
  Smartphone, Upload, X,
} from 'lucide-react';
import { ChangeEvent, useRef, useState } from 'react';
import { clearLocalCache } from '../../lib/client-cache';
import type { GroceryCategory, HouseholdPreferences } from '../../lib/types';

export function SettingsSheet({
  user, preferences, installAvailable, onInstall, onSave, onExport, onImport, onClose,
}: {
  user: { displayName: string; email: string };
  preferences: HouseholdPreferences;
  installAvailable: boolean;
  onInstall: () => Promise<void>;
  onSave: (preferences: HouseholdPreferences) => Promise<void>;
  onExport: () => Promise<void>;
  onImport: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const [pantryText, setPantryText] = useState(preferences.pantryStaples.join(', '));
  const [exclude, setExclude] = useState(preferences.excludePantryStaples);
  const [order, setOrder] = useState(preferences.sectionOrder);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    setOrder((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      await onSave({
        pantryStaples: pantryText.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
        excludePantryStaples: exclude,
        sectionOrder: order,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Settings could not be saved.');
    } finally { setSaving(false); }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setError('');
    try { await onImport(file); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Backup could not be imported.'); }
    finally { setImporting(false); event.target.value = ''; }
  }

  async function signOut() {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_PRIVATE_CACHE' });
    await clearLocalCache().catch(() => undefined);
    window.location.assign('/signout-with-chatgpt?return_to=/');
  }

  return (
    <div className="sheet-backdrop settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header"><div><p className="eyebrow">Our kitchen</p><h1 id="settings-title">Household settings</h1><p>Private, practical defaults for the way you cook and shop.</p></div><button className="icon-button" aria-label="Close settings" type="button" onClick={onClose}><X size={20} /></button></header>
        <div className="settings-content">
          {error ? <div className="settings-error" role="alert">{error}</div> : null}
          <section className="settings-section account-section">
            <div className="settings-section-heading"><span><Cloud size={19} /></span><div><h2>Private household sync</h2><p>Signed in as {user.email}</p></div></div>
            <div className="sync-status-row"><span className="status-dot" /><div><strong>Saved privately</strong><small>Changes sync through this private Savor site. Access is controlled by the site’s member list.</small></div></div>
            <button className="button button-ghost signout-button" type="button" onClick={signOut}><LogOut size={16} />Sign out</button>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading"><span><HardDrive size={19} /></span><div><h2>Pantry staples</h2><p>Skip ingredients you usually have when generating a list.</p></div></div>
            <label className="switch-row"><input type="checkbox" checked={exclude} onChange={(event) => setExclude(event.target.checked)} /><span className="switch-track" /><span><strong>Exclude pantry staples</strong><small>Every excluded contribution remains recoverable.</small></span></label>
            <label className="field-label">Usually have<textarea rows={3} value={pantryText} onChange={(event) => setPantryText(event.target.value)} placeholder="salt, black pepper, olive oil" /><small>Separate ingredients with commas. Matching stays exact and conservative.</small></label>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading"><span><Smartphone size={19} /></span><div><h2>Your store route</h2><p>Arrange sections in the order you walk the store.</p></div></div>
            <ol className="section-order-list">{order.map((category: GroceryCategory, index) => <li key={category}><span>{index + 1}</span><strong>{category}</strong><div><button aria-label={`Move ${category} up`} type="button" disabled={index === 0} onClick={() => move(index, -1)}><ChevronUp size={15} /></button><button aria-label={`Move ${category} down`} type="button" disabled={index === order.length - 1} onClick={() => move(index, 1)}><ChevronDown size={15} /></button></div></li>)}</ol>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading"><span><ShieldCheck size={19} /></span><div><h2>Your data</h2><p>You own the cookbook you build here.</p></div></div>
            <div className="privacy-grid">
              <div><strong>Stored on device</strong><span>Offline viewing cache and unsynced changes</span></div>
              <div><strong>Synced privately</strong><span>Recipes, meal plan, groceries, preferences, and uploaded scans</span></div>
              <div><strong>Sent for parsing</strong><span>Only the recipe URL or text you explicitly import; photo OCR is not configured</span></div>
            </div>
            <div className="backup-actions">
              <button className="button button-secondary" type="button" onClick={onExport}><Download size={16} />Export JSON backup</button>
              <button className="button button-secondary" type="button" disabled={importing} onClick={() => inputRef.current?.click()}><Upload size={16} />{importing ? 'Validating…' : 'Merge backup'}</button>
              <input ref={inputRef} className="sr-only" type="file" accept="application/json,.json" onChange={importFile} />
            </div>
            <p className="backup-note">Imports are validated before anything changes. Merge never deletes current recipes.</p>
          </section>

          {installAvailable ? <section className="install-card"><Smartphone size={21} /><div><strong>Install Savor</strong><p>Open it from your home screen or desktop like a native app.</p></div><button className="button button-secondary" type="button" onClick={onInstall}>Install</button></section> : null}
        </div>
        <footer className="settings-footer"><button className="button button-ghost" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save preferences'}</button></footer>
      </section>
    </div>
  );
}
