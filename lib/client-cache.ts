'use client';

import type { BootstrapData } from './types';

const DB_NAME = 'savor-local-cache';
const DB_VERSION = 1;
const STATE_STORE = 'state';
const QUEUE_STORE = 'mutation-queue';

export interface QueuedMutation {
  id?: number;
  url: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  createdAt: string;
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cacheBootstrap(data: BootstrapData): Promise<void> {
  const db = await openCache();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STATE_STORE, 'readwrite');
    transaction.objectStore(STATE_STORE).put(data, 'bootstrap');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function readCachedBootstrap(): Promise<BootstrapData | null> {
  const db = await openCache();
  const value = await new Promise<BootstrapData | null>((resolve, reject) => {
    const request = db.transaction(STATE_STORE).objectStore(STATE_STORE).get('bootstrap');
    request.onsuccess = () => resolve((request.result as BootstrapData | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

export async function queueMutation(mutation: Omit<QueuedMutation, 'createdAt'>): Promise<void> {
  const db = await openCache();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(QUEUE_STORE, 'readwrite');
    transaction.objectStore(QUEUE_STORE).add({ ...mutation, createdAt: new Date().toISOString() });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function flushMutationQueue(): Promise<number> {
  const db = await openCache();
  const queued = await new Promise<QueuedMutation[]>((resolve, reject) => {
    const request = db.transaction(QUEUE_STORE).objectStore(QUEUE_STORE).getAll();
    request.onsuccess = () => resolve(request.result as QueuedMutation[]);
    request.onerror = () => reject(request.error);
  });
  let completed = 0;
  for (const mutation of queued) {
    try {
      const response = await fetch(mutation.url, {
        method: mutation.method,
        headers: mutation.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: mutation.body === undefined ? undefined : JSON.stringify(mutation.body),
      });
      if (!response.ok) break;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(QUEUE_STORE, 'readwrite');
        transaction.objectStore(QUEUE_STORE).delete(mutation.id!);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      completed += 1;
    } catch {
      break;
    }
  }
  db.close();
  return completed;
}

export function clearLocalCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
