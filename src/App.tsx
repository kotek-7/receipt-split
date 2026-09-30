import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Copy,
  ImagePlus,
  Link,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ReceiptText,
  RotateCcw,
  Share2,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { Identity, ParsedReceipt, ReceiptItem, Room, SessionResponse } from '../shared/types';
import { calculateSettlement, getItemSplitMode, getSelectionQuantity } from '../shared/settlement';
import { createItemId } from '../shared/id';
import { canSaveSession, getIdentity, getRecents, getRoom, request, saveSession } from './api';
import CameraCapture from './CameraCapture';
import ItemSelection from './ItemSelection';
import LandingGuide from './LandingGuide';
import BrandMark from './BrandMark';

const yen = (n: number) =>
  new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(n);
const newItem = (name = '', amount = 0): ReceiptItem => ({
  id: createItemId(),
  name,
  amount,
  splitMode: 'quantity',
});
const demo = (): ParsedReceipt => ({
  title: '金曜の居酒屋',
  total: 4200,
  rawText: '',
  items: [
    { ...newItem('生ビール', 1800), quantity: 3 },
    { ...newItem('ウーロン茶', 600), quantity: 2 },
    { ...newItem('唐揚げ', 900), splitMode: 'equal' },
    { ...newItem('枝豆', 500), splitMode: 'equal' },
    { ...newItem('ポテト', 400), splitMode: 'equal' },
  ],
});
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'うまく処理できませんでした。もう一度お試しください。';

