import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { SavorApp } from '../app/components/SavorApp';
import {
  EMPTY_TOMBSTONES,
  clearGitHubCredentials,
  clearGitHubCredential,
  readGitHubSession,
  readLocalSnapshot,
  saveGitHubCredentials,
  saveGitHubConnectionForCredential,
  saveLocalSnapshot,
  type LocalSnapshot,
  type StoredGitHubConnection,
  type Tombstones,
} from '../lib/client-cache';
import { queueGitHubRecipeImport, type GitHubImportOptions } from '../lib/github-import-queue';
import { GitHubSyncError, syncGitHubSnapshot, validateGitHubConnection } from '../lib/github-sync';
import { SEED_GROCERY_ITEMS, SEED_MEAL_PLAN, SEED_PREFERENCES, SEED_RECIPES } from '../lib/seed';
import type { GitHubConnectInput, SyncPresentation } from '../lib/sync-types';
import type { BootstrapData, ImportResult } from '../lib/types';

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

const TOKEN_REQUIRED_STATUS: SyncPresentation = {
  phase: 'needs-token',
  label: 'GitHub login needed',
  message: 'Enter this device’s fine-grained token in Settings to resume sync.',
};

export function AppRoot() {
  const [snapshot, setSnapshot] = useState<LocalSnapshot | null>(null);
  const [connection, setConnection] = useState<StoredGitHubConnection | null>(null);
  const [token, setToken] = useState('');
  const [sync, setSync] = useState<SyncPresentation>(LOCAL_STATUS);
  const snapshotRef = useRef<LocalSnapshot | null>(null);
  const syncingRef = useRef(false);
  const initialPullRef = useRef(false);
  const localSnapshotAvailableRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const credentialIdRef = useRef<string | null>(null);
  const disconnectingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([readLocalSnapshot(), readGitHubSession()]).then(([snapshotResult, sessionResult]) => {
      if (cancelled) return;
      const storedSnapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
      const storedSession = sessionResult.status === 'fulfilled'
        ? sessionResult.value
        : { connection: null, credential: null };
      const { connection: storedConnection, credential: storedCredential } = storedSession;
      const nextSnapshot = storedSnapshot ?? seedSnapshot();
      const credentialMatches = Boolean(storedConnection && storedCredential
        && storedCredential.owner === storedConnection.owner.trim().toLowerCase()
        && storedCredential.repo === storedConnection.repo.trim().toLowerCase());
      const storedToken = credentialMatches ? storedCredential?.token ?? null : null;
      localSnapshotAvailableRef.current = snapshotResult.status === 'fulfilled';
      snapshotRef.current = nextSnapshot;
      credentialIdRef.current = credentialMatches ? storedCredential?.id ?? null : null;
      setSnapshot(nextSnapshot);
      setConnection(storedConnection);
      setToken(storedConnection ? storedToken ?? '' : '');
      if (storedCredential && !credentialMatches) void clearGitHubCredential(storedCredential.id).catch(() => undefined);
      if (storedConnection && !storedToken) {
        setSync(TOKEN_REQUIRED_STATUS);
      } else if (storedConnection && storedToken && !navigator.onLine) {
        setSync({ phase: 'offline', label: 'Offline', message: 'Changes are safe on this device and will sync when you reconnect.' });
      } else if (storedConnection && storedToken) {
        setSync({ phase: 'connecting', label: 'Connecting to GitHub…', message: 'Using the token saved on this device.' });
      }
      if (sessionResult.status === 'rejected') {
        setSync({ phase: 'error', label: 'Saved GitHub login unavailable', message: 'Your local recipes are open, but Savor could not read the saved GitHub login on this device.' });
      }
      if (snapshotResult.status === 'rejected') {
        setSync({ phase: 'error', label: 'Local storage unavailable', message: 'Savor could not open its offline storage. Changes will not be saved until this is resolved.' });
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!snapshot || !localSnapshotAvailableRef.current) return;
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
    if (!localSnapshotAvailableRef.current) {
      setSync({ phase: 'error', label: 'Local storage unavailable', message: 'GitHub sync is paused so an unsaved temporary copy cannot replace your household data.' });
      return;
    }
    if (syncingRef.current || disconnectingRef.current) return;
    if (!navigator.onLine) {
      setSync({ phase: 'offline', label: 'Offline', message: 'Changes are safe on this device and will sync when you reconnect.' });
      return;
    }
    if (!selectedToken) {
      setSync(TOKEN_REQUIRED_STATUS);
      return;
    }
    const requestGeneration = connectionGenerationRef.current;
    const requestCredentialId = credentialIdRef.current;
    initialPullRef.current = true;
    syncingRef.current = true;
    setSync({ phase: 'syncing', label: 'Syncing with GitHub…', message: `Updating ${selectedConnection.owner}/${selectedConnection.repo}.` });
    try {
      const result = await syncGitHubSnapshot(selectedSnapshot, selectedConnection, selectedToken);
      if (requestGeneration !== connectionGenerationRef.current) return;
      if (!requestCredentialId) return;
      const connectionSaved = await saveGitHubConnectionForCredential(result.connection, requestCredentialId);
      if (!connectionSaved) return;
      if (requestGeneration !== connectionGenerationRef.current) return;
      const latest = snapshotRef.current;
      const committed = latest && latest !== selectedSnapshot
        ? rebaseEditsMadeDuringSync(selectedSnapshot, result.snapshot, latest)
        : result.snapshot;
      snapshotRef.current = committed;
      setSnapshot(committed);
      setConnection(result.connection);
      await saveLocalSnapshot(committed);
      if (requestGeneration !== connectionGenerationRef.current) return;
      setSync({ phase: 'synced', label: 'Synced privately', message: `Up to date in ${result.connection.owner}/${result.connection.repo}.` });
    } catch (error) {
      if (requestGeneration !== connectionGenerationRef.current) return;
      const message = error instanceof Error ? error.message : 'GitHub sync failed.';
      const needsToken = error instanceof GitHubSyncError && [401, 403, 404].includes(error.status);
      if (needsToken) {
        if (requestCredentialId) {
          try {
            await clearGitHubCredential(requestCredentialId);
          } catch {
            setSync({ phase: 'error', label: 'Saved token could not be removed', message: 'Use Stop GitHub sync to try again, or clear Savor’s site data before closing the app.' });
            return;
          }
        }
        if (requestGeneration !== connectionGenerationRef.current) return;
        setToken('');
        credentialIdRef.current = null;
      }
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
    if (!localSnapshotAvailableRef.current) throw new Error('Local storage is unavailable. Reopen Savor before connecting GitHub.');
    const connectionGeneration = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = connectionGeneration;
    setSync({ phase: 'connecting', label: 'Checking GitHub…', message: 'Verifying the private data repository and token permissions.' });
    const normalizedToken = input.token.trim();
    const result = await validateGitHubConnection(normalizedToken, input.owner, input.repo);
    if (connectionGeneration !== connectionGenerationRef.current) return;
    const credential = await saveGitHubCredentials(result.connection, normalizedToken);
    if (connectionGeneration !== connectionGenerationRef.current) {
      await clearGitHubCredentials(credential.id).catch(() => undefined);
      return;
    }
    credentialIdRef.current = credential.id;
    if (navigator.storage?.persist) void navigator.storage.persist().catch(() => false);
    setToken(normalizedToken);
    setConnection(result.connection);
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
    await runSync(withUser, result.connection, normalizedToken);
  }, [runSync]);

  const disconnect = useCallback(async () => {
    if (disconnectingRef.current) return;
    const disconnectGeneration = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = disconnectGeneration;
    disconnectingRef.current = true;
    setSync({ phase: 'connecting', label: 'Removing saved token…', message: 'Stopping private GitHub sync on this device.' });
    try {
      await clearGitHubCredentials();
      if (disconnectGeneration !== connectionGenerationRef.current) return;
      credentialIdRef.current = null;
      setToken('');
      setConnection(null);
      setSync(LOCAL_STATUS);
    } catch {
      if (disconnectGeneration === connectionGenerationRef.current) {
        setSync({ phase: 'error', label: 'Could not stop GitHub sync', message: 'Savor could not remove the saved token from this device. Try again before closing the app.' });
      }
      throw new Error('Savor could not remove the saved GitHub token. Try again before closing the app.');
    } finally {
      disconnectingRef.current = false;
    }
  }, []);

  const syncNow = useCallback(async () => {
    const current = snapshotRef.current;
    if (current && connection) await runSync(current, connection, token);
  }, [connection, runSync, token]);

  const importRecipeUrl = useCallback((url: string, options?: GitHubImportOptions): Promise<ImportResult> => (
    queueGitHubRecipeImport(connection, token, url, options)
  ), [connection, token]);

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
      else if (connection && !token) setSync(TOKEN_REQUIRED_STATUS);
      else setSync(LOCAL_STATUS);
    };
    const handleOffline = () => {
      if (connection && !token) setSync(TOKEN_REQUIRED_STATUS);
      else setSync({ phase: 'offline', label: 'Offline', message: 'Changes are safe on this device and will sync when you reconnect.' });
    };
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

  return (
    <SavorApp
      data={snapshot.data}
      setData={updateData}
      connection={connection}
      hasGitHubToken={Boolean(token)}
      sync={sync}
      startInSettings={!connection || !token || sync.phase === 'needs-token'}
      onConnectGitHub={connect}
      onDisconnectGitHub={disconnect}
      onSyncNow={syncNow}
      onImportRecipeUrl={importRecipeUrl}
    />
  );
}
