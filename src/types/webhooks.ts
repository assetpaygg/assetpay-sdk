import type { CryptoDeposit, CryptoWithdrawal, Trade } from './api.js';

interface WebhookBase {
  deliveryId: string;
  timestamp: string;
  dedupeKey: string;
}

export interface WithdrawApprovalEvent extends WebhookBase {
  type: 'withdraw.approval';
  trade: Trade;
}

export interface CryptoWithdrawApprovalEvent extends WebhookBase {
  type: 'crypto_withdraw.approval';
  withdrawal: CryptoWithdrawal;
}

export interface TradeEvent extends WebhookBase {
  type: 'trade';
  trade: Trade;
}

export interface CryptoDepositEvent extends WebhookBase {
  type: 'crypto_deposit';
  deposit: CryptoDeposit;
}

export interface CryptoWithdrawEvent extends WebhookBase {
  type: 'crypto_withdraw';
  withdrawal: CryptoWithdrawal;
}

export interface UnknownWebhookEvent extends WebhookBase {
  type: 'unknown';
  body: unknown;
}

export type ApprovalEvent = WithdrawApprovalEvent | CryptoWithdrawApprovalEvent;

export type WebhookEvent =
  | WithdrawApprovalEvent
  | CryptoWithdrawApprovalEvent
  | TradeEvent
  | CryptoDepositEvent
  | CryptoWithdrawEvent
  | UnknownWebhookEvent;

export interface ApprovalResponse {
  status: 200;
  body: { action: 'approve' } | { action: 'reject'; reason: string };
}
