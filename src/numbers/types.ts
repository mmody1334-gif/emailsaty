export type SupportedService = 'whatsapp' | 'google' | 'facebook' | 'telegram' | 'tiktok' | 'any'

export interface CountryInfo {
  code: string
  name: string
  dialCode: string
  flag: string
  whatsappSuccessRate: string
}

export interface PhoneNumberOrder {
  orderId: string
  service: SupportedService
  country: string
  dialCode: string
  phoneNumber: string
  status: 'PENDING' | 'RECEIVED' | 'CANCELLED' | 'TIMEOUT'
  smsCode?: string
  smsText?: string
  createdAt: number
  expiresAt: number
  chatId?: string | number
}

export interface FreePublicNumber {
  country: string
  flag: string
  number: string
  serviceTag: string
  lastSmsText?: string
  lastSmsTime?: string
}
