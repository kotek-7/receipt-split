import { useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { ReceiptScanProgress } from '../shared/receipt-progress';
import type { ReceiptReader } from './ocr';
import './scan-progress.css';

const stepIndex: Record<ReceiptScanProgress['stage'], number> = {
  preparing: 0,
  uploading: 1,
  loading: 1,
  reading: 2,
  checking: 3,
};

export default function ScanProgress({
  progress,
  reader,
}: {
  progress: ReceiptScanProgress;
  reader: ReceiptReader;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((performance.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const current = stepIndex[progress.stage];
  const retrying = progress.stage === 'reading' && (progress.attempt ?? 1) > 1;
  const labels = [
    '写真を整える',
    reader === 'ai' ? '写真を送る' : '読み取りを準備',
    retrying ? 'もう一度読み取り中' : '品名・金額を読む',
    '数量・合計を確認',
  ];
  const percent = reader === 'local' && progress.stage === 'reading' ? progress.percent : undefined;

  return (
    <div className="scan-progress">
      <div className="scan-progress-heading">
        <h3>読み取り中</h3>
        <span className="scan-elapsed" role="timer" aria-live="off" aria-label="経過時間">
          {elapsed}秒
        </span>
      </div>
      <span className="sr-only" role="status">
        {labels[current]}
      </span>
      <ol className="scan-steps" aria-label="読み取りの進捗">
        {labels.map((label, index) => (
          <li
            key={index}
            className={index < current ? 'is-done' : index === current ? 'is-current' : ''}
            aria-current={index === current ? 'step' : undefined}
          >
            <span className="scan-step-mark" aria-hidden="true">
              {index < current ? (
                <Check size={16} />
              ) : index === current ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                index + 1
              )}
            </span>
            <span className="scan-step-label">
              {label}
              {index < current && <span className="sr-only">：完了</span>}
            </span>
            {index === current && percent !== undefined && (
              <span
                className="scan-percent"
                role="progressbar"
                aria-label="文字の読み取り"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                {percent}%
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
