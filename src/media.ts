import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * Everything the message converter needs to handle WeCom media. Implemented by
 * the agent pool so downloads, attachments, and workspace writes stay in one
 * place.
 */
export interface MediaPort {
  /** Fetch an encrypted media resource; the SDK decrypts it with `aesKey`. */
  download(url: string, aesKey?: string): Promise<{ data: Uint8Array; filename?: string }>
  /** Persist a decoded image as a Harness attachment and return its block. */
  saveImage(data: Uint8Array, mediaType: ImageMediaType, name?: string): Promise<ContentBlock>
  /** Persist a decoded upload into the agent's workspace; returns the path. */
  saveUpload(data: Uint8Array, filename?: string): string
  /** Per-message attachment budget, read from the attachment service. */
  limits: { maxImages: number; maxBytes: number }
}

/** Recognize the four image formats the attachment service accepts, by magic bytes. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    startsWith(data, [0x52, 0x49, 0x46, 0x46]) &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp'
  }
  throw new Error('unrecognized image format')
}

/** Keep an uploaded filename safe for a workspace path. */
export function safeFilename(name: string | undefined, fallback: string): string {
  const raw = basename((name ?? '').trim())
    .replace(/[^\w.\- ]/g, '_')
    .trim()
    .slice(0, 120)
  return raw || fallback
}

/** Write a downloaded upload into the agent's workspace so its tools can read it. */
export function saveUploadFile(cwd: string, data: Uint8Array, filename: string): string {
  const dir = join(cwd, '.wecom-uploads')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${Date.now().toString(36)}-${filename}`)
  writeFileSync(path, data)
  return path
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte)
}
