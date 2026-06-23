export type OngoingCredentials = {
  key: string
  baseUrl: string
  username: string
  password: string
  goodsOwnerId: number
  webhookSecret?: string
}

export type OngoingPluginOptions = {
  integrations: OngoingCredentials[]
  defaultStockSyncInterval?: string
  defaultStatusPollInterval?: string
  rateLimitConcurrency?: number
}

export interface OngoingInventoryRow {
  articleNumber: string
  articleSystemId?: number
  numberOfItems: number
  allocatedNumberOfItems: number
  sellableNumberOfItems: number
  toReceiveNumberOfItems: number
}

export interface OngoingOrderStatus {
  number: number
  text: string
}

export interface OngoingParcelTracking {
  code?: string
  carrier?: string
  url?: string
}

export interface OngoingTrackedOrder {
  ongoingOrderId: number
  orderNumber: string
  statusNumber: number
  statusText: string
  trackingNumbers: string[]
}

// Full Medusa->Ongoing order mapping is implemented in Milestone 2.
export type PostOrderModel = Record<string, unknown>
