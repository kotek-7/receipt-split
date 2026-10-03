import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
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
import AmountRatio from './AmountRatio';
import QuantityTiles from './QuantityTiles';
import LandingGuide from './LandingGuide';
import BrandMark from './BrandMark';
import type { ReceiptReader } from './ocr';

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
  const [readerReady, setReaderReady] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [reader, setReader] = useState<ReceiptReader>('local');
  const [retryPhoto, setRetryPhoto] = useState<File>();
  const activeScan = useRef<AbortController | null>(null);
  const gallery = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/receipt-reader', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
    })
      .then(async (response) => (response.ok ? response.json() : { ai: false }))
      .then((result: { ai?: boolean }) => {
        if (controller.signal.aborted) return;
        setAiAvailable(result.ai === true);
        setReader(result.ai === true ? 'ai' : 'local');
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setReaderReady(true);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const handler = () => {
      activeScan.current?.abort();
      setCameraOpen(false);
      setPhoto(undefined);
      setPath(location.pathname);
      setDraft(undefined);
      setRetryPhoto(undefined);
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
    setRetryPhoto(undefined);
    setError('');
    window.scrollTo(0, 0);
  };
  const importPhoto = async (file?: File, method: ReceiptReader = reader) => {
    if (!file || activeScan.current || !readerReady) return;
    const controller = new AbortController();
    activeScan.current = controller;
    setCameraOpen(false);
    setPhoto(undefined);
    if (gallery.current) gallery.current.value = '';
    setError('');
    setRetryPhoto(undefined);
    setScan(0);
    try {
      const { recognizeReceipt } = await import('./ocr');
      const { receipt: result, preview } = await recognizeReceipt(
        file,
        setScan,
        controller.signal,
        method,
      );
      if (controller.signal.aborted) return;
      setPhoto(URL.createObjectURL(preview));
      setDraft(result.items.length ? result : { ...result, items: [newItem()] });
      if (!result.items.length)
        setError(
          'レシートの内容を読み取れませんでした。写真を見ながら入力するか、明るい場所で撮り直してください。',
        );
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorText(e));
        if (method === 'ai') setRetryPhoto(file);
      }
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
                <span>
                  <span className="hero-phrase">飲んだ分、</span>
                  <wbr />
                  <span className="hero-phrase">食べた分。</span>
                </span>
              </h1>
              <p className="home-intro">
                家飲みの食材・お酒の買い出しも、居酒屋の注文も。
                料理はみんなで割り勘、ドリンクは自分の分。レシートを共有し、食べた・飲んだ分を選ぶと、立て替えた人に返す金額が分かります。
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
                    <Users size={13} />
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
            <section className="start-card" id="start">
              <h2>割り勘をはじめる</h2>
              {aiAvailable && (
                <fieldset className="reader-choice" disabled={scan !== null}>
                  <legend className="sr-only">写真の読み取り方法</legend>
                  <label>
                    <input
                      type="radio"
                      name="reader"
                      checked={reader === 'ai'}
                      onChange={() => setReader('ai')}
                    />
                    AIで読み取る
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="reader"
                      checked={reader === 'local'}
                      onChange={() => setReader('local')}
                    />
                    端末内で読み取る
                  </label>
                </fieldset>
              )}
              <div className="privacy-note">
                <LockKeyhole size={13} aria-hidden="true" />
                {!readerReady
                  ? '読み取りの準備中…'
                  : reader === 'ai'
                    ? '写真をCloudflareに送信して読み取ります'
                    : '写真は端末から送信しません'}
              </div>
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
                    {reader === 'ai' ? (
                      <p role="status">
                        <Spinner /> 品名・数量・金額を確認しています
                      </p>
                    ) : (
                      <>
                        <p>初回は少し時間がかかります</p>
                        <div className="progress-track">
                          <span style={{ width: `${scan}%` }} />
                        </div>
                        <span className="progress-text" role="status">
                          {Math.round(scan)}%
                        </span>
                      </>
                    )}
                    <button className="text-button" onClick={() => activeScan.current?.abort()}>
                      中止
                    </button>
                  </>
                ) : (
                  <>
                    <p className="drop-hint">写真をここにドロップ</p>
                    <button
                      className="button primary full"
                      disabled={!readerReady}
                      onClick={() => setCameraOpen(true)}
                    >
                      <Camera size={19} />
                      レシートを撮る
                    </button>
                    <button
                      className="button secondary full"
                      disabled={!readerReady}
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
              {retryPhoto && scan === null && (
                <button
                  className="button secondary full"
                  onClick={() => {
                    setReader('local');
                    void importPhoto(retryPhoto, 'local');
                  }}
                >
                  この写真を端末内で読み取る
                </button>
              )}
              <div className="alternative">
                <button
                  className="text-button"
                  disabled={scan !== null}
                  onClick={() => {
                    setError('');
                    setRetryPhoto(undefined);
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
                    setRetryPhoto(undefined);
                    setPhoto(undefined);
                    setDraft(demo());
                  }}
                >
                  サンプルで試す
                </button>
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
                参加者は名前を入れ、食べた・飲んだ分だけタイルを選びます。立て替えた人も選んでください。
              </p>
            </li>
            <li>
              <strong>返す金額を確認</strong>
              <p>
                みんなで分ける料理代も含めて、返す金額が決まります。ほかの人の入力を待たずに精算できます。
              </p>
            </li>
          </ol>
          <div className="info-box">
            たとえば4人で、ビールは1杯600円、唐揚げは1皿1,200円。ビールを1杯飲んだ人は、600円＋唐揚げ代300円で900円です。
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
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
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
        calculationMode: 'fixed-participants',
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
        <h1>割り勘を作成</h1>
      </div>
      <form
        onSubmit={submit}
        className={`editor-layout ${photo || draft.rawText ? 'with-preview' : ''}`}
      >
        <section className="editor-panel">
          {draft.warnings?.length ? (
            <div className="scan-warnings" role="status">
              {draft.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
          <div className="form-row">
            <label className="form-field event-name-field">
              飲み会の名前
              <input
                required
                maxLength={80}
                placeholder="例：金曜の家飲み"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="sentence-field payer-sentence">
              <span className="sr-only">立て替えた人</span>
              <input
                required
                maxLength={24}
                placeholder="例：あおい"
                autoComplete="given-name"
                value={payerName}
                onChange={(e) => setPayerName(e.target.value)}
              />
              <span aria-hidden="true">が立て替え</span>
            </label>
            <label className="sentence-field participant-sentence">
              <span aria-hidden="true">自分も含めて</span>
              <input
                id="participant-count"
                aria-label="人数（自分も含む）"
                type="number"
                required
                min="1"
                max="100"
                step="1"
                inputMode="numeric"
                value={participantCount}
                onChange={(e) => setParticipantCount(e.target.value)}
              />
              <span aria-hidden="true">人で割り勘</span>
            </label>
          </div>
          <h2 className="editor-section-title">料理・飲み物</h2>
          <div className="editable-items">
            {items.map((item, index) => (
              <div className="editable-item" key={item.id}>
                <label className="form-field item-name-field">
                  <span className="sr-only">品名</span>
                  <input
                    aria-label={`${index + 1}行目の品名`}
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
                </label>
                <QuantityTiles
                  name={item.name}
                  quantity={item.quantity ?? 1}
                  inputLabel={`${index + 1}行目の数量`}
                  disabled={busy}
                  onChange={(quantity) =>
                    updateItems(items.map((i) => (i.id === item.id ? { ...i, quantity } : i)))
                  }
                />
                <label className="inline-field item-amount-field">
                  合計
                  <span className="input-with-unit">
                    <input
                      aria-label={`${index + 1}行目の合計金額`}
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
                    <span aria-hidden="true">円</span>
                  </span>
                </label>
                <button
                  type="button"
                  className="icon-button delete-button"
                  aria-label={`${index + 1}行目を削除`}
                  disabled={items.length === 1}
                  onClick={() => updateItems(items.filter((i) => i.id !== item.id))}
                >
                  <Trash2 size={17} />
                </button>
                <fieldset
                  className="choice-group item-split-options"
                  aria-label={`${index + 1}行目の分け方`}
                >
                  <legend className="sr-only">分け方</legend>
                  <div className="radio-options">
                    {[
                      { mode: 'quantity' as const, label: '各自' },
                      { mode: 'equal' as const, label: '全員で割り勘' },
                    ].map(({ mode, label }) => (
                      <label key={mode} className="radio-option">
                        <input
                          type="radio"
                          name={`split-${item.id}`}
                          value={mode}
                          aria-label={`${index + 1}行目：${label}`}
                          checked={getItemSplitMode(item) === mode}
                          onChange={() =>
                            updateItems(
                              items.map((i) => (i.id === item.id ? { ...i, splitMode: mode } : i)),
                            )
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
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
            <span>明細の合計</span>
            <strong>{yen(subtotal)}</strong>
          </div>
          <div className="total-input">
            <label className="form-field" htmlFor="receipt-total">
              支払った総額
            </label>
            <div className="input-with-unit">
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
              <span aria-hidden="true">円</span>
            </div>
          </div>
          {total !== subtotal && (
            <div className="receipt-adjustment">
              <span>税・値引き</span>
              <strong>
                {total > subtotal ? '+' : ''}
                {yen(total - subtotal)}
              </strong>
            </div>
          )}
          <ErrorMessage>{error}</ErrorMessage>
          <button className="button primary full large" disabled={busy}>
            {busy ? <Spinner /> : <Link size={18} />}共有リンクを作る
            <ArrowRight size={17} />
          </button>
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
  const [requestBusy, setBusy] = useState(false);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [invalidSelectionDrafts, setInvalidSelectionDrafts] = useState<Set<string>>(new Set());
  const busy = requestBusy || selectionSaving;
  const [sharing, setSharing] = useState(openShareInitially);
  const [confirming, setConfirming] = useState<{
    action: 'close' | 'reopen';
    version: number;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const currentVersion = useRef(-1);
  const initialTabSelected = useRef(false);
  const contentHeading = useRef<HTMLHeadingElement>(null);
  const errorPosition = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (!room || initialTabSelected.current) return;
    const currentMember = room.members.find((m) => m.id === identity?.memberId);
    if (!currentMember && !room.closed) return;
    initialTabSelected.current = true;
    if (currentMember?.done || room.closed) setTab('summary');
  }, [room, identity]);
  useEffect(() => {
    contentHeading.current?.focus();
  }, [tab]);
  useEffect(() => {
    if (error) errorPosition.current?.focus();
  }, [error]);
  const mutate = async (path: string, data: unknown, method: string, success?: () => void) => {
    setBusy(true);
    setError('');
    try {
      applyRoom(await request<Room>(`/rooms/${id}${path}`, data, identity, method));
      success?.();
      return true;
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
      return false;
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
  const fixedAmounts = room.calculationMode === 'fixed-participants';
  const selected = room.selections[member?.id || ''] || [];
  const myAmount = settlement.memberAmounts[member?.id || ''] || 0;
  const doneCount = room.members.filter((m) => m.done).length;
  const participantCount = room.participantCount ?? room.members.length;
  const missingParticipants = Math.max(0, participantCount - room.members.length);
  const isFull = room.participantCount !== undefined && missingParticipants === 0;
  const includedItems = fixedAmounts
    ? room.items.filter((item) => getItemSplitMode(item) === 'equal')
    : [];
  const hasIndividualItems = room.items.some((item) => getItemSplitMode(item) === 'quantity');
  const includedAmount = includedItems.reduce(
    (sum, item) =>
      sum +
      (settlement.itemAllocations.find((allocation) => allocation.itemId === item.id)
        ?.memberAmounts[member?.id || ''] || 0),
    0,
  );
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
    return mutate('/selection', data, 'PUT');
  };
  const finishSelection = () => {
    if (busy || invalidSelectionDrafts.size > 0) return;
    void mutate('/selection', selectionData(selected, true), 'PUT', () => setTab('summary'));
  };
  const finishLabel = fixedAmounts
    ? 'この金額で完了'
    : selected.length
      ? '選択を終える'
      : '自分の分なしで完了';
  const selectionGroups = [
    {
      mode: 'quantity' as const,
      title: '食べた・飲んだ分をタップ',
      hint: '',
    },
    {
      mode: 'equal' as const,
      title: 'シェアしたものを選ぶ',
      hint: '飲んだ・食べた人だけで、均等に割ります。',
    },
  ];
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
          {room.closed ? (fixedAmounts ? '入力締め切り済み' : '金額が確定しました') : '入力受付中'}
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
      <div ref={errorPosition} tabIndex={-1} className="room-error">
        <ErrorMessage>{error}</ErrorMessage>
      </div>
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
              ? '参加したときのブラウザから、自分の金額を確認してください。'
              : isFull
                ? '参加済みの方は、参加したときのブラウザから開いてください。'
                : fixedAmounts
                  ? '名前を入れて、食べた・飲んだ分を選びます。'
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
            <Avatar name={member.name} index={room.members.indexOf(member)} />
            <span>
              <strong>{member.name}</strong>さんの分
            </span>
          </div>
        </>
      )}
      {member && tab === 'items' ? (
        <div className="room-grid">
          <section className="item-selection">
            {room.closed && (
              <button className="text-button receipt-back" onClick={() => setTab('summary')}>
                <ArrowLeft size={16} />
                金額に戻る
              </button>
            )}
            <div className="selection-heading">
              <div>
                <h2 ref={contentHeading} tabIndex={-1} className="room-content-heading">
                  {room.closed
                    ? 'あなたの明細'
                    : fixedAmounts
                      ? hasIndividualItems
                        ? '食べた・飲んだ分をタップ'
                        : 'あなたの金額を確認'
                      : '自分の分を選んでください'}
                </h2>
              </div>
            </div>
            {selectionGroups.map((group) => {
              if (fixedAmounts && group.mode === 'equal') return null;
              const groupItems = room.items.filter((item) => getItemSplitMode(item) === group.mode);
              if (!groupItems.length) return null;
              return (
                <section
                  className="selection-group"
                  key={group.mode}
                  aria-labelledby={fixedAmounts ? undefined : `group-${group.mode}`}
                  aria-label={fixedAmounts ? '食べた・飲んだもの' : undefined}
                >
                  {!fixedAmounts && (
                    <div className="selection-group-heading">
                      <h3 id={`group-${group.mode}`}>{group.title}</h3>
                      {!room.closed && group.hint && <p>{group.hint}</p>}
                    </div>
                  )}
                  {groupItems.map((item) => (
                    <ItemSelection
                      key={item.id}
                      item={item}
                      room={room}
                      memberId={member.id}
                      allocation={settlement.itemAllocations.find((a) => a.itemId === item.id)!}
                      busy={busy}
                      onChange={(quantity) => changeQuantity(item, quantity)}
                      onSavingChange={setSelectionSaving}
                      onDraftChange={(invalid) => {
                        setInvalidSelectionDrafts((current) => {
                          if (current.has(item.id) === invalid) return current;
                          const next = new Set(current);
                          if (invalid) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        });
                      }}
                    />
                  ))}
                </section>
              );
            })}
            {includedItems.length > 0 && (
              <section className="included-items" aria-labelledby="included-heading">
                <div>
                  <h3 id="included-heading">{participantCount}人で割り勘</h3>
                </div>
                <ul>
                  {includedItems.map((item) => (
                    <li key={item.id}>
                      <span>{item.name}</span>
                      <AmountRatio
                        amount={
                          settlement.itemAllocations.find((a) => a.itemId === item.id)!
                            .memberAmounts[member.id] || 0
                        }
                        total={settlement.itemAllocations.find((a) => a.itemId === item.id)!.amount}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {fixedAmounts && isOwner && settlement.roundingAmount > 0 && (
              <div className="receipt-adjustment">
                <span>端数</span>
                <strong>{yen(settlement.roundingAmount)}</strong>
              </div>
            )}
          </section>
          <aside className="amount-card">
            <h2>{isOwner ? 'あなたの分' : `${payer.name}さんに返す金額`}</h2>
            <div className="large-amount">{yen(myAmount)}</div>
            {!fixedAmounts && (
              <span className="amount-status">
                {room.closed ? '確定済み' : 'ほかの人の選択で金額が変わります'}
              </span>
            )}
            {fixedAmounts ? (
              <div className="amount-breakdown">
                <div>
                  <span>食べた・飲んだ分</span>
                  <strong>
                    {yen(myAmount - includedAmount - (isOwner ? settlement.roundingAmount : 0))}
                  </strong>
                </div>
                <div>
                  <span>{participantCount}人で割り勘</span>
                  <strong>{yen(includedAmount)}</strong>
                </div>
                {isOwner && settlement.roundingAmount > 0 && (
                  <div>
                    <span>端数</span>
                    <strong>{yen(settlement.roundingAmount)}</strong>
                  </div>
                )}
              </div>
            ) : (
              <div className="amount-details">
                <span>選んだもの</span>
                <strong>{selected.length}件</strong>
              </div>
            )}
            {room.closed ? (
              <div className="completed-note">
                <CheckCheck size={19} />
                {isOwner
                  ? '受け取り状況は下で確認できます'
                  : room.paidMemberIds.includes(member.id)
                    ? '受け取りを確認済みです'
                    : '表示金額を立て替えた人に返してください'}
              </div>
            ) : (
              <>
                <button
                  className="button primary full selection-finish"
                  disabled={busy || invalidSelectionDrafts.size > 0}
                  onClick={finishSelection}
                >
                  {busy ? <Spinner /> : <Check size={18} />}
                  {finishLabel}
                </button>
              </>
            )}
          </aside>
        </div>
      ) : member ? (
        <section className="personal-summary">
          {member && (
            <div className={`selection-result ${member.done || room.closed ? 'is-done' : ''}`}>
              <div>
                {(member.done || room.closed) && <CheckCheck size={22} aria-hidden="true" />}
                <h2 ref={contentHeading} tabIndex={-1} className="room-content-heading">
                  {member.done || room.closed
                    ? fixedAmounts
                      ? isOwner
                        ? 'あなたの分'
                        : `${payer.name}さんに返す金額`
                      : 'あなたの入力は完了です'
                    : fixedAmounts
                      ? hasIndividualItems
                        ? '食べた・飲んだ分を確認'
                        : '金額を確認'
                      : '自分の分を選んでください'}
                </h2>
              </div>
              {(member.done || room.closed) && (
                <div className="personal-final-amount">
                  {yen(myAmount)}
                  {!fixedAmounts && !room.closed && <small>（仮）</small>}
                </div>
              )}
              {!fixedAmounts && !room.closed && (
                <p>
                  {!member.done
                    ? '飲んだもの・食べたものを選び、選択を終えてください。'
                    : participantCount > doneCount
                      ? `あと${participantCount - doneCount}人の入力を待っています。`
                      : settlement.unassignedCount > 0
                        ? 'まだ選ばれていないものがあります。みんなで確認してください。'
                        : isOwner
                          ? '全員の入力が揃いました。金額を確認して、下のボタンで確定してください。'
                          : `${payer.name}さんが金額を確定するのを待っています。`}
                </p>
              )}
              {room.closed && !isOwner && (
                <p className="personal-payment-state">
                  {room.paidMemberIds.includes(member.id)
                    ? '受け取り済み'
                    : `${payer.name}さんへ返してください`}
                </p>
              )}
              <button
                className={member.done || room.closed ? 'text-button' : 'button primary'}
                onClick={() => setTab('items')}
              >
                {member.done ? <ArrowLeft size={15} /> : null}
                {room.closed
                  ? '明細を見る'
                  : fixedAmounts
                    ? member.done
                      ? hasIndividualItems
                        ? '選び直す'
                        : '明細を見る'
                      : hasIndividualItems
                        ? '食べた・飲んだ分を選ぶ'
                        : '金額を確認する'
                    : member.done
                      ? '自分の分を選び直す'
                      : '自分の分を選ぶ'}
              </button>
            </div>
          )}
        </section>
      ) : null}
      {isOwner && (
        <details className="owner-management" open={room.closed || tab === 'summary'}>
          <summary>
            <Users size={18} aria-hidden="true" />
            <strong>{room.closed ? '受け取り状況' : '参加状況'}</strong>
            <span>
              {room.closed
                ? `${room.paidMemberIds.length} / ${Math.max(0, room.members.length - 1)}人`
                : `${doneCount} / ${participantCount}人が入力完了`}
            </span>
            <ChevronDown size={18} className="disclosure-arrow" aria-hidden="true" />
          </summary>
          <section className="settlement-panel">
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
                          ? fixedAmounts
                            ? '金額確定'
                            : '入力完了'
                          : '入力中'}
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
            {fixedAmounts && settlement.pendingParticipantAmount > 0 && (
              <p className="pending-participant-amount">
                まだ参加していない{missingParticipants}人の分{' '}
                <strong>{yen(settlement.pendingParticipantAmount)}</strong>
              </p>
            )}
            {settlement.unassignedCount > 0 && (
              <div className="unassigned">
                <div>
                  <span className="small-dot" />
                  <strong>まだ選ばれていないものが{settlement.unassignedCount}件</strong>
                  <span>
                    {yen(settlement.unassignedAmount - settlement.pendingParticipantAmount)}
                  </span>
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
                    締め切りを解除する
                  </button>
                ) : (
                  <>
                    <button
                      className="button primary"
                      disabled={busy || !settlement.ready}
                      onClick={() => setConfirming({ action: 'close', version: room.version })}
                    >
                      <LockKeyhole size={16} />
                      {fixedAmounts ? '全員の入力を締め切る' : 'この金額で確定'}
                    </button>
                    <p className="muted small">
                      {settlement.ready
                        ? fixedAmounts
                          ? '締め切ると受け取りを記録できます。'
                          : '全員の入力が完了しました。金額を確認して確定できます。'
                        : missingParticipants > 0
                          ? fixedAmounts
                            ? `参加 ${room.members.length} / ${participantCount}人`
                            : `あと${missingParticipants}人の参加を待っています。共有リンクを送ってください。`
                          : fixedAmounts
                            ? doneCount < participantCount
                              ? `入力完了 ${doneCount} / ${participantCount}人`
                              : '残りの数を確認してください。'
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
        </details>
      )}
      {member && !room.closed && tab === 'items' && (
        <div className="mobile-amount-bar">
          <div>
            <span>
              {isOwner
                ? `あなたの分${fixedAmounts ? '' : '（仮）'}`
                : `${payer.name}さんに返す${fixedAmounts ? '' : '（仮）'}`}
            </span>
            <strong>{yen(myAmount)}</strong>
          </div>
          <button
            className="button primary"
            disabled={busy || invalidSelectionDrafts.size > 0}
            onClick={finishSelection}
          >
            {busy ? <Spinner /> : <Check size={17} />}
            {finishLabel}
          </button>
        </div>
      )}
      {sharing && (
        <ShareModal
          room={room}
          onClose={() => setSharing(false)}
          onSelect={
            member && !room.closed
              ? () => {
                  setSharing(false);
                  setTab('items');
                }
              : undefined
          }
        />
      )}
      {confirming && (
        <Modal
          title={
            confirming.action === 'close'
              ? fixedAmounts
                ? '全員の入力を締め切りますか？'
                : 'この金額で確定しますか？'
              : '締め切りを解除しますか？'
          }
          onClose={() => setConfirming(null)}
        >
          <p className="modal-description">
            {confirming.action === 'close'
              ? fixedAmounts
                ? '締め切ると、飲んだ数・食べた数を変更できなくなります。'
                : '参加者と金額を確認してください。確定すると選び直しができなくなり、返す金額が決まります。'
              : fixedAmounts
                ? '全員が食べた・飲んだ分を選び直せます。受け取り済みの記録はリセットされます。'
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
                    confirming.action === 'close'
                      ? fixedAmounts
                        ? '入力を締め切りました'
                        : '金額を確定しました'
                      : '締め切りを解除しました',
                  );
                },
              )
            }
          >
            {busy ? <Spinner /> : <Check size={18} />}
            {confirming.action === 'close'
              ? fixedAmounts
                ? '入力を締め切る'
                : '金額を確定する'
              : '締め切りを解除する'}
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
function ShareModal({
  room,
  onClose,
  onSelect,
}: {
  room: Room;
  onClose: () => void;
  onSelect?: () => void;
}) {
  const url = `${location.origin}/r/${room.id}`;
  const [error, setError] = useState('');
  return (
    <Modal title="リンクを共有" onClose={onClose}>
      <p className="modal-description">飲み会のメンバーに送ってください。</p>
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
                    : room.calculationMode === 'fixed-participants'
                      ? '食べた・飲んだ分を選んで、返す金額を確認してください。'
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
      {onSelect && (
        <button className="button primary full" onClick={onSelect}>
          {room.calculationMode === 'fixed-participants'
            ? '自分の金額を確認する'
            : '自分の分を選ぶ'}
          <ArrowRight size={17} />
        </button>
      )}
    </Modal>
  );
}
