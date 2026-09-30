import { Check, Minus, Plus } from 'lucide-react';
import type { ItemAllocation, ReceiptItem, Room } from '../shared/types';
import { getItemQuantity, getItemSplitMode, getSelectionQuantity } from '../shared/settlement';

const yen = (amount: number) =>
  new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(amount);

export default function ItemSelection({
  item,
  room,
  memberId,
  allocation,
  busy,
  onChange,
}: {
  item: ReceiptItem;
  room: Room;
  memberId: string;
  allocation: ItemAllocation;
  busy: boolean;
  onChange: (quantity: number) => void;
}) {
  const quantity = getSelectionQuantity(room, memberId, item);
  const byQuantity = getItemSplitMode(item) === 'quantity';
  const eaters = room.members.filter((member) => getSelectionQuantity(room, member.id, item) > 0);
  const content = (
    <>
      {!byQuantity && (
        <span className="item-checkbox">
          {quantity > 0 && <Check size={17} strokeWidth={2.5} />}
        </span>
      )}
      <span className="selection-item-content">
        <span className="selection-item-name">{item.name}</span>
        <span className="selection-item-mode">
          {byQuantity
            ? `全${getItemQuantity(item)}個 · 個数で分ける`
            : `${getItemQuantity(item) > 1 ? `全${getItemQuantity(item)}個 · ` : ''}均等に割り勘`}
        </span>
        <span className="selection-item-members">
          {eaters.length
            ? byQuantity
              ? eaters
                  .map(
                    (member) => `${member.name} ${getSelectionQuantity(room, member.id, item)}個`,
                  )
                  .join('・')
              : `${eaters.map((member) => member.name).join('・')}（${eaters.length}人で割り勘）`
            : 'まだ選ばれていません'}
        </span>
      </span>
      <span className="selection-item-price">
        <strong>{yen(allocation.amount)}</strong>
        {quantity > 0 && <small>あなた {yen(allocation.memberAmounts[memberId] || 0)}</small>}
      </span>
    </>
  );
  if (!byQuantity) {
    return (
      <button
        className={`selectable-item ${quantity > 0 ? 'selected' : ''}`}
        aria-pressed={quantity > 0}
        disabled={busy || room.closed}
        onClick={() => onChange(quantity > 0 ? 0 : 1)}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      className={`quantity-item ${quantity > 0 ? 'selected' : ''}`}
      role="group"
      aria-label={item.name}
    >
      <div className="selectable-item">{content}</div>
      <div className="quantity-controls">
        <span
          className={`quantity-remaining ${allocation.unassignedQuantity > 0 ? 'pending' : ''}`}
        >
          {allocation.unassignedQuantity > 0
            ? `あと${allocation.unassignedQuantity}個が未割当`
            : `全${getItemQuantity(item)}個を割当済み`}
        </span>
        <div className="quantity-stepper">
          <button
            aria-label={`${item.name}の個数を減らす`}
            disabled={busy || room.closed || quantity === 0}
            onClick={() => onChange(quantity - 1)}
          >
            <Minus size={16} />
          </button>
          <span aria-live="polite" aria-atomic="true">
            あなた <strong>{quantity}</strong> 個
          </span>
          <button
            aria-label={`${item.name}の個数を増やす`}
            disabled={busy || room.closed || allocation.unassignedQuantity === 0}
            onClick={() => onChange(quantity + 1)}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
