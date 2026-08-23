import { Github, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { SavorApp } from '../app/components/SavorApp';
import {
  EMPTY_TOMBSTONES,
  clearGitHubConnection,
  readGitHubConnection,
  readLocalSnapshot,
  saveGitHubConnection,
  saveLocalSnapshot,
  type LocalSnapshot,
  type StoredGitHubConnection,
  type Tombstones,
} from '../lib/client-cache';
import { GitHubSyncError, syncGitHubSnapshot, validateGitHubConnection } from '../lib/github-sync';
import { SEED_GROCERY_ITEMS, SEED_MEAL_PLAN, SEED_PREFERENCES, SEED_RECIPES } from '../lib/seed';
import type { GitHubConnectInput, SyncPresentation } from '../lib/sync-types';
import type { BootstrapData } from '../lib/types';

function newDeviceId(): string {
  return `device_${crypto.randomUUID()}`;
}

function seedSnapshot(): LocalSnapshot {
  const now = new Date().toISOString();
  return {
    data: {
      recipes: structuredClone(SEED_RECIPES),
      mealPlan: structuredClone(SEED_MEAL_PLAN),
      groceryItems: structuredClone(SEED_GROCERY_ITEMS),
      preferences: structuredClone(SEED_PREFERENCES),
      user: { displayName: 'Your kitchen', email: 'Local-first' },
      syncedAt: now,
    },
    tombstones: structuredClone(EMPTY_TOMBSTONES),
    deviceId: newDeviceId(),
    updatedAt: now,
    preferencesUpdatedAt: now,
    initialized: false,
    dirty: true,
  };
}

function rowsById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function sameValue(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function rebaseEditsMadeDuringSync(base: LocalSnapshot, synced: LocalSnapshot, latest: LocalSnapshot): LocalSnapshot {
  const rebaseRows = <T extends { id: string }>(baseRows: T[], syncedRows: T[], latestRows: T[]) => {
    const baseMap = rowsById(baseRows);
    const latestMap = rowsById(latestRows);
    const output = rowsById(syncedRows);
    const ids = new Set([...baseMap.keys(), ...latestMap.keys()]);
    for (const id of ids) {
      if (sameValue(baseMap.get(id), latestMap.get(id))) continue;
      const local = latestMap.get(id);
      if (local) output.set(id, local);
      else output.delete(id);
    }
    return [...output.values()];
  };
  const rebaseTombstones = (baseRows: Record<string, string>, syncedRows: Record<string, string>, latestRows: Record<string, string>) => {
    const output = { ...syncedRows };
    const ids = new Set([...Object.keys(baseRows), ...Object.keys(latestRows)]);
    for (const id of ids) {
      if (baseRows[id] === latestRows[id]) continue;
      if (latestRows[id]) output[id] = latestRows[id];
      else delete output[id];
    }
    return output;
  };
  const preferencesChanged = !sameValue(base.data.preferences, latest.data.preferences);
  return {
    ...synced,
    data: {
      ...synced.data,
      recipes: rebaseRows(base.data.recipes, synced.data.recipes, latest.data.recipes),
      mealPlan: rebaseRows(base.data.mealPlan, synced.data.mealPlan, latest.data.mealPlan),
      groceryItems: rebaseRows(base.data.groceryItems, synced.data.groceryItems, latest.data.groceryItems),
      preferences: preferencesChanged ? latest.data.preferences : synced.data.preferences,
      user: latest.data.user,
    },
    tombstones: {
      recipes: rebaseTombstones(base.tombstones.recipes, synced.tombstones.recipes, latest.tombstones.recipes),
      mealPlan: rebaseTombstones(base.tombstones.mealPlan, synced.tombstones.mealPlan, latest.tombstones.mealPlan),
      groceryItems: rebaseTombstones(base.tombstones.groceryItems, synced.tombstones.groceryItems, latest.tombstones.groceryItems),
    },
    updatedAt: latest.updatedAt,
    preferencesUpdatedAt: preferencesChanged ? latest.preferencesUpdatedAt : synced.preferencesUpdatedAt,
    initialized: latest.initialized,
    dirty: true,
  };
}

function recordDeletions(current: BootstrapData, next: BootstrapData, previous: Tombstones, timestamp: string): Tombstones {
  const update = (before: Array<{ id: string }>, after: Array<{ id: string; dateModified?: string; dateAdded?: string }>, existing: Record<string, string>) => {
    const output = { ...existing };
    const afterIds = new Set(after.map((row) => row.id));
    for (const row of before) if (!afterIds.has(row.id)) output[row.id] = timestamp;
    for (const row of after) {
      if (before.some((item) => item.id === row.id)) continue;
      const changedAt = row.dateModified ?? row.dateAdded ?? timestamp;
      if (!output[row.id] || changedAt > output[row.id]) delete output[row.id];
    }
    return output;
  };
  return {
    recipes: update(current.recipes, next.recipes, previous.recipes),
    mealPlan: update(current.mealPlan, next.mealPlan, previous.mealPlan),
    groceryItems: update(current.groceryItems, next.groceryItems, previous.groceryItems),
  };
}

const LOCAL_STATUS: SyncPresentation = {
  phase: 'local',
  label: 'Saved on this device',
  message: 'Connect a private GitHub data repository to sync across devices.',
};

export function AppRoot() {
  const [snapshot, setSnapshot] = useState<LocalSnapshot | null>(null);
  const [connection, setConnection] = useState<StoredGitHubConnection | null>(null);
  const [token, setToken] = useState('');
  const [sync, setSync] = useState<SyncPresentation>(LOCAL_STATUS);
  const snapshotRef = useRef<LocalSnapshot | null>(null);
  const syncingRef = useRef(false);
  const initialPullRef = useRef(false);
  const connectionGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([readLocalSnapshot(), readGitHubConnection()]).then(([storedSnapshot, storedConnection]) => {
      if (cancelled) return;
      const nextSnapshot = storedSnapshot ?? seedSnapshot();
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setConnection(storedConnection);
      if (storedConnection && !token) {
        setSync({ phase: 'needs-token', label: 'GitHub login needed', message: 'Paste this device’s fine-grained token to resume sync.' });
      } else if (storedConnection && token && !navigator.onLine) {
        setSync({ phase: 'offline', label: 'Offline', message: 'Changes are safe on this device and will sync when you reconnect.' });
      }
    }).catch(() => {
      const nextSnapshot = seedSnapshot();
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setSync({ phase: 'error', label: 'Local storage unavailable', message: 'Savor could not open its offline storage.' });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    snapshotRef.current = snapshot;
    const timer = window.setTimeout(() => saveLocalSnapshot(snapshot).catch(() => {
      setSync({ phase: 'error', label: 'Local save failed', message: 'Browser storage could not save this change. Export a backup before closing Savor.' });
    }), 250);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  const runSync = useCallback(async (
    selectedSnapshot: LocalSnapshot,
    selectedConnection: StoredGitHubConnection,
    selectedToken: string,
  ) => {
    if (syncingRef.current) return;
    if (!navigator.onLine) {
      setSync({ phase: 'offline', label: 'Offline', message: 'Changes are safe on this device and will sync when you reconnect.' });
      return;
    }
    if (!selectedToken) {
      setSync({ phase: 'needs-token', label: 'GitHub login needed', message: 'Paste this device’s fine-grained token to resume sync.' });
      return;
    }
    const requestGeneration = connectionGenerationRef.current;
    initialPullRef.current = true;
    syncingRef.current = true;
    setSync({ phase: 'syncing', label: 'Syncing with GitHub…', message: `Updating ${selectedConnection.owner}/${selectedConnection.repo}.` });
    try {
      const result = await syncGitHubSnapshot(selectedSnapshot, selectedConnection, selectedToken);
      if (requestGeneration !== connectionGenerationRef.current) return;
      const latest = snapshotRef.current;
      const committed = latest && latest !== selectedSnapshot
        ? rebaseEditsMadeDuringSync(selectedSnapshot, result.snapshot, latest)
        : result.snapshot;
      snapshotRef.current = committed;
      setSnapshot(committed);
      setConnection(result.connection);
      await Promise.all([saveLocalSnapshot(committed), saveGitHubConnection(result.connection)]);
      setSync({ phase: 'synced', label: 'Synced privately', message: `Up to date in ${result.connection.owner}/${result.connection.repo}.` });
    } catch (error) {
      if (requestGeneration !== connectionGenerationRef.current) return;
      const message = error instanceof Error ? error.message : 'GitHub sync failed.';
      const needsToken = error instanceof GitHubSyncError && (error.status === 401 || error.status === 403 || error.status === 404);
      setSync({ phase: needsToken ? 'needs-token' : 'error', label: needsToken ? 'GitHub login needed' : 'Sync needs attention', message });
    } finally {
      syncingRef.current = false;
    }
  }, []);

  const updateData = useCallback((action: SetStateAction<BootstrapData>) => {
    setSnapshot((current) => {
      if (!current) return current;
      const nextData = typeof action === 'function' ? action(current.data) : action;
      const now = new Date().toISOString();
      const next: LocalSnapshot = {
        ...current,
        data: { ...nextData, syncedAt: current.data.syncedAt },
        tombstones: recordDeletions(current.data, nextData, current.tombstones, now),
        updatedAt: now,
        preferencesUpdatedAt: sameValue(current.data.preferences, nextData.preferences) ? current.preferencesUpdatedAt : now,
        initialized: true,
        dirty: true,
      };
      snapshotRef.current = next;
      return next;
    });
  }, []);

  const connect = useCallback(async (input: GitHubConnectInput) => {
    connectionGenerationRef.current += 1;
    setSync({ phase: 'connecting', label: 'Checking GitHub…', message: 'Verifying the private data repository and token permissions.' });
    const result = await validateGitHubConnection(input.token, input.owner, input.repo);
    setToken(input.token.trim());
    setConnection(result.connection);
    await saveGitHubConnection(result.connection);
    const current = snapshotRef.current;
    if (!current) return;
    const withUser: LocalSnapshot = {
      ...current,
      data: { ...current.data, user: { displayName: result.displayName, email: `@${result.connection.username}` } },
      updatedAt: new Date().toISOString(),
      dirty: true,
    };
    snapshotRef.current = withUser;
    setSnapshot(withUser);
    await runSync(withUser, result.connection, input.token.trim());
  }, [runSync]);

  const disconnect = useCallback(async () => {
    connectionGenerationRef.current += 1;
    setToken('');
    setConnection(null);
    await clearGitHubConnection();
    setSync(LOCAL_STATUS);
  }, []);

  const syncNow = useCallback(async () => {
    const current = snapshotRef.current;
    if (current && connection) await runSync(current, connection, token);
  }, [connection, runSync, token]);

  useEffect(() => {
    if (!snapshot || !connection || !token) return;
    if (!snapshot.dirty && connection.lastSyncAt) {
      if (initialPullRef.current) {
        setSync({ phase: 'synced', label: 'Synced privately', message: `Up to date in ${connection.owner}/${connection.repo}.` });
        return;
      }
      initialPullRef.current = true;
    }
    const timer = window.setTimeout(() => runSync(snapshot, connection, token), 5_000);
    return () => window.clearTimeout(timer);
  }, [connection, runSync, snapshot, token]);

  useEffect(() => {
    const handleOnline = () => {
      const current = snapshotRef.current;
      if (current && connection && token) runSync(current, connection, token);
      else setSync(LOCAL_STATUS);
    };
    const handleOffline = () => setSync({ phase: 'offline', label: 'Offline', message: 'Changes are safe on this device and will sync when you reconnect.' });
    const handleVisibility = () => { if (document.visibilityState === 'visible') handleOnline(); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [connection, runSync, token]);

  if (!snapshot) {
    return <div className="app-loading"><div className="loading-brand"><span>S</span>Savor</div><div className="loading-shell"><aside /><section><header /><div className="loading-hero" /></section></div><p>Opening your kitchen…</p></div>;
  }

  if (connection && !token) {
    return <GitHubUnlock connection={connection} onUnlock={(nextToken) => connect({ owner: connection.owner, repo: connection.repo, token: nextToken })} />;
  }

  return (
    <SavorApp
      data={snapshot.data}
      setData={updateData}
      connection={connection}
      sync={sync}
      startInSettings={!connection || !token}
      onConnectGitHub={connect}
      onDisconnectGitHub={disconnect}
      onSyncNow={syncNow}
    />
  );
}

function GitHubUnlock({ connection, onUnlock }: {
  connection: StoredGitHubConnection;
  onUnlock: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try { await onUnlock(token); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'GitHub login failed.'); }
    finally { setBusy(false); }
  }

  return (
    <main className="github-lock-screen">
      <section className="github-lock-card">
        <div className="lock-brand"><span>S</span><strong>Savor</strong></div>
        <div className="lock-icon"><KeyRound size={24} /></div>
        <p className="eyebrow">Private household sync</p>
        <h1>Unlock your kitchen</h1>
        <p>Enter this device’s fine-grained GitHub token to load the latest private household data.</p>
        <div className="lock-repository"><Github size={16} /><span><strong>{connection.owner}/{connection.repo}</strong><small>Private data repository</small></span></div>
        <form onSubmit={submit}>
          <label className="field-label">Fine-grained token<input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="github_pat_…" /></label>
          {error ? <div className="settings-error" role="alert">{error}</div> : null}
          <button className="button button-primary full-button" type="submit" disabled={busy || !token.trim()}>{busy ? 'Checking GitHub…' : 'Unlock with GitHub'}</button>
        </form>
        <small className="lock-note">The token stays only in memory for this open page. Reloading or closing the page locks Savor again.</small>
      </section>
    </main>
  );
}
