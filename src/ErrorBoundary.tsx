import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clearAllLocalData, readLocalSnapshot } from '../lib/client-cache';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  busy: string | null;
  note: string | null;
}

// One malformed record must not turn into a blank screen on every launch.
// The boundary keeps the household's data reachable: export it, reload, or
// as a last resort clear this device and pull from GitHub again.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, busy: null, note: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Savor crashed while rendering', error, info.componentStack);
  }

  exportBackup = async () => {
    this.setState({ busy: 'export', note: null });
    try {
      const snapshot = await readLocalSnapshot();
      if (!snapshot) throw new Error('No local data was found on this device.');
      const { recipes, mealPlan, groceryItems, preferences, syncedAt } = snapshot.data;
      const payload = JSON.stringify({ format: 'savor-household-backup', version: 1, exportedAt: new Date().toISOString(), recipes, mealPlan, groceryItems, preferences, syncedAt }, null, 2);
      const filename = `savor-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const file = new File([payload], filename, { type: 'application/json' });
      const sharing = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
      if (typeof sharing.share === 'function' && sharing.canShare?.({ files: [file] })) {
        await sharing.share({ files: [file], title: 'Savor backup' });
      } else {
        const href = URL.createObjectURL(file);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
      }
      this.setState({ note: 'Backup saved.' });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      this.setState({ note: caught instanceof Error ? caught.message : 'The backup could not be created.' });
    } finally {
      this.setState({ busy: null });
    }
  };

  resetDevice = async () => {
    if (!window.confirm('Remove Savor’s data from this device? Recipes synced to GitHub can be pulled again after you reconnect. Export a backup first if you are unsure.')) return;
    this.setState({ busy: 'reset', note: null });
    try {
      await clearAllLocalData();
      window.location.reload();
    } catch (caught) {
      this.setState({ busy: null, note: caught instanceof Error ? caught.message : 'Local data could not be cleared.' });
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal-error" role="alert">
        <span>!</span>
        <p className="eyebrow">Something went wrong</p>
        <h1>Savor hit a snag while drawing the screen.</h1>
        <p>Your recipes are still saved on this device. Reloading usually fixes it. If it keeps happening, export a backup and then clear this device’s copy.</p>
        <p className="fatal-error-detail">{this.state.error.message}</p>
        <div className="fatal-error-actions">
          <button className="button button-primary" type="button" onClick={() => window.location.reload()}>Reload Savor</button>
          <button className="button button-secondary" type="button" disabled={this.state.busy !== null} onClick={this.exportBackup}>{this.state.busy === 'export' ? 'Preparing…' : 'Export backup'}</button>
          <button className="button button-ghost" type="button" disabled={this.state.busy !== null} onClick={this.resetDevice}>{this.state.busy === 'reset' ? 'Clearing…' : 'Clear this device'}</button>
        </div>
        {this.state.note ? <p className="fatal-error-note">{this.state.note}</p> : null}
      </div>
    );
  }
}
