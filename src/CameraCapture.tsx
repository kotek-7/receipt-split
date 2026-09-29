import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, ImagePlus, LoaderCircle, X } from 'lucide-react';
import './camera.css';

type CameraCaptureProps = {
  onCapture: (file: File) => void;
  onClose: () => void;
  onPickPhoto: () => void;
};

function cameraError(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
    return 'カメラの使用が許可されていません。ブラウザの設定で許可するか、保存済みの写真を選んでください。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return 'カメラが見つかりません。保存済みの写真を選んでください。';
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'カメラを起動できませんでした。他のカメラアプリを閉じて撮り直すか、保存済みの写真を選んでください。';
  if (name === 'SecurityError')
    return 'このブラウザではカメラを利用できません。Chromeで開き直すか、保存済みの写真を選んでください。';
  return 'カメラを起動できませんでした。画面を閉じて撮り直すか、保存済みの写真を選んでください。';
}

const stopTracks = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop());

export default function CameraCapture({ onCapture, onClose, onPickPhoto }: CameraCaptureProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const closed = useRef(false);
  const capturing = useRef(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const stopCamera = useCallback(() => {
    closed.current = true;
    if (stream.current) stopTracks(stream.current);
    stream.current = null;
    if (video.current) {
      video.current.pause();
      video.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    closed.current = false;
    const modal = dialog.current;
    if (modal && !modal.open) modal.showModal();
    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError('このブラウザではカメラを利用できません。保存済みの写真を選んでください。');
          return;
        }
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1600 },
            height: { ideal: 1200 },
            frameRate: { ideal: 15, max: 24 },
          },
          audio: false,
        });
        if (cancelled || closed.current || !video.current) {
          stopTracks(media);
          return;
        }
        stream.current = media;
        video.current.srcObject = media;
        await video.current.play();
      } catch (error) {
        if (cancelled || closed.current) return;
        stopCamera();
        // Keep the dialog open so permission errors always have a photo alternative.
        setError(cameraError(error));
        setReady(false);
      }
    };
    void startCamera();
    return () => {
      cancelled = true;
      stopCamera();
      if (modal?.open) modal.close();
    };
  }, [stopCamera]);

  const close = () => {
    stopCamera();
    onClose();
  };
  const pickPhoto = () => {
    stopCamera();
    onPickPhoto();
  };
  const updateReady = () => {
    if (closed.current) return;
    const source = video.current;
    setReady(Boolean(source && source.readyState >= 2 && source.videoWidth && source.videoHeight));
  };
  const capture = async () => {
    const source = video.current;
    if (
      closed.current ||
      capturing.current ||
      !source ||
      source.readyState < 2 ||
      !source.videoWidth ||
      !source.videoHeight
    )
      return;
    capturing.current = true;
    setPending(true);
    setError('');
    const canvas = document.createElement('canvas');
    try {
      const width = source.videoWidth;
      const height = source.videoHeight;
      const scale = Math.min(
        1,
        1600 / width,
        1600 / height,
        Math.sqrt((1600 * 1200) / (width * height)),
      );
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('写真を作成できませんでした。もう一度お試しください。');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) =>
            result
              ? resolve(result)
              : reject(new Error('写真を作成できませんでした。もう一度お試しください。')),
          'image/jpeg',
          0.88,
        );
      });
      if (closed.current) return;
      const file = new File([blob], 'receipt.jpg', {
        type: 'image/jpeg',
        lastModified: Date.now(),
      });
      // Release both the camera and canvas before recognition allocates its resources.
      stopCamera();
      canvas.width = 0;
      canvas.height = 0;
      onCapture(file);
    } catch (error) {
      if (!closed.current)
        setError(
          error instanceof Error ? error.message : '撮影できませんでした。もう一度お試しください。',
        );
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      capturing.current = false;
      if (!closed.current) setPending(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal camera-modal"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>レシートを撮る</h2>
        <button
          className="icon-button camera-close"
          type="button"
          aria-label="閉じる"
          onClick={close}
          autoFocus
        >
          <X size={22} />
        </button>
      </div>
      <p id={descriptionId} className="camera-instruction">
        明るい場所で、レシート全体を写してください。
      </p>
      <div className="camera-viewfinder" aria-busy={!ready && !error}>
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          aria-label="レシート撮影用カメラの映像"
          onLoadedMetadata={updateReady}
          onLoadedData={updateReady}
          onCanPlay={updateReady}
        />
        {!ready && (
          <div className="camera-placeholder" role="status">
            {error ? <Camera size={30} /> : <LoaderCircle size={26} className="spin" />}
            <span>{error ? '写真からも読み取れます' : 'カメラを準備しています…'}</span>
          </div>
        )}
      </div>
      {error && (
        <p className="camera-error" role="alert">
          {error}
        </p>
      )}
      <div className="camera-actions">
        <button
          className="button primary full"
          type="button"
          disabled={!ready || pending}
          onClick={() => void capture()}
        >
          {pending ? <LoaderCircle size={19} className="spin" /> : <Camera size={19} />}
          {pending ? '写真を準備しています…' : '撮影して読み取る'}
        </button>
        <button className="button secondary full" type="button" onClick={pickPhoto}>
          <ImagePlus size={18} />
          保存済みの写真を選ぶ
        </button>
      </div>
    </dialog>
  );
}
