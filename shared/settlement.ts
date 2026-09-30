import type { ReceiptItem, Room, Settlement } from './types';

export function getItemQuantity(item: ReceiptItem): number {
  const quantity = item.quantity ?? 1;
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
}

export function getItemSplitMode(item: ReceiptItem): 'equal' | 'quantity' {
  return item.splitMode === 'quantity' ? 'quantity' : 'equal';
}

export function getSelectionQuantity(room: Room, memberId: string, item: ReceiptItem): number {
  if (!room.selections[memberId]?.includes(item.id)) return 0;
  if (getItemSplitMode(item) === 'equal') return 1;
  const quantity = room.selectionQuantities?.[memberId]?.[item.id] ?? 1;
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
}

/** Ties retain the input order, including any unassigned bucket at the end. */
function allocateIntegerYen(total: number, weights: number[]): number[] {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (!weightTotal) return weights.map(() => 0);
  const amounts = weights.map((weight) => Math.floor((total * weight) / weightTotal));
  const remainderOrder = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % weightTotal }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const remaining = total - amounts.reduce((sum, amount) => sum + amount, 0);
  for (let index = 0; index < remaining; index++) amounts[remainderOrder[index].index]++;
  return amounts;
}

/** Allocate integer yen without losing tax, discounts, or rounding remainders. */
export function calculateSettlement(room: Room): Settlement {
  const memberAmounts = Object.fromEntries(room.members.map((member) => [member.id, 0]));
  const amounts = allocateIntegerYen(
    room.total,
    room.items.map((item) => item.amount),
  );

  let unassignedAmount = 0;
  let unassignedCount = 0;
  const itemAllocations = room.items.map((item, index) => {
    const amount = amounts[index];
    const quantity = getItemQuantity(item);
    const splitMode = getItemSplitMode(item);
    let remainingQuantity = quantity;
    const participants = room.members.flatMap((member) => {
      const selectedQuantity = getSelectionQuantity(room, member.id, item);
      // The API rejects overclaims; cap old or corrupt data to conserve the total.
      const weight =
        splitMode === 'quantity' ? Math.min(selectedQuantity, remainingQuantity) : selectedQuantity;
      if (splitMode === 'quantity') remainingQuantity -= weight;
      return weight > 0 ? [{ member, weight }] : [];
    });
    const unassignedQuantity =
      splitMode === 'quantity' ? remainingQuantity : participants.length ? 0 : quantity;
    const shares = allocateIntegerYen(amount, [
      ...participants.map(({ weight }) => weight),
      unassignedQuantity,
    ]);
    const itemUnassignedAmount = shares[participants.length];
    const allocation: Record<string, number> = {};
    if (unassignedQuantity > 0) unassignedCount++;
    unassignedAmount += itemUnassignedAmount;
    participants.forEach(({ member }, memberIndex) => {
      const memberAmount = shares[memberIndex];
      allocation[member.id] = memberAmount;
      memberAmounts[member.id] += memberAmount;
    });
    return {
      itemId: item.id,
      amount,
      memberAmounts: allocation,
      unassignedQuantity,
      unassignedAmount: itemUnassignedAmount,
    };
  });
  return {
    memberAmounts,
    itemAllocations,
    unassignedAmount,
    unassignedCount,
    assignedCount: room.items.length - unassignedCount,
    ready:
      room.members.length > 0 &&
      room.members.every((member) => member.done) &&
      unassignedCount === 0,
  };
}
