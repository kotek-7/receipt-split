import { useId, useLayoutEffect, useRef } from 'react';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import MealIcon from './MealIcon';
import './quantity-tiles.css';

const MAX_VISIBLE_TILES = 12;
const MAX_QUANTITY = 999;

export default function QuantityTiles({
  name,
  quantity,
  onChange,
  inputLabel,
  disabled = false,
}: {
  name: string;
  quantity: number;
  onChange: (quantity: number) => void;
  inputLabel: string;
  disabled?: boolean;
}) {
  const inputId = useId();
  const tileKeys = useRef<number[]>([]);
  const nextKey = useRef(0);
  const focusIndex = useRef<number | null>(null);
  const tileGroup = useRef<HTMLDivElement>(null);
  const numericDetails = useRef<HTMLDetailsElement>(null);
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_QUANTITY;
  const count = valid ? quantity : 0;
  const label = name.trim() || '品物';

  // Keep surviving tiles mounted when a unit is removed from the middle.
  tileKeys.current = tileKeys.current.slice(0, count);
  while (tileKeys.current.length < count) tileKeys.current.push(nextKey.current++);

  useLayoutEffect(() => {
    if (focusIndex.current === null) return;
    const buttons = Array.from(
      tileGroup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
    );
    buttons[Math.min(focusIndex.current, buttons.length - 1)]?.focus();
    focusIndex.current = null;
  }, [quantity]);

  return (
    <div className="quantity-tiles" role="group" aria-label={`${label}の数量`}>
      <div className="quantity-tiles-heading">
        <output className="quantity-tiles-count" htmlFor={inputId} aria-live="polite">
          <span>数量</span>
          {valid ? quantity : '—'}
        </output>
      </div>
      <div className="quantity-tiles-grid" ref={tileGroup}>
        {tileKeys.current.slice(0, MAX_VISIBLE_TILES).map((key, index) => (
          <button
            key={key}
            type="button"
            className="quantity-unit"
            aria-label={`${label}を1つ減らす（${index + 1}/${quantity}）`}
            disabled={disabled || count <= 1}
            onClick={(event) => {
              if (event.detail === 0) focusIndex.current = index;
              tileKeys.current = tileKeys.current.filter((tileKey) => tileKey !== key);
              onChange(quantity - 1);
            }}
          >
            <MealIcon name={name} />
            <span className="quantity-unit-minus" aria-hidden="true">
              <Minus size={11} strokeWidth={2.5} />
            </span>
          </button>
        ))}
        {count > MAX_VISIBLE_TILES && (
          <span className="quantity-tiles-extra" aria-label={`ほか${count - MAX_VISIBLE_TILES}`}>
            ＋{count - MAX_VISIBLE_TILES}
          </span>
        )}
        <button
          type="button"
          className="quantity-unit quantity-add"
          aria-label={`${label}を1つ増やす`}
          disabled={disabled || count === MAX_QUANTITY}
          onClick={() => onChange(valid ? quantity + 1 : 1)}
        >
          <Plus size={22} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      <details className="quantity-tiles-numeric" ref={numericDetails}>
        <summary>
          数で入力
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min="1"
          max={MAX_QUANTITY}
          step="1"
          required
          aria-label={inputLabel}
          aria-invalid={!valid || undefined}
          value={quantity === 0 || !Number.isFinite(quantity) ? '' : quantity}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          onInvalid={() => {
            if (numericDetails.current) numericDetails.current.open = true;
          }}
        />
      </details>
    </div>
  );
}
