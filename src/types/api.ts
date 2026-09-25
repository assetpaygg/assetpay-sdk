export type GameId = 730 | 252490;

export type TradeStatus =
  | 'initiated'
  | 'pending'
  | 'active'
  | 'hold'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'declined'
  | 'reverted';

export type TradeType = 'deposit' | 'withdraw';
export type TradeSource = 'client' | 'self';
export type RevertedBy = 'supplier' | 'user';
export type DeliveryMode = 'standard' | 'instant';
export type DeliveryFilter = 'any' | DeliveryMode;
export type ItemSort = 'relevance' | 'priceAsc' | 'priceDesc' | 'nameAsc' | 'nameDesc';
export type MarketSource = 'internal' | 'external' | 'Xk9W';

export type DopplerPhase =
  | 'Phase 1'
  | 'Phase 2'
  | 'Phase 3'
  | 'Phase 4'
  | 'Ruby'
  | 'Sapphire'
  | 'Black Pearl'
  | 'Emerald';

export type TradeFailureCode =
  | 'LISTING_UNAVAILABLE'
  | 'NO_LISTING_AT_PRICE'
  | 'PRICE_CHANGED'
  | 'TRADE_URL_INVALID'
  | 'STEAM_ACCOUNT_RESTRICTED'
  | 'BUYER_TRADE_RESTRICTED'
  | 'OFFER_NOT_ACCEPTED'
  | 'MARKET_UNAVAILABLE'
  | 'PURCHASE_FAILED';

export type TradeErrorCode =
  | TradeFailureCode
  | 'USER_TRADE_RESTRICTED'
  | 'USER_INVENTORY_PRIVATE'
  | 'USER_ESCROW'
  | 'USER_NOT_FOUND'
  | 'SERVICE_UNAVAILABLE'
  | 'MERCHANT_REJECTED'
  | 'APPROVAL_TIMEOUT';

export interface Sticker {
  name: string;
  marketHashName?: string;
  slot: number;
  wear?: number;
  iconUrl: string;
}

export interface Charm {
  name: string;
  marketHashName?: string;
  iconUrl: string;
}

export interface Doppler {
  status?: number;
  name: string;
  paintIndex?: number;
}

export interface Fade {
  percentage: number;
}

export interface Hardened {
  status: number;
  name: string;
}

export interface BotInfo {
  name: string;
  avatar?: string;
  joined?: string;
  steamId?: string;
}

export interface ItemOffer {
  price: number;
  delivery?: DeliveryMode;
  maxAmount?: number;
  accepted?: boolean;
}

export interface Item {
  id: string;
  itemId?: string;
  externalId?: string;
  assetId?: string;
  appid: GameId;
  name?: string;
  marketHashName?: string;
  type?: string;
  iconUrl?: string;
  tradable: boolean;
  amount?: number;
  status?: TradeStatus;
  error?: TradeFailureCode;
  marketPrice?: number;
  offer?: ItemOffer;
  exterior?: string;
  rarity?: string;
  color?: string;
  wear?: string;
  paintSeed?: number;
  previewToken?: string;
  doppler?: Doppler;
  fade?: Fade;
  hardened?: Hardened;
  stickers?: Sticker[];
  charm?: Charm;
  botInfo?: BotInfo;
}

export interface Collateral {
  merchant: number;
  provider: number;
}