function Brand() {
  return (
    <a href="/" className="brand" aria-label="レシわけ ホーム">
      <span className="brand-icon">
        <BrandMark />
      </span>
      レシわけ<span className="brand-dot">.</span>
    </a>
  );
}
function ErrorMessage({ children }: { children: string }) {
  return children ? (
    <div className="error" role="alert">
      {children}
    </div>
  ) : null;
}
function Spinner() {
  return <LoaderCircle size={18} className="spin" aria-hidden="true" />;
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [draft, setDraft] = useState<ParsedReceipt>();
  const [createdRoomId, setCreatedRoomId] = useState<string>();
  const [photo, setPhoto] = useState<string>();
  const [scan, setScan] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const activeScan = useRef<AbortController | null>(null);
  const gallery = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = () => {
      activeScan.current?.abort();
      setCameraOpen(false);
      setPhoto(undefined);
      setPath(location.pathname);
      setDraft(undefined);
    };
    window.addEventListener('popstate', handler);
    return () => {
      window.removeEventListener('popstate', handler);
      activeScan.current?.abort();
      activeScan.current = null;
    };
  }, []);
  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo);
    },
    [photo],
  );
  const navigate = (next: string) => {
    activeScan.current?.abort();
    setCameraOpen(false);
    setPhoto(undefined);
    history.pushState(null, '', next);
    setPath(next);
    setDraft(undefined);
    setError('');
    window.scrollTo(0, 0);
  };
  const importPhoto = async (file?: File) => {
    if (!file || activeScan.current) return;
    const controller = new AbortController();
    activeScan.current = controller;
    setCameraOpen(false);
    setPhoto(undefined);
    if (gallery.current) gallery.current.value = '';
    setError('');
    setScan(0);
    try {
      const { recognizeReceipt } = await import('./ocr');
      const { receipt: result, preview } = await recognizeReceipt(file, setScan, controller.signal);
      if (controller.signal.aborted) return;
      setPhoto(URL.createObjectURL(preview));
      setDraft(result.items.length ? result : { ...result, items: [newItem()] });
      if (!result.items.length)
        setError(
          'レシートの内容を読み取れませんでした。写真を見ながら入力するか、明るい場所で撮り直してください。',
        );
    } catch (e) {
      if (!controller.signal.aborted) setError(errorText(e));
    } finally {
      if (activeScan.current === controller) {
        activeScan.current = null;
        setScan(null);
      }
    }
  };
  const roomId = /^\/r\/([\w-]+)$/.exec(path)?.[1];
  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <button className="text-button help-button" onClick={() => setHelp(true)}>
            <CircleHelp size={17} />
            使い方
          </button>
        </div>
      </header>
      <input
        hidden
        ref={gallery}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => void importPhoto(e.target.files?.[0])}
      />
      {roomId ? (
        <RoomPage key={roomId} id={roomId} openShareInitially={createdRoomId === roomId} />
      ) : draft ? (
        <Editor
          draft={draft}
          photo={photo}
          error={error}
          setError={setError}
          onBack={() => {
            setDraft(undefined);
            setPhoto(undefined);
            setError('');
          }}
          onCreated={(data) => {
            saveSession(data);
            setCreatedRoomId(data.room.id);
            navigate(`/r/${data.room.id}`);
          }}
        />
      ) : (
        <main className="home container">
          <div className="hero">
            <section className="hero-copy">
              <h1>
                飲み会の会計を、
                <br />
                <span>飲んだ分、食べた分。</span>
              </h1>
              <p className="home-intro">
                家飲みの食材・お酒の買い出しも、居酒屋の注文も。
                レシートを共有し、それぞれが飲んだもの・食べたものを選ぶと、立て替えた人に返す金額が分かります。
              </p>
              <p className="home-availability">会員登録・アプリのインストールは不要です。</p>
              <div
                className="mini-receipt receipt-edge"
                aria-label="料理や飲み物を選んで割り勘する例"
              >
                <div className="mini-receipt-title">
                  <ReceiptText size={16} />
                  レシート
                </div>
                <div className="mini-item">
                  <span className="mini-check">
                    <Check size={13} />
                  </span>
                  <span>唐揚げ</span>
                  <strong>¥900</strong>
                  <span className="mini-avatar">あ</span>
                  <span className="mini-avatar alternate">ゆ</span>
                </div>
                <div className="mini-item">
                  <span className="mini-check">
                    <Check size={13} />
                  </span>
                  <span>生ビール</span>
                  <strong>¥600</strong>
                  <span className="mini-avatar">あ</span>
                </div>
                <div className="mini-total">
                  <span>あなたの分</span>
                  <strong>¥1,050</strong>
                </div>
              </div>
            </section>
            <section className="start-card receipt-edge" id="start">
              <h2>割り勘をはじめる</h2>
              <div
                className={`upload-area ${scan !== null ? 'scanning' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (scan === null) void importPhoto(e.dataTransfer.files[0]);
                }}
              >
                <div className="scan-illustration">
                  <ReceiptText size={48} strokeWidth={1.4} />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                {scan !== null ? (
                  <>
                    <h3>レシートを読み取り中…</h3>
                    <p>初回は少し時間がかかります</p>
                    <div className="progress-track">
                      <span style={{ width: `${scan}%` }} />
                    </div>
                    <span className="progress-text" role="status">
                      {Math.round(scan)}%
                    </span>
                  </>
                ) : (
                  <>
                    <p className="drop-hint">写真をここにドロップ</p>
                    <button className="button primary full" onClick={() => setCameraOpen(true)}>
                      <Camera size={19} />
                      レシートを撮る
                    </button>
                    <button
                      className="button secondary full"
                      onClick={() => gallery.current?.click()}
                    >
                      <ImagePlus size={18} />
                      写真から選ぶ
                    </button>
                    <span className="file-note">JPG・PNG・WebP / 最大20MB</span>
                  </>
                )}
              </div>
              <ErrorMessage>{error}</ErrorMessage>
              <div className="alternative">
                <button
                  className="text-button"
                  disabled={scan !== null}
                  onClick={() => {
                    setError('');
                    setPhoto(undefined);
                    setDraft({ items: [newItem()], total: 0, title: '', rawText: '' });
                  }}
                >
                  手入力ではじめる
                </button>
                <button
                  className="text-button"
                  disabled={scan !== null}
                  onClick={() => {
                    setError('');
                    setPhoto(undefined);
                    setDraft(demo());
                  }}
                >
                  サンプルで試す
                </button>
              </div>
              <div className="privacy-note">
                <LockKeyhole size={13} />
                写真はあなたの端末で読み取ります
              </div>
            </section>
          </div>
          {getRecents().length > 0 && (
            <section className="recent-section">
              <div className="section-heading">
                <h2>最近の割り勘</h2>
                <span className="muted small">このブラウザで参加したもの</span>
              </div>
              <div className="recents">
                {getRecents().map((room) => (
                  <a className="recent-card" key={room.id} href={`/r/${room.id}`}>
                    <span className="recent-icon">
                      <ReceiptText size={22} />
                    </span>
                    <div>
                      <strong>{room.title}</strong>
                      <span>
                        {new Date(room.createdAt).toLocaleDateString('ja-JP')} · {yen(room.total)}
                      </span>
                    </div>
                    <ChevronRight size={18} />
                  </a>
                ))}
              </div>
            </section>
          )}
          <LandingGuide />
        </main>
      )}
      {cameraOpen && (
        <CameraCapture
          onCapture={(file) => void importPhoto(file)}
          onClose={() => setCameraOpen(false)}
          onPickPhoto={() => {
            setCameraOpen(false);
            gallery.current?.click();
          }}
        />
      )}
      {help && (
        <Modal title="レシわけの使い方" onClose={() => setHelp(false)}>
          <ol className="help-list">
            <li>
              <strong>立て替えた人がレシートを撮影</strong>
              <p>料理・飲み物・食材の数量と金額を確認し、自分を含む割り勘人数を入力します。</p>
            </li>
            <li>
              <strong>リンクをみんなに共有</strong>
              <p>
                参加者は名前を入れ、飲んだもの・食べたものを選びます。立て替えた人も選んでください。
              </p>
            </li>
            <li>
              <strong>返す金額を確認</strong>
              <p>
                全員が選び終えたら、立て替えた人が金額を確定。表示された金額を立て替えた人に返します。
              </p>
            </li>
          </ol>
          <div className="info-box">
            自分のドリンクは「各自」で飲んだ数を入力。料理や食材、ボトルのお酒などを分け合ったら「シェア」で一緒に飲食した人が選び、その人たちだけで均等に分けます。
          </div>
          <p className="muted small">
            共有リンクを知っている人は割り勘内容を閲覧できます。参加したブラウザをそのまま使ってください。
          </p>
          <button className="button primary full" onClick={() => setHelp(false)}>
            わかりました
          </button>
        </Modal>
      )}
    </>
  );
}

function Editor({
  draft,
  photo,
  error,
  setError,
  onBack,
  onCreated,
}: {
  draft: ParsedReceipt;
  photo?: string;
  error: string;
  setError: (s: string) => void;
  onBack: () => void;
  onCreated: (data: SessionResponse) => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [payerName, setPayerName] = useState('');
  const [participantCount, setParticipantCount] = useState('2');
  const [items, setItems] = useState<ReceiptItem[]>(() =>
    draft.items.map((item) => ({ ...item, splitMode: item.splitMode ?? 'quantity' })),
  );
  const [total, setTotal] = useState(draft.total);
  const [totalEdited, setTotalEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const updateItems = (next: ReceiptItem[]) => {
    setItems(next);
    if (
      !draft.rawText &&
      !totalEdited &&
      draft.total === draft.items.reduce((s, i) => s + i.amount, 0)
    )
      setTotal(next.reduce((s, i) => s + i.amount, 0));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!canSaveSession()) {
      setError(
        'このブラウザでは参加情報を保存できません。ブラウザのストレージを有効にしてください。',
      );
      return;
    }
    setBusy(true);
    try {
      const result = await request<SessionResponse>('/rooms', {
        title: title.trim(),
        payerName: payerName.trim(),
        participantCount: Number(participantCount),
        items: items.map((i) => ({ ...i, name: i.name.trim() })),
        total,
      });
      onCreated(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="container edit-page">
      <button className="text-button back-button" onClick={onBack} disabled={busy}>
        <ArrowLeft size={16} />
        戻る
      </button>
      <div className="page-heading">
        <h1>レシートを確認</h1>
        <p>
          料理・飲み物・食材の数量と金額を確認します。誰が飲んだ・食べたかは、リンクを送ったあとにそれぞれが選びます。
        </p>
      </div>
      <form
        onSubmit={submit}
        className={`editor-layout ${photo || draft.rawText ? 'with-preview' : ''}`}
      >
        <section className="panel editor-panel">
          <div className="form-row">
            <label>
              飲み会の名前
              <input
                required
                maxLength={80}
                placeholder="例：金曜の家飲み"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              立て替えた人（あなた）
              <input
                required
                maxLength={24}
                placeholder="例：あおい"
                autoComplete="given-name"
                value={payerName}
                onChange={(e) => setPayerName(e.target.value)}
              />
            </label>
          </div>
          <div className="participant-count-field">
            <label htmlFor="participant-count">割り勘人数</label>
            <div>
              <input
                id="participant-count"
                type="number"
                required
                min="1"
                max="100"
                step="1"
                inputMode="numeric"
                aria-describedby="participant-count-help"
                value={participantCount}
                onChange={(e) => setParticipantCount(e.target.value)}
              />
              <span>人</span>
            </div>
            <p id="participant-count-help" className="muted small">
              立て替えた人（あなた）を含めた人数です。
            </p>
          </div>
          <div className="item-editor-header">
            <h2>
              <ReceiptText size={19} />
              レシートの内容
            </h2>
            <span>金額は1行の合計</span>
          </div>
          <div className="info-box">
            <p>
              自分のドリンクなどは「各自」。料理・食材やボトルのお酒など、分け合うものは「シェア」にします。
            </p>
          </div>
          <div className="item-editor-labels">
            <span>料理・飲み物など</span>
            <span>金額（円）</span>
          </div>
          <div className="editable-items">
            {items.map((item, index) => (
              <div className="editable-item" key={item.id}>
                <input
                  aria-label={`${index + 1}行目の名前`}
                  required
                  maxLength={100}
                  value={item.name}
                  placeholder="例：生ビール"
                  onChange={(e) =>
                    updateItems(
                      items.map((i) => (i.id === item.id ? { ...i, name: e.target.value } : i)),
                    )
                  }
                />
                <input
                  aria-label={`${index + 1}行目の金額`}
                  type="number"
                  required
                  min="1"
                  max="1000000"
                  step="1"
                  inputMode="numeric"
                  value={item.amount || ''}
                  placeholder="0"
                  onChange={(e) =>
                    updateItems(
                      items.map((i) =>
                        i.id === item.id ? { ...i, amount: Number(e.target.value) } : i,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button delete-button"
                  aria-label={`${index + 1}行目を削除`}
                  disabled={items.length === 1}
                  onClick={() => updateItems(items.filter((i) => i.id !== item.id))}
                >
                  <Trash2 size={17} />
                </button>
                <div className="item-split-options">
                  <label>
                    数量
                    <input
                      aria-label={`${index + 1}行目の数量`}
                      type="number"
                      required
                      min="1"
                      max="999"
                      step="1"
                      inputMode="numeric"
                      value={(item.quantity ?? 1) || ''}
                      onChange={(e) => {
                        const quantity = Number(e.target.value);
                        updateItems(items.map((i) => (i.id === item.id ? { ...i, quantity } : i)));
                      }}
                    />
                  </label>
                  <div
                    className="split-mode-choices"
                    role="group"
                    aria-label={`${index + 1}行目の分け方`}
                  >
                    {[
                      {
                        mode: 'quantity' as const,
                        label: '各自',
                      },
                      {
                        mode: 'equal' as const,
                        label: 'シェア',
                      },
                    ].map(({ mode, label }) => (
                      <button
                        key={mode}
                        type="button"
                        className="split-mode-choice"
                        aria-label={`${index + 1}行目：${label}`}
                        aria-pressed={getItemSplitMode(item) === mode}
                        onClick={() =>
                          updateItems(
                            items.map((i) => (i.id === item.id ? { ...i, splitMode: mode } : i)),
                          )
                        }
                      >
                        <span className="split-mode-title">
                          <span className="split-mode-check" aria-hidden="true">
                            {getItemSplitMode(item) === mode && <Check size={12} strokeWidth={3} />}
                          </span>
                          {label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="text-button add-item"
            disabled={items.length >= 100}
            onClick={() => updateItems([...items, newItem()])}
          >
            <Plus size={17} />
            料理・飲み物を追加
          </button>
          <div className="receipt-subtotal">
            <span>入力した金額の合計</span>
            <strong>{yen(subtotal)}</strong>
          </div>
          <div className="total-input">
            <label htmlFor="receipt-total">
              実際に払った総額<span>レシートの合計金額を入力</span>
            </label>
            <div>
              <span>¥</span>
              <input
                id="receipt-total"
                type="number"
                required
                min="1"
                max="10000000"
                step="1"
                inputMode="numeric"
                value={total || ''}
                placeholder="0"
                onChange={(e) => {
                  setTotalEdited(true);
                  setTotal(Number(e.target.value));
                }}
              />
            </div>
          </div>
          {total !== subtotal && (
            <p className="adjustment-note">
              税・値引きなどの差額 {yen(total - subtotal)} も、金額に応じて分けます。
            </p>
          )}
          <ErrorMessage>{error}</ErrorMessage>
          <button className="button primary full large" disabled={busy}>
            {busy ? <Spinner /> : <Link size={18} />}共有リンクを作る
            <ArrowRight size={17} />
          </button>
          <p className="under-button">
            リンクを作ったら、あなたも飲んだもの・食べたものを選びます。
          </p>
        </section>
        {(photo || draft.rawText) && (
          <aside className="editor-aside">
            {photo && (
              <div className="photo-panel">
                <h2>レシート</h2>
                <img src={photo} alt="読み取ったレシート" />
              </div>
            )}
            {draft.rawText && (
              <details className="raw-text">
                <summary>読み取ったテキスト</summary>
                <pre>{draft.rawText}</pre>
              </details>
            )}
          </aside>
        )}
      </form>
    </main>
  );
}

function RoomPage({
  id,
  openShareInitially = false,
}: {
  id: string;
  openShareInitially?: boolean;
}) {
  const [room, setRoom] = useState<Room>();
  const [identity, setIdentity] = useState<Identity | undefined>(() => getIdentity(id));
  const [name, setName] = useState('');
  const [tab, setTab] = useState<'items' | 'summary'>('items');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(openShareInitially);
  const [confirming, setConfirming] = useState<{
    action: 'close' | 'reopen';
    version: number;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const currentVersion = useRef(-1);
  const applyRoom = (next: Room) => {
    if (next.version >= currentVersion.current) {
      currentVersion.current = next.version;
      setRoom(next);
    }
  };
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const data = await getRoom(id);
        if (live) {
          applyRoom(data);
          setConnectionError('');
        }
      } catch (e) {
        if (live) setConnectionError(errorText(e));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [id]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timeout);
  }, [notice]);
  const mutate = async (path: string, data: unknown, method: string, success?: () => void) => {
    setBusy(true);
    setError('');
    try {
      applyRoom(await request<Room>(`/rooms/${id}${path}`, data, identity, method));
      success?.();
    } catch (e) {
      setError(errorText(e));
      if (path === '/close') setConfirming(null);
      setRemoving(null);
      if (path === '/selection') {
        try {
          applyRoom(await getRoom(id));
        } catch {
          // Keep the original selection error; polling will retry the refresh.
        }
      }
    } finally {
      setBusy(false);
    }
  };
  const join = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!canSaveSession()) {
      setError('参加情報を保存するため、ブラウザのストレージを有効にしてください。');
      return;
    }
    setBusy(true);
    try {
      const data = await request<SessionResponse>(`/rooms/${id}/members`, { name: name.trim() });
      saveSession(data);
      setIdentity(data.identity);
      applyRoom(data.room);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!room)
    return (
      <main className="container loading-page">
        {connectionError ? (
          <>
            <ReceiptText size={42} />
            <h1>割り勘ページを開けませんでした</h1>
            <ErrorMessage>{connectionError}</ErrorMessage>
            <a className="button secondary" href="/">
              ホームへ戻る
            </a>
          </>
        ) : (
          <>
            <Spinner />
            <p>割り勘を読み込んでいます…</p>
          </>
        )}
      </main>
    );
  const member = room.members.find((m) => m.id === identity?.memberId);
  const payer = room.members.find((m) => m.id === room.payerId)!;
  const isOwner = member?.id === room.payerId;
  const settlement = calculateSettlement(room);
  const selected = room.selections[member?.id || ''] || [];
  const myAmount = settlement.memberAmounts[member?.id || ''] || 0;
  const doneCount = room.members.filter((m) => m.done).length;
  const participantCount = room.participantCount ?? room.members.length;
  const missingParticipants = Math.max(0, participantCount - room.members.length);
  const isFull = room.participantCount !== undefined && missingParticipants === 0;
  const selectionData = (itemIds = selected, done = false) => ({
    itemIds,
    done,
    quantities: Object.fromEntries(
      room.items
        .filter((item) => itemIds.includes(item.id) && getItemSplitMode(item) === 'quantity')
        .map((item) => [item.id, getSelectionQuantity(room, member?.id || '', item) || 1]),
    ),
  });
  const changeQuantity = (item: ReceiptItem, quantity: number) => {
    const itemIds =
      quantity > 0
        ? selected.includes(item.id)
          ? selected
          : [...selected, item.id]
        : selected.filter((id) => id !== item.id);
    const data = selectionData(itemIds);
    if (quantity > 0 && getItemSplitMode(item) === 'quantity') data.quantities[item.id] = quantity;
    void mutate('/selection', data, 'PUT');
  };
  const transferText = [
    `${room.title} の割り勘`,
    ...room.members
      .filter((m) => m.id !== payer.id)
      .map((m) => `${m.name} → ${payer.name}：${yen(settlement.memberAmounts[m.id] || 0)}`),
    `${window.location.origin}/r/${id}`,
  ].join('\n');
  return (
    <main className="container room-page">
      <div className="room-topline">
        <a className="text-button" href="/">
          <ArrowLeft size={16} />
          ホーム
        </a>
        <span className={`status-pill ${room.closed ? 'closed' : ''}`}>
          {room.closed ? <LockKeyhole size={12} /> : <span className="small-dot" />}
          {room.closed ? '金額が確定しました' : '入力受付中'}
        </span>
      </div>
      <div className="room-heading">
        <div>
          <h1>{room.title}</h1>
          <p>
            <span>{payer.name}さんが立て替え</span>
            <span className="dot-separator">·</span>
            {room.items.length}件<span className="dot-separator">·</span>
            {yen(room.total)}
            <span className="dot-separator">·</span>
            {room.members.length} / {participantCount}人が参加
          </p>
        </div>
        <button className="button secondary share-button" onClick={() => setSharing(true)}>
          <Share2 size={17} />
          リンクを共有
        </button>
      </div>
      <ErrorMessage>{connectionError}</ErrorMessage>
      <ErrorMessage>{error}</ErrorMessage>
      {!member ? (
        <section className="join-panel panel">
          <span className="join-icon">
            <Users size={30} />
          </span>
          <h2>
            {room.closed ? '金額が確定しました' : isFull ? '全員が参加しています' : '割り勘に参加'}
          </h2>
          <p>
            {room.closed
              ? 'それぞれが返す金額は、下の一覧で確認できます。'
              : isFull
                ? '参加済みの方は、参加したときのブラウザから開いてください。'
                : '名前を入力して、飲んだもの・食べたものを選んでください。'}
          </p>
          {!room.closed && !isFull && (
            <form onSubmit={join}>
              <label className="sr-only" htmlFor="join-name">
                あなたの名前
              </label>
              <input
                id="join-name"
                placeholder="例：ゆうき"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={24}
                autoComplete="given-name"
              />
              <button className="button primary" disabled={busy}>
                {busy ? <Spinner /> : '参加する'}
                <ArrowRight size={17} />
              </button>
            </form>
          )}
          <div className="joined-names">
            {room.members.map((m, i) => (
              <span key={m.id}>
                <Avatar name={m.name} index={i} />
                {m.name}
              </span>
            ))}
            <span className="muted">が参加しています</span>
          </div>
        </section>
      ) : (
        <>
          <div className="member-strip">
            <div>
              <Avatar name={member.name} index={room.members.indexOf(member)} />
              <span>
                <strong>{member.name}</strong>として参加中{isOwner && <small>立て替えた人</small>}
              </span>
            </div>
            <span className="member-progress">
              <Users size={15} />
              {doneCount} / {participantCount}人が入力完了
            </span>
          </div>
          <div className="tabs" role="tablist" aria-label="割り勘の表示">
            <button role="tab" aria-selected={tab === 'items'} onClick={() => setTab('items')}>
              <ReceiptText size={17} />
              自分の分<span>{selected.length}</span>
            </button>
            <button role="tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')}>
              <Users size={17} />
              みんなの金額
            </button>
          </div>
        </>
      )}
      {member && tab === 'items' ? (
        <div className="room-grid">
          <section className="panel item-selection">
            <div className="selection-heading">
              <div>
                <h2>{room.closed ? 'あなたが選んだもの' : '飲んだ・食べたものを選ぶ'}</h2>
                <p>
                  {room.closed
                    ? '選び直す場合は、立て替えた人が「みんなの金額」から選択を再開します。'
                    : '「各自」は飲んだ・食べた数を入力。「シェア」は一緒に飲食した人が選びます。'}
                </p>
              </div>
              <span>
                {selected.length} / {room.items.length}
              </span>
            </div>
            <div className="selectable-items">
              {room.items.map((item, index) => (
                <ItemSelection
                  key={item.id}
                  item={item}
                  room={room}
                  memberId={member.id}
                  allocation={settlement.itemAllocations[index]}
                  busy={busy}
                  onChange={(quantity) => changeQuantity(item, quantity)}
                />
              ))}
            </div>
            {room.total !== room.items.reduce((s, i) => s + i.amount, 0) && (
              <p className="selection-footnote">
                表示金額には、税・値引きなどの差額も含まれています。
              </p>
            )}
            <div className="selection-tip">
              <Users size={16} />
              <p>立て替えた人も、飲んだもの・食べたものを選びます。</p>
            </div>
          </section>
          <aside className="amount-card">
            <h2>{isOwner ? 'あなたの分' : `${payer.name}さんに返す金額`}</h2>
            <div className="large-amount">{yen(myAmount)}</div>
            <span className="amount-status">
              {room.closed ? '確定した金額です' : 'ほかの人の選択で金額が変わります'}
            </span>
            <div className="amount-details">
              <span>選んだもの</span>
              <strong>{selected.length}件</strong>
            </div>
            {room.closed ? (
              <div className="completed-note">
                <CheckCheck size={19} />
                {isOwner
                  ? 'みんなの金額で受け取り状況を確認'
                  : room.paidMemberIds.includes(member.id)
                    ? '受け取りを確認済みです'
                    : '表示金額を立て替えた人に返してください'}
              </div>
            ) : (
              <>
                <button
                  className={`button full ${member.done ? 'secondary' : 'primary'}`}
                  disabled={busy}
                  onClick={() =>
                    void mutate('/selection', selectionData(selected, !member.done), 'PUT', () =>
                      setNotice(member.done ? '選択を再開しました' : '入力完了にしました'),
                    )
                  }
                >
                  {busy ? (
                    <Spinner />
                  ) : member.done ? (
                    <CheckCheck size={18} />
                  ) : (
                    <Check size={18} />
                  )}
                  {member.done
                    ? '入力完了済み · 選び直す'
                    : selected.length
                      ? 'これで入力完了'
                      : '自分の分なしで完了'}
                </button>
                <p className="under-button">確定前なら、入力完了後も選び直せます。</p>
              </>
            )}
            <button className="text-button summary-link" onClick={() => setTab('summary')}>
              みんなの金額を見る
              <ArrowRight size={15} />
            </button>
          </aside>
        </div>
      ) : (
        <section className="panel settlement-panel">
          <div className="selection-heading">
            <div>
              <h2>{room.closed ? '返す相手と金額' : 'みんなの金額（仮）'}</h2>
              <p>
                {room.closed
                  ? 'お金を受け取ったら、立て替えた人が「受け取った」を押します。'
                  : '全員の選択が終わると、立て替えた人が確定できます。'}
              </p>
            </div>
            <span className="summary-total">{yen(room.total)}</span>
          </div>
          <div className="settlement-list">
            {room.members.map((m, i) => (
              <div className="settlement-person" key={m.id}>
                <Avatar name={m.name} index={i} />
                <div className="settlement-person-name">
                  <strong>
                    {m.name}
                    {m.id === member?.id && <small>あなた</small>}
                  </strong>
                  <span>
                    {m.id === payer.id ? '立て替えた人 · 自分の分' : `${payer.name}さんに返す`}
                  </span>
                </div>
                <div className="settlement-person-amount">
                  <strong>{yen(settlement.memberAmounts[m.id] || 0)}</strong>
                  <span>
                    {room.closed
                      ? m.id === payer.id
                        ? ''
                        : room.paidMemberIds.includes(m.id)
                          ? '受け取り済み'
                          : '受け取り待ち'
                      : m.done
                        ? '入力完了'
                        : '選択中'}
                  </span>
                </div>
                {!room.closed && isOwner && m.id !== payer.id && (
                  <button
                    className="icon-button"
                    aria-label={`${m.name}さんを参加者から削除`}
                    disabled={busy}
                    onClick={() => setRemoving(m.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                {room.closed && isOwner && m.id !== payer.id && (
                  <button
                    className={`paid-button ${room.paidMemberIds.includes(m.id) ? 'is-paid' : ''}`}
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        '/paid',
                        { memberId: m.id, paid: !room.paidMemberIds.includes(m.id) },
                        'PUT',
                      )
                    }
                  >
                    {room.paidMemberIds.includes(m.id) ? (
                      <CheckCheck size={16} />
                    ) : (
                      <Check size={16} />
                    )}
                    {room.paidMemberIds.includes(m.id) ? '受け取り済み' : '受け取った'}
                  </button>
                )}
              </div>
            ))}
          </div>
          {settlement.unassignedCount > 0 && (
            <div className="unassigned">
              <div>
                <span className="small-dot" />
                <strong>まだ選ばれていないものが{settlement.unassignedCount}件</strong>
                <span>{yen(settlement.unassignedAmount)}</span>
              </div>
              <p>
                {room.items
                  .filter((_, index) => settlement.itemAllocations[index].unassignedQuantity > 0)
                  .map((item) => {
                    const allocation = settlement.itemAllocations.find(
                      (a) => a.itemId === item.id,
                    )!;
                    return getItemSplitMode(item) === 'quantity'
                      ? `${item.name}（残り ${allocation.unassignedQuantity}）`
                      : item.name;
                  })
                  .join('・')}
              </p>
            </div>
          )}
          <div className="settlement-actions">
            {isOwner &&
              (room.closed ? (
                <button
                  className="text-button"
                  onClick={() => setConfirming({ action: 'reopen', version: room.version })}
                  disabled={busy}
                >
                  <RotateCcw size={16} />
                  選択を再開する
                </button>
              ) : (
                <>
                  <button
                    className="button primary"
                    disabled={busy || !settlement.ready}
                    onClick={() => setConfirming({ action: 'close', version: room.version })}
                  >
                    <LockKeyhole size={16} />
                    この金額で確定
                  </button>
                  <p className="muted small">
                    {settlement.ready
                      ? '全員の入力が完了しました。金額を確認して確定できます。'
                      : missingParticipants > 0
                        ? `あと${missingParticipants}人の参加を待っています。共有リンクを送ってください。`
                        : '全員が入力を完了し、選び忘れや数の残りがなくなると確定できます。'}
                  </p>
                </>
              ))}
            {room.closed && (
              <CopyButton
                text={transferText}
                label="割り勘の結果をコピー"
                onCopied={() => setNotice('割り勘の結果をコピーしました')}
              />
            )}
          </div>
        </section>
      )}
      {member && !room.closed && tab === 'items' && (
        <div className="mobile-amount-bar">
          <div>
            <span>{isOwner ? 'あなたの分（仮）' : `${payer.name}さんに返す（仮）`}</span>
            <strong>{yen(myAmount)}</strong>
          </div>
          <button
            className={`button ${member.done ? 'secondary' : 'primary'}`}
            disabled={busy}
            onClick={() => void mutate('/selection', selectionData(selected, !member.done), 'PUT')}
          >
            {busy ? <Spinner /> : <Check size={17} />}
            {member.done ? '選び直す' : '入力完了'}
          </button>
        </div>
      )}
      {sharing && <ShareModal room={room} onClose={() => setSharing(false)} />}
      {confirming && (
        <Modal
          title={
            confirming.action === 'close' ? 'この金額で確定しますか？' : 'みんなで選び直しますか？'
          }
          onClose={() => setConfirming(null)}
        >
          <p className="modal-description">
            {confirming.action === 'close'
              ? '参加者と金額を確認してください。確定すると選び直しができなくなり、返す金額が決まります。'
              : '全員が飲んだもの・食べたものを選び直せます。受け取り済みの記録はリセットされます。'}
          </p>
          <div className="confirm-amount">
            <span>{room.members.length}人の合計</span>
            <strong>{yen(room.total)}</strong>
          </div>
          <button
            className="button primary full"
            disabled={busy}
            onClick={() =>
              void mutate(
                '/close',
                { closed: confirming.action === 'close', version: confirming.version },
                'POST',
                () => {
                  setConfirming(null);
                  setNotice(
                    confirming.action === 'close' ? '金額を確定しました' : '選択を再開しました',
                  );
                },
              )
            }
          >
            {busy ? <Spinner /> : <Check size={18} />}
            {confirming.action === 'close' ? '金額を確定する' : '選択を再開する'}
          </button>
        </Modal>
      )}
      {removing && (
        <Modal title="参加者を削除しますか？" onClose={() => setRemoving(null)}>
          <p className="modal-description">
            {room.members.find((m) => m.id === removing)?.name}
            さんの選択を取り消して、参加者から削除します。
          </p>
          <button
            className="button primary full"
            disabled={busy}
            onClick={() =>
              void mutate(`/members/${removing}`, {}, 'DELETE', () => {
                setRemoving(null);
                setNotice('参加者を削除しました');
              })
            }
          >
            {busy ? <Spinner /> : <Trash2 size={17} />}参加者を削除する
          </button>
        </Modal>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
    </main>
  );
}

function Avatar({ name, index }: { name: string; index: number }) {
  return <span className={`avatar avatar-${index % 5}`}>{Array.from(name)[0]}</span>;
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="modal"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="閉じる">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function CopyButton({
  text,
  label,
  onCopied,
}: {
  text: string;
  label: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  return (
    <>
      <button
        className="button secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            onCopied?.();
          } catch {
            setFallback(true);
          }
        }}
      >
        {copied ? <Check size={17} /> : <Copy size={17} />}
        {copied ? 'コピーしました' : label}
      </button>
      {fallback && (
        <label className="copy-fallback">
          長押し・選択してコピーしてください
          <textarea readOnly value={text} onFocus={(e) => e.target.select()} />
        </label>
      )}
    </>
  );
}
function ShareModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const url = `${location.origin}/r/${room.id}`;
  const [error, setError] = useState('');
  return (
    <Modal title="リンクを共有" onClose={onClose}>
      <p className="modal-description">
        {room.closed
          ? '参加者にリンクを送って、返す相手と金額を共有できます。'
          : '飲み会のメンバーにリンクを送ってください。名前を入力すると、飲んだもの・食べたものを選べます。'}
      </p>
      <div className="qr-code">
        <QRCodeSVG value={url} size={164} fgColor="currentColor" marginSize={1} />
      </div>
      <div className="share-room-name">
        <ReceiptText size={16} />
        {room.title}
      </div>
      <input
        className="share-url"
        readOnly
        aria-label="共有リンク"
        value={url}
        onFocus={(e) => e.target.select()}
      />
      <div className="share-actions">
        <CopyButton text={url} label="リンクをコピー" />
        {typeof navigator.share === 'function' && (
          <button
            className="button primary"
            onClick={async () => {
              try {
                await navigator.share({
                  title: `${room.title} | レシわけ`,
                  text: room.closed
                    ? '返す相手と金額を確認してください。'
                    : '飲んだもの・食べたものを選んでください。',
                  url,
                });
              } catch (e) {
                if (!(e instanceof Error && e.name === 'AbortError'))
                  setError('共有メニューを開けませんでした。リンクをコピーしてください。');
              }
            }}
          >
            <Share2 size={17} />
            共有する
          </button>
        )}
        <a
          className="button line-button"
          href={`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`}
          target="_blank"
          rel="noreferrer"
        >
          LINEで送る
          <ArrowRight size={16} />
        </a>
      </div>
      <ErrorMessage>{error}</ErrorMessage>
      <p className="muted small share-note">リンクを知っている人が参加・閲覧できます。</p>
    </Modal>
  );
}
