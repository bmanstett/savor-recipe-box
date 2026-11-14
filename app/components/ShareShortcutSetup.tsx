'use client';

import { Check, ClipboardCopy, Share2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { shareShortcutPrefix } from '../../lib/share-intake';

export function ShareShortcutSetup() {
  const prefix = typeof window === 'undefined' ? '' : shareShortcutPrefix(window.location.href);
  const isLocalPreview = typeof window !== 'undefined'
    && /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);
  const addressRef = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [copied, setCopied] = useState(false);

  async function copyPrefix() {
    if (!prefix || isLocalPreview) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prefix);
      setCopied(true);
      setCopyStatus('Address copied. Paste it into the Text action in Shortcuts.');
    } catch {
      addressRef.current?.focus();
      addressRef.current?.select();
      setCopied(false);
      setCopyStatus('Address selected. Use Copy from the selection menu, or copy it manually below.');
    }
  }

  return (
    <section className="settings-section share-shortcut-setup">
      <div className="settings-section-heading"><span><Share2 size={19} /></span><div><h2>Share to Savor from iPhone</h2><p>Send a recipe from Instagram, NYT Cooking, or Safari.</p></div></div>
      <p className="share-shortcut-intro">Set up <strong>Save to Savor</strong> once in Apple Shortcuts. Then tap Share in a recipe app and choose Save to Savor. It opens Savor in your browser (normally Safari) for recipe review.</p>
      <details className="share-shortcut-details">
        <summary>Set up Save to Savor</summary>
        <div className="share-shortcut-steps">
          <p>On your iPhone, open <strong>Shortcuts</strong>, tap <strong>+</strong>, and name the new shortcut <strong>Save to Savor</strong>.</p>
          <div className="share-shortcut-editor"><a className="button button-secondary" href="shortcuts://create-shortcut">Open Shortcuts editor</a><p>Opens a blank shortcut on your iPhone. Follow the steps below to set it up.</p></div>
          <p>Open the shortcut’s <strong>Details</strong> and turn on <strong>Show in Share Sheet</strong>. In its input settings, select <strong>URLs</strong>, <strong>Text</strong>, and <strong>Safari Web Pages</strong>.</p>
          <p className="share-shortcut-action-heading">Add these actions in this order:</p>
          <ol className="share-shortcut-actions">
            <li><strong>Get URLs from Input</strong><span>Use <em>Shortcut Input</em> as the input.</span></li>
            <li><strong>Get Item from List</strong><span>Get <em>First Item</em> from the <em>URLs</em> output.</span></li>
            <li><strong>URL Encode</strong><span>Choose <em>Encode</em> and use <em>Item from List</em>.</span></li>
            <li><strong>Text</strong><span>Paste the Savor address below. Immediately after it, insert the <em>URL Encoded Text</em> variable from the previous action. Keep both on one line, with no spaces between them.</span></li>
            <li><strong>Open URLs</strong><span>Use the <em>Text</em> output from the previous action.</span></li>
          </ol>
          <div className="share-shortcut-address">
            <label htmlFor="savor-shortcut-address">Savor address for the Text action</label>
            <textarea
              id="savor-shortcut-address"
              ref={addressRef}
              rows={3}
              readOnly
              value={prefix}
              spellCheck={false}
              autoCapitalize="none"
              onFocus={(event) => event.currentTarget.select()}
              aria-describedby="savor-shortcut-address-help"
            />
            <button className="button button-secondary" type="button" disabled={!prefix || isLocalPreview} onClick={copyPrefix}>{copied ? <Check size={16} /> : <ClipboardCopy size={16} />}{copied ? 'Copied address' : 'Copy Savor address'}</button>
            <p id="savor-shortcut-address-help">{isLocalPreview ? 'This is a local preview. Open your published Savor address on your iPhone before copying the shortcut address.' : 'This address comes from the Savor app you have open. You can also select and copy it yourself.'}</p>
            <p className="share-shortcut-copy-status" role="status" aria-live="polite">{copyStatus}</p>
          </div>
          <p>Tap <strong>Done</strong>. In Instagram or NYT Cooking, open a recipe and tap <strong>Share → Save to Savor</strong>. If Instagram first shows its own sharing panel, choose the system share option to find your shortcut.</p>
          <p className="share-shortcut-note">Safari may need its own connection to your private GitHub repository, even if Savor on your Home Screen is already connected. Keep API keys and tokens out of the shortcut. You review every recipe before saving; private pages and recipes available only in a video may still need recipe text.</p>
        </div>
      </details>
    </section>
  );
}
