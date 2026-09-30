import { Check, Minus, Plus } from 'lucide-react';
import type { ItemAllocation, ReceiptItem, Room } from '../shared/types';
import { getItemQuantity, getItemSplitMode, getSelectionQuantity } from '../shared/settlement';
import './selection.css';

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
  const ItemHeading = room.calculationMode === 'fixed-participants' ? 'h3' : 'h4';
  const eaters = room.members.filter((member) => getSelectionQuantity(room, member.id, item) > 0);
  return (
    <div
      className={`meal-choice ${quantity > 0 ? 'meal-choice-selected' : ''}`}
      role="group"
      aria-label={item.name}
    >
      <div className="meal-choice-heading">
        <ItemHeading>{item.name}</ItemHeading>
        <p className="meal-choice-total">
          全体 {yen(allocation.amount)} <span>· 数量 {getItemQuantity(item)}</span>
        </p>
      </div>
      <div className="meal-choice-actions">
        <div className="meal-choice-share">
          <span>あなたの分</span>
          <strong>{yen(allocation.memberAmounts[memberId] || 0)}</strong>
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
              <span>自分の数</span>
              <strong>{quantity}</strong>
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
      <div className="meal-choice-status">
        <p>
          {eaters.length
            ? byQuantity
              ? eaters
                  .map(
                    (member) => `${member.name} × ${getSelectionQuantity(room, member.id, item)}`,
                  )
                  .join('・')
              : `${eaters.map((member) => member.name).join('・')}（${eaters.length}人で割り勘）`
            : 'まだ選ばれていません'}
        </p>
        {byQuantity && (
          <span>
            {allocation.unassignedQuantity > 0
              ? `残り ${allocation.unassignedQuantity}`
              : 'すべて選択済み'}
          </span>
        )}
      </div>
    </div>
  );
}