export interface Trade {
  id: string;
  type: TradeType;
  source: TradeSource;
  externalId?: string;
  externalClientUserId?: string;
  merchantId: string;
  clientUserId: string;
  clientTradeUrl: string;
  clientSteamID: string;
  offerID?: string;
  status: TradeStatus;
  game: string;
  items: Item[];
  totalPrice: number;
  preCredit?: number;
  pendingCredit?: number;
  isInstant?: boolean;
  collateral?: Collateral;
  holdEndDate?: string;
  revertedBy?: RevertedBy;
  botInfo?: BotInfo;
  error?: TradeErrorCode;
  activeAt?: string;
  autoCancelAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DepositTrade extends Trade {
  relatedTrades?: Trade[];
}

export interface TradePage {
  items: Trade[];
  nextCursor: string | null;
}

export interface ItemCancelResult {
  tradeId: string;
  itemId: string;
  externalId?: string;
  // Two Ls here, unlike TradeStatus 'canceled'.
  status: 'cancelled';
}

export interface ItemCancelOutcome {
  itemId: string;
  externalId?: string;
  status: 'cancelled' | 'failed';
  reason?: string;
}

export interface TradeCancelResult {
  tradeId: string;
  requested: number;
  cancelled: number;
  failed: number;
  items: ItemCancelOutcome[];
}

export type TradeUrlCheckState = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface TradeRestriction {
  escrowDays: number;
  probation: boolean;
}

export interface SteamBans {
  vacBanned: boolean;
  gameBans: number;
  economyBan: string;
}

export interface TradeUrlCheck {
  state: TradeUrlCheckState;
  steamid?: string;
  message: string;
  canTrade?: boolean;
  reason?: TradeRestriction;
  bans?: SteamBans;
}

export interface Cs2WithdrawPrices {
  standard: number | null;
  instant: number | null;
}

export interface Cs2PhasePrice {
  phase: DopplerPhase;
  accepted: boolean;
  deposit: number;
  withdraw: Cs2WithdrawPrices;
}

export interface Cs2PriceItem {
  itemId: string | null;
  marketHashName: string;
  accepted: boolean;
  deposit: number;
  withdraw: Cs2WithdrawPrices;
  phases?: Cs2PhasePrice[];
}

export interface RustPriceItem {
  marketHashName: string;
  accepted: boolean;
  deposit: number;
  withdraw: number | null;
}

export type PriceItem = Cs2PriceItem | RustPriceItem;

export interface Inventory {
  inventory: Item[];
  count: number;
  updatedAt: string;
  collateral: number;
}

export interface MarketPage {
  items: Item[];
  count: number;
}

export interface MarketSuggestion {
  id: string;
  marketHashName: string;
  iconUrl: string;
  rarity?: string;
  rarityColor?: string;
  itemType?: string;
}

export type MarketSuggestions = MarketSuggestion[];

export interface ClientAuthToken {
  token: string;
}

export type CryptoChain = 'ETH' | 'BSC' | 'SOL';
export type CryptoToken = 'USDT' | 'USDC';
export type CryptoDepositAddressStatus = 'active' | 'pending' | 'paused';

export interface CryptoTokenInfo {
  token: CryptoToken;
  contract: string;
  decimals: number;
}

export interface CryptoDepositAddress {
  steamId: string;
  chain: CryptoChain;
  network: string;
  testnet: boolean;
  status: CryptoDepositAddressStatus;
  address: string | null;
  tokenAccount: string | null;
  tokens: CryptoTokenInfo[];
  minDepositCents: number;
  minConfirmations: number;
  explorerUrl: string | null;
}

export type CryptoDepositStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'frozen'
  | 'refunded'
  | 'below_minimum';

export interface CryptoDeposit {
  id: string;
  type: 'crypto_deposit';
  status: CryptoDepositStatus;
  steamId: string;
  chain: string;
  token: string;
  amount: string;
  amountCents: number;
  cryptoAmount: string;
  address: string;
  txHash: string | null;
  from: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CryptoDepositPage {
  deposits: CryptoDeposit[];
  nextBefore: string | null;
}

export type CryptoWithdrawalStatus =
  | 'awaiting_approval'
  | 'in_review'
  | 'approved'
  | 'sent'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export interface CryptoWithdrawal {
  id: string;
  type: 'crypto_withdraw';
  status: CryptoWithdrawalStatus;
  steamId: string;
  chain: string;
  token: string;
  amount: string;
  amountCents: number;
  feeCents: number;
  receiveCents: number;
  cryptoAmount: string;
  address: string;
  txHash: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CryptoWithdrawalPage {
  withdrawals: CryptoWithdrawal[];
  nextBefore: string | null;
}

export interface WalletBalance {
  balance: number;
  pendingBalance: number;
  escrowBalance: number;
  currency: string;
}

export type FundingType = 'DEPOSIT' | 'WITHDRAWAL' | 'REFUND' | 'INTERNAL_TRANSFER';

export type FundingStatus =
  | 'INITIATED'
  | 'PENDING'
  | 'PENDING_ADMIN'
  | 'APPROVED'
  | 'REJECTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'EXPIRED';

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface LedgerAmount {
  usd: number;
  crypto: string;
  token: string | null;
  chain: string | null;
}

export interface LedgerTimestamps {
  created: string;
  completed: string | null;
  updated: string;
}

export interface LedgerTransaction {
  id: string;
  type: FundingType | 'ADMIN_CREDIT' | 'ADMIN_DEBIT';
  status: FundingStatus | 'POSTED';
  amount: LedgerAmount;
  fee: number;
  address: string | null;
  txnHash: string | null;
  timestamps: LedgerTimestamps;
}

export interface LedgerTransactionPage {
  items: LedgerTransaction[];
  pagination: Pagination;
}

export interface LedgerTransactionDetailsAmount extends LedgerAmount {
  exchangeRate: string;
}

export interface LedgerTransactionDetailsTimestamps extends LedgerTimestamps {
  expired: string | null;
}

export interface LedgerTransactionDetails {
  id: string;
  type: FundingType;
  status: FundingStatus;
  amount: LedgerTransactionDetailsAmount;
  address: string | null;
  txnHash: string | null;
  fee: number;
  timestamps: LedgerTransactionDetailsTimestamps;
}

export interface Envelope<T> {
  requestId: string;
  success: true;
  data: T;
}

export interface ErrorBody {
  code: number;
  key: string;
  message: string | string[];
  fields?: Record<string, string>;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  requestId: string;
  success: false;
  error: ErrorBody;
}

export interface ClientData {
  totalWager?: number | undefined;
  registrationDate?: string | Date | undefined;
  kycHash?: string | undefined;
  kycLevel?: number | undefined;
  fiatDeposits?: boolean | undefined;
  cryptoDeposits?: boolean | undefined;
}

export interface ClientIdentity {
  steamId: string;
  tradeUrl: string;
  clientId?: string | undefined;
  clientData?: ClientData | undefined;
}

export interface CheckTradeUrlInput {
  tradeUrl: string;
  forceRefresh?: boolean | undefined;
}

export interface PricesQuery {
  game?: GameId | undefined;
}

export interface InventoryQuery {
  refresh?: boolean | undefined;
  acceptedOnly?: boolean | undefined;
  game?: GameId | undefined;
  search?: string | undefined;
  sort?: ItemSort | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface MerchantInventoryQuery extends InventoryQuery {
  tradeUrl: string;
}

export interface DepositItem {
  itemId: string;
  price: number;
  amount?: number | undefined;
}

export type SellItem = DepositItem;

export interface DepositInput {
  items: DepositItem[];
  game?: GameId | undefined;
  externalId?: string | undefined;
  isInstant?: boolean | undefined;
}

export interface SellInput extends DepositInput {
  tradeUrl: string;
}

export interface BuyItem {
  itemId: string;
  price: number;
  maxPrice?: number | undefined;
  externalId?: string | undefined;
}

export interface WithdrawInput {
  items: BuyItem[];
  slippageBps?: number | undefined;
  autoCancel?: number | undefined;
  game?: GameId | undefined;
  externalId?: string | undefined;
}

export interface BuyInput extends WithdrawInput {
  tradeUrl: string;
}

export interface QuickWithdrawInput {
  itemId?: string | undefined;
  marketHashName?: string | undefined;
  maxPrice: number;
  amount: number;
  delivery?: DeliveryMode | undefined;
  phase?: DopplerPhase | undefined;
  autoCancel?: number | undefined;
  game?: GameId | undefined;
  externalId?: string | undefined;
  externalIds?: string[] | undefined;
}

export interface QuickBuyInput extends QuickWithdrawInput {
  tradeUrl: string;
}

export interface MarketSearchQuery {
  game?: GameId | undefined;
  search?: string | undefined;
  sort?: ItemSort | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
  development?: boolean | undefined;
}

export interface MerchantMarketSearchQuery extends MarketSearchQuery {
  source?: MarketSource | undefined;
}

export interface MarketListingsQuery {
  itemId?: string | undefined;
  marketHashName?: string | undefined;
  delivery?: DeliveryFilter | undefined;
  phase?: DopplerPhase | undefined;
  floatMin?: number | undefined;
  floatMax?: number | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
}

export interface MarketSuggestionsQuery {
  q: string;
}

export interface TradeListQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  type?: TradeType | undefined;
  game?: GameId | undefined;
}

export interface CryptoDepositAddressQuery {
  chain: CryptoChain;
  token?: CryptoToken | undefined;
}

export interface CryptoListQuery {
  limit?: number | undefined;
  before?: string | undefined;
}

export interface CryptoWithdrawInput {
  chain: CryptoChain;
  token: CryptoToken;
  address: string;
  amountCents: number;
  requestId?: string | undefined;
}

export interface MerchantCryptoDepositAddressQuery extends CryptoDepositAddressQuery {
  steamId: string;
}

export interface MerchantCryptoListQuery extends CryptoListQuery {
  steamId: string;
}

export interface MerchantCryptoWithdrawInput extends CryptoWithdrawInput {
  steamId: string;
}

export interface LedgerTransactionsQuery {
  type?: FundingType | undefined;
  status?: FundingStatus | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface HealthStatus {
  status: 'ok';
  timestamp: string;
  uptime: number;
  maintenance: { mode: string };
}
