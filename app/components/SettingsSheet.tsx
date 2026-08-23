'use client';

import {
  ChevronDown, ChevronUp, Cloud, Download, ExternalLink, Github, HardDrive,
  KeyRound, Mail, RefreshCw, ShieldCheck, Smartphone, Unplug, Upload, X,
} from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import type { StoredGitHubConnection } from '../../lib/client-cache';
import type { GitHubConnectInput, SyncPresentation } from '../../lib/sync-types';
import type { GroceryCategory, HouseholdPreferences, SkylightEmailApp } from '../../lib/types';
import { isValidSkylightDeviceEmail } from '../../lib/skylight';

export function SettingsSheet({
  preferences, skylightEmailApp, connection, hasGitHubToken, sync, installAvailable,
  onInstall, onChangeSkylightEmailApp, onSave, onExport, onImport, onConnectGitHub, onDisconnectGitHub, onSyncNow, onClose,
}: {
  preferences: HouseholdPreferences;
  skylightEmailApp: SkylightEmailApp;
  connection: StoredGitHubConnection | null;
  hasGitHubToken: boolean;
  sync: SyncPresentation;
  installAvailable: boolean;
  onInstall: () => Promise<void>;
  onChangeSkylightEmailApp: (value: SkylightEmailApp) => void;
  onSave: (preferences: HouseholdPreferences) => Promise<void>;
  onExport: () => Promise<void>;
  onImport: (file: File) => Promise<void>;
  onConnectGitHub: (input: GitHubConnectInput) => Promise<void>;
  onDisconnectGitHub: () => Promise<void>;
  onSyncNow: () => Promise<void>;
  onClose: () => void;
}) {
  const [pantryText, setPantryText] = useState(preferences.pantryStaples.join(', '));
  const [exclude, setExclude] = useState(preferences.excludePantryStaples);
  const [order, setOrder] = useState(preferences.sectionOrder);
  const [skylightEmail, setSkylightEmail] = useState(preferences.skylightDeviceEmail ?? '');
  const [owner, setOwner] = useState(connection?.owner ?? 'bmanstett');
  const [repo, setRepo] = useState(connection?.repo ?? 'savor-data');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const needsLogin = !connection || !hasGitHubToken || sync.phase === 'needs-token';

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
      const cleanSkylightEmail = skylightEmail.trim().toLowerCase();
      if (cleanSkylightEmail && !isValidSkylightDeviceEmail(cleanSkylightEmail)) {
        throw new Error('Enter a Skylight device email ending in @ourskylight.com, or leave it blank.');
      }
      await onSave({
        pantryStaples: pantryText.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
        excludePantryStaples: exclude,
        sectionOrder: order,
        skylightDeviceEmail: cleanSkylightEmail || null,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Settings could not be saved.');
    } finally { setSaving(false); }
  }

  async function connectGitHub() {
    setConnecting(true);
    setError('');
    try {
      await onConnectGitHub({ owner, repo, token });
      setToken('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'GitHub could not be connected.');
    } finally { setConnecting(false); }
  }

  async function disconnectGitHub() {
    setDisconnecting(true);
    setError('');
    try {
      await onDisconnectGitHub();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The saved GitHub token could not be removed.');
    } finally {
      setDisconnecting(false);
    }
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

  return (
    <div className="sheet-backdrop settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header"><div><p className="eyebrow">Our kitchen</p><h1 id="settings-title">Household settings</h1><p>Private sync, practical defaults, and a backup you control.</p></div><button className="icon-button" aria-label="Close settings" type="button" onClick={onClose}><X size={20} /></button></header>
        <div className="settings-content">
          {error ? <div className="settings-error" role="alert">{error}</div> : null}

          <section className="settings-section account-section">
            <div className="settings-section-heading"><span><Github size={19} /></span><div><h2>Private GitHub sync</h2><p>The app and household data live in separate repositories.</p></div></div>
            {needsLogin ? (
              <div className="github-connect-card">
                {sync.phase === 'needs-token' ? <div className="settings-error" role="alert">{sync.message}</div> : null}
                <div className="github-security-note"><KeyRound size={18} /><div><strong>Use a fine-grained personal access token</strong><p>Select only the private <code>{repo || 'savor-data'}</code> repository and grant Contents read/write. Do not grant access to the public app repository.</p></div></div>
                <div className="github-repo-fields">
                  <label className="field-label">Repository owner<input value={owner} onChange={(event) => setOwner(event.target.value)} autoCapitalize="none" spellCheck={false} placeholder="github-username" /></label>
                  <label className="field-label">Private data repository<input value={repo} onChange={(event) => setRepo(event.target.value)} autoCapitalize="none" spellCheck={false} placeholder="savor-data" /></label>
                </div>
                <label className="field-label">Fine-grained token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="github_pat_…" /><small><strong>Saved on this device.</strong> Savor reconnects automatically after you close or restart it. The token is never included in backups, synced household data, or the service-worker cache.</small></label>
                <div className="github-connect-actions">
                  <a className="button button-secondary" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create token<ExternalLink size={14} /></a>
                  <button className="button button-primary" type="button" disabled={connecting || !owner.trim() || !repo.trim() || !token.trim()} onClick={connectGitHub}>{connecting ? 'Checking…' : connection ? 'Reconnect GitHub' : 'Connect GitHub'}</button>
                </div>
                <p className="github-helper">Use a different token on each device so any one device can be revoked without interrupting the others.</p>
              </div>
            ) : (
              <div className="github-connected-card">
                <div className="sync-status-row"><span className={sync.phase === 'error' ? 'status-dot status-dot-error' : 'status-dot'} /><div><strong>{sync.label}</strong><small>{sync.message}</small></div></div>
                <div className="connected-repo"><span><Github size={16} /></span><div><strong>{connection.owner}/{connection.repo}</strong><small>@{connection.username} · {connection.branch}</small></div></div>
                <div className="github-connect-actions">
                  <button className="button button-secondary" type="button" disabled={sync.phase === 'syncing'} onClick={onSyncNow}><RefreshCw className={sync.phase === 'syncing' ? 'spin' : ''} size={15} />{sync.phase === 'syncing' ? 'Syncing…' : 'Sync now'}</button>
                  <button className="button button-ghost signout-button" type="button" disabled={disconnecting} onClick={disconnectGitHub}><Unplug size={15} />{disconnecting ? 'Removing…' : 'Stop GitHub sync'}</button>
                </div>
                <p className="github-helper">Savor reconnects automatically until this token expires, is revoked, you disconnect, or Savor’s site data is removed. Disconnecting does not revoke it at GitHub.</p>
              </div>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-section-heading"><span><Mail size={19} /></span><div><h2>Skylight Sidekick</h2><p>Send a planned week to your Calendar's native Meal Planner.</p></div></div>
            <label className="field-label">Skylight device email<input type="email" value={skylightEmail} onChange={(event) => setSkylightEmail(event.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="your-calendar@ourskylight.com" /><small>Optional. Find this address in the Skylight app. It stays with your private household preferences.</small></label>
            <label className="field-label">Default email app<select value={skylightEmailApp} onChange={(event) => onChangeSkylightEmailApp(event.target.value as SkylightEmailApp)}><option value="gmail">Gmail app</option><option value="device-default">Device default mail app</option></select><small>Saved immediately on this device. Gmail must be installed; device default uses the mail app selected in your phone or computer settings.</small></label>
            <div className="github-security-note"><ShieldCheck size={18} /><div><strong>Drafts only</strong><p>Savor opens your email app with a prepared menu. Nothing is sent automatically, and Sidekick meal imports require Calendar Plus.</p></div></div>
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
              <div><strong>Stored on device</strong><span>Recipes, offline changes, and a media cache</span></div>
              <div><strong>Synced privately</strong><span>One state file plus compressed photos in your private data repo</span></div>
              <div><strong>Public app only</strong><span>The GitHub Pages bundle contains no household data or credentials</span></div>
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
        <footer className="settings-footer"><button className="button button-ghost" type="button" onClick={onClose}>Close</button><button className="button button-primary" type="button" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save preferences'}</button></footer>
      </section>
    </div>
  );
}
