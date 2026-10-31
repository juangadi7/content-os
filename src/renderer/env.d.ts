import type { ContentOsApi } from '../core/api'

declare global {
  interface Window {
    contentOS: ContentOsApi
  }
}

export {}
