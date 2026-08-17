import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BaseMessage, ImageContent, MixedMsgItem } from '@wecom/aibot-node-sdk'
import { detectImageMediaType, type MediaPort } from './media.js'

/** True when the message carries any image (body, mixed item, or quote). */
export function containsImageMedia(message: BaseMessage): boolean {
  if (message.msgtype === 'image') return true
  if ((message.mixed?.msg_item ?? []).some((item: MixedMsgItem) => item.msgtype === 'image')) {
    return true
  }
  return message.quote?.msgtype === 'image'
}

/**
 * Turn one inbound WeCom message into model-facing content blocks.
 *
 * Text and voice transcription go into the text block; images are downloaded,
 * decrypted by the SDK, and attached when `includeImages` (otherwise noted as
 * text); files and videos are saved into the agent's workspace and referenced
 * by path so the agent's own tools can read them.
 */
export async function toContentBlocks(
  message: BaseMessage,
  media: MediaPort,
  includeImages: boolean,
): Promise<ContentBlock[]> {
  const scope = message.chattype === 'group' ? 'WeCom group' : 'WeCom private chat'
  const parts = [`[${scope} message from WeCom user ${message.from.userid}]`]
  const images: ImageContent[] = []
  await readBody(message, parts, images, media)
  readQuote(message, parts, images)

  const blocks: ContentBlock[] = []
  const selected = images.slice(0, media.limits.maxImages)
  for (const image of selected) {
    let downloaded: { data: Uint8Array; filename?: string }
    try {
      downloaded = await media.download(image.url, image.aeskey)
    } catch (error) {
      parts.push(`[image download failed: ${brief(error)}]`)
      continue
    }
    if (downloaded.data.byteLength > media.limits.maxBytes) {
      parts.push(`[image skipped: exceeds the ${media.limits.maxBytes}-byte attachment limit]`)
      continue
    }
    let mediaType: ImageMediaType
    try {
      mediaType = detectImageMediaType(downloaded.data)
    } catch {
      parts.push('[image received in an unrecognized format]')
      continue
    }
    if (includeImages) {
      try {
        blocks.push(await media.saveImage(downloaded.data, mediaType, downloaded.filename))
      } catch (error) {
        parts.push(`[image attachment failed: ${brief(error)}]`)
      }
    } else {
      parts.push(`[image received (${mediaType}) — the selected model cannot view images]`)
    }
  }

  if (parts.length === 1 && blocks.length === 0) {
    parts.push(`[Unsupported WeCom message type: ${message.msgtype}]`)
  }
  return [{ type: 'text', text: parts.join('\n') }, ...blocks]
}

async function readBody(
  message: BaseMessage,
  parts: string[],
  images: ImageContent[],
  media: MediaPort,
): Promise<void> {
  switch (message.msgtype) {
    case 'text':
      appendText(parts, message.text?.content)
      break
    case 'voice':
      appendText(parts, message.voice?.content, '[Voice transcription]\n')
      break
    case 'mixed':
      readMixed(message.mixed?.msg_item ?? [], parts, images)
      break
    case 'image':
      if (message.image !== undefined) images.push(message.image)
      break
    case 'file':
      if (message.file !== undefined) {
        await noteUpload(message.file.url, message.file.aeskey, 'file', parts, media)
      }
      break
    case 'video':
      if (message.video !== undefined) {
        await noteUpload(message.video.url, message.video.aeskey, 'video', parts, media)
      }
      break
    default:
      break
  }
}

async function noteUpload(
  url: string,
  aesKey: string | undefined,
  kind: string,
  parts: string[],
  media: MediaPort,
): Promise<void> {
  try {
    const downloaded = await media.download(url, aesKey)
    const path = media.saveUpload(downloaded.data, downloaded.filename)
    parts.push(`[WeCom ${kind} received, saved at ${path}]`)
  } catch (error) {
    parts.push(`[WeCom ${kind} download failed: ${brief(error)}]`)
  }
}

function readQuote(message: BaseMessage, parts: string[], images: ImageContent[]): void {
  const quote = message.quote
  if (quote === undefined) return
  if (quote.msgtype === 'text') appendText(parts, quote.text?.content, '[Quoted text]\n')
  else if (quote.msgtype === 'voice') appendText(parts, quote.voice?.content, '[Quoted voice]\n')
  else if (quote.msgtype === 'mixed') {
    readMixed(quote.mixed?.msg_item ?? [], parts, images, '[Quoted]\n')
  } else if (quote.msgtype === 'image' && quote.image !== undefined) images.push(quote.image)
}

function readMixed(
  items: readonly MixedMsgItem[],
  parts: string[],
  images: ImageContent[],
  prefix = '',
): void {
  for (const item of items) {
    if (item.msgtype === 'text') appendText(parts, item.text?.content, prefix)
    else if (item.msgtype === 'image' && item.image !== undefined) images.push(item.image)
  }
}

function appendText(parts: string[], value: string | undefined, prefix = ''): void {
  const normalized = value?.trim()
  if (normalized) parts.push(prefix + normalized)
}

function brief(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
