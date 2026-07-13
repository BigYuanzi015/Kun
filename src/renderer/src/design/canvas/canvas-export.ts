import { getCanvasDocumentContentBounds } from './canvas-placement'
import { useCanvasShapeStore } from './canvas-shape-store'
import type { CanvasDocument, Rect } from './canvas-types'

export type CanvasExportFormat = 'svg' | 'png'

export type CanvasAgentExportRequest = {
  format: CanvasExportFormat
  fileName: string
  relativePath: string
}

export type CanvasAgentExportResult = {
  name: string
  relativePath: string
  absolutePath?: string
  mimeType: 'image/png' | 'image/svg+xml'
  byteSize: number
  previewUrl: string
}

export type CanvasAgentExportRequestHandler = (
  request: CanvasAgentExportRequest
) => CanvasAgentExportResult | Promise<CanvasAgentExportResult>

const EXPORT_PADDING = 24
const MAX_RASTER_EDGE = 8192
// About 40 MiB of RGBA pixels; even a poorly-compressing PNG remains below the
// main-process IPC payload ceiling after base64 expansion.
const MAX_RASTER_PIXELS = 10 * 1024 * 1024
const CANVAS_EXPORT_PATH_PATTERN = /^\.deepseekgui-images\/([A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(png|svg))$/i

export function canvasExportBounds(document: CanvasDocument, padding = EXPORT_PADDING): Rect | null {
  const bounds = getCanvasDocumentContentBounds(document)
  if (!bounds) return null
  const safePadding = Math.max(0, padding)
  return {
    x: bounds.x - safePadding,
    y: bounds.y - safePadding,
    width: bounds.width + safePadding * 2,
    height: bounds.height + safePadding * 2
  }
}

/** Keep normal diagrams crisp at 2x while bounding large-board canvas memory. */
export function canvasRasterScale(bounds: Pick<Rect, 'width' | 'height'>): number {
  const width = Math.max(1, bounds.width)
  const height = Math.max(1, bounds.height)
  const edgeScale = MAX_RASTER_EDGE / Math.max(width, height)
  const areaScale = Math.sqrt(MAX_RASTER_PIXELS / (width * height))
  return Math.min(2, edgeScale, areaScale)
}

function safeFileName(value: string): string {
  const normalized = value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
  return normalized || 'kun-whiteboard'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function extractCanvasAgentExportRequest(value: unknown): CanvasAgentExportRequest | null {
  if (!isRecord(value) || !isRecord(value.exportRequest)) return null
  const format = value.exportRequest.format
  const fileName = typeof value.exportRequest.fileName === 'string'
    ? value.exportRequest.fileName.trim()
    : ''
  const relativePath = typeof value.exportRequest.relativePath === 'string'
    ? value.exportRequest.relativePath.trim()
    : ''
  if (format !== 'png' && format !== 'svg') return null
  const match = relativePath.match(CANVAS_EXPORT_PATH_PATTERN)
  if (!match || match[1] !== fileName || match[2]?.toLowerCase() !== format) return null
  return { format, fileName, relativePath }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  window.document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function serializeCanvasSvg(options: {
  sourceSvg: SVGSVGElement
  document: CanvasDocument
  backgroundColor: string
}): { svg: string; bounds: Rect } {
  const bounds = canvasExportBounds(options.document)
  if (!bounds) throw new Error('Canvas is empty')
  const shapeLayer = options.sourceSvg.querySelector<SVGGElement>('#shape-layer')
  if (!shapeLayer) throw new Error('Canvas shape layer is unavailable')

  const svg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('xmlns:xhtml', 'http://www.w3.org/1999/xhtml')
  svg.setAttribute('width', String(Math.ceil(bounds.width)))
  svg.setAttribute('height', String(Math.ceil(bounds.height)))
  svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`)
  svg.setAttribute('style', `color:${getComputedStyle(options.sourceSvg).color || '#1e1e1e'}`)

  const background = window.document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  background.setAttribute('x', String(bounds.x))
  background.setAttribute('y', String(bounds.y))
  background.setAttribute('width', String(bounds.width))
  background.setAttribute('height', String(bounds.height))
  background.setAttribute('fill', options.backgroundColor)
  const exportedLayer = shapeLayer.cloneNode(true) as SVGGElement
  for (const editor of exportedLayer.querySelectorAll<HTMLElement>('[contenteditable]')) {
    editor.setAttribute('contenteditable', 'false')
    editor.style.outline = 'none'
    editor.style.cursor = 'default'
  }
  svg.append(background, exportedLayer)

  return {
    svg: new XMLSerializer().serializeToString(svg),
    bounds
  }
}

async function svgToPng(svgMarkup: string, bounds: Rect): Promise<Blob> {
  const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    const scale = canvasRasterScale(bounds)
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(bounds.width * scale))
    canvas.height = Math.max(1, Math.floor(bounds.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('PNG export is unavailable')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('PNG export failed')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function bytesToBase64(
  bytes: Uint8Array,
  encode: (binary: string) => string = (binary) => window.btoa(binary)
): string {
  const encodedChunks: string[] = []
  // Divisible by three, so only the final chunk receives base64 padding.
  const chunkSize = 0x6000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const binary = String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    encodedChunks.push(encode(binary))
  }
  return encodedChunks.join('')
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

async function canvasExportBlob(options: {
  sourceSvg: SVGSVGElement
  document: CanvasDocument
  format: CanvasExportFormat
  backgroundColor: string
}): Promise<Blob> {
  const { svg, bounds } = serializeCanvasSvg(options)
  return options.format === 'svg'
    ? new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    : svgToPng(svg, bounds)
}

export async function exportCanvasToWorkspace(options: {
  sourceSvg: SVGSVGElement
  document: CanvasDocument
  request: CanvasAgentExportRequest
  workspaceRoot: string
  backgroundColor?: string
}): Promise<CanvasAgentExportResult> {
  const request = extractCanvasAgentExportRequest({ exportRequest: options.request })
  if (!request) throw new Error('Whiteboard export request is invalid')
  if (!options.workspaceRoot.trim()) throw new Error('Whiteboard export requires a workspace')
  const blob = await canvasExportBlob({
    sourceSvg: options.sourceSvg,
    document: options.document,
    format: request.format,
    backgroundColor: options.backgroundColor || '#ffffff'
  })
  const dataBase64 = await blobToBase64(blob)
  const mimeType = request.format === 'png' ? 'image/png' : 'image/svg+xml'
  let absolutePath: string | undefined

  if (typeof window.kunGui?.saveWorkspaceImageBytes !== 'function') {
    throw new Error('Workspace image export is unavailable')
  }
  const directory = request.relativePath.slice(0, request.relativePath.lastIndexOf('/'))
  const saved = await window.kunGui.saveWorkspaceImageBytes({
    workspaceRoot: options.workspaceRoot,
    dataBase64,
    mimeType,
    imageDirectory: directory,
    fileName: request.fileName
  })
  if (!saved.ok) throw new Error(saved.message)
  if (saved.workspaceRelativePath !== request.relativePath) {
    throw new Error('Whiteboard export was saved to an unexpected path')
  }
  absolutePath = saved.path

  return {
    name: request.fileName,
    relativePath: request.relativePath,
    ...(absolutePath ? { absolutePath } : {}),
    mimeType,
    byteSize: blob.size,
    previewUrl: `data:${mimeType};base64,${dataBase64}`
  }
}

function waitForCanvasPaint(browserDocument: Document): Promise<void> {
  const view = browserDocument.defaultView
  if (!view?.requestAnimationFrame) return Promise.resolve()
  return new Promise((resolve) => view.requestAnimationFrame(() => resolve()))
}

export async function exportActiveCodeCanvasToWorkspace(options: {
  request: CanvasAgentExportRequest
  workspaceRoot: string
  browserDocument?: Document
}): Promise<CanvasAgentExportResult> {
  const browserDocument = options.browserDocument ?? window.document
  // Shape ops update Zustand synchronously, while their SVG nodes paint on the
  // following frame. Waiting twice keeps an export tool immediately following
  // an update tool from capturing the previous diagram.
  await waitForCanvasPaint(browserDocument)
  await waitForCanvasPaint(browserDocument)
  const sourceSvg = browserDocument.querySelector<SVGSVGElement>('svg[data-canvas-surface="code"]')
  if (!sourceSvg) throw new Error('The Code whiteboard is not open')
  const backgroundColor = sourceSvg.parentElement
    ? getComputedStyle(sourceSvg.parentElement).backgroundColor
    : '#ffffff'
  return exportCanvasToWorkspace({
    sourceSvg,
    document: useCanvasShapeStore.getState().document,
    request: options.request,
    workspaceRoot: options.workspaceRoot,
    backgroundColor
  })
}

export async function exportCanvasFromSvg(options: {
  sourceSvg: SVGSVGElement
  document: CanvasDocument
  format: CanvasExportFormat
  filename?: string
  backgroundColor?: string
}): Promise<void> {
  const blob = await canvasExportBlob({
    sourceSvg: options.sourceSvg,
    document: options.document,
    format: options.format,
    backgroundColor: options.backgroundColor || '#ffffff'
  })
  const filename = `${safeFileName(options.filename || 'kun-whiteboard')}.${options.format}`
  triggerDownload(blob, filename)
}
