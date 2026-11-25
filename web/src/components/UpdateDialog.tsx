import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { UpdateConfig, UpdateInfo } from '../types';
import { IconCheck, IconClose, IconDatabase, IconDownload, IconRefresh } from './icons';

const AUTHOR = 'Nguyễn Trung Hiếu';

interface Props {
  /** Tabs with unsaved text or an open transaction: the update restarts the app. */
  strUnsaved: string | null;
  onClose: () => void;
}

const errorText = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);
/** 2026-11-25 -> 25/11/2026 */
const dayText = (strDate: string) => strDate.split('-').reverse().join('/');
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
  // The password box stays away while a saved password works: it comes back when the link refuses it, or on request.
  const [boolAskPassword, setBoolAskPassword] = useState(false);

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
      setBoolAskPassword(false);
    } catch (objEx) {
      if (objEx instanceof ApiError && objEx.detail.code === 'UpdateAuth') setBoolAskPassword(true);
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

  // Nothing saved yet, the link refused what is saved, the link itself changed, or the user asked.
  const boolPasswordBox = !objConfig?.hasPassword || boolAskPassword || strUrl.trim() !== (objConfig.url ?? '');

  const intPercent = objProgress?.total ? Math.min(100, Math.round((objProgress.received / objProgress.total) * 100)) : null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onMouseDown={strBusy === 'apply' ? undefined : onClose}>
      <div onMouseDown={objEvent => objEvent.stopPropagation()} className="w-[32rem] rounded-md border border-line bg-raised shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line py-3 pl-4 pr-2">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg"><IconDatabase intSize={22} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              DbStudio
              {objConfig && (
                <span className="rounded-full border border-accent/50 bg-accent/10 px-2 py-px font-mono text-[11px] font-semibold text-accent">
                  v{objConfig.currentVersion}
                </span>
              )}
            </h2>
            <p className="mt-0.5 text-xs text-muted">Author: <span className="text-fg">{AUTHOR}</span></p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={strBusy === 'apply'} aria-label="Close" title="Close (Esc)"><IconClose /></button>
        </div>

        <form className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-2.5 p-4"
          onSubmit={objEvent => { objEvent.preventDefault(); if (objConfig) check(objConfig, strUrl, strPassword); }}>
          <label htmlFor="u-url" className="text-muted">Update link</label>
          <input id="u-url" className="field font-mono text-xs" spellCheck={false} value={strUrl} placeholder="https://cloud.example.com/index.php/s/AbCdEf123"
            onChange={objEvent => setStrUrl(objEvent.target.value)} />
          {boolPasswordBox
            ? (
              <>
                <label htmlFor="u-pass" className="text-muted">Link password</label>
                <input id="u-pass" className="field" type="password" autoComplete="new-password" value={strPassword} autoFocus={boolAskPassword}
                  placeholder={objConfig?.hasPassword ? 'Type the current password of the link' : 'Empty if the link has none'}
                  onChange={objEvent => setStrPassword(objEvent.target.value)} />
              </>
            )
            : (
              <>
                <span className="text-muted">Link password</span>
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex items-center gap-1.5 text-success"><IconCheck intSize={13} /> Saved on this computer</span>
                  <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setBoolAskPassword(true)}>Change…</button>
                </div>
              </>
            )}
          <p className="col-span-2 text-[11px] leading-snug text-muted">
            The public share link of the folder that holds DbStudio.exe and version.json. Nothing is downloaded until you press Update.
          </p>
          <div className="col-span-2 flex justify-end">
            <button type="submit" className="btn shrink-0 whitespace-nowrap" disabled={!objConfig || strBusy !== null || strUrl.trim() === ''}>
              <IconRefresh intSize={14} /> {strBusy === 'check' ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
        </form>

        {strBusy === 'check' && <div className="mx-4 mb-3"><div className="progress-bar" /></div>}

        {objInfo && !objInfo.available && strBusy === null && (objInfo.latestVersion === objInfo.currentVersion
          ? (
            <p role="status" className="mx-4 mb-3 flex items-center gap-2 rounded border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
              <IconCheck intSize={14} /> You have the latest version (v{objInfo.currentVersion}{objInfo.releasedOn ? `, released ${dayText(objInfo.releasedOn)}` : ''}), the same as the update folder.
            </p>
          )
          : (
            // Only the publisher's machine gets here: the build was not uploaded yet.
            <div role="status" className="mx-4 mb-3 rounded border border-env-amber/50 bg-env-amber/10 px-3 py-2 text-xs">
              <div className="font-semibold">This version (v{objInfo.currentVersion}) is newer than the update folder (v{objInfo.latestVersion}{objInfo.releasedOn ? `, released ${dayText(objInfo.releasedOn)}` : ''})</div>
              <div className="mt-0.5 text-muted">
                Other machines will not see v{objInfo.currentVersion} until DbStudio.exe and version.json are uploaded to the folder.
              </div>
            </div>
          ))}

        {objInfo?.available && (
          <div className="mx-4 mb-3 rounded border border-accent/50 bg-accent/10 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">Version v{objInfo.latestVersion} is available</div>
                <div className="text-muted">
                  {objInfo.releasedOn && <>Released {dayText(objInfo.releasedOn)} · </>}You have v{objInfo.currentVersion}.
                </div>
              </div>
              <button className="btn btn-primary shrink-0 whitespace-nowrap" onClick={apply} disabled={strBusy !== null || boolRestarting || !objConfig?.canApply}
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
