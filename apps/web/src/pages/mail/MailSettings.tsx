import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';
import { Button, Spinner, PageHeader } from '../../components/ui';
import { RichTextEditor } from './RichTextEditor';
import * as api from './api';
import type { MailPrefs } from '@tupo/shared';
import './mail.css';

export const MailSettings: React.FC = () => {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState<MailPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.getPrefs().then(setPrefs).catch(() => setPrefs({ displayName: null, signatureHtml: '', signatureEnabled: false, emailCopies: false })); }, []);

  if (!prefs) return <div className="grid h-full place-items-center"><Spinner /></div>;

  const save = async () => {
    setBusy(true); setSaved(false);
    try { setPrefs(await api.updatePrefs(prefs)); setSaved(true); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <button onClick={() => navigate('/app/mail')} className="mb-3 inline-flex items-center gap-1 text-sm text-blue-600"><ArrowLeft size={15} /> Back to mail</button>
      <PageHeader title="Mail settings" subtitle="Your display name, signature and delivery preferences." />

      <div className="space-y-5">
        <div>
          <label className="mb-1 block text-sm font-medium">Display name</label>
          <input value={prefs.displayName ?? ''} onChange={(e) => setPrefs({ ...prefs, displayName: e.target.value || null })}
            placeholder="Defaults to your account name"
            className="w-full rounded-xl border border-border-light bg-transparent px-3 py-2 text-sm dark:border-border-dark/60" />
        </div>

        <div>
          <label className="mb-2 flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={prefs.signatureEnabled} onChange={(e) => setPrefs({ ...prefs, signatureEnabled: e.target.checked })} className="accent-blue-600" />
            Append a signature to new messages
          </label>
          {prefs.signatureEnabled && (
            <RichTextEditor value={prefs.signatureHtml} onChange={(html) => setPrefs({ ...prefs, signatureHtml: html })} minimal placeholder="Your signature" />
          )}
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={prefs.emailCopies} onChange={(e) => setPrefs({ ...prefs, emailCopies: e.target.checked })} className="mt-0.5 accent-blue-600" />
          <span>
            <span className="font-medium">Also email me a copy</span>
            <span className="block text-xs text-text-secondary-light dark:text-text-secondary-dark">
              Internal mail is delivered in-app by default. Turn this on to also receive an SMTP copy at your address.
            </span>
          </span>
        </label>

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save</Button>
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
        </div>
      </div>
    </div>
  );
};

export default MailSettings;
