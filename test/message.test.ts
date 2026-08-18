import { describe, expect, it, vi } from 'vitest'
import type { MediaPort } from '../src/media.js'
import { containsImageMedia, toContentBlocks } from '../src/message.js'

function textMessage(content: string, chattype: 'single' | 'group' = 'single') {
  return {
    msgid: 'm1',
    aibotid: 'bot',
    chattype,
    ...(chattype === 'group' ? { chatid: 'group-1' } : {}),
    from: { userid: 'u1' },
    msgtype: 'text',
    text: { content },
  } as never
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function makeMedia() {
  const saveImage = vi.fn(async () => ({ type: 'image', attachment: {} }) as never)
  const media: MediaPort = {
    download: vi.fn(async () => ({ data: PNG, filename: 'shot.png' })),
    saveImage,
    saveUpload: vi.fn(() => '/tmp/ws/.wecom-uploads/abc-shot.png'),
    limits: { maxImages: 4, maxBytes: 10_000 },
  }
  return { media, saveImage }
}

describe('toContentBlocks', () => {
  it('leaves single-chat text messages unlabeled', async () => {
    const { media } = makeMedia()
    const blocks = await toContentBlocks(textMessage('hello'), media, true)
    expect(blocks).toHaveLength(1)
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text).toBe('hello')
  })

  it('labels group messages with the full sender userid, untruncated', async () => {
    const { media } = makeMedia()
    const message = {
      ...(textMessage('hello', 'group') as object),
      from: { userid: 'zhangsan.very.long.id' },
    }
    const blocks = await toContentBlocks(message as never, media, true)
    expect((blocks[0] as { text: string }).text).toBe('[zhangsan.very.long.id]：hello')
  })

  it('uses the compact [userid]： prefix for group messages', async () => {
    const { media } = makeMedia()
    const blocks = await toContentBlocks(textMessage('hi', 'group'), media, true)
    expect((blocks[0] as { text: string }).text).toBe('[u1]：hi')
  })

  it('passes voice transcription through', async () => {
    const { media } = makeMedia()
    const message = {
      msgid: 'm1',
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'voice',
      voice: { content: 'transcribed text' },
    } as never
    const blocks = await toContentBlocks(message, media, true)
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('[Voice transcription]')
    expect(text).toContain('transcribed text')
  })

  it('downloads and attaches an image when the model can view it', async () => {
    const { media, saveImage } = makeMedia()
    const message = {
      msgid: 'm1',
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'image',
      image: { url: 'https://x/y.png', aeskey: 'k' },
    } as never
    const blocks = await toContentBlocks(message, media, true)
    expect(media.download).toHaveBeenCalledWith('https://x/y.png', 'k')
    expect(saveImage).toHaveBeenCalledWith(PNG, 'image/png', 'shot.png')
    expect(blocks).toHaveLength(2)
    expect((blocks[1] as { type: string }).type).toBe('image')
  })

  it('notes an image as text when the model cannot view images', async () => {
    const { media, saveImage } = makeMedia()
    const message = {
      msgid: 'm1',
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'image',
      image: { url: 'https://x/y.png', aeskey: 'k' },
    } as never
    const blocks = await toContentBlocks(message, media, false)
    expect(saveImage).not.toHaveBeenCalled()
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { text: string }).text).toContain('cannot view images')
  })

  it('saves a file into the workspace and references its path', async () => {
    const { media } = makeMedia()
    const message = {
      msgid: 'm1',
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'file',
      file: { url: 'https://x/f.bin', aeskey: 'k' },
    } as never
    const blocks = await toContentBlocks(message, media, true)
    const text = (blocks[0] as { text: string }).text
    expect(media.download).toHaveBeenCalledWith('https://x/f.bin', 'k')
    expect(media.saveUpload).toHaveBeenCalledWith(PNG, 'shot.png')
    expect(text).toContain('saved at /tmp/ws/.wecom-uploads/abc-shot.png')
  })

  it('collects text from mixed content', async () => {
    const { media } = makeMedia()
    const message = {
      msgid: 'm1',
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'mixed',
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: 'first part' } },
          { msgtype: 'text', text: { content: 'second part' } },
        ],
      },
    } as never
    const blocks = await toContentBlocks(message, media, true)
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('first part')
    expect(text).toContain('second part')
  })
})

describe('containsImageMedia', () => {
  it('detects images in body, mixed items, and quotes', () => {
    expect(containsImageMedia({ msgtype: 'image' } as never)).toBe(true)
    expect(
      containsImageMedia({
        msgtype: 'mixed',
        mixed: { msg_item: [{ msgtype: 'image' }] },
      } as never),
    ).toBe(true)
    expect(containsImageMedia({ msgtype: 'text', quote: { msgtype: 'image' } } as never)).toBe(true)
    expect(containsImageMedia({ msgtype: 'text' } as never)).toBe(false)
  })
})
