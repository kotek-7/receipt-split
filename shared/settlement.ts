import type { Room, Settlement } from './types';

/** Allocate integer yen without losing tax, discounts, or rounding remainders. */
export function calculateSettlement(room: Room): Settlement {
  const memberAmounts = Object.fromEntries(room.members.map((member) => [member.id, 0]));
  const weightTotal = room.items.reduce((sum, item) => sum + item.amount, 0);
  const amounts = room.items.map((item) => Math.floor((room.total * item.amount) / weightTotal));
  const remainderOrder = room.items
    .map((item, index) => ({ index, remainder: (room.total * item.amount) % weightTotal }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const remaining = room.total - amounts.reduce((sum, amount) => sum + amount, 0);
  for (let index = 0; index < remaining; index++) amounts[remainderOrder[index].index]++;

  let unassignedAmount = 0;
  let unassignedCount = 0;
  const itemAllocations = room.items.map((item, index) => {
    const amount = amounts[index];
    const participants = room.members.filter((member) =>
      room.selections[member.id]?.includes(item.id),
    );
    const allocation: Record<string, number> = {};
    if (!participants.length) {
      unassignedAmount += amount;
      unassignedCount++;
    } else {
      const share = Math.floor(amount / participants.length);
      const remainder = amount % participants.length;
      participants.forEach((member, memberIndex) => {
        const memberAmount = share + (memberIndex < remainder ? 1 : 0);
        allocation[member.id] = memberAmount;
        memberAmounts[member.id] += memberAmount;
      });
    }
    return { itemId: item.id, amount, memberAmounts: allocation };
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
