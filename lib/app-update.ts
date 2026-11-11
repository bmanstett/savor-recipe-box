interface UpdateWorker extends EventTarget {
  readonly state: string;
}

interface UpdateRegistration extends EventTarget {
  readonly installing: UpdateWorker | null;
  readonly waiting: UpdateWorker | null;
  readonly active: UpdateWorker | null;
}

interface UpdateContainer extends EventTarget {
  readonly controller: UpdateWorker | null;
}

/** Watch already-running installs as well as later updates, without reloading edits. */
export function watchAppUpdate(
  registration: UpdateRegistration,
  container: UpdateContainer,
  onReady: () => void,
): () => void {
  let originalController = container.controller;
  const watched = new Map<UpdateWorker, EventListener>();
  let announced = false;
  let active = true;

  const inspect = (worker: UpdateWorker | null) => {
    // Do not offer a reload during the first installation or before the new
    // worker has finished activation and can serve the new app shell.
    if (!active || announced || !originalController || !worker
        || worker === originalController || worker.state !== 'activated') return;
    announced = true;
    onReady();
  };
  const watch = (worker: UpdateWorker | null) => {
    if (!worker || watched.has(worker)) return;
    const onStateChange = () => inspect(worker);
    watched.set(worker, onStateChange);
    worker.addEventListener('statechange', onStateChange);
    inspect(worker);
  };
  const onUpdateFound = () => watch(registration.installing);
  const onControllerChange = () => {
    // An uncontrolled first visit becomes controlled after its first install.
    // That is our baseline, so a later update in this same session still works.
    originalController ??= container.controller;
    watch(container.controller);
    inspect(container.controller);
  };

  registration.addEventListener('updatefound', onUpdateFound);
  container.addEventListener('controllerchange', onControllerChange);
  watch(registration.installing);
  watch(registration.waiting);
  watch(registration.active);
  onControllerChange();

  return () => {
    active = false;
    registration.removeEventListener('updatefound', onUpdateFound);
    container.removeEventListener('controllerchange', onControllerChange);
    watched.forEach((listener, worker) => worker.removeEventListener('statechange', listener));
    watched.clear();
  };
}
