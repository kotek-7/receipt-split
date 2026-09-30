import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, Plus, UserRound } from 'lucide-react';
import type { ItemAllocation, ReceiptItem, Room } from '../shared/types';
import { getItemQuantity, getItemSplitMode, getSelectionQuantity } from '../shared/settlement';
import AmountRatio from './AmountRatio';
import MealIcon from './MealIcon';
import './selection.css';

const TILE_PAGE_SIZE = 12;

function draftQuantity(value: string, maximum: number) {
  const count = value.trim() === '' ? 0 : Number(value);
  return Number.isInteger(count) && count >= 0 && count <= maximum ? count : null;
}

function reconcileSlots(slots: number[], count: number, total: number) {
  const next = slots.filter((slot) => slot < total).slice(0, count);
  for (let slot = 0; next.length < count && slot < total; slot += 1) {
    if (!next.includes(slot)) next.push(slot);
  }
  return next.length === slots.length && next.every((slot, index) => slot === slots[index])
    ? slots
    : next;
}

export default function ItemSelection({
  item,
  room,
  memberId,
  allocation,
  busy,
  onChange,
  onSavingChange,
  onDraftChange,
}: {
  item: ReceiptItem;
  room: Room;
  memberId: string;
  allocation: ItemAllocation;
  busy: boolean;
  onChange: (quantity: number) => Promise<boolean>;
  onSavingChange?: (saving: boolean) => void;
  onDraftChange?: (invalid: boolean) => void;
}) {
  const quantity = getSelectionQuantity(room, memberId, item);
  const byQuantity = getItemSplitMode(item) === 'quantity';
  const totalQuantity = getItemQuantity(item);
  const myAmount = allocation.memberAmounts[memberId] || 0;
  const ItemHeading = room.calculationMode === 'fixed-participants' ? 'h3' : 'h4';
  const eaters = room.members.filter((member) => getSelectionQuantity(room, member.id, item) > 0);
  const others = eaters.filter((member) => member.id !== memberId);
  const othersQuantity = others.reduce(
    (total, member) => total + getSelectionQuantity(room, member.id, item),
    0,
  );
  const [selectedSlots, setSelectedSlots] = useState(() =>
    reconcileSlots([], quantity, totalQuantity),
  );
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const intendedSlots = useRef(selectedSlots);
  const acknowledgedSlots = useRef(selectedSlots);
  const callbacks = useRef({ onChange, onSavingChange, onDraftChange });
  callbacks.current = { onChange, onSavingChange, onDraftChange };
  const takenSlots = useRef<number[]>([]);
  const [visibleCount, setVisibleCount] = useState(TILE_PAGE_SIZE);
  const [numericCount, setNumericCount] = useState(String(quantity));
  const numericEditing = useRef(false);
  const numericDraft = useRef(numericCount);
  const numericErrorId = useId();
  const maximumQuantity = totalQuantity - othersQuantity;
  const numericInvalid =
    totalQuantity > TILE_PAGE_SIZE && draftQuantity(numericCount, maximumQuantity) === null;
  const disabled = busy || pending || room.closed;
  const tileDisabled = (busy && !pending) || room.closed;
  const displayedQuantity = pending ? selectedSlots.length : quantity;

  function updateNumericDraft(value: string) {
    numericDraft.current = value;
    setNumericCount(value);
  }

  useEffect(() => {
    if (pending) return;
    // Slots are local positions for interchangeable units; only the count is saved.
    const slots = reconcileSlots(intendedSlots.current, quantity, totalQuantity);
    intendedSlots.current = slots;
    acknowledgedSlots.current = slots;
    setSelectedSlots(slots);
    if (!numericEditing.current && draftQuantity(numericDraft.current, maximumQuantity) !== null) {
      updateNumericDraft(String(quantity));
    }
  }, [quantity, totalQuantity, maximumQuantity, pending]);

  useEffect(() => {
    callbacks.current.onDraftChange?.(numericInvalid);
  }, [numericInvalid]);

  useEffect(
    () => () => {
      callbacks.current.onDraftChange?.(false);
    },
    [],
  );

  const selected = new Set(selectedSlots);
  const taken = new Set(
    takenSlots.current
      .filter((slot) => slot < totalQuantity && !selected.has(slot))
      .slice(0, othersQuantity),
  );
  for (let slot = totalQuantity - 1; taken.size < othersQuantity && slot >= 0; slot -= 1) {
    if (!selected.has(slot)) taken.add(slot);
  }
  useEffect(() => {
    takenSlots.current = [...taken];
  });

  async function saveSlots(nextSlots: number[]) {
    if ((busy && !saving.current) || room.closed) return;
    intendedSlots.current = nextSlots;
    setSelectedSlots(nextSlots);
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    callbacks.current.onSavingChange?.(true);
    try {
      // Keep taps responsive while serializing saves to the latest intended count.
      while (intendedSlots.current.length !== acknowledgedSlots.current.length) {
        const requestedSlots = intendedSlots.current;
        if (!(await callbacks.current.onChange(requestedSlots.length))) {
          intendedSlots.current = acknowledgedSlots.current;
          setSelectedSlots(acknowledgedSlots.current);
          updateNumericDraft(String(acknowledgedSlots.current.length));
          return;
        }
        acknowledgedSlots.current = requestedSlots;
      }
      acknowledgedSlots.current = intendedSlots.current;
    } catch {
      intendedSlots.current = acknowledgedSlots.current;
      setSelectedSlots(acknowledgedSlots.current);
      updateNumericDraft(String(acknowledgedSlots.current.length));
    } finally {
      saving.current = false;
      setPending(false);
      callbacks.current.onSavingChange?.(false);
    }
  }

  return (
    <div
      className={`meal-choice ${displayedQuantity > 0 ? 'meal-choice-selected' : ''}`}
      role="group"
      aria-label={item.name}
      aria-busy={pending || undefined}
    >
      <div className="meal-choice-heading">
        <ItemHeading>{item.name}</ItemHeading>
      </div>
      <div className="meal-choice-actions">
        <div className="meal-choice-share">
          <AmountRatio amount={myAmount} total={allocation.amount} />
          {pending && (
            <LoaderCircle className="meal-choice-saving" size={14} role="img" aria-label="保存中" />
          )}
        </div>
        {byQuantity ? (
          <span className="meal-choice-count" aria-live="polite" aria-atomic="true">
            <span className="sr-only">
              食べた・飲んだ数 {displayedQuantity}、全部で {totalQuantity}
            </span>
            <span aria-hidden="true">
              <strong>{displayedQuantity}</strong>
              <span className="meal-choice-denominator"> / {totalQuantity}</span>
            </span>
          </span>
        ) : (
          <button
            type="button"
            className="meal-choice-toggle"
            aria-label={`${item.name}：${quantity > 0 ? '選択済み' : '選ぶ'}`}
            aria-pressed={quantity > 0}
            disabled={disabled}
            onClick={() => void onChange(quantity > 0 ? 0 : 1)}
          >
            {quantity > 0 ? <Check size={18} strokeWidth={2.5} /> : <Plus size={18} />}
            {quantity > 0 ? '選択済み' : '選ぶ'}
          </button>
        )}
      </div>
      {byQuantity && (
        <>
          <div className="meal-choice-tiles">
            {Array.from({ length: Math.min(visibleCount, totalQuantity) }, (_, slot) => (
              <button
                key={slot}
                type="button"
                className={`meal-unit${taken.has(slot) ? ' is-taken' : ''}`}
                data-slot={slot}
                aria-label={`${item.name} ${slot + 1}/${totalQuantity}${taken.has(slot) ? '（ほかの人の分）' : ''}`}
                aria-pressed={selected.has(slot)}
                disabled={tileDisabled || taken.has(slot)}
                onClick={() => {
                  const current = intendedSlots.current;
                  const next = current.includes(slot)
                    ? current.filter((selectedSlot) => selectedSlot !== slot)
                    : [...current, slot];
                  updateNumericDraft(String(next.length));
                  void saveSlots(next);
                }}
              >
                <MealIcon name={item.name} />
                {selected.has(slot) && (
                  <span className="meal-unit-mark is-selected" aria-hidden="true">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
                {taken.has(slot) && (
                  <span className="meal-unit-mark is-person" aria-hidden="true">
                    <UserRound size={12} strokeWidth={2} />
                  </span>
                )}
              </button>
            ))}
          </div>
          {totalQuantity > TILE_PAGE_SIZE && (
            <div className="meal-choice-overflow">
              {visibleCount < totalQuantity && (
                <button
                  type="button"
                  className="meal-choice-more"
                  aria-label={`${item.name}をさらに表示`}
                  onClick={() => setVisibleCount((count) => count + TILE_PAGE_SIZE)}
                >
                  さらに表示 <ChevronDown size={16} aria-hidden="true" />
                </button>
              )}
              <details className="meal-choice-numeric">
                <summary>数で入力</summary>
                <div className="meal-choice-numeric-field">
                  <input
                    type="number"
                    inputMode="numeric"
                    aria-label={`${item.name}の食べた・飲んだ数`}
                    min="0"
                    max={maximumQuantity}
                    step="1"
                    aria-invalid={numericInvalid || undefined}
                    aria-describedby={numericInvalid ? numericErrorId : undefined}
                    disabled={tileDisabled}
                    value={numericCount}
                    onFocus={() => {
                      numericEditing.current = true;
                    }}
                    onBlur={() => {
                      numericEditing.current = false;
                      if (numericDraft.current.trim() === '') updateNumericDraft('0');
                    }}
                    onChange={(event) => {
                      const value = event.target.value;
                      updateNumericDraft(value);
                      const count = draftQuantity(value, maximumQuantity);
                      if (count !== null) {
                        void saveSlots(reconcileSlots(intendedSlots.current, count, totalQuantity));
                      }
                    }}
                  />
                  <span className="meal-choice-denominator"> / {totalQuantity}</span>
                </div>
                {numericInvalid && (
                  <p className="meal-choice-numeric-error" id={numericErrorId} role="alert">
                    0〜{maximumQuantity}の整数
                  </p>
                )}
              </details>
            </div>
          )}
        </>
      )}
      {byQuantity && others.length > 0 && (
        <details className="meal-choice-others">
          <summary>
            ほかの人の分 {othersQuantity} / {totalQuantity}
            <span>残り {Math.max(0, totalQuantity - othersQuantity - displayedQuantity)}</span>
          </summary>
          <p>
            {others
              .map((member) => `${member.name} × ${getSelectionQuantity(room, member.id, item)}`)
              .join('・')}
          </p>
        </details>
      )}
      {!byQuantity && eaters.length > 0 && (
        <p className="meal-choice-shared-members">
          {eaters.map((member) => member.name).join('・')}（{eaters.length}人）
        </p>
      )}
    </div>
  );
}
