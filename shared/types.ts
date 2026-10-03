export interface ReceiptItem {
  id: string;
  name: string;
  amount: number;
  quantity?: number;
  splitMode?: 'equal' | 'quantity';
}
export interface Member {
  id: string;
  name: string;
  done: boolean;
}
export interface Room {
  id: string;
  title: string;
  payerId: string;
  items: ReceiptItem[];
  total: number;
  participantCount?: number;
  calculationMode?: 'fixed-participants';
  members: Member[];
  selections: Record<string, string[]>;
  selectionQuantities?: Record<string, Record<string, number>>;
  paidMemberIds: string[];
  closed: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface Identity {
  memberId: string;
  token: string;
}
export interface SessionResponse {
  room: Room;
  identity: Identity;
}
export interface ItemAllocation {
  itemId: string;
  amount: number;
  memberAmounts: Record<string, number>;
  unassignedQuantity: number;
  unassignedAmount: number;
  roundingAmount?: number;
}
export interface Settlement {
  memberAmounts: Record<string, number>;
  itemAllocations: ItemAllocation[];
  unassignedAmount: number;
  unassignedCount: number;
  assignedCount: number;
  roundingAmount: number;
  pendingParticipantAmount: number;
  ready: boolean;
}
export interface ParsedReceipt {
  items: ReceiptItem[];
  total: number;
  title: string;
  rawText: string;
  warnings?: string[];
}
