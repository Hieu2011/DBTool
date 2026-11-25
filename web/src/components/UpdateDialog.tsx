import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { UpdateConfig, UpdateInfo } from '../types';
import { IconCheck, IconClose, IconDownload } from './icons';

interface Props {
  /** Tabs with unsaved text or an open transaction: the update restarts the app. */
  strUnsaved: string | null;
  onClose: () => void;
}

const errorText = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);
const megabytes = (intBytes: number) => `${(intBytes / 1048576).toFixed(0)} MB`;

/** Help > Check for updates: the share link the new versions come from, the check, and the update itself. */
export function UpdateDialog({ strUnsaved, onClose }: Props) {
  const [objConfig, setObjConfig] = useState<UpdateConfig | null>(null);
  const [strUrl, setStrUrl] = useState('');
  const [strPassword, setStrPassword] = useState('');
  const [strBusy, setStrBusy] = useState<'check' | 'apply' | null>(null);
  const [objInfo, setObjInfo] = useState<UpdateInfo | null>(null);
  const [strError, setStrError] = useState<string | null>(null);
  const [objProgress, setObjProgress] = useState<{ received: number; total?: number | null } | null>(null);
  const [boolRestarting, setBoolRestarting] = useState(false);

  /** Saves the link when it was changed, then asks the folder for its version. */
  const check = async (objCurrent: UpdateConfig, strLink: string, strSecret: string) => {
    setStrBusy('check');
    setStrError(null);
    setObjInfo(null);
    try {
      if (strLink.trim() !== (objCurrent.url ?? '') || strSecret !== '')
        setObjConfig(await api.saveUpdateConfig(strLink.trim(), strSecret === '' ? undefined : strSecret));
      setStrPassword('');
      setObjInfo(await api.checkUpdate());
    } catch (objEx) {
      setStrError(errorText(objEx));
    } finally {
      setStrBusy(null);
    }
  };

  useEffect(() => {
    api.updateConfig().then(objLoaded => {
      setObjConfig(objLoaded);
      setStrUrl(objLoaded.url ?? '');
      if (objLoaded.url) check(objLoaded, objLoaded.url, '');
    }, objEx => setStrError(errorText(objEx)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (objEvent: KeyboardEvent) => objEvent.key === 'Escape' && strBusy !== 'apply' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, strBusy]);

  // Download progress while the update runs.
  useEffect(() => {
    if (strBusy !== 'apply') return;
    const intTimer = setInterval(() => { api.updateProgress().then(objNow => setObjProgress(objNow ?? null), () => {}); }, 400);
    return () => clearInterval(intTimer);
  }, [strBusy]);

  const apply = async () => {
    if (strUnsaved && !confirm(`${strUnsaved}\n\nThe update closes DbStudio and opens the new version. Continue?`)) return;
    setStrBusy('apply');
    setStrError(null);
    setObjProgress(null);
    try {
      await api.applyUpdate();
      setBoolRestarting(true); // the app closes by itself in a moment
    } catch (objEx) {
      setStrError(errorText(objEx));
      setStrBusy(null);
    }
  };

  const intPercent = objProgress?.total ? Math.min(100, Math.round((objProgress.received / objProgress.total) * 100)) : null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onMouseDown={strBusy === 'apply' ? undefined : onClose}>
      <div onMouseDown={objEvent => objEvent.stopPropagation()} className="w-[32rem] rounded-md border border-line bg-raised shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-line py-2 pl-4 pr-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            Updates <span className="ml-1 font-normal text-muted">DbStudio {objConfig?.currentVersion}</span>
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={strBusy === 'apply'} aria-label="Close" title="Close (Esc)"><IconClose /></button>
        </div>

        <form className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-2.5 p-4"
          onSubmit={objEvent => { objEvent.preventDefault(); if (objConfig) check(objConfig, strUrl, strPassword); }}>
          <label htmlFor="u-url" className="text-muted">Update link</label>
          <input id="u-url" className="field font-mono text-xs" spellCheck={false} value={strUrl} placeholder="https://cloud.example.com/index.php/s/AbCdEf123"
            onChange={objEvent => setStrUrl(objEvent.target.value)} />
          <label htmlFor="u-pass" className="text-muted">Link password</label>
          <input id="u-pass" className="field" type="password" autoComplete="new-password" value={strPassword}
            placeholder={objConfig?.hasPassword ? 'Saved. Type only to change it' : 'Empty if the link has none'}
            onChange={objEvent => setStrPassword(objEvent.target.value)} />
          <span />
          <div className="flex items-center gap-2">
            <button type="submit" className="btn" disabled={!objConfig || strBusy !== null || strUrl.trim() === ''}>
              {strBusy === 'check' ? 'Checking…' : 'Check for updates'}
            </button>
            <span className="text-[11px] text-muted">Public share link of the folder holding DbStudio.exe + version.json</span>
          </div>
        </form>

        {strBusy === 'check' && <div className="mx-4 mb-3"><div className="progress-bar" /></div>}

        {objInfo && !objInfo.available && strBusy === null && (
          <p role="status" className="mx-4 mb-3 flex items-center gap-2 rounded border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
            <IconCheck intSize={14} /> You have the latest version ({objInfo.currentVersion}).
          </p>
        )}

        {objInfo?.available && (
          <div className="mx-4 mb-3 rounded border border-accent/50 bg-accent/10 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">Version {objInfo.latestVersion} is available</div>
                <div className="text-muted">You have {objInfo.currentVersion}.</div>
              </div>
              <button className="btn btn-primary" onClick={apply} disabled={strBusy !== null || boolRestarting || !objConfig?.canApply}
                title={objConfig?.canApply ? 'Download it, replace DbStudio.exe and restart' : 'Only the published DbStudio.exe can update itself'}>
                <IconDownload intSize={14} /> {strBusy === 'apply' ? 'Updating…' : 'Update and restart'}
              </button>
            </div>
            {objInfo.notes && <p className="mt-2 whitespace-pre-wrap border-t border-line/60 pt-2 text-fg" style={{ userSelect: 'text' }}>{objInfo.notes}</p>}
            {strBusy === 'apply' && (
              <div className="mt-2.5" role="status">
                <div className="mb-1 flex justify-between text-muted">
                  <span>{boolRestarting ? 'Installed. Restarting…' : 'Downloading…'}</span>
                  <span className="tabular-nums">
                    {objProgress ? `${megabytes(objProgress.received)}${objProgress.total ? ` of ${megabytes(objProgress.total)}` : ''}` : ''}
                  </span>
                </div>
                {intPercent === null || boolRestarting
                  ? <div className="progress-bar" />
                  : <div className="h-[3px] overflow-hidden rounded-sm bg-accent/20"><div className="h-full rounded-sm bg-accent" style={{ width: `${intPercent}%` }} /></div>}
              </div>
            )}
          </div>
        )}

        {strError && (
          <p role="alert" className="mx-4 mb-3 whitespace-pre-wrap break-words rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
            style={{ userSelect: 'text' }}>{strError}</p>
        )}
      </div>
    </div>
  );
}
