export interface ReceiptItem {
  id: string;
  name: string;
  amount: number;
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
  members: Member[];
  selections: Record<string, string[]>;
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
}
export interface Settlement {
  memberAmounts: Record<string, number>;
  itemAllocations: ItemAllocation[];
  unassignedAmount: number;
  unassignedCount: number;
  assignedCount: number;
  ready: boolean;
}
export interface ParsedReceipt {
  items: ReceiptItem[];
  total: number;
  title: string;
  rawText: string;
}
