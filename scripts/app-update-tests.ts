import assert from 'node:assert/strict';
import { watchAppUpdate } from '../lib/app-update.ts';

class Worker extends EventTarget {
  state: string;
  constructor(state: string) { super(); this.state = state; }
  transition(state: string) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
class Registration extends EventTarget {
  installing: Worker | null = null;
  waiting: Worker | null = null;
  active: Worker | null = null;
  install(worker: Worker) { this.installing = worker; this.dispatchEvent(new Event('updatefound')); }
}
class Container extends EventTarget {
  controller: Worker | null;
  constructor(worker: Worker | null) { super(); this.controller = worker; }
  control(worker: Worker) { this.controller = worker; this.dispatchEvent(new Event('controllerchange')); }
}

{
  const original = new Worker('activated');
  const registration = new Registration();
  registration.active = original;
  const container = new Container(original);
  let notices = 0;
  const stop = watchAppUpdate(registration, container, () => { notices += 1; });
  const update = new Worker('installing');
  registration.install(update);
  update.transition('installed');
  update.transition('activating');
  assert.equal(notices, 0, 'never offer reload while the app shell is still activating');
  update.transition('activated');
  assert.equal(notices, 1);
  container.control(update);
  assert.equal(notices, 1, 'state and controller events only announce the update once');
  stop();
}

{
  // register() can finish after updatefound already fired.
  const registration = new Registration();
  const update = new Worker('installing');
  registration.installing = update;
  let notices = 0;
  const stop = watchAppUpdate(registration, new Container(new Worker('activated')), () => { notices += 1; });
  update.transition('activated');
  assert.equal(notices, 1, 'an already-started installation must still produce a notice');
  stop();
}

{
  // Another tab can activate a worker without this tab seeing updatefound.
  const registration = new Registration();
  const container = new Container(new Worker('activated'));
  let notices = 0;
  const stop = watchAppUpdate(registration, container, () => { notices += 1; });
  container.control(new Worker('activated'));
  assert.equal(notices, 1, 'controller changes must surface an activated update');
  stop();
}

{
  const registration = new Registration();
  const container = new Container(null);
  let notices = 0;
  const stop = watchAppUpdate(registration, container, () => { notices += 1; });
  const first = new Worker('installing');
  registration.install(first);
  first.transition('activated');
  container.control(first);
  assert.equal(notices, 0, 'first installation is not an update');
  const later = new Worker('installing');
  registration.install(later);
  later.transition('activated');
  assert.equal(notices, 1, 'a later update during the same first session must be detected');
  stop();
}

{
  const registration = new Registration();
  const waiting = new Worker('installed');
  registration.waiting = waiting;
  const container = new Container(new Worker('activated'));
  let notices = 0;
  const stop = watchAppUpdate(registration, container, () => { notices += 1; });
  assert.equal(notices, 0, 'a waiting worker must activate before offering reload');
  stop();
  waiting.transition('activated');
  container.control(waiting);
  registration.install(new Worker('activated'));
  assert.equal(notices, 0, 'cleanup removes registration, controller, and worker listeners');
}

console.log('App update lifecycle tests passed: activation readiness, install race, controller change, first install, and cleanup.');
