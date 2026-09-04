/**
 * AdminPanel.tsx
 *
 * Moderation queue for pending sticker submissions. Mounted `client:only` on
 * /admin — the page itself is static and holds no secrets, so the gate is the
 * API: every /api/admin/* route 401s without a live session, and this component
 * simply renders whichever state the server reports.
 *
 * That split matters. The login form here is a convenience, not the security
 * boundary; hiding the UI would protect nothing on its own.
 */

import { useCallback, useEffect, useState } from 'react';

interface PendingRow {
  row?: number;
  name: string;
  latitude: string;
  longitude: string;
  date: string;
  description: string;
  photo_url: string;
  placed_by: string;
}

type Verdict = 'active' | 'rejected' | 'review';

const VERDICTS: { status: Verdict; label: string; kind: string }[] = [
  { status: 'active', label: 'Approve', kind: 'approve' },
  { status: 'review', label: 'Defer', kind: 'defer' },
  { status: 'rejected', label: 'Reject', kind: 'reject' },
];

/** A row's identity for the status write: photo_url when it has one, else row. */
function identify(item: PendingRow): { photo_url?: string; row?: number } {
  return item.photo_url ? { photo_url: item.photo_url } : { row: item.row };
}

/** Stable per-item key — photo_url is unique; photo-less rows fall back to row. */
function itemKey(item: PendingRow): string {
  return item.photo_url || `row-${item.row}`;
}

export default function AdminPanel() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = still checking
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);

  const [pending, setPending] = useState<PendingRow[]>([]);
  const [queueError, setQueueError] = useState('');
  const [loadingQueue, setLoadingQueue] = useState(false);
  // Keys of rows currently being written, so their buttons disable individually.
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');

  const loadQueue = useCallback(async () => {
    setLoadingQueue(true);
    setQueueError('');
    try {
      const res = await fetch('/api/admin/pending');
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = (await res.json()) as { ok?: boolean; pending?: PendingRow[]; error?: string };
      if (!data.ok) throw new Error(data.error ?? 'Could not load the queue.');
      setPending(data.pending ?? []);
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : 'Could not load the queue.');
    } finally {
      setLoadingQueue(false);
    }
  }, []);

  // Ask the server whether this browser already holds a session.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/login')
      .then((r) => r.json())
      .then((d) => {
        const parsed = d as { authenticated?: boolean };
        if (!cancelled) setAuthed(Boolean(parsed?.authenticated));
      })
      .catch(() => {
        if (!cancelled) setAuthed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authed) void loadQueue();
  }, [authed, loadQueue]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginError('');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setLoginError(
          res.status === 429
            ? 'Too many attempts. Wait a few minutes and try again.'
            : 'That password was not accepted.',
        );
        return;
      }
      setPassword(''); // don't leave it sitting in component state
      setAuthed(true);
    } catch {
      setLoginError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    setPending([]);
    setAuthed(false);
  }

  async function setStatus(item: PendingRow, status: Verdict, label: string) {
    const key = itemKey(item);
    setWorking((prev) => new Set(prev).add(key));
    setNotice('');
    try {
      const res = await fetch('/api/admin/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...identify(item), status }),
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? 'The sheet rejected that update.');
      // Drop it locally rather than refetching the whole queue — one less
      // round trip, and the row is provably no longer pending.
      setPending((prev) => prev.filter((p) => itemKey(p) !== key));
      setNotice(`${label}: ${item.name || 'untitled sighting'}`);
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setWorking((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  if (authed === null) {
    return <div className="map-skeleton" style={{ height: 200 }} />;
  }

  if (!authed) {
    return (
      <form className="card admin-login" onSubmit={handleLogin}>
        <h2>Officer sign-in</h2>
        <p className="admin-muted">
          Approving a submission publishes it on the public map.
        </p>
        <label htmlFor="admin-password">Admin password</label>
        <input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {loginError && <p className="admin-error">{loginError}</p>}
        <button type="submit" className="poc-cta-button" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    );
  }

  return (
    <div className="admin-queue">
      <div className="admin-bar">
        <span className="admin-muted">
          {loadingQueue
            ? 'Loading…'
            : `${pending.length} submission${pending.length === 1 ? '' : 's'} awaiting review`}
        </span>
        <span className="admin-bar-actions">
          <button type="button" className="admin-btn" onClick={() => void loadQueue()}>
            Refresh
          </button>
          <button type="button" className="admin-btn" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </span>
      </div>

      {notice && <p className="admin-notice">{notice}</p>}
      {queueError && <p className="admin-error">{queueError}</p>}

      {!loadingQueue && pending.length === 0 && !queueError && (
        <div className="card admin-empty">Nothing pending. The queue is clear. 🎉</div>
      )}

      {pending.map((item) => {
        const key = itemKey(item);
        const isWorking = working.has(key);
        return (
          <article className="card admin-item" key={key}>
            {item.photo_url ? (
              <a href={item.photo_url} target="_blank" rel="noreferrer">
                <img src={item.photo_url} alt="" className="admin-thumb" loading="lazy" />
              </a>
            ) : (
              <div className="admin-thumb admin-thumb-empty">No photo</div>
            )}

            <div className="admin-item-body">
              <h3>{item.name || 'Untitled sighting'}</h3>
              <p className="admin-muted">
                {item.placed_by ? `Placed by ${item.placed_by}` : 'No name given'}
                {item.date ? ` · ${item.date}` : ''}
                {item.latitude && item.longitude ? ` · ${item.latitude}, ${item.longitude}` : ''}
              </p>
              {item.description && <p className="admin-desc">{item.description}</p>}

              <div className="admin-actions">
                {VERDICTS.map((v) => (
                  <button
                    key={v.status}
                    type="button"
                    className={`admin-btn admin-btn-${v.kind}`}
                    disabled={isWorking}
                    onClick={() => void setStatus(item, v.status, v.label + 'd')}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
