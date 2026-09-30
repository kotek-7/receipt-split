import { Check, Minus, Plus } from 'lucide-react';
import type { ItemAllocation, ReceiptItem, Room } from '../shared/types';
import { getItemQuantity, getItemSplitMode, getSelectionQuantity } from '../shared/settlement';
import AmountRatio from './AmountRatio';
import './selection.css';

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
  const totalQuantity = getItemQuantity(item);
  const myAmount = allocation.memberAmounts[memberId] || 0;
  const ItemHeading = room.calculationMode === 'fixed-participants' ? 'h3' : 'h4';
  const eaters = room.members.filter((member) => getSelectionQuantity(room, member.id, item) > 0);
  const others = eaters.filter((member) => member.id !== memberId);
  const othersQuantity = others.reduce(
    (total, member) => total + getSelectionQuantity(room, member.id, item),
    0,
  );
  return (
    <div
      className={`meal-choice ${quantity > 0 ? 'meal-choice-selected' : ''}`}
      role="group"
      aria-label={item.name}
    >
      <div className="meal-choice-heading">
        <ItemHeading>{item.name}</ItemHeading>
      </div>
      <div className="meal-choice-actions">
        <div className="meal-choice-share">
          <AmountRatio amount={myAmount} total={allocation.amount} />
        </div>
        {byQuantity ? (
          <div className="meal-choice-stepper">
            <button
              type="button"
              aria-label={`${item.name}の数を減らす`}
              disabled={busy || room.closed || quantity === 0}
              onClick={() => onChange(quantity - 1)}
            >
              <Minus size={18} />
            </button>
            <span className="meal-choice-count" aria-live="polite" aria-atomic="true">
              <span className="sr-only">
                食べた・飲んだ数 {quantity}、全部で {totalQuantity}
              </span>
              <span aria-hidden="true">
                <strong>{quantity}</strong>
                <span className="meal-choice-denominator"> / {totalQuantity}</span>
              </span>
            </span>
            <button
              type="button"
              aria-label={`${item.name}の数を増やす`}
              disabled={busy || room.closed || allocation.unassignedQuantity === 0}
              onClick={() => onChange(quantity + 1)}
            >
              <Plus size={18} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="meal-choice-toggle"
            aria-label={`${item.name}：${quantity > 0 ? '選択済み' : '選ぶ'}`}
            aria-pressed={quantity > 0}
            disabled={busy || room.closed}
            onClick={() => onChange(quantity > 0 ? 0 : 1)}
          >
            {quantity > 0 ? <Check size={18} strokeWidth={2.5} /> : <Plus size={18} />}
            {quantity > 0 ? '選択済み' : '選ぶ'}
          </button>
        )}
      </div>
      {byQuantity && others.length > 0 && (
        <details className="meal-choice-others">
          <summary>
            ほかの人の分 {othersQuantity} / {totalQuantity}
            <span>残り {allocation.unassignedQuantity}</span>
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
